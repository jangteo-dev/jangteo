import { formatUnits, parseAbi, type Address, type Hex } from "viem";
import { abi, explorerTx, giwa, write } from "../chain.ts";
import { gyeDeployment } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import { sangjangAddress } from "../sangjang/tasks.ts";
import { jangoeAbi, jangoeAddress } from "../jangoe.ts";
import { sweepPumpFees } from "../pump.ts";
import { krwPlus } from "../engine/fx.ts";
import { existsSync as exists, readFileSync as readFile } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { config as cfg } from "../config.ts";
import { l1 } from "../chain.ts";

const bridgeAbi = parseAbi(["function feesAccrued() view returns (uint256)", "function sweepFees()"]);

/** 장터 브릿지 lives on Ethereum Sepolia: its 0.5% deposit fees are swept there, in ETH. */
async function sweepBridgeFees(keeper: { key: Hex }): Promise<string | null> {
  const p = resolvePath(cfg.root, "../contracts/deployments/11155111.bridge.json");
  if (!exists(p)) return null;
  const bridge = (JSON.parse(readFile(p, "utf8")) as { bridge: Address }).bridge;
  const fee = await l1.readContract({ address: bridge, abi: bridgeAbi, functionName: "feesAccrued" });
  if (fee < 10n ** 15n) return null; // under 0.001 ETH the L1 gas eats a real share of it
  const { hash } = await write({ key: keeper.key, address: bridge, abi: bridgeAbi, functionName: "sweepFees", chain: "l1" });
  return `Bridge ${formatUnits(fee, 18)} ETH https://sepolia.etherscan.io/tx/${hash}`;
}
import { cheongyakAbi, cheongyakV2Abi, launchpadAddresses, stallAddresses, yutAbi } from "../stalls.ts";

/** The withdrawal front door lives on GIWA: its 0.5% is swept there. */
async function sweepWithdrawFees(keeper: { key: Hex }): Promise<string | null> {
  const p = resolvePath(cfg.root, "../contracts/deployments/91342.withdraw.json");
  if (!exists(p)) return null;
  const door = (JSON.parse(readFile(p, "utf8")) as { withdraw: Address }).withdraw;
  const fee = await giwa.readContract({ address: door, abi: bridgeAbi, functionName: "feesAccrued" });
  if (fee < 10n ** 14n) return null;
  const { hash } = await write({ key: keeper.key, address: door, abi: bridgeAbi, functionName: "sweepFees" });
  return `Withdrawals ${formatUnits(fee, 18)} ETH ${explorerTx(hash)}`;
}

const circleFees = parseAbi(["function feesAccrued() view returns (uint256)", "function sweepFees()", "function treasury() view returns (address)"]);
const marketFees = parseAbi(["function treasuryAccrued() view returns (uint256)", "function withdrawTreasury()", "function treasury() view returns (address)"]);

/** Revenue totals kept in the store, in raw tKRW units (18 decimals). */
export interface Revenue {
  gye: string;
  sangjang: string;
  cheongyak: string;
  yut: string;
  jangoe: string;
  lastSweep: number;
}

export function revenue(store: Store): Revenue {
  return { gye: "0", sangjang: "0", cheongyak: "0", yut: "0", jangoe: "0", lastSweep: 0, ...store.get<Partial<Revenue>>("revenue") };
}

export const revenueTotal = (r: Revenue) => BigInt(r.gye) + BigInt(r.sangjang) + BigInt(r.cheongyak) + BigInt(r.yut) + BigInt(r.jangoe);

/** Test-won amounts, with their ETH and dollar equivalents at Upbit's live price. */
export const krw = (raw: bigint) => krwPlus(Number(formatUnits(raw, 18)));

/** Unswept fees still sitting in contracts right now. */
export async function pendingFees(): Promise<{ gye: bigint; sangjang: bigint; cheongyak: bigint; yut: bigint; jangoe: bigint }> {
  let gye = 0n;
  const d = gyeDeployment();
  if (d) {
    const n = await giwa.readContract({ address: d.factory, abi: abi.gyeFactory, functionName: "circleCount" });
    if (n > 0n) {
      const cs = await giwa.readContract({ address: d.factory, abi: abi.gyeFactory, functionName: "circles", args: [0n, n] });
      const fees = await Promise.all(cs.map((c) => giwa.readContract({ address: c, abi: circleFees, functionName: "feesAccrued" })));
      gye = fees.reduce((a, b) => a + b, 0n);
    }
  }
  const m = sangjangAddress();
  const sangjang = m ? await giwa.readContract({ address: m, abi: marketFees, functionName: "treasuryAccrued" }) : 0n;
  const s = stallAddresses();
  const [cheongyak, yut] = s
    ? await Promise.all([
        giwa.readContract({ address: s.cheongyak, abi: cheongyakAbi, functionName: "feesAccrued" }),
        giwa.readContract({ address: s.yut, abi: yutAbi, functionName: "feesAccrued" }),
      ])
    : [0n, 0n];
  const lp = launchpadAddresses();
  const v2 = lp && d ? await giwa.readContract({ address: lp.cheongyakV2, abi: cheongyakV2Abi, functionName: "feesAccrued", args: [d.tkrw] }) : 0n;
  const mk = jangoeAddress();
  const jangoe = mk && d ? await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "feesAccrued", args: [d.tkrw] }) : 0n;
  return { gye, sangjang, cheongyak: cheongyak + v2, yut, jangoe };
}

/**
 * Moves every accrued platform fee to the treasury (the deployer) and keeps a running total.
 * sweepFees / withdrawTreasury are permissionless and always pay the treasury, so the keeper
 * key only pays gas.
 */
export function feeSweepTask(keeper: { address: Address; key: Hex }, store: Store): Task {
  return {
    id: "fees:sweep",
    title: "💰 Fee sweep",
    everyMs: 6 * 3600_000,
    jitterMs: 15 * 60_000,
    timeoutMs: 10 * 60_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const rev = revenue(store);
      let gye = BigInt(rev.gye);
      let sj = BigInt(rev.sangjang);
      let cy = BigInt(rev.cheongyak);
      let yt = BigInt(rev.yut);
      const swept: string[] = [];

      const d = gyeDeployment();
      if (d) {
        const n = await giwa.readContract({ address: d.factory, abi: abi.gyeFactory, functionName: "circleCount" });
        const cs = n > 0n ? await giwa.readContract({ address: d.factory, abi: abi.gyeFactory, functionName: "circles", args: [0n, n] }) : [];
        for (const c of cs) {
          const fee = await giwa.readContract({ address: c, abi: circleFees, functionName: "feesAccrued" });
          if (fee === 0n) continue;
          const { hash } = await write({ key: keeper.key, address: c, abi: circleFees, functionName: "sweepFees" });
          gye += fee;
          swept.push(`Gye circle ${c.slice(0, 8)}… ${krw(fee)} ${explorerTx(hash)}`);
        }
      }

      const m = sangjangAddress();
      if (m) {
        const fee = await giwa.readContract({ address: m, abi: marketFees, functionName: "treasuryAccrued" });
        if (fee > 0n) {
          const { hash } = await write({ key: keeper.key, address: m, abi: marketFees, functionName: "withdrawTreasury" });
          sj += fee;
          swept.push(`Listings ${krw(fee)} ${explorerTx(hash)}`);
        }
      }

      const s = stallAddresses();
      if (s) {
        for (const [label, address, abi] of [
          ["Offerings", s.cheongyak, cheongyakAbi],
          ["Yut", s.yut, yutAbi],
        ] as const) {
          const fee = await giwa.readContract({ address, abi, functionName: "feesAccrued" });
          if (fee === 0n) continue;
          const { hash } = await write({ key: keeper.key, address, abi, functionName: "sweepFees" });
          if (label === "Offerings") cy += fee;
          else yt += fee;
          swept.push(`${label} ${krw(fee)} ${explorerTx(hash)}`);
        }
      }

      // 청약 v2 escrows fees per quote token; tKRW counts toward revenue, WETH is reported apart.
      const lp = launchpadAddresses();
      if (lp && d) {
        for (const quote of [d.tkrw, "0x4200000000000000000000000000000000000006" as Address]) {
          const fee = await giwa.readContract({ address: lp.cheongyakV2, abi: cheongyakV2Abi, functionName: "feesAccrued", args: [quote] });
          if (fee === 0n) continue;
          const { hash } = await write({ key: keeper.key, address: lp.cheongyakV2, abi: cheongyakV2Abi, functionName: "sweepFees", args: [quote] });
          const weth = quote !== d.tkrw;
          if (!weth) cy += fee;
          swept.push(`Offerings v2 ${weth ? `${formatUnits(fee, 18)} WETH` : krw(fee)} ${explorerTx(hash)}`);
        }
      }

      let jg = BigInt(rev.jangoe);
      const mk = jangoeAddress();
      if (mk && d) {
        const fee = await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "feesAccrued", args: [d.tkrw] });
        if (fee > 0n) {
          const { hash } = await write({ key: keeper.key, address: mk, abi: jangoeAbi, functionName: "sweepFees", args: [d.tkrw] });
          jg += fee;
          swept.push(`Premarket ${krw(fee)} ${explorerTx(hash)}`);
        }
      }

      // 장터 뻥튀기 fees are ETH; they are reported apart from the won totals.
      const pumpSwept = await sweepPumpFees(keeper);
      if (pumpSwept) swept.push(pumpSwept);
      const bridgeSwept = await sweepBridgeFees(keeper).catch(() => null);
      if (bridgeSwept) swept.push(bridgeSwept);
      const withdrawSwept = await sweepWithdrawFees(keeper).catch(() => null);
      if (withdrawSwept) swept.push(withdrawSwept);

      const next: Revenue = {
        gye: gye.toString(),
        sangjang: sj.toString(),
        cheongyak: cy.toString(),
        yut: yt.toString(),
        jangoe: jg.toString(),
        lastSweep: swept.length ? Date.now() : rev.lastSweep,
      };
      store.set("revenue", next);
      const total = `total revenue ${krw(revenueTotal(next))} 
• Gye ${krw(gye)}
• Listings ${krw(sj)}
• Offerings ${krw(cy)}
• Yut ${krw(yt)}
• Premarket ${krw(jg)}`;
      return swept.length ? { summary: `💰 swept ${swept.join(" · ")}\n${total}`, notify: "info" } : { summary: `nothing to sweep · ${total}` };
    },
  };
}
