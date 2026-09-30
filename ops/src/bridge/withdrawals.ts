import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, fallback, formatEther, http, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { giwaSepolia, sepolia } from "viem/chains";
import { getWithdrawals, publicActionsL1, publicActionsL2, walletActionsL1 } from "viem/op-stack";
import { config } from "../config.ts";
import { PAGE, scanStart } from "../engine/rescan.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";

/**
 * 장터 브릿지 withdrawals, GIWA → Ethereum Sepolia. GIWA is an OP Stack chain with fault proofs:
 * a withdrawal started on GIWA is proven on L1 once a dispute game covers its block (about an
 * hour), then claimed after the 7-day proof window. This keeper follows every withdrawal made
 * through Jangteo's front door, proves and claims it for the user whenever the 0.5% fee covers
 * the L1 gas (smaller ones are left for the user's own button), and publishes withdrawals.json
 * for the web.
 */

const PROVE_GAS = 550_000n;
const FINALIZE_GAS = 250_000n;
const L1_FLOOR = 10n ** 15n; // never spend the deployer's L1 ETH below 0.001

const deposited = parseAbiItem("event Deposited(address indexed from, address indexed to, uint256 amount, uint256 fee)");

export interface WithdrawalRow {
  l2Tx: Hex;
  hash: Hex; // the withdrawal hash on L1
  from: Address;
  to: Address;
  amount: string; // wei, what arrives on L1
  fee: string;
  startedAt: number;
  status: "waiting-to-prove" | "ready-to-prove" | "waiting-to-finalize" | "ready-to-finalize" | "finalized";
  proveTx?: Hex;
  finalizeTx?: Hex;
  prover?: Address;
  /** Unix seconds when the next step opens, when known. */
  nextAt?: number;
  /** Last time the status was read from Ethereum (unix seconds). */
  checkedAt?: number;
  /** Whether Jangteo relays it (fee covers the L1 gas), or the user does. */
  relayed: boolean;
  /** Fast exits (장터 빠른 출금): the exit id, and the L1 fill that paid the user early. */
  kind?: "fast";
  id?: string;
  fillTx?: Hex;
  filledAt?: number;
}

const exited = parseAbiItem("event Exit(uint256 indexed id, address indexed from, address indexed to, uint256 amount, uint256 amountOut, uint256 fee)");

export function fastAddresses(): { exit: Address; vault: Address } | null {
  const a = resolve(config.root, "../contracts/deployments/91342.fastexit.json");
  const b = resolve(config.root, "../contracts/deployments/11155111.fastvault.json");
  if (!existsSync(a) || !existsSync(b)) return null;
  return { exit: JSON.parse(readFileSync(a, "utf8")).fastExit, vault: JSON.parse(readFileSync(b, "utf8")).fastVault };
}

function door(): Address | null {
  const p = resolve(config.root, "../contracts/deployments/91342.withdraw.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { withdraw: Address }).withdraw : null;
}

/** What the fast-exit float can pay out right now: the deployer's L1 ETH above a gas reserve. */
export const FAST_RESERVE = 10n ** 16n; // 0.01 ETH stays for L1 gas
export const fastFloat = (l1Balance: bigint) => (l1Balance > FAST_RESERVE ? l1Balance - FAST_RESERVE : 0n);

export function withdrawRelayTask(keeper: { address: Address; key: Hex }, store: Store): Task {
  const l1 = createPublicClient({ chain: sepolia, transport: fallback(config.rpc.l1.map((u) => http(u, { timeout: 20_000 }))) }).extend(publicActionsL1());
  const l2 = createPublicClient({ chain: giwaSepolia, transport: fallback(config.rpc.giwa.map((u) => http(u, { timeout: 20_000 }))) }).extend(publicActionsL2());
  const wallet = createWalletClient({
    account: privateKeyToAccount(keeper.key),
    chain: sepolia,
    transport: fallback(config.rpc.l1.map((u) => http(u, { timeout: 30_000 }))),
  }).extend(walletActionsL1());

  return {
    id: "bridge:withdrawals",
    title: "Bridge withdrawals (prove + claim)",
    everyMs: 5 * 60_000,
    jitterMs: 30_000,
    timeoutMs: 10 * 60_000,
    lane: `l1:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const addr = door();
      if (!addr) return { summary: "Withdrawals not deployed", nextAt: Date.now() + 60 * 60_000 };
      const rows = new Map((store.get<WithdrawalRow[]>("withdrawals") ?? []).map((r) => [r.l2Tx, r]));

      // New withdrawals since the last scan (the front door is a single address: 100k-block pages).
      const head = await l2.getBlockNumber();
      let from = scanStart(store.get<number>("withdrawals:block"), head);
      while (from <= head) {
        const to = from + PAGE > head ? head : from + PAGE;
        const logs = await l2.getLogs({ address: addr, event: deposited, fromBlock: from, toBlock: to });
        for (const l of logs) {
          if (rows.has(l.transactionHash)) continue;
          const block = await l2.getBlock({ blockNumber: l.blockNumber });
          const receipt = await l2.getTransactionReceipt({ hash: l.transactionHash });
          const [w] = getWithdrawals(receipt);
          rows.set(l.transactionHash, {
            l2Tx: l.transactionHash,
            hash: w.withdrawalHash,
            from: l.args.from!,
            to: l.args.to!,
            amount: l.args.amount!.toString(),
            fee: l.args.fee!.toString(),
            startedAt: Number(block.timestamp),
            status: "waiting-to-prove",
            relayed: false,
          });
        }
        from = to + 1n;
      }
      // Fast exits are withdrawals too: always proven and claimed by Jangteo, whose float they repay.
      const fast = fastAddresses();
      if (fast) {
        let f = scanStart(store.get<number>("fastexit:scan"), head);
        while (f <= head) {
          const to = f + PAGE > head ? head : f + PAGE;
          for (const l of await l2.getLogs({ address: fast.exit, event: exited, fromBlock: f, toBlock: to })) {
            if (rows.has(l.transactionHash)) continue;
            const block = await l2.getBlock({ blockNumber: l.blockNumber });
            const receipt = await l2.getTransactionReceipt({ hash: l.transactionHash });
            const [w] = getWithdrawals(receipt);
            const fills = store.get<Record<string, { tx: Hex; at: number }>>("fastexit:fills") ?? {};
            const fill = fills[l.args.id!.toString()];
            rows.set(l.transactionHash, {
              l2Tx: l.transactionHash,
              hash: w.withdrawalHash,
              from: l.args.from!,
              to: l.args.to!,
              amount: l.args.amountOut!.toString(),
              fee: l.args.fee!.toString(),
              startedAt: Number(block.timestamp),
              status: "waiting-to-prove",
              relayed: true,
              kind: "fast",
              id: l.args.id!.toString(),
              fillTx: fill?.tx,
              filledAt: fill?.at,
            });
          }
          f = to + 1n;
        }
        store.set("fastexit:scan", Number(head) + 1);
        const fills = store.get<Record<string, { tx: Hex; at: number }>>("fastexit:fills") ?? {};
        for (const r of rows.values()) if (r.kind === "fast" && !r.fillTx && fills[r.id!]) (r.fillTx = fills[r.id!].tx), (r.filledAt = fills[r.id!].at);
      }
      store.set("withdrawals:block", Number(head) + 1);

      const gasPrice = await l1.getGasPrice();
      let bal = await l1.getBalance({ address: keeper.address });
      const done: string[] = [];
      const nowS = Math.floor(Date.now() / 1000);
      for (const r of rows.values()) {
        if (r.status === "finalized") continue;
        // Reading a withdrawal's status walks GIWA's dispute games on Ethereum, which grows heavier
        // every day: only look when something can have changed. Waiting rows are read again shortly
        // before their time (or every few hours, in case), rows the user must act on every 30 min.
        const since = nowS - (r.checkedAt ?? 0);
        const waiting = r.status === "waiting-to-finalize" || r.status === "waiting-to-prove";
        if (waiting && r.nextAt && nowS < r.nextAt - 600 && since < 6 * 3600) continue;
        if (!waiting && !r.relayed && since < 30 * 60) continue;
        try {
          const receipt = await l2.getTransactionReceipt({ hash: r.l2Tx });
          r.status = await l1.getWithdrawalStatus({ receipt, targetChain: giwaSepolia } as never);
          r.checkedAt = nowS;
          // Jangteo relays when its fee pays for both L1 steps at today's gas price.
          r.relayed = r.kind === "fast" || BigInt(r.fee) >= (PROVE_GAS + FINALIZE_GAS) * gasPrice;
          if (r.status === "waiting-to-prove") {
            const { seconds } = await l1.getTimeToProve({ receipt, targetChain: giwaSepolia } as never);
            r.nextAt = Math.floor(Date.now() / 1000) + seconds;
          } else if (r.status === "ready-to-prove" && r.relayed && bal - PROVE_GAS * gasPrice > L1_FLOOR) {
            const [w] = getWithdrawals(receipt);
            const game = await l1.getGame({ l2BlockNumber: receipt.blockNumber, targetChain: giwaSepolia } as never);
            const args = await l2.buildProveWithdrawal({ withdrawal: w, game } as never);
            const hash = await wallet.proveWithdrawal(args as never);
            await l1.waitForTransactionReceipt({ hash });
            r.proveTx = hash;
            r.prover = keeper.address;
            r.status = "waiting-to-finalize";
            bal = await l1.getBalance({ address: keeper.address });
            done.push(`proved ${formatEther(BigInt(r.amount))} ETH for ${r.to.slice(0, 8)}…`);
          } else if (r.status === "waiting-to-finalize") {
            const [w] = getWithdrawals(receipt);
            const { seconds } = await l1.getTimeToFinalize({ withdrawalHash: w.withdrawalHash, targetChain: giwaSepolia } as never);
            r.nextAt = Math.floor(Date.now() / 1000) + seconds;
          } else if (r.status === "ready-to-finalize" && r.relayed && (r.prover ?? keeper.address) === keeper.address && bal - FINALIZE_GAS * gasPrice > L1_FLOOR) {
            const [w] = getWithdrawals(receipt);
            const hash = await wallet.finalizeWithdrawal({ withdrawal: w, targetChain: giwaSepolia } as never);
            await l1.waitForTransactionReceipt({ hash });
            r.finalizeTx = hash;
            r.status = "finalized";
            bal = await l1.getBalance({ address: keeper.address });
            done.push(`claimed ${formatEther(BigInt(r.amount))} ETH to ${r.to.slice(0, 8)}…`);
          }
        } catch (err) {
          done.push(`${r.l2Tx.slice(0, 10)}…: ${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 120)}`);
        }
      }

      const list = [...rows.values()].sort((a, b) => b.startedAt - a.startedAt);
      store.set("withdrawals", list);
      if (existsSync(config.webroot)) {
        const out = resolve(config.webroot, "withdrawals.json");
        writeFileSync(`${out}.tmp`, JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000), withdrawals: list, fastLiquidity: fastFloat(bal).toString() }));
        renameSync(`${out}.tmp`, out);
      }
      const open = list.filter((r) => r.status !== "finalized").length;
      return done.length ? { summary: done.join("\n"), notify: "info" } : { summary: `${list.length} withdrawals, ${open} open` };
    },
  };
}
