import { formatUnits, parseAbi, type Address } from "viem";
import { call, rpc } from "./rpc.ts";
import type { IndexDb } from "./db.ts";
import { routeOf } from "./probe.ts";

/**
 * Builds market.json from the indexer's database: every token with a market on GIWA, priced in
 * ETH and won, with liquidity, volume, change and a 7-day sparkline, plus each wallet's buy and
 * sell flows for profit and loss. Pure reads from SQLite apart from a few cached RPC lookups.
 */

const WETH = "0x4200000000000000000000000000000000000006";
const DEAD = "0x000000000000000000000000000000000000dead";
const DAY = 86_400;
const EXPLORER = "https://sepolia-explorer.giwa.io/api/v2";
/** A pool must hold at least this much of its priced side (in ETH) to set a price. */
const MIN_PRICING_LIQ = 0.02; // ≈ ₩70,000: thinner pools don't get to price anything

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function name() view returns (string)"]);

export interface MarketToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  icon: string | null;
  holders: number | null;
  priceEth: number | null;
  priceKrw: number | null;
  change24h: number | null;
  change7d: number | null;
  mcapKrw: number | null;
  fdvKrw: number | null;
  liquidityKrw: number;
  volume24hKrw: number;
  trades24h: number;
  spark: number[];
  /** Markets the token trades on, deepest first. */
  venues: { dex: string; pool: string; kind: string; liquidityKrw: number; quote: string }[];
  /** 장터 뻥튀기 curve state when the token is still on its curve. */
  curve: { progress: number } | null;
  graduated: boolean;
  createdAt: number | null;
  suspicious: boolean;
  /** Used as a quote currency (WETH, USDC, KRW tokens): shown, but not ranked with the rest. */
  anchor: boolean;
}

interface TokenRow {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  icon: string | null;
  holders: number | null;
  supply: string | null;
  dead: string | null;
  updated: number;
}

interface PoolRow {
  address: string;
  factory: string;
  kind: string;
  dex: string;
  token0: string;
  token1: string;
  r0: string;
  r1: string;
  sqrt_price: string;
  updated_block: number;
}

interface PumpCurve {
  address: string;
  threshold: bigint;
  virtualEth: bigint;
  virtualTokens: bigint;
}
/** Every 뻥튀기 contract (v1, v2…) with its own curve; each launch says which one it lives on. */
interface PumpInfo {
  curves: PumpCurve[];
  launches: () => Promise<{ token: string; pump: string; graduated: boolean; realEth: bigint; sold: bigint; createdAt: number }[]>;
}

export class MarketBuilder {
  private ethKrw = 0;
  private ethKrwAt = 0;
  private usdKrw = 0;
  /** Extra price anchors, in ETH per whole token: WETH copies proven backed, USD and KRW tokens. */
  private anchors = new Map<string, number>();
  private v3Balances = new Map<string, { b0: bigint; b1: bigint; at: number }>();
  private readonly db: IndexDb;
  private readonly tkrw: string;
  private readonly pump: PumpInfo;
  /** token → the curve of the contract it launched on (filled from launches). */
  private curveOfToken = new Map<string, PumpCurve>();
  private curve(token: string): PumpCurve {
    return this.curveOfToken.get(token) ?? this.pump.curves[0];
  }


  constructor(db: IndexDb, tkrw: string, pump: PumpInfo) {
    this.db = db;
    this.tkrw = tkrw;
    this.pump = pump;
  }

  private async rate() {
    if (Date.now() - this.ethKrwAt > 60_000) {
      try {
        const res = await fetch("https://api.upbit.com/v1/ticker?markets=KRW-ETH,KRW-USDT", { signal: AbortSignal.timeout(8000) });
        const j = (await res.json()) as { market: string; trade_price: number }[];
        this.ethKrw = j.find((x) => x.market === "KRW-ETH")!.trade_price;
        this.usdKrw = j.find((x) => x.market === "KRW-USDT")?.trade_price ?? this.usdKrw;
        this.ethKrwAt = Date.now();
      } catch {
        /* keep the last good rate */
      }
    }
    return this.ethKrw || 3_600_000;
  }

  /** Cached metadata only: a build never waits on the network. `refreshMeta` fills the cache. */
  private token(address: string): TokenRow {
    const row = this.db.db.prepare("SELECT * FROM token WHERE address = ?").get(address) as unknown as TokenRow | undefined;
    return row ?? { address, name: null, symbol: null, decimals: 18, icon: null, holders: null, supply: "0", dead: "0", updated: 0 };
  }

  /**
   * Fills token metadata and icons from GIWA's explorer (refreshed every 6 hours), with name,
   * symbol, decimals and supply read on-chain in one multicall when the explorer lacks them.
   * Runs on its own loop. Returns how many tokens it refreshed.
   */
  async refreshMeta(limit = 40): Promise<number> {
    const tokens = new Set<string>();
    for (const p of this.db.db.prepare("SELECT token0, token1 FROM pool").all() as { token0: string; token1: string }[]) tokens.add(p.token0), tokens.add(p.token1);
    for (const r of this.db.db.prepare("SELECT DISTINCT token FROM trade").all() as { token: string }[]) tokens.add(r.token);
    const stale = [...tokens].filter((t) => {
      const r = this.db.db.prepare("SELECT updated FROM token WHERE address = ?").get(t) as { updated: number } | undefined;
      return !r || Date.now() - r.updated > 6 * 3600_000;
    }).slice(0, limit);
    if (!stale.length) return 0;
    const fromExplorer = await Promise.all(
      stale.map(async (address) => {
        try {
          const res = await fetch(`${EXPLORER}/tokens/${address}`, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return null;
          return (await res.json()) as { name: string | null; symbol: string | null; decimals: string | null; icon_url: string | null; holders_count: string | null; total_supply: string | null };
        } catch {
          return null;
        }
      }),
    );
    const onchain = await call(
      () =>
        rpc.multicall({
          contracts: stale.flatMap((a) => [
            { address: a as Address, abi: erc20, functionName: "name" } as const,
            { address: a as Address, abi: erc20, functionName: "symbol" } as const,
            { address: a as Address, abi: erc20, functionName: "decimals" } as const,
            { address: a as Address, abi: erc20, functionName: "totalSupply" } as const,
            { address: a as Address, abi: erc20, functionName: "balanceOf", args: [DEAD as Address] } as const,
          ]),
          allowFailure: true,
        }),
      "meta",
    );
    const put = this.db.db.prepare(
      "INSERT INTO token (address, name, symbol, decimals, icon, holders, supply, dead, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET name=excluded.name, symbol=excluded.symbol, decimals=excluded.decimals, icon=excluded.icon, holders=excluded.holders, supply=excluded.supply, dead=excluded.dead, updated=excluded.updated",
    );
    this.db.tx(() => {
      stale.forEach((address, i) => {
        const e = fromExplorer[i];
        const r = (k: number) => (onchain[i * 5 + k].status === "success" ? onchain[i * 5 + k].result : null);
        put.run(
          address,
          e?.name ?? (r(0) as string | null) ?? "?",
          e?.symbol ?? (r(1) as string | null) ?? "?",
          e?.decimals ? Number(e.decimals) : r(2) !== null ? Number(r(2)) : 18,
          e?.icon_url ?? null,
          e?.holders_count ? Number(e.holders_count) : null,
          e?.total_supply ?? (r(3) !== null ? String(r(3)) : "0"),
          r(4) !== null ? String(r(4)) : "0",
          Date.now(),
        );
      });
    });
    return stale.length;
  }

  /**
   * Price anchors beyond GIWA's WETH and our tKRW, found among the tokens pools actually pair with:
   *  - other "Wrapped Ether" contracts count as ETH only when the ETH they hold covers their supply,
   *    so a fake WETH can't price anything;
   *  - "USD Coin"/"Tether USD" tokens used as a quote in at least 3 pools count as one US dollar,
   *    converted at Upbit's KRW-USDT price;
   *  - "Korean Won" tokens count as one won.
   */
  async refreshAnchors() {
    const quotes = this.db.db
      .prepare(
        "SELECT t, count(*) n FROM (SELECT token0 t FROM pool UNION ALL SELECT token1 FROM pool) GROUP BY t HAVING n >= 3 ORDER BY n DESC LIMIT 40",
      )
      .all() as { t: string; n: number }[];
    const next = new Map<string, number>();
    for (const { t } of quotes) {
      const m = this.token(t);
      const name = `${m.name ?? ""} ${m.symbol ?? ""}`;
      if (/wrapped ether|\bweth\b/i.test(name) && t !== WETH) {
        const [bal, supply] = await Promise.all([
          call(() => rpc.getBalance({ address: t as Address }), "anchor").catch(() => 0n),
          call(() => rpc.readContract({ address: t as Address, abi: erc20, functionName: "totalSupply" }), "anchor").catch(() => 1n),
        ]);
        if (supply > 0n && bal * 100n >= supply * 99n) next.set(t, 1);
      } else if (/usd coin|tether|\busdc\b|\busdt\b/i.test(name)) next.set(t, -1); // resolved per build: USD → ETH
      else if (/korean won|\bkrw\b/i.test(name) && t !== this.tkrw) next.set(t, -2); // won → ETH
    }
    this.anchors = next;
  }

  /** V3 pools keep no reserves: what they hold is read for all of them in one multicall. */
  async refreshV3() {
    const pools = this.db.db.prepare("SELECT address, token0, token1 FROM pool WHERE kind = 'v3'").all() as { address: string; token0: string; token1: string }[];
    if (!pools.length) return;
    const res = await call(
      () =>
        rpc.multicall({
          contracts: pools.flatMap((p) => [
            { address: p.token0 as Address, abi: erc20, functionName: "balanceOf", args: [p.address as Address] } as const,
            { address: p.token1 as Address, abi: erc20, functionName: "balanceOf", args: [p.address as Address] } as const,
          ]),
          allowFailure: true,
        }),
      "v3held",
    );
    pools.forEach((p, i) => {
      const b0 = res[2 * i].status === "success" ? (res[2 * i].result as bigint) : 0n;
      const b1 = res[2 * i + 1].status === "success" ? (res[2 * i + 1].result as bigint) : 0n;
      this.v3Balances.set(p.address, { b0, b1, at: Date.now() });
    });
  }

  private v3Held(p: PoolRow) {
    return this.v3Balances.get(p.address) ?? { b0: 0n, b1: 0n, at: 0 };
  }

  private lastPrices = new Map<string, number>();
  private lastPools: PoolRow[] = [];
  private lastDec = new Map<string, number>();

  /**
   * Every trade in a token, oldest first, for its chart: pool swaps (valued by the other side's
   * current price) and 뻥튀기 curve trades. Capped to the most recent 2,000.
   */
  tradesFor(token: string) {
    const out: { at: number; price: number; eth: string; tokens: string; isBuy: boolean; trader: string; venue: string; hash: string }[] = [];
    const dec = (t: string) => this.lastDec.get(t) ?? 18;
    for (const p of this.lastPools) {
      if (p.token0 !== token && p.token1 !== token) continue;
      const other = p.token0 === token ? p.token1 : p.token0;
      const po = this.lastPrices.get(other);
      if (po === undefined) continue;
      const scale = 10 ** (dec(p.token0) - dec(p.token1));
      const rows = this.db.db.prepare("SELECT ts, tx, sender, amount0, amount1, price FROM swap WHERE pool = ? ORDER BY block DESC, log DESC LIMIT 2000").all(p.address) as {
        ts: number;
        tx: string;
        sender: string | null;
        amount0: string;
        amount1: string;
        price: number;
      }[];
      for (const r of rows) {
        const [aT, aO] = p.token0 === token ? [BigInt(r.amount0), BigInt(r.amount1)] : [BigInt(r.amount1), BigInt(r.amount0)];
        const ratio = r.price * scale; // token0 in token1
        const priceInOther = p.token0 === token ? ratio : ratio > 0 ? 1 / ratio : 0;
        const ethVal = Math.abs(Number(formatUnits(aO, dec(other)))) * po;
        out.push({
          at: r.ts,
          price: priceInOther * po,
          eth: BigInt(Math.round(ethVal * 1e18)).toString(),
          tokens: (aT < 0n ? -aT : aT).toString(),
          isBuy: aT < 0n,
          trader: r.sender ?? "",
          venue: p.dex,
          hash: r.tx,
        });
      }
    }
    const trades = this.db.db.prepare("SELECT ts, tx, sender, is_buy, eth, tokens, real_eth, sold FROM trade WHERE token = ? ORDER BY block DESC, log DESC LIMIT 2000").all(token) as {
      ts: number;
      tx: string;
      sender: string | null;
      is_buy: number;
      eth: string;
      tokens: string;
      real_eth: string;
      sold: string;
    }[];
    const c = this.curve(token); // learned by build(), which always runs first
    for (const x of trades) {
      const price = Number(formatUnits(c.virtualEth + BigInt(x.real_eth), 18)) / Number(formatUnits(c.virtualTokens - BigInt(x.sold), 18));
      out.push({ at: x.ts, price, eth: x.eth, tokens: x.tokens, isBuy: !!x.is_buy, trader: x.sender ?? "", venue: "장터 뻥튀기", hash: x.tx });
    }
    return out.sort((a, b) => a.at - b.at).slice(-2000);
  }

  async build(now: number) {
    const ethKrw = await this.rate();
    const pools = this.db.db.prepare("SELECT * FROM pool").all() as unknown as PoolRow[];
    const launches = await this.pump.launches();
    for (const l of launches) {
      const c = this.pump.curves.find((x) => x.address === l.pump);
      if (c) this.curveOfToken.set(l.token, c);
    }
    const tokenSet = new Set<string>();
    for (const p of pools) tokenSet.add(p.token0), tokenSet.add(p.token1);
    for (const l of launches) tokenSet.add(l.token);
    const meta = new Map<string, TokenRow>();
    for (const t of tokenSet) meta.set(t, this.token(t));
    const dec = (t: string) => meta.get(t)?.decimals ?? 18;

    // Pool reserves in whole-token units.
    const held = new Map<string, [number, number]>();
    for (const p of pools) {
      if (p.kind === "v2") held.set(p.address, [Number(formatUnits(BigInt(p.r0), dec(p.token0))), Number(formatUnits(BigInt(p.r1), dec(p.token1)))]);
      else {
        const b = this.v3Held(p);
        held.set(p.address, [Number(formatUnits(b.b0, dec(p.token0))), Number(formatUnits(b.b1, dec(p.token1)))]);
      }
    }
    // Spot price of token0 in token1 (whole units), per pool.
    const spot = (p: PoolRow) => {
      if (p.kind === "v2") {
        const [a, b] = held.get(p.address)!;
        return a > 0 ? b / a : 0;
      }
      const sp = Number(p.sqrt_price) / 2 ** 96;
      return sp * sp * 10 ** (dec(p.token0) - dec(p.token1));
    };

    // Prices in ETH: anchored on WETH and tKRW, then carried across the deepest pools.
    const price = new Map<string, number>([[WETH, 1], [this.tkrw, 1 / ethKrw]]);
    const usdKrw = this.usdKrw || 1400;
    for (const [t, v] of this.anchors) price.set(t, v === 1 ? 1 : v === -1 ? usdKrw / ethKrw : 1 / ethKrw);
    const anchored = new Set(price.keys());
    const via = new Map<string, number>(); // liquidity (ETH) of the pool that priced each token
    const viaPool = new Map<string, string>();
    for (let pass = 0; pass < 4; pass++) {
      for (const p of pools) {
        const s = spot(p);
        if (!s) continue;
        const [h0, h1] = held.get(p.address)!;
        for (const [known, other, knownHeld, conv] of [
          [p.token1, p.token0, h1, (x: number) => x * s],
          [p.token0, p.token1, h0, (x: number) => x / s],
        ] as const) {
          const pk = price.get(known);
          if (pk === undefined || anchored.has(other)) continue;
          const liq = knownHeld * pk;
          if (liq < MIN_PRICING_LIQ || liq <= (via.get(other) ?? 0)) continue;
          price.set(other, conv(pk));
          via.set(other, liq);
          viaPool.set(other, p.address);
        }
      }
    }
    // Tokens still on a 뻥튀기 curve take the curve's price.
    const curveOf = new Map<string, { progress: number; price: number }>();
    for (const l of launches) {
      if (l.graduated) continue;
      const cv = this.curve(l.token);
      const p = Number(formatUnits(cv.virtualEth + l.realEth, 18)) / Number(formatUnits(cv.virtualTokens - l.sold, 18));
      curveOf.set(l.token, { progress: Number((l.realEth * 10_000n) / cv.threshold) / 100, price: p });
      price.set(l.token, p);
    }

    // Per-token aggregates from pools and swaps.
    const out = new Map<string, MarketToken>();
    const since24 = now - DAY;
    const get = (t: string) => {
      if (!out.has(t)) {
        const m = meta.get(t)!;
        const name = m.name ?? "?";
        const symbol = m.symbol ?? "?";
        out.set(t, {
          address: t,
          name,
          symbol,
          decimals: m.decimals ?? 18,
          // Icons stored before the move to jangteo.org still name the retired gye.rygroup.asia.
          icon: m.icon ? m.icon.replace(/^https:\/\/gye\.rygroup\.asia\//, "https://jangteo.org/") : m.icon,
          holders: m.holders,
          priceEth: null,
          priceKrw: null,
          change24h: null,
          change7d: null,
          mcapKrw: null,
          fdvKrw: null,
          liquidityKrw: 0,
          volume24hKrw: 0,
          trades24h: 0,
          spark: [],
          venues: [],
          curve: null,
          graduated: false,
          createdAt: null,
          anchor: anchored.has(t),
          suspicious: /https?:|www\.|\.(com|xyz|fun|io|net|org)\b|t\.me/i.test(`${name} ${symbol}`),
        });
      }
      return out.get(t)!;
    };
    const vol = this.db.db.prepare("SELECT amount0, amount1, ts FROM swap WHERE pool = ? AND ts >= ?");
    const series = new Map<string, { t: number; p: number }[]>();
    // Every pool the aggregator can route through: [pool, kind, fee, token0, token1, liquidity ETH, dex].
    const routes: [string, number, number, string, string, number, string][] = [];
    const how = new Map<string, { kind: number; fee: number } | null>();
    for (const p of pools) {
      const [h0, h1] = held.get(p.address)!;
      const p0 = price.get(p.token0);
      const p1 = price.get(p.token1);
      const liqEth = (p0 !== undefined ? h0 * p0 : 0) + (p1 !== undefined ? h1 * p1 : 0);
      if (!how.has(p.factory)) how.set(p.factory, routeOf(this.db, p.factory));
      const r = how.get(p.factory);
      if (r && liqEth >= 0.0001) routes.push([p.address, r.kind, r.fee, p.token0, p.token1, Number(liqEth.toPrecision(4)), p.dex]);
      const swaps = vol.all(p.address, since24) as { amount0: string; amount1: string; ts: number }[];
      let volEth = 0;
      for (const s of swaps) {
        // Value each swap by whichever side has a price, taking what went into the pool.
        const a0 = Math.abs(Number(formatUnits(BigInt(s.amount0), dec(p.token0))));
        const a1 = Math.abs(Number(formatUnits(BigInt(s.amount1), dec(p.token1))));
        volEth += p1 !== undefined ? a1 * p1 : p0 !== undefined ? a0 * p0 : 0;
      }
      for (const t of [p.token0, p.token1]) {
        if (t === WETH || t === this.tkrw) continue;
        const m = get(t);
        m.liquidityKrw += liqEth * ethKrw;
        m.volume24hKrw += volEth * ethKrw;
        m.trades24h += swaps.length;
        m.venues.push({ dex: p.dex, pool: p.address, kind: p.kind, liquidityKrw: liqEth * ethKrw, quote: t === p.token0 ? p.token1 : p.token0 });
      }
      // Price history of each side, in ETH, from the swap prices of the pool that prices it.
      // Only the pool that prices a token feeds its history; skip the query for every other pool.
      const feeds = [p.token0, p.token1].some((t) => viaPool.get(t) === p.address && !curveOf.has(t));
      const all = feeds
        ? (this.db.db.prepare("SELECT ts, price FROM swap WHERE pool = ? AND ts >= ? ORDER BY block, log").all(p.address, now - 8 * DAY) as { ts: number; price: number }[])
        : [];
      const scale = 10 ** (dec(p.token0) - dec(p.token1)); // raw ratio → whole-unit price of token0 in token1
      for (const [t, other, toEth] of [
        [p.token0, p.token1, (r: number) => r * scale * (p1 ?? 0)],
        [p.token1, p.token0, (r: number) => (r > 0 ? (1 / (r * scale)) * (p0 ?? 0) : 0)],
      ] as const) {
        if (price.get(other) === undefined || t === WETH || t === this.tkrw) continue;
        if (viaPool.get(t) === p.address && !curveOf.has(t)) {
          const pts = series.get(t) ?? [];
          for (const x of all) if (x.price > 0) pts.push({ t: x.ts, p: toEth(x.price) });
          series.set(t, pts);
        }
      }
    }
    // Curve trades: price after each trade, volume, and a venue of their own.
    const trades = this.db.db.prepare("SELECT token, ts, eth, real_eth, sold FROM trade WHERE ts >= ? ORDER BY block, log").all(now - 8 * DAY) as {
      token: string;
      ts: number;
      eth: string;
      real_eth: string;
      sold: string;
    }[];
    for (const x of trades) {
      const m = get(x.token);
      const cv = this.curve(x.token);
      const p = Number(formatUnits(cv.virtualEth + BigInt(x.real_eth), 18)) / Number(formatUnits(cv.virtualTokens - BigInt(x.sold), 18));
      const pts = series.get(x.token) ?? [];
      pts.push({ t: x.ts, p });
      series.set(x.token, pts);
      if (x.ts >= since24) {
        m.volume24hKrw += Number(formatUnits(BigInt(x.eth), 18)) * ethKrw;
        m.trades24h++;
      }
    }
    for (const l of launches) {
      const m = get(l.token);
      m.createdAt = l.createdAt;
      m.graduated = l.graduated;
      const c = curveOf.get(l.token);
      if (c) {
        m.curve = { progress: c.progress };
        m.liquidityKrw += Number(formatUnits(l.realEth, 18)) * ethKrw;
        m.venues.unshift({ dex: "장터 뻥튀기", pool: l.pump, kind: "curve", liquidityKrw: Number(formatUnits(l.realEth, 18)) * ethKrw, quote: WETH });
      }
    }

    // Price, market cap, change, sparkline.
    for (const [t, m] of out) {
      const pe = price.get(t);
      m.venues.sort((a, b) => b.liquidityKrw - a.liquidityKrw);
      if (pe === undefined) continue;
      m.priceEth = pe;
      m.priceKrw = pe * ethKrw;
      const row = meta.get(t)!;
      const supply = Number(formatUnits(BigInt(row.supply ?? "0"), m.decimals));
      const burned = Number(formatUnits(BigInt(row.dead ?? "0"), m.decimals));
      m.fdvKrw = m.priceKrw * supply;
      m.mcapKrw = m.priceKrw * Math.max(0, supply - burned);
      const pts = (series.get(t) ?? []).sort((a, b) => a.t - b.t);
      pts.push({ t: now, p: pe });
      const at = (ts: number) => {
        let v: number | null = null;
        for (const x of pts) if (x.t <= ts) v = x.p;
        return v ?? pts[0].p;
      };
      const d1 = at(now - DAY);
      const d7 = at(now - 7 * DAY);
      m.change24h = d1 ? (pe - d1) / d1 : null;
      m.change7d = d7 ? (pe - d7) / d7 : null;
      // Seven days, or the token's whole life when it is younger: a new token still draws a shape.
      const startT = Math.max(now - 7 * DAY, pts[0].t);
      for (let k = 0; k <= 48; k++) m.spark.push(at(startT + ((now - startT) * k) / 48));
    }

    // Each wallet's flows per token, for profit and loss (valued in won at today's ETH rate).
    const flows: Record<string, Record<string, { spentKrw: number; receivedKrw: number; bought: number; sold: number }>> = {};
    const flow = (w: string, t: string) => ((flows[w.toLowerCase()] ??= {})[t] ??= { spentKrw: 0, receivedKrw: 0, bought: 0, sold: 0 });
    const poolById = new Map(pools.map((p) => [p.address, p]));
    const swapRows = this.db.db.prepare("SELECT pool, sender, amount0, amount1 FROM swap WHERE sender IS NOT NULL AND sender != ''").all() as { pool: string; sender: string; amount0: string; amount1: string }[];
    for (const s of swapRows) {
      const p = poolById.get(s.pool);
      if (!p) continue;
      for (const [t, other, at, ao] of [
        [p.token0, p.token1, BigInt(s.amount0), BigInt(s.amount1)],
        [p.token1, p.token0, BigInt(s.amount1), BigInt(s.amount0)],
      ] as const) {
        if (t === WETH || t === this.tkrw) continue;
        const po = price.get(other);
        if (po === undefined) continue;
        const amt = Math.abs(Number(formatUnits(at, dec(t))));
        const val = Math.abs(Number(formatUnits(ao, dec(other)))) * po * ethKrw;
        const f = flow(s.sender, t);
        if (at < 0n) (f.bought += amt), (f.spentKrw += val); // tokens left the pool: the sender bought
        else (f.sold += amt), (f.receivedKrw += val);
      }
    }
    const tradeRows = this.db.db.prepare("SELECT token, sender, is_buy, eth, tokens FROM trade WHERE sender IS NOT NULL AND sender != ''").all() as {
      token: string;
      sender: string;
      is_buy: number;
      eth: string;
      tokens: string;
    }[];
    for (const x of tradeRows) {
      const f = flow(x.sender, x.token);
      const eth = Number(formatUnits(BigInt(x.eth), 18)) * ethKrw;
      const amt = Number(formatUnits(BigInt(x.tokens), 18));
      if (x.is_buy) (f.bought += amt), (f.spentKrw += eth);
      else (f.sold += amt), (f.receivedKrw += eth * 0.99);
    }

    this.lastPrices = price;
    this.lastPools = pools;
    this.lastDec = new Map([...meta].map(([k, v]) => [k, v.decimals ?? 18]));
    const tokens = [...out.values()].sort((a, b) => (b.mcapKrw ?? -1) - (a.mcapKrw ?? -1));
    return {
      updatedAt: now,
      ethKrw,
      block: this.db.cursor("live") ?? 0,
      totals: {
        tokens: tokens.length,
        pools: pools.length,
        dexes: new Set(pools.map((p) => p.dex)).size + 1,
        liquidityKrw: tokens.reduce((s, t) => s + t.liquidityKrw, 0),
        volume24hKrw: tokens.reduce((s, t) => s + t.volume24hKrw, 0),
      },
      tokens,
      flows,
      routes,
    };
  }
}
