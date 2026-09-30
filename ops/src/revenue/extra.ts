import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatEther, parseAbiItem, type Address } from "viem";
import { giwa, l1 } from "../chain.ts";
import { config } from "../config.ts";
import { PAGE, Seen } from "../engine/rescan.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import type { WithdrawalRow } from "../bridge/withdrawals.ts";

/**
 * Revenue the fee sweep can't see: the aggregator pays its 0.1% straight to the treasury in
 * whatever token the trade started with (valued here in ETH at the indexer's prices), and fast
 * withdrawals earn their fee when the vault repays the float. Also watches the bridge float and
 * tells the owner when something needs a human.
 */
const WETH = "0x4200000000000000000000000000000000000006";
const ZERO = "0x0000000000000000000000000000000000000000";
/** Every aggregator we ever deployed; the first one still earns if old links point at it. */
const AGGREGATORS: Address[] = ["0x300f3e48b664551541c0708C1b68082913f32527"];
const swapped = parseAbiItem("event Swapped(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee)");
const FLOAT_LOW = 10n ** 17n; // 0.1 ETH

export interface AggRevenue {
  swaps: number;
  feeEth: number;
  volumeEth: number;
  byToken: Record<string, string>;
}

function aggregators(): Address[] {
  const p = resolve(config.root, "../contracts/deployments/91342.aggregator.json");
  const now = existsSync(p) ? [(JSON.parse(readFileSync(p, "utf8")) as { aggregator: Address }).aggregator] : [];
  return [...new Set([...AGGREGATORS, ...now].map((a) => a.toLowerCase() as Address))];
}

/** Token prices in ETH and decimals, from the indexer's market.json. */
function prices(): Map<string, { eth: number; dec: number }> {
  const out = new Map<string, { eth: number; dec: number }>([[WETH, { eth: 1, dec: 18 }], [ZERO, { eth: 1, dec: 18 }]]);
  try {
    const m = JSON.parse(readFileSync(resolve(config.webroot, "market.json"), "utf8")) as { tokens: { address: string; priceEth: number | null; decimals: number }[] };
    for (const t of m.tokens) if (t.priceEth !== null) out.set(t.address.toLowerCase(), { eth: t.priceEth, dec: t.decimals });
  } catch {
    /* no prices yet */
  }
  return out;
}

export function fastRevenue(store: Store) {
  const rows = (store.get<WithdrawalRow[]>("withdrawals") ?? []).filter((r) => r.kind === "fast");
  const paid = rows.filter((r) => r.fillTx);
  return {
    exits: rows.length,
    paid: paid.length,
    feesEth: Number(formatEther(paid.reduce((s, r) => s + BigInt(r.fee), 0n))),
    floatWei: BigInt(store.get<string>("fastfill:float") ?? "0"),
    openStandard: (store.get<WithdrawalRow[]>("withdrawals") ?? []).filter((r) => r.kind !== "fast" && r.status !== "finalized").length,
  };
}

export function extraRevenueTask(keeper: { address: Address }, store: Store): Task {
  return {
    id: "revenue:extra",
    title: "Aggregator + fast-exit revenue, bridge alerts",
    everyMs: 5 * 60_000,
    jitterMs: 30_000,
    async run(): Promise<TaskResult> {
      // ── aggregator fees, per token ──
      const head = await giwa.getBlockNumber();
      const byToken = store.get<Record<string, string>>("agg:fees") ?? {};
      const volByToken = store.get<Record<string, string>>("agg:volume") ?? {};
      let swaps = store.get<number>("agg:swaps") ?? 0;
      const seenAgg = new Seen(store, "agg");
      for (const a of aggregators()) {
        let from = seenAgg.start(store.get<number>(`agg:block:${a}`), head, 99_000n);
        while (from <= head) {
          const to = from + PAGE > head ? head : from + PAGE;
          for (const l of await giwa.getLogs({ address: a, event: swapped, fromBlock: from, toBlock: to })) {
            if (!seenAgg.fresh(l)) continue;
            const t = l.args.tokenIn!.toLowerCase();
            byToken[t] = (BigInt(byToken[t] ?? "0") + l.args.fee!).toString();
            volByToken[t] = (BigInt(volByToken[t] ?? "0") + l.args.amountIn!).toString();
            swaps++;
          }
          from = to + 1n;
        }
        store.set(`agg:block:${a}`, Number(head) + 1);
        seenAgg.save();
      }
      store.set("agg:fees", byToken);
      store.set("agg:volume", volByToken);
      store.set("agg:swaps", swaps);
      const px = prices();
      const value = (m: Record<string, string>) =>
        Object.entries(m).reduce((s, [t, raw]) => {
          const p = px.get(t);
          return p ? s + (Number(BigInt(raw)) / 10 ** p.dec) * p.eth : s;
        }, 0);
      const agg: AggRevenue = { swaps, feeEth: value(byToken), volumeEth: value(volByToken), byToken };
      store.set("revenue:agg", agg);

      // ── bridge alerts: things a human should know ──
      const alerts: string[] = [];
      const float = BigInt(store.get<string>("fastfill:float") ?? "0");
      const lastLow = store.get<number>("alert:floatlow") ?? 0;
      if (store.get<string>("fastfill:float") !== undefined && float < FLOAT_LOW && Date.now() - lastLow > 6 * 3600_000) {
        const l1bal = await l1.getBalance({ address: keeper.address }).catch(() => 0n);
        alerts.push(`⚠️ Fast-withdrawal float low: ${formatEther(float)} ETH free (deployer L1 ${formatEther(l1bal)}). Send Sepolia ETH to the deployer on Ethereum.`);
        store.set("alert:floatlow", Date.now());
      }
      const pending = store.get<{ id: string }[]>("fastfill:pending") ?? [];
      const since = store.get<number>("alert:pending:since") ?? 0;
      if (pending.length && !since) store.set("alert:pending:since", Date.now());
      if (!pending.length && since) store.set("alert:pending:since", 0);
      if (pending.length && since && Date.now() - since > 10 * 60_000 && !store.get<boolean>("alert:pending:sent")) {
        alerts.push(`⚠️ ${pending.length} fast exit(s) unpaid for over 10 min (float too small). They still settle in full after 7 days.`);
        store.set("alert:pending:sent", true);
      }
      if (!pending.length) store.set("alert:pending:sent", false);
      // Users' own (unrelayed) withdrawals reaching a step they must take themselves.
      const told = new Set(store.get<string[]>("alert:wd") ?? []);
      for (const r of store.get<WithdrawalRow[]>("withdrawals") ?? []) {
        if (r.relayed || r.kind === "fast") continue;
        const k = `${r.l2Tx}:${r.status}`;
        if ((r.status === "ready-to-prove" || r.status === "ready-to-finalize") && !told.has(k)) {
          alerts.push(`🌉 Withdrawal ${formatEther(BigInt(r.amount))} ETH for ${r.to.slice(0, 8)}… is ${r.status === "ready-to-prove" ? "ready to prove" : "ready to claim"} (user's own button).`);
          told.add(k);
        }
      }
      store.set("alert:wd", [...told]);

      const summary = `aggregator ${swaps} swaps, fees ≈ ${agg.feeEth.toFixed(6)} ETH`;
      return alerts.length ? { summary: `${summary}\n${alerts.join("\n")}`, notify: "alert" } : { summary };
    },
  };
}
