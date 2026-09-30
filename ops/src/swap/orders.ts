import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { explorerTx, giwa, reason, write } from "../chain.ts";
import { config } from "../config.ts";
import { PAGE, Seen } from "../engine/rescan.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import { bestRoute } from "./route.ts";

/**
 * 장터 스왑 limit orders and DCA: fills every order that is due through the aggregator's best
 * route, when that route meets the order's own minimum (limit) or within 1% of the quote (DCA at
 * market), returns expired limit orders to their owners, and publishes orders.json (open book and
 * recent fills) for the trade page.
 */
export const ordersAbi = parseAbi([
  "struct Order { address owner; address tokenIn; address tokenOut; uint128 total; uint128 remaining; uint256 minRate; uint64 expiry; uint32 slices; uint32 done; uint32 interval; uint64 nextAt; }",
  "struct Hop { address pool; uint8 kind; uint24 fee; }",
  "function orderCount() view returns (uint256)",
  "function order(uint256) view returns (Order)",
  "function nextFill(uint256) view returns (uint256 amountIn, uint256 fee, uint256 minOut, bool due)",
  "function execute(uint256 id, address[] path, Hop[] hops, uint256 minOut) returns (uint256)",
  "function expire(uint256 id)",
]);
const executed = parseAbiItem("event Executed(uint256 indexed id, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 remaining)");

function addresses(): { orders: Address; aggregator: Address } | null {
  const d = resolve(config.root, "../contracts/deployments");
  if (!existsSync(`${d}/91342.orders.json`) || !existsSync(`${d}/91342.aggregator.json`)) return null;
  return { orders: JSON.parse(readFileSync(`${d}/91342.orders.json`, "utf8")).orders, aggregator: JSON.parse(readFileSync(`${d}/91342.aggregator.json`, "utf8")).aggregator };
}

export interface BookOrder {
  id: number;
  owner: Address;
  tokenIn: Address;
  tokenOut: Address;
  total: string;
  remaining: string;
  minRate: string;
  expiry: number;
  slices: number;
  done: number;
  interval: number;
  nextAt: number;
}

export function ordersTask(keeper: { address: Address; key: Hex }, store: Store): Task {
  return {
    id: "orders:exec",
    title: "Limit orders + DCA",
    everyMs: 15_000,
    timeoutMs: 3 * 60_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const a = addresses();
      if (!a) return { summary: "orders not deployed", nextAt: Date.now() + 60 * 60_000 };
      const n = Number(await giwa.readContract({ address: a.orders, abi: ordersAbi, functionName: "orderCount" }));
      const closed = new Set(store.get<number[]>("orders:closed") ?? []);
      const open: BookOrder[] = [];
      const done: string[] = [];
      const now = Math.floor(Date.now() / 1000);
      const ids = Array.from({ length: n }, (_, i) => i).filter((i) => !closed.has(i));
      const all = await Promise.all(ids.map((i) => giwa.readContract({ address: a.orders, abi: ordersAbi, functionName: "order", args: [BigInt(i)] })));
      for (const [k, o] of all.entries()) {
        const id = ids[k];
        if (o.remaining === 0n) {
          closed.add(id);
          continue;
        }
        if (o.slices === 0 && Number(o.expiry) < now) {
          try {
            await write({ key: keeper.key, address: a.orders, abi: ordersAbi, functionName: "expire", args: [BigInt(id)] });
            done.push(`#${id} expired, returned to ${o.owner.slice(0, 8)}…`);
            closed.add(id);
          } catch (err) {
            done.push(`#${id} expire: ${reason(err).slice(0, 80)}`);
          }
          continue;
        }
        open.push({
          id,
          owner: o.owner,
          tokenIn: o.tokenIn,
          tokenOut: o.tokenOut,
          total: o.total.toString(),
          remaining: o.remaining.toString(),
          minRate: o.minRate.toString(),
          expiry: Number(o.expiry),
          slices: o.slices,
          done: o.done,
          interval: o.interval,
          nextAt: Number(o.nextAt),
        });
        const [amountIn, fee, minOut, due] = await giwa.readContract({ address: a.orders, abi: ordersAbi, functionName: "nextFill", args: [BigInt(id)] });
        if (!due || amountIn === 0n) continue;
        const r = await bestRoute(a.aggregator, o.tokenIn, o.tokenOut, amountIn - fee).catch(() => null);
        if (!r || r.out < minOut || r.out === 0n) continue; // a limit still below its price, or no route yet
        // DCA at market keeps a 1% guard against the quote; a limit keeps its own minimum.
        const guard = o.slices === 0 ? minOut : (r.out * 99n) / 100n > minOut ? (r.out * 99n) / 100n : minOut;
        try {
          const { hash } = await write({
            key: keeper.key,
            address: a.orders,
            abi: ordersAbi,
            functionName: "execute",
            args: [BigInt(id), r.path, r.hops, guard],
          });
          done.push(`filled #${id} ${o.slices ? `DCA ${o.done + 1}/${o.slices}` : "limit"} via ${[...new Set(r.dexes)].join("+")} ${explorerTx(hash)}`);
        } catch (err) {
          done.push(`#${id}: ${reason(err).slice(0, 100)}`);
        }
      }
      store.set("orders:closed", [...closed]);

      // Recent fills for the trade page's tape.
      const head = await giwa.getBlockNumber();
      const fills = store.get<{ id: number; amountIn: string; amountOut: string; at: number; tx: Hex }[]>("orders:fills") ?? [];
      const seenFills = new Seen(store, "orders");
      let from = seenFills.start(store.get<number>("orders:block"), head);
      while (from <= head) {
        const to = from + PAGE > head ? head : from + PAGE;
        for (const l of await giwa.getLogs({ address: a.orders, event: executed, fromBlock: from, toBlock: to })) {
          if (!seenFills.fresh(l)) continue;
          fills.push({ id: Number(l.args.id), amountIn: l.args.amountIn!.toString(), amountOut: l.args.amountOut!.toString(), at: now - Number(head - l.blockNumber), tx: l.transactionHash });
        }
        from = to + 1n;
      }
      store.set("orders:block", Number(head) + 1);
      seenFills.save();
      const recent = fills.slice(-300);
      store.set("orders:fills", recent);
      if (existsSync(config.webroot)) {
        const out = resolve(config.webroot, "orders.json");
        writeFileSync(`${out}.tmp`, JSON.stringify({ updatedAt: now, open, fills: recent }));
        renameSync(`${out}.tmp`, out);
      }
      if (done.length) return { summary: done.join("\n"), notify: "info" };
      return { summary: `${open.length} open orders` };
    },
  };
}
