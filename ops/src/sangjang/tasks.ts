import { keccak256, parseAbi, stringToHex, toBytes, hexToString, type Address, type Hex } from "viem";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { explorerTx, giwa, reason, write } from "../chain.ts";
import { config } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import { listingCandidates, parseListing, recentNotices, type ListingNotice } from "./upbit.ts";

export const marketAbi = parseAbi([
  "function marketCount() view returns (uint256)",
  "function market(uint256 id) view returns ((bytes32 symbol,uint64 createdAt,uint64 closesAt,uint128 cap,uint8 status,bool yes,uint64 announcedAt,uint64 proposedAt,address disputer,bytes32 evidence,uint128 yesPool,uint128 noPool,uint128 effYes,uint128 effNo,uint128 fee))",
  "function challengeWindow() view returns (uint64)",
  "function createMarket(bytes32 symbol, uint64 closesAt, uint128 cap) returns (uint256)",
  "function propose(uint256 id, bool yes, uint64 announcedAt, bytes32 evidence)",
  "function finalize(uint256 id)",
]);

export const STATUS = ["None", "Open", "Proposed", "Disputed", "Resolved", "Voided"] as const;

export function sangjangAddress(): Address | null {
  const p = resolve(config.root, "../contracts/deployments/91342.sangjang.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).market as Address) : null;
}

export const symToBytes = (s: string): Hex => stringToHex(s, { size: 32 });
export const bytesToSym = (b: Hex) => hexToString(b, { size: 32 }).replace(/\0+$/, "");

export async function readMarkets(addr: Address) {
  const n = await giwa.readContract({ address: addr, abi: marketAbi, functionName: "marketCount" });
  const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i));
  const ms = await Promise.all(ids.map((id) => giwa.readContract({ address: addr, abi: marketAbi, functionName: "market", args: [id] })));
  return ms.map((m, i) => ({ id: BigInt(i), ...m, sym: bytesToSym(m.symbol), statusName: STATUS[m.status] }));
}

const TARGET_OPEN = Number(process.env.SANGJANG_TARGET_OPEN ?? 10);
const MARKET_DAYS = Number(process.env.SANGJANG_MARKET_DAYS ?? 30);
const CAP = 1_000_000n * 10n ** 18n;

/** Keeps ~10 open markets on the most likely next Upbit KRW listings. */
export function curateTask(keeper: { address: Address; key: Hex }): Task {
  return {
    id: "sangjang:curate",
    title: "Listings: curate markets",
    everyMs: 6 * 3600_000,
    jitterMs: 20 * 60_000,
    timeoutMs: 10 * 60_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const addr = sangjangAddress();
      if (!addr) return { summary: "Sangjang not deployed" };
      const markets = await readMarkets(addr);
      const now = Date.now() / 1000;
      const open = markets.filter((m) => m.statusName === "Open" && Number(m.closesAt) > now);
      const taken = new Set(open.map((m) => m.sym));
      const need = TARGET_OPEN - open.length;
      if (need <= 0) return { summary: `${open.length} open markets — nothing to add` };
      const cands = (await listingCandidates()).filter((c) => !taken.has(c.symbol)).slice(0, need);
      const made: string[] = [];
      for (const c of cands) {
        const closesAt = BigInt(Math.floor(now + MARKET_DAYS * 86400));
        const { hash } = await write({ key: keeper.key, address: addr, abi: marketAbi, functionName: "createMarket", args: [symToBytes(c.symbol), closesAt, CAP] });
        made.push(`${c.symbol} (${c.onBithumb ? "Bithumb, " : ""}$${Math.round(c.binanceVolumeUsd / 1e6)}M Binance vol) ${explorerTx(hash)}`);
      }
      return made.length ? { summary: `new markets: ${made.join(" · ")}`, notify: "info" } : { summary: "no new candidates" };
    },
  };
}

export const evidenceOf = (n: ListingNotice): Hex => keccak256(toBytes(`upbit-notice:${n.id}:${n.title}`));

/**
 * Watches Upbit's trade notices. A KRW listing for an open market → propose YES at the notice
 * time. A deadline passed without one → propose NO. Proposals past the challenge window get
 * finalized. Cancellation-style notices are escalated instead of proposed.
 */
export function resolveTask(keeper: { address: Address; key: Hex }, store: Store): Task {
  return {
    id: "sangjang:resolve",
    title: "Listings resolver",
    everyMs: 60_000,
    jitterMs: 5_000,
    timeoutMs: 5 * 60_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const addr = sangjangAddress();
      if (!addr) return { summary: "Sangjang not deployed", nextAt: Date.now() + 10 * 60_000 };
      const [markets, notices, window] = await Promise.all([
        readMarkets(addr),
        recentNotices(),
        giwa.readContract({ address: addr, abi: marketAbi, functionName: "challengeWindow" }),
      ]);
      const listings = notices.map(parseListing).filter((x): x is ListingNotice => x !== null);
      const now = Math.floor(Date.now() / 1000);
      const acts: string[] = [];
      const alerts: string[] = [];

      for (const m of markets) {
        try {
          if (m.statusName === "Open") {
            const hit = listings.filter((l) => l.tickers.includes(m.sym)).sort((a, b) => a.at - b.at)[0];
            if (hit) {
              if (hit.cancelled) {
                const key = `sangjang:alerted:${m.id}:${hit.id}`;
                if (!store.get(key)) {
                  store.set(key, true);
                  alerts.push(`⚠️ ${m.sym} market #${m.id}: notice mentions cancel/delay — decide manually: "${hit.title}"`);
                }
                continue;
              }
              const at = BigInt(Math.floor(hit.at / 1000));
              const { hash } = await write({ key: keeper.key, address: addr, abi: marketAbi, functionName: "propose", args: [m.id, true, at, evidenceOf(hit)] });
              acts.push(`🔔 ${m.sym} LISTED on Upbit KRW → proposed YES (#${m.id}, notice ${hit.id} "${hit.title}") ${explorerTx(hash)}`);
            } else if (now >= Number(m.closesAt)) {
              const { hash } = await write({ key: keeper.key, address: addr, abi: marketAbi, functionName: "propose", args: [m.id, false, 0n, keccak256(toBytes(`no-listing:${m.sym}:${m.closesAt}`))] });
              acts.push(`${m.sym} deadline passed without a listing → proposed NO (#${m.id}) ${explorerTx(hash)}`);
            }
          } else if (m.statusName === "Proposed" && now >= Number(m.proposedAt) + Number(window)) {
            const { hash } = await write({ key: keeper.key, address: addr, abi: marketAbi, functionName: "finalize", args: [m.id] });
            acts.push(`${m.sym} #${m.id} finalized ${m.yes ? "YES" : "NO"} ${explorerTx(hash)}`);
          } else if (m.statusName === "Disputed") {
            const key = `sangjang:disputed:${m.id}`;
            if (!store.get(key)) {
              store.set(key, true);
              alerts.push(`⚖️ ${m.sym} market #${m.id} is DISPUTED by ${m.disputer} — owner must arbitrate`);
            }
          }
        } catch (err) {
          alerts.push(`${m.sym} #${m.id}: ${reason(err)}`);
        }
      }
      const open = markets.filter((m) => m.statusName === "Open").length;
      if (alerts.length) return { summary: [...acts, ...alerts].join("\n"), notify: "alert" };
      if (acts.length) return { summary: acts.join("\n"), notify: acts.some((a) => a.startsWith("🔔")) ? "alert" : "info" };
      return { summary: `${open} open · ${listings.length} KRW listing notices in feed · no action` };
    },
  };
}
