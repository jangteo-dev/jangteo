import { formatEther, type Address, type Hex } from "viem";
import { abi, ADDR, explorerTx, giwa, l1, sendEth, write } from "./chain.ts";
import { config, type FarmWallet } from "./config.ts";
import type { Task, TaskResult } from "./engine/scheduler.ts";

const fmt = (w: bigint) => `${Number(formatEther(w)).toFixed(4)} ETH`;

/**
 * Anything that lands on Sepolia L1 for this wallet gets bridged to GIWA through the
 * canonical L1StandardBridge (no captcha faucets needed). Deposits arrive on L2 in ~1-3 min.
 */
export function bridgeTask(w: { label: string; address: Address; key: Hex }): Task {
  return {
    id: `bridge:${w.label.toLowerCase()}`,
    title: `Bridge L1→GIWA (${w.label})`,
    everyMs: 10 * 60_000,
    jitterMs: 2 * 60_000,
    lane: `l1:${w.address}`,
    async run(): Promise<TaskResult> {
      const bal = await l1.getBalance({ address: w.address });
      const { l1Reserve, l1MinBridge } = config.farm;
      if (bal < l1Reserve + l1MinBridge) return { summary: `L1 ${fmt(bal)} — nothing to bridge` };
      const amount = bal - l1Reserve;
      const { hash } = await write({
        key: w.key,
        chain: "l1",
        address: ADDR.l1StandardBridge,
        abi: abi.l1Bridge,
        functionName: "bridgeETHTo",
        args: [w.address, 200_000, "0x"],
        value: amount,
      });
      return {
        summary: `bridged ${fmt(amount)} to GIWA · https://sepolia.etherscan.io/tx/${hash ?? "(dry-run)"}`,
        notify: "info",
      };
    },
  };
}

/** The deployer is the treasury: it keeps every farm wallet above a gas floor on GIWA. */
export function topUpTask(treasury: { address: Address; key: Hex }, farms: FarmWallet[]): Task {
  return {
    id: "fund:topup",
    title: "Top-up farm wallets",
    everyMs: 30 * 60_000,
    jitterMs: 5 * 60_000,
    lane: `giwa:${treasury.address}`,
    async run(): Promise<TaskResult> {
      const done: string[] = [];
      let tBal = await giwa.getBalance({ address: treasury.address });
      for (const f of farms) {
        const bal = await giwa.getBalance({ address: f.address });
        if (bal >= config.farm.l2Floor) continue;
        const need = config.farm.l2TopUp - bal;
        if (tBal < need + config.farm.l2Floor) {
          return { summary: `treasury low (${fmt(tBal)}) — cannot top up ${f.label}`, notify: "alert" };
        }
        const hash = await sendEth(treasury.key, f.address, need);
        tBal -= need;
        done.push(`${f.label} +${fmt(need)} ${explorerTx(hash)}`);
      }
      return done.length ? { summary: `topped up: ${done.join("; ")}`, notify: "info" } : { summary: "all farm wallets above floor" };
    },
  };
}
