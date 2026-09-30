import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, type Address, type Hex } from "viem";
import { explorerTx, giwa, reason, write } from "./chain.ts";
import { config, gyeDeployment } from "./config.ts";
import type { Task, TaskResult } from "./engine/scheduler.ts";
import { cheongyakV2Abi, launchpadAddresses } from "./stalls.ts";

export function jangoeAddress(): Address | null {
  const p = resolve(config.root, "../contracts/deployments/91342.jangoe.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { jangoe: Address }).jangoe : null;
}

export const jangoeAbi = parseAbi([
  "struct Market { bytes32 name; address quote; uint16 collateralBps; uint16 feeBps; uint8 status; address token; uint128 tokensPerUnit; uint64 deliverBy; uint128 volume; uint32 trades; }",
  "struct Trade { uint64 market; uint8 status; address buyer; address seller; uint128 units; uint128 paid; uint128 collateral; }",
  "function marketCount() view returns (uint256)",
  "function market(uint256 id) view returns (Market)",
  "function marketMeta(uint256 id) view returns (string)",
  "function tradeCount() view returns (uint256)",
  "function trade(uint256 id) view returns (Trade)",
  "function createMarket(bytes32 name, address quote, uint16 collateralBps, string meta) returns (uint256)",
  "function startSettlement(uint256 id, address token, uint128 tokensPerUnit, uint64 window)",
  "function voidMarket(uint256 id)",
  "function claimDefault(uint256[] ids)",
  "function refund(uint256[] ids)",
  "function feesAccrued(address quote) view returns (uint256)",
  "function sweepFees(address quote)",
]);

export const MK = { Open: 1, Settling: 2, Voided: 3 } as const;
const CY = { Scheduled: 1, Settling: 2, Settled: 3, Failed: 4, Cancelled: 5 } as const;
const DAY = 86_400;
/** Sellers get this long after the last token unlocks to deliver. */
const GRACE = 3 * DAY;

const nameOf = (h: Hex) => Buffer.from(h.slice(2), "hex").toString("utf8").replace(/\0+$/, "");

/** Which 청약 v2 offering each market trades, read back from the markets' own metadata. */
async function marketsByOffering(mk: Address): Promise<Map<number, number>> {
  const n = Number(await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "marketCount" }));
  const metas = await Promise.all(Array.from({ length: n }, (_, i) => giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "marketMeta", args: [BigInt(i)] })));
  const out = new Map<number, number>();
  metas.forEach((m, i) => {
    try {
      const j = JSON.parse(m) as { kind?: string; offering?: number };
      if (j.kind === "cheongyak" && typeof j.offering === "number") out.set(j.offering, i);
    } catch {
      /* not ours */
    }
  });
  return out;
}

/**
 * 장외 curator for 청약 allocations: opens a market for every v2 offering, starts delivery
 * once allocations exist (window runs until the last token unlocks, plus a grace period), and
 * voids the market if the offering fails or is withdrawn.
 */
export function jangoeCuratorTask(keeper: { address: Address; key: Hex }): Task {
  return {
    id: "jangoe:curate",
    title: "Premarket curator",
    everyMs: 3 * 60_000,
    jitterMs: 15_000,
    timeoutMs: 10 * 60_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const mk = jangoeAddress();
      const lp = launchpadAddresses();
      const tkrw = gyeDeployment()?.tkrw;
      if (!mk || !lp || !tkrw) return { summary: "Premarket not deployed", nextAt: Date.now() + 10 * 60_000 };
      const byOffering = await marketsByOffering(mk);
      const n = Number(await giwa.readContract({ address: lp.cheongyakV2, abi: cheongyakV2Abi, functionName: "offeringCount" }));
      const now = Math.floor(Date.now() / 1000);
      const done: string[] = [];
      for (let id = 0; id < n; id++) {
        const o = await giwa.readContract({ address: lp.cheongyakV2, abi: cheongyakV2Abi, functionName: "offering", args: [BigInt(id)] });
        const name = nameOf(o.t.name);
        const mid = byOffering.get(id);
        try {
          if (mid === undefined) {
            // Only live offerings get a market; finished ones before the premarket existed are skipped.
            if (o.status !== CY.Scheduled || now >= Number(o.t.endAt)) continue;
            // Premarket prices are always in won, whatever the offering itself is paid in.
            const meta = JSON.stringify({ kind: "cheongyak", offering: id, token: o.t.token });
            const { hash } = await write({ key: keeper.key, address: mk, abi: jangoeAbi, functionName: "createMarket", args: [o.t.name, tkrw, 10_000, meta] });
            done.push(`Premarket market opened for offering #${id} ${name} ${explorerTx(hash)}`);
            continue;
          }
          const m = await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "market", args: [BigInt(mid)] });
          if (m.status !== MK.Open) continue;
          if (o.status === CY.Failed || o.status === CY.Cancelled) {
            const { hash } = await write({ key: keeper.key, address: mk, abi: jangoeAbi, functionName: "voidMarket", args: [BigInt(mid)] });
            done.push(`Premarket #${mid} ${name} voided: offering ${o.status === CY.Failed ? "missed its minimum" : "withdrawn"} ${explorerTx(hash)}`);
          } else if (o.status === CY.Settled) {
            const unlocked = Number(o.settledAt) + (o.t.tgeBps < 10_000 ? o.t.cliff + o.t.vesting : 0);
            const window = BigInt(Math.max(unlocked - now, 0) + GRACE);
            const { hash } = await write({
              key: keeper.key,
              address: mk,
              abi: jangoeAbi,
              functionName: "startSettlement",
              args: [BigInt(mid), o.t.token, 10n ** 18n, window],
            });
            done.push(`Premarket #${mid} ${name}: delivery open for ${Math.round(Number(window) / DAY)} days ${explorerTx(hash)}`);
          }
        } catch (err) {
          done.push(`Premarket for offering #${id}: ${reason(err)}`);
        }
      }
      return done.length ? { summary: done.join("\n"), notify: "info" } : { summary: `${byOffering.size} offering markets up to date` };
    },
  };
}

/** After a delivery window, pays buyers of undelivered trades; in voided markets, unwinds trades. */
export function jangoeSettleTask(keeper: { address: Address; key: Hex }): Task {
  return {
    id: "jangoe:settle",
    title: "Premarket defaults & refunds",
    everyMs: 10 * 60_000,
    jitterMs: 30_000,
    timeoutMs: 10 * 60_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const mk = jangoeAddress();
      if (!mk) return { summary: "Premarket not deployed", nextAt: Date.now() + 10 * 60_000 };
      const nm = Number(await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "marketCount" }));
      const markets = await Promise.all(Array.from({ length: nm }, (_, i) => giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "market", args: [BigInt(i)] })));
      const now = Date.now() / 1000;
      const due = (i: number) => {
        const m = markets[i];
        return m.status === MK.Voided || (m.status === MK.Settling && now > Number(m.deliverBy) + 30);
      };
      if (!markets.some((_, i) => due(i))) return { summary: `${nm} markets, nothing due` };

      const nt = Number(await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "tradeCount" }));
      const defaults: bigint[] = [];
      const refunds: bigint[] = [];
      for (let i = 0; i < nt; i++) {
        const t = await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "trade", args: [BigInt(i)] });
        if (t.status !== 1 || !due(Number(t.market))) continue;
        (markets[Number(t.market)].status === MK.Voided ? refunds : defaults).push(BigInt(i));
      }
      const done: string[] = [];
      for (const [label, fn, ids] of [
        ["defaults paid to buyers", "claimDefault", defaults],
        ["trades refunded", "refund", refunds],
      ] as const) {
        for (let k = 0; k < ids.length; k += 40) {
          const batch = ids.slice(k, k + 40);
          const { hash } = await write({ key: keeper.key, address: mk, abi: jangoeAbi, functionName: fn, args: [batch] });
          done.push(`Premarket: ${batch.length} ${label} ${explorerTx(hash)}`);
        }
      }
      return done.length ? { summary: done.join("\n"), notify: "info" } : { summary: `${nm} markets, no open trades due` };
    },
  };
}
