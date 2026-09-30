import { createPublicClient, fallback, formatEther, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { giwaSepolia } from "viem/chains";
import { l1, write } from "../chain.ts";
import { config } from "../config.ts";
import { RESCAN } from "../engine/rescan.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import { fastAddresses, fastFloat } from "./withdrawals.ts";

/**
 * 장터 빠른 출금 filler: pays each fast exit on Ethereum as soon as its GIWA transaction is a few
 * blocks deep, from the deployer's L1 float. The vault repays the float, fee included, when GIWA's
 * official withdrawal lands a week later (bridge:withdrawals proves and claims it). An exit larger
 * than the float is left unfilled: the vault then pays its user in full, fee refunded, at settlement.
 */
const CONFIRMATIONS = 5n;
/**
 * Above this, an exit is paid only once its GIWA block is in the L2 "safe" head (its data already
 * posted to Ethereum), so a sequencer reorg can never undo an exit Jangteo has already paid out.
 * Small exits keep the few-block path: the float risk is capped by this size.
 */
const SAFE_ABOVE = 10n ** 17n; // 0.1 ETH
const exited = parseAbiItem("event Exit(uint256 indexed id, address indexed from, address indexed to, uint256 amount, uint256 amountOut, uint256 fee)");
const vaultAbi = parseAbi([
  "function fill(uint256 id, address to, uint256 amountOut) payable",
  "function filler(bytes32) view returns (address)",
  "function settled(uint256) view returns (bool)",
  "function key(uint256 id, address to, uint256 amountOut) pure returns (bytes32)",
]);

export function fastFillTask(keeper: { address: Address; key: Hex }, store: Store): Task {
  const l2 = createPublicClient({ chain: giwaSepolia, transport: fallback(config.rpc.giwa.map((u) => http(u, { timeout: 15_000 }))) });
  return {
    id: "bridge:fastfill",
    title: "Fast withdrawals (fill on Ethereum)",
    everyMs: 20_000,
    timeoutMs: 3 * 60_000,
    lane: `l1:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const a = fastAddresses();
      if (!a) return { summary: "Fast exits not deployed", nextAt: Date.now() + 60 * 60_000 };
      const head = (await l2.getBlockNumber()) - CONFIRMATIONS;
      // GIWA's RPC is a pool of nodes: one that is a few blocks behind answers "no logs" for blocks it
      // has not seen, and a cursor that moved past them would miss an exit. So every run also re-reads
      // the last RESCAN blocks, and exits are de-duplicated by id.
      const cursor = BigInt(store.get<number>("fastfill:block") ?? Number(head) - 90_000);
      let from = cursor < head - RESCAN ? cursor : head - RESCAN;
      const pending = store.get<{ id: string; to: Address; out: string; block?: string }[]>("fastfill:pending") ?? [];
      const known = new Set(pending.map((p) => p.id));
      while (from <= head) {
        const to = from + 9_999n > head ? head : from + 9_999n;
        for (const l of await l2.getLogs({ address: a.exit, event: exited, fromBlock: from, toBlock: to })) {
          const id = l.args.id!.toString();
          if (known.has(id)) continue;
          known.add(id);
          pending.push({ id, to: l.args.to!, out: l.args.amountOut!.toString(), block: l.blockNumber.toString() });
        }
        from = to + 1n;
      }
      store.set("fastfill:block", Number(head) + 1);

      const fills = store.get<Record<string, { tx: Hex; at: number }>>("fastexit:fills") ?? {};
      const left: typeof pending = [];
      const done: string[] = [];
      let bal = await l1.getBalance({ address: keeper.address });
      const safe = pending.some((p) => BigInt(p.out) > SAFE_ABOVE) ? (await l2.getBlock({ blockTag: "safe" })).number : 0n;
      for (const p of pending) {
        if (fills[p.id]) continue;
        const id = BigInt(p.id);
        const out = BigInt(p.out);
        const key = await l1.readContract({ address: a.vault, abi: vaultAbi, functionName: "key", args: [id, p.to, out] });
        const [who, settled] = await Promise.all([
          l1.readContract({ address: a.vault, abi: vaultAbi, functionName: "filler", args: [key] }),
          l1.readContract({ address: a.vault, abi: vaultAbi, functionName: "settled", args: [id] }),
        ]);
        if (settled || who !== "0x0000000000000000000000000000000000000000") continue;
        if (out > SAFE_ABOVE && (!p.block || BigInt(p.block) > safe)) {
          left.push(p); // large exit: wait until its block is safe on Ethereum (a few minutes)
          continue;
        }
        if (out > fastFloat(bal)) {
          left.push(p); // wait for the float to refill; settlement pays the user in full anyway
          continue;
        }
        const { hash } = await write({ key: keeper.key, chain: "l1", address: a.vault, abi: vaultAbi, functionName: "fill", args: [id, p.to, out], value: out });
        fills[p.id] = { tx: hash!, at: Math.floor(Date.now() / 1000) };
        store.set("fastexit:fills", fills);
        bal = await l1.getBalance({ address: keeper.address });
        done.push(`paid fast exit #${p.id}: ${formatEther(out)} ETH to ${p.to.slice(0, 8)}… https://sepolia.etherscan.io/tx/${hash}`);
      }
      store.set("fastfill:pending", left);
      store.set("fastfill:float", fastFloat(bal).toString());
      if (done.length) return { summary: done.join("\n"), notify: "info" };
      return { summary: left.length ? `${left.length} exits waiting for float (${formatEther(fastFloat(bal))} ETH free)` : `idle · float ${formatEther(fastFloat(bal))} ETH` };
    },
  };
}
