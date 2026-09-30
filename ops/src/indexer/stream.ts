import { getAddress, parseAbi, parseAbiItem, type Address, type Hex, type Log } from "viem";
import { call, callAny, rpc } from "./rpc.ts";
import type { IndexDb } from "./db.ts";

/**
 * Follows every DEX pool and the 장터 뻥튀기 curve on GIWA, block by block.
 *
 * Each source (a pool, or the pump) has its own `backfilled_block`: every event at or below it is
 * stored. The loop always advances the sources that are furthest behind, in ranges of at most
 * MAX_RANGE blocks, so sources created later catch up and then move together with the rest. A
 * range is written in one transaction together with the new block marks, so there is never a
 * gap: a crash or restart repeats at most the range that was in flight (writes are idempotent).
 */

const MAX_RANGE = 10_000; // GIWA's limit for multi-address log queries
const ADDRS_PER_QUERY = 120;
const PARALLEL = 20;
const OVERLAP = 30;
const LAG = 2; // stay two blocks behind the head: GIWA can still reorder its newest blocks
const V2_FACTORY = parseAbi(["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"]);
const V3_FACTORY = parseAbi(["function feeAmountTickSpacing(uint24) view returns (int24)"]);
const PAIR = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);
const EV = {
  poolCreated: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"),
  sync: parseAbiItem("event Sync(uint112 reserve0, uint112 reserve1)"),
  v2Swap: parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"),
  v3Swap: parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"),
  trade: parseAbiItem(
    "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEth, uint256 sold)",
  ),
};
const Q96 = 2 ** 96;
export interface Source {
  address: string;
  kind: "v2" | "v3" | "pump";
  backfilled: number;
  created: number;
}

export class Stream {
  private head = 0n;
  private headTs = 0;
  private readonly db: IndexDb;
  /** 뻥튀기 contracts (v1 keeps its old cursor name "pump"), each followed from its deploy block. */
  readonly pumps: { address: string; created: number; cursor: string }[];

  constructor(db: IndexDb, pumps: { address: Address; created: number }[]) {
    this.db = db;
    this.pumps = pumps.map((p, i) => ({ address: p.address.toLowerCase(), created: p.created, cursor: i === 0 ? "pump" : `pump:${p.address.toLowerCase()}` }));
  }

  /** Block time from the block number: GIWA makes exactly one block a second. */
  private ts(bn: bigint) {
    return this.headTs - Number(this.head - bn);
  }

  // ─────────────────────────────── discovery ───────────────────────────────

  addFactory(address: string, kind: "v2" | "v3", dex: string, createdBlock: number) {
    this.db.db
      .prepare("INSERT OR IGNORE INTO factory (address, kind, dex, created_block, scanned_block) VALUES (?, ?, ?, ?, ?)")
      .run(address.toLowerCase(), kind, dex, createdBlock, createdBlock - 1);
  }

  /**
   * Finds pools created since the last look, in every factory. At most `budget` new V2 pairs per
   * call, so a factory with hundreds of pairs is registered over several rounds while the block
   * stream keeps moving in between.
   */
  async discover(budget = 60) {
    const factories = this.db.db.prepare("SELECT * FROM factory").all() as {
      address: string;
      kind: string;
      dex: string;
      created_block: number;
      scanned_block: number;
      pairs_known: number;
    }[];
    let found = 0;
    // Every V2 factory's pair count in one multicall; only factories that grew are read further.
    const v2 = factories.filter((f) => f.kind === "v2");
    const counts = await call(
      () =>
        rpc.multicall({
          contracts: v2.map((f) => ({ address: f.address as Address, abi: V2_FACTORY, functionName: "allPairsLength" }) as const),
          allowFailure: true,
        }),
      "allPairsLength",
    );
    const countOf = new Map(v2.map((f, i) => [f.address, counts[i].status === "success" ? Number(counts[i].result) : f.pairs_known]));
    for (const f of factories) {
      if (f.kind === "v2") {
        const n = countOf.get(f.address) ?? f.pairs_known;
        const upto = Math.min(n, f.pairs_known + budget - found);
        if (upto <= f.pairs_known) continue;
        // One multicall for the pair addresses, one for their tokens: hundreds of pairs cost a
        // handful of requests.
        const idx = Array.from({ length: upto - f.pairs_known }, (_, k) => BigInt(f.pairs_known + k));
        const pairs = await call(
          () => rpc.multicall({ contracts: idx.map((i) => ({ address: f.address as Address, abi: V2_FACTORY, functionName: "allPairs", args: [i] }) as const), allowFailure: false }),
          "allPairs",
        );
        const toks = await call(
          () =>
            rpc.multicall({
              contracts: pairs.flatMap((p) => [
                { address: p, abi: PAIR, functionName: "token0" } as const,
                { address: p, abi: PAIR, functionName: "token1" } as const,
              ]),
              allowFailure: true,
            }),
          "pairTokens",
        );
        this.db.tx(() => {
          pairs.forEach((pair, k) => {
            const t0 = toks[2 * k];
            const t1 = toks[2 * k + 1];
            // A pair's creation block isn't on the pair; its factory's is a safe lower bound.
            if (t0.status === "success" && t1.status === "success") this.addPool(pair, f.address, "v2", f.dex, t0.result as string, t1.result as string, 3000, f.created_block);
          });
          this.db.db.prepare("UPDATE factory SET pairs_known = ? WHERE address = ?").run(upto, f.address);
        });
        found += pairs.length;
      } else {
        // V3 factories have no list: read their PoolCreated events forward.
        const head = Number(this.head) - LAG;
        for (let b = f.scanned_block + 1; b <= head; b += 100_000) {
          const to = Math.min(b + 99_999, head);
          const logs = await call(
            () => rpc.getLogs({ address: f.address as Address, event: EV.poolCreated, fromBlock: BigInt(b), toBlock: BigInt(to) }),
            "PoolCreated",
          );
          this.db.tx(() => {
            for (const l of logs) {
              this.addPool(l.args.pool!, f.address, "v3", f.dex, l.args.token0!, l.args.token1!, Number(l.args.fee), Number(l.blockNumber));
              found++;
            }
            this.db.db.prepare("UPDATE factory SET scanned_block = ? WHERE address = ?").run(to, f.address);
          });
        }
      }
    }
    return found;
  }

  private addPool(pool: string, factory: string, kind: string, dex: string, t0: string, t1: string, fee: number, created: number) {
    this.db.db
      .prepare(
        "INSERT OR IGNORE INTO pool (address, factory, kind, dex, token0, token1, fee, created_block, backfilled_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(pool.toLowerCase(), factory.toLowerCase(), kind, dex, t0.toLowerCase(), t1.toLowerCase(), fee, created, created - 1);
  }

  sources(): Source[] {
    const pools = this.db.db.prepare("SELECT address, kind, backfilled_block, created_block FROM pool").all() as {
      address: string;
      kind: "v2" | "v3";
      backfilled_block: number;
      created_block: number;
    }[];
    return [
      ...pools.map((p) => ({ address: p.address, kind: p.kind, backfilled: p.backfilled_block, created: p.created_block })),
      ...this.pumps.map((p) => ({ address: p.address, kind: "pump" as const, backfilled: this.db.cursor(p.cursor) ?? p.created - 1, created: p.created })),
    ];
  }

  // ───────────────────────────────── stream ────────────────────────────────

  async refreshHead() {
    const b = await call(() => rpc.getBlock(), "head", true);
    this.head = b.number;
    this.headTs = Number(b.timestamp);
    return Number(b.number) - LAG;
  }

  /**
   * One step: take the sources furthest behind, read their next range, store it. Returns how far
   * behind the most lagging source still is (0 = everything is live).
   */
  async step(target: number): Promise<number> {
    const all = this.sources();
    const lowest = Math.min(...all.map((s) => s.backfilled));
    if (lowest >= target) return 0;
    // Re-read the last OVERLAP blocks: a pool node a few blocks behind answers "no logs" for blocks it
    // has not seen, and stores ignore duplicates, so overlapping is free and nothing is skipped.
    const from = Math.max(0, lowest + 1 - OVERLAP);
    const to = Math.min(from + PARALLEL * MAX_RANGE - 1, target);
    // Everyone still behind `to` is read over the whole range together. Sources that already
    // hold part of it get those events again; stores ignore duplicates, so a sweep is always safe
    // and far fewer queries than walking each source's own start block.
    const group = all.filter((s) => s.backfilled < to);
    const spans: [number, number][] = [];
    for (let f = from; f <= to; f += MAX_RANGE) spans.push([f, Math.min(f + MAX_RANGE - 1, to)]);
    // Per range, only the sources that existed by its end (older history holds few pools).
    const queries: { a: number; b: number; addrs: Address[] }[] = [];
    for (const [a, b] of spans) {
      const live = group.filter((s) => s.created <= b && s.backfilled < b);
      for (let i = 0; i < live.length; i += ADDRS_PER_QUERY) queries.push({ a, b, addrs: live.slice(i, i + ADDRS_PER_QUERY).map((s) => s.address as Address) });
    }
    const parts = await Promise.all(
      queries.map((q) =>
        callAny(
          (c) => c.getLogs({ address: q.addrs, events: [EV.sync, EV.v2Swap, EV.v3Swap, EV.trade], fromBlock: BigInt(q.a), toBlock: BigInt(q.b) }),
          `logs ${q.a}-${q.b}`,
        ),
      ),
    );
    // Store in chain order, so a pool's latest state is the one it ends the range with.
    const logs = parts.flat().sort((x, y) => Number(x.blockNumber! - y.blockNumber!) || x.logIndex! - y.logIndex!);
    const kinds = new Map(group.map((s) => [s.address, s.kind]));
    this.db.tx(() => {
      this.store(logs as Log[], kinds);
      for (const s of group) {
        if (s.kind === "pump") this.db.setCursor(this.pumps.find((p) => p.address === s.address)!.cursor, Math.max(s.backfilled, to));
        else this.db.db.prepare("UPDATE pool SET backfilled_block = MAX(backfilled_block, ?) WHERE address = ?").run(to, s.address);
      }
    });
    return target - to;
  }

  private store(logs: Log[], kinds: Map<string, string>) {
    const putSwap = this.db.db.prepare(
      "INSERT OR IGNORE INTO swap (block, log, pool, tx, ts, amount0, amount1, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const putTrade = this.db.db.prepare(
      "INSERT OR IGNORE INTO trade (block, log, token, tx, ts, is_buy, eth, tokens, real_eth, sold) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const setV2 = this.db.db.prepare("UPDATE pool SET r0 = ?, r1 = ?, updated_block = ? WHERE address = ? AND updated_block <= ?");
    const setV3 = this.db.db.prepare("UPDATE pool SET sqrt_price = ?, updated_block = ? WHERE address = ? AND updated_block <= ?");
    // The Sync right before a V2 Swap (same transaction) carries the reserves after it.
    const lastSync = new Map<string, { r0: bigint; r1: bigint }>();
    for (const raw of logs) {
      const l = raw as Log & { eventName: string; args: Record<string, unknown> };
      const addr = l.address.toLowerCase();
      const kind = kinds.get(addr);
      const bn = l.blockNumber!;
      const li = l.logIndex!;
      if (l.eventName === "Sync" && kind === "v2") {
        const r0 = l.args.reserve0 as bigint;
        const r1 = l.args.reserve1 as bigint;
        lastSync.set(`${l.transactionHash}:${addr}`, { r0, r1 });
        setV2.run(r0.toString(), r1.toString(), Number(bn), addr, Number(bn));
      } else if (l.eventName === "Swap" && kind === "v2" && "amount0In" in l.args) {
        const a = l.args as Record<string, bigint>;
        const s = lastSync.get(`${l.transactionHash}:${addr}`);
        const price = s && s.r0 > 0n ? Number(s.r1) / Number(s.r0) : 0;
        putSwap.run(Number(bn), li, addr, l.transactionHash!, this.ts(bn), (a.amount0In - a.amount0Out).toString(), (a.amount1In - a.amount1Out).toString(), price);
      } else if (l.eventName === "Swap" && kind === "v3" && "sqrtPriceX96" in l.args) {
        const a = l.args as Record<string, bigint>;
        const sp = Number(a.sqrtPriceX96) / Q96;
        putSwap.run(Number(bn), li, addr, l.transactionHash!, this.ts(bn), a.amount0.toString(), a.amount1.toString(), sp * sp);
        setV3.run(a.sqrtPriceX96.toString(), Number(bn), addr, Number(bn));
      } else if (l.eventName === "Trade" && kind === "pump") {
        const a = l.args;
        putTrade.run(
          Number(bn),
          li,
          (a.token as string).toLowerCase(),
          l.transactionHash!,
          this.ts(bn),
          a.isBuy ? 1 : 0,
          (a.ethAmount as bigint).toString(),
          (a.tokenAmount as bigint).toString(),
          (a.realEth as bigint).toString(),
          (a.sold as bigint).toString(),
        );
      }
    }
  }

  /**
   * Fills in who sent each stored swap or trade (routers sit in the event, people sign the tx).
   * Runs on its own loop: the block stream never waits for it. Returns how many were resolved.
   */
  async resolveSenders(): Promise<number> {
    // Most useful first: curve trades, then 장터 스왑, then the last week of every other pool,
    // newest first. Older swaps on other DEXes are left unresolved (marked ''): they would take
    // hours and nothing on screen needs who made them.
    const weekAgo = this.headTs - 7 * 86_400;
    this.db.db.prepare("UPDATE swap SET sender = '' WHERE sender IS NULL AND ts < ? AND pool NOT IN (SELECT address FROM pool WHERE dex = '장터 스왑')").run(weekAgo);
    let pending = this.db.db.prepare("SELECT DISTINCT tx FROM trade WHERE sender IS NULL LIMIT 200").all() as { tx: Hex }[];
    if (!pending.length)
      pending = this.db.db
        .prepare(
          "SELECT tx FROM swap WHERE sender IS NULL GROUP BY tx ORDER BY (pool IN (SELECT address FROM pool WHERE dex = '장터 스왑')) DESC, MAX(block) DESC LIMIT 200",
        )
        .all() as { tx: Hex }[];
    for (let i = 0; i < pending.length; i += 8) {
      const chunk = pending.slice(i, i + 8);
      const senders = await Promise.all(chunk.map((p) => call(() => rpc.getTransaction({ hash: p.tx }), "tx").then((t) => getAddress(t.from))));
      this.db.tx(() => {
        chunk.forEach((p, k) => {
          this.db.db.prepare("UPDATE swap SET sender = ? WHERE tx = ?").run(senders[k], p.tx);
          this.db.db.prepare("UPDATE trade SET sender = ? WHERE tx = ?").run(senders[k], p.tx);
        });
      });
    }
    return pending.length;
  }

  /** Validates a factory's kind by asking it: V2 has allPairsLength, V3 has fee tiers. */
  static async kindOf(address: Address): Promise<"v2" | "v3" | null> {
    try {
      await call(() => rpc.readContract({ address, abi: V2_FACTORY, functionName: "allPairsLength" }), "probe");
      return "v2";
    } catch {
      /* not V2 */
    }
    try {
      const s = await call(() => rpc.readContract({ address, abi: V3_FACTORY, functionName: "feeAmountTickSpacing", args: [3000] }), "probe");
      return s !== 0 ? "v3" : null;
    } catch {
      return null;
    }
  }

}
