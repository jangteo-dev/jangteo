import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { formatEther, maxUint256, parseAbi, parseEther, type Address, type Hex } from "viem";
import { explorerTx, giwa, reason, write } from "../chain.ts";
import { config, gyeDeployment } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import { oracleAbi, STOCKS, stocksAbi, stocksAddresses, symId } from "./catalog.ts";
import { readFeed, type Quote } from "./feed.ts";

/**
 * 장터 주식 ops:
 *   stocks:oracle  posts live prices (reporter key) every 15 s; closed markets get a closing price
 *                  every 30 min so the board and the vault always know the last price
 *   stocks:index   stocks.json + stocks/<sym>.json (candles, tape) for the web, every 30 s
 *   stocks:seed    team wallets add their daily test won to the vault (protocol-owned liquidity)
 */

let db: DatabaseSync | null = null;
export function stocksDb(): DatabaseSync {
  if (db) return db;
  const path = resolve(config.dataDir, "stocks.sqlite");
  mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS tick (sym TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY (sym, t));
    CREATE TABLE IF NOT EXISTS lp (t INTEGER PRIMARY KEY, price REAL NOT NULL, nav REAL NOT NULL, cash REAL NOT NULL, liability REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS trade (block INTEGER NOT NULL, log INTEGER NOT NULL, tx TEXT NOT NULL, t INTEGER NOT NULL, sym TEXT NOT NULL,
      side TEXT NOT NULL, who TEXT NOT NULL, krw REAL NOT NULL, shares REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL, PRIMARY KEY (block, log));
    CREATE TABLE IF NOT EXISTS daily (sym TEXT NOT NULL, t INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, PRIMARY KEY (sym, t));
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intra (sym TEXT NOT NULL, size INTEGER NOT NULL, t INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, PRIMARY KEY (sym, size, t));
  `);
  return db;
}
const kvGet = (k: string) => (stocksDb().prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
const kvSet = (k: string, v: string) => stocksDb().prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);

const CLOSED_EVERY = 30 * 60;

/** Which quotes go on-chain this pass: every open market, and closed ones every 30 min or on close. */
export function toPost(quotes: Quote[], last: Record<string, { open: boolean; at: number }>, now: number): Quote[] {
  return quotes.filter((q) => {
    const l = last[q.sym];
    if (q.open) return true;
    if (!l) return true; // never posted
    if (l.open) return true; // the market just closed: say so at once
    return now - l.at >= CLOSED_EVERY;
  });
}

export function stocksOracleTask(reporter: { address: Address; key: Hex }, store: Store): Task {
  return {
    id: "stocks:oracle",
    title: "📈 Stock prices",
    everyMs: 15_000,
    jitterMs: 2_000,
    timeoutMs: 60_000,
    lane: `giwa:${reporter.address}`,
    async run(): Promise<TaskResult> {
      const a = stocksAddresses();
      if (!a) return { summary: "Stocks not deployed", nextAt: Date.now() + 30 * 60_000 };
      const now = Math.floor(Date.now() / 1000);
      const feed = await readFeed(now);
      const last = store.get<Record<string, { open: boolean; at: number }>>("stocks:posted") ?? {};
      const post = toPost(feed.quotes, last, now);
      const ins = stocksDb().prepare("INSERT OR REPLACE INTO tick (sym, t, price) VALUES (?, ?, ?)");
      for (const q of feed.quotes) if (q.open) ins.run(q.sym, now, q.priceNum);
      // Remembered for the board even while a market is closed.
      store.set("stocks:quotes", Object.fromEntries(feed.quotes.map((q) => [q.sym, { ...q, price: q.price.toString() }])));
      if (feed.skipped.length) store.set("stocks:skipped", { at: now, list: feed.skipped });
      if (!post.length) return { summary: `nothing to post · ${feed.skipped.length} skipped` };
      const { hash } = await write({
        key: reporter.key,
        address: a.stockOracle,
        abi: oracleAbi,
        functionName: "post",
        args: [post.map((q) => symId(q.sym)), post.map((q) => q.price), post.map((q) => q.open)],
      });
      for (const q of post) last[q.sym] = { open: q.open, at: now };
      store.set("stocks:posted", last);
      const open = post.filter((q) => q.open).length;
      return {
        summary: `posted ${post.length} (${open} open)${feed.skipped.length ? ` · skipped ${feed.skipped.map((s) => `${s.sym}: ${s.why}`).join("; ")}` : ""} ${explorerTx(hash)}`,
      };
    },
  };
}

// ──────────────────────────────── index ────────────────────────────────

const won = (v: bigint) => Number(formatEther(v));
const DAY = 86_400;

type Candle = { time: number; open: number; high: number; low: number; close: number };
/** Buckets ticks into OHLC candles of `size` seconds. */
export function candles(ticks: { t: number; price: number }[], size: number): Candle[] {
  const out: Candle[] = [];
  for (const k of ticks) {
    const time = Math.floor(k.t / size) * size;
    const c = out[out.length - 1];
    if (c && c.time === time) {
      c.high = Math.max(c.high, k.price);
      c.low = Math.min(c.low, k.price);
      c.close = k.price;
    } else out.push({ time, open: k.price, high: k.price, low: k.price, close: k.price });
  }
  return out;
}

async function refreshDaily(fx: number) {
  const at = Number(kvGet("daily:at") ?? 0);
  if (Date.now() / 1000 - at < 6 * 3600) return;
  const put = stocksDb().prepare("INSERT OR REPLACE INTO daily (sym, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)");
  for (const s of STOCKS) {
    try {
      const j = (await (
        await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s.yahoo}?interval=1d&range=1y`, {
          headers: { "user-agent": "Mozilla/5.0 (jangteo-ops)" },
          signal: AbortSignal.timeout(15_000),
        })
      ).json()) as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] } }[] } };
      const r = j.chart?.result?.[0];
      const q = r?.indicators?.quote?.[0];
      if (!r?.timestamp || !q) continue;
      // US history is shown in won at today's rate: the chart's shape is right, older levels approximate.
      const k = s.region === 1 ? fx : 1;
      r.timestamp.forEach((t, i) => {
        if (q.open[i] == null || q.close[i] == null) return;
        put.run(s.sym, Math.floor(t / DAY) * DAY, q.open[i]! * k, q.high[i]! * k, q.low[i]! * k, q.close[i]! * k);
      });
    } catch {
      /* next refresh */
    }
  }
  kvSet("daily:at", String(Math.floor(Date.now() / 1000)));
}

/**
 * Intraday candles from the exchange's own history (Yahoo: 1m for a day, 5m for five days, 1h for a
 * month), so a chart is full from the first visit. Our oracle ticks replace them wherever we have
 * our own prices (those are the prices people actually traded at).
 */
async function refreshIntraday(fx: number) {
  const at = Number(kvGet("intra:at") ?? 0);
  if (Date.now() / 1000 - at < 10 * 60) return;
  const put = stocksDb().prepare("INSERT OR REPLACE INTO intra (sym, size, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const s of STOCKS) {
    const k = s.region === 1 ? fx : 1;
    for (const [interval, range, size] of [["1m", "1d", 60], ["5m", "5d", 300], ["60m", "1mo", 3600]] as const) {
      try {
        const j = (await (
          await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s.yahoo}?interval=${interval}&range=${range}`, {
            headers: { "user-agent": "Mozilla/5.0 (jangteo-ops)" },
            signal: AbortSignal.timeout(15_000),
          })
        ).json()) as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] } }[] } };
        const r = j.chart?.result?.[0];
        const q = r?.indicators?.quote?.[0];
        if (!r?.timestamp || !q) continue;
        r.timestamp.forEach((t, i) => {
          if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
          put.run(s.sym, size, Math.floor(t / size) * size, q.open[i]! * k, q.high[i]! * k, q.low[i]! * k, q.close[i]! * k);
        });
      } catch {
        /* next refresh */
      }
    }
  }
  stocksDb().prepare("DELETE FROM intra WHERE t < ?").run(Math.floor(Date.now() / 1000) - 40 * DAY);
  kvSet("intra:at", String(Math.floor(Date.now() / 1000)));
}

/** Exchange candles where we have no ticks, our own tick candles wherever we do. */
export function mergeCandles(exchange: Candle[], ours: Candle[]): Candle[] {
  const m = new Map(exchange.map((c) => [c.time, c]));
  for (const c of ours) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

const tradeAbi = stocksAbi.filter((x) => x.type === "event" && (x.name === "Bought" || x.name === "Sold"));
const lpAbi = stocksAbi.filter((x) => x.type === "event" && (x.name === "Deposited" || x.name === "Withdrawn"));

async function syncTrades(addr: Address) {
  // One read for both: a block number from one RPC node can be unknown to the next one asked.
  const top = await giwa.getBlock();
  const head = top.number;
  const headTs = Number(top.timestamp);
  let from = BigInt(kvGet("trades:block") ?? "0");
  if (from === 0n) from = head - 200_000n; // the exchange is younger than this
  const put = stocksDb().prepare("INSERT OR IGNORE INTO trade (block, log, tx, t, sym, side, who, krw, shares, price, fee) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  while (from <= head) {
    const to = from + 9_999n > head ? head : from + 9_999n;
    const logs = await giwa.getLogs({ address: addr, events: tradeAbi, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const t = headTs - Number(head - l.blockNumber); // 1-second blocks
      const a = l.args as Record<string, unknown>;
      const sym = Buffer.from((a.sym as string).slice(2), "hex").toString("utf8").replace(/\0+$/, "");
      if (l.eventName === "Bought") put.run(Number(l.blockNumber), l.logIndex, l.transactionHash, t, sym, "buy", (a.buyer as string).toLowerCase(), won(a.krwIn as bigint), won(a.shares as bigint), won(a.price as bigint), won(a.fee as bigint));
      else put.run(Number(l.blockNumber), l.logIndex, l.transactionHash, t, sym, "sell", (a.seller as string).toLowerCase(), won(a.krwOut as bigint), won(a.shares as bigint), won(a.price as bigint), won(a.fee as bigint));
    }
    from = to + 1n;
  }
  kvSet("trades:block", String(head - 30n)); // re-read a little: a lagging node may have missed the newest blocks
}

function publish(name: string, data: unknown) {
  const out = resolve(config.webroot, name);
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(`${out}.tmp`, JSON.stringify(data));
  renameSync(`${out}.tmp`, out);
}

export function stocksIndexTask(store: Store): Task {
  return {
    id: "stocks:index",
    title: "Stocks board",
    everyMs: 30_000,
    jitterMs: 3_000,
    timeoutMs: 3 * 60_000,
    lane: "stocks:index",
    async run(): Promise<TaskResult> {
      const a = stocksAddresses();
      if (!a) return { summary: "Stocks not deployed", nextAt: Date.now() + 30 * 60_000 };
      const ex = a.stocks;
      const now = Math.floor(Date.now() / 1000);
      const quotes = store.get<Record<string, Quote & { price: string }>>("stocks:quotes") ?? {};
      const fx = quotes.NVDA ? quotes.NVDA.priceNum / quotes.NVDA.local : 0;
      if (fx) {
        await refreshDaily(fx);
        await refreshIntraday(fx);
      }
      await syncTrades(ex);
      const [cash, liability, nav, lpPrice, supply, tradeBps, protoBps] = await Promise.all([
        giwa.readContract({ address: ex, abi: stocksAbi, functionName: "cash" }),
        giwa.readContract({ address: ex, abi: stocksAbi, functionName: "liability" }),
        giwa.readContract({ address: ex, abi: stocksAbi, functionName: "nav" }),
        giwa.readContract({ address: ex, abi: stocksAbi, functionName: "lpPrice" }),
        giwa.readContract({ address: ex, abi: stocksAbi, functionName: "totalSupply" }),
        giwa.readContract({ address: ex, abi: stocksAbi, functionName: "tradeBps" }),
        giwa.readContract({ address: ex, abi: stocksAbi, functionName: "protocolShareBps" }),
      ]);
      const lastLp = Number(kvGet("lp:at") ?? 0);
      if (now - lastLp >= 600) {
        stocksDb().prepare("INSERT OR REPLACE INTO lp (t, price, nav, cash, liability) VALUES (?, ?, ?, ?, ?)").run(now, won(lpPrice), won(nav), won(cash), won(liability));
        kvSet("lp:at", String(now));
      }
      const d = stocksDb();
      const lpShare = 1 - Number(protoBps) / 10_000;
      const fees7 = (d.prepare("SELECT COALESCE(SUM(fee), 0) AS f FROM trade WHERE t >= ?").get(now - 7 * DAY) as { f: number }).f * lpShare;
      const vol24 = (d.prepare("SELECT COALESCE(SUM(krw), 0) AS v FROM trade WHERE t >= ?").get(now - DAY) as { v: number }).v;
      const markets = [];
      for (const s of STOCKS) {
        const [q, m] = await Promise.all([
          giwa.readContract({ address: ex, abi: stocksAbi, functionName: "quoteOf", args: [symId(s.sym)] }),
          giwa.readContract({ address: ex, abi: stocksAbi, functionName: "marketOf", args: [symId(s.sym)] }),
        ]);
        const supplyTok = await giwa.readContract({ address: m.token, abi: parseAbi(["function totalSupply() view returns (uint256)"]), functionName: "totalSupply" });
        const live = quotes[s.sym];
        const v24 = (d.prepare("SELECT COALESCE(SUM(krw), 0) AS v, COUNT(*) AS n FROM trade WHERE sym = ? AND t >= ?").get(s.sym, now - DAY) as { v: number; n: number });
        markets.push({
          sym: s.sym,
          region: s.region,
          name: s.name,
          nameKo: s.nameKo,
          ticker: s.ticker,
          token: m.token,
          price: won(q[0]),
          updatedAt: Number(q[1]),
          tradable: q[2],
          buyRoom: won(q[3]),
          buyPaused: m.buyPaused,
          open: live?.open ?? false,
          local: live?.local ?? 0,
          prevClose: live?.prevClose ?? 0,
          changePct: live?.changePct ?? 0,
          supply: won(supplyTok),
          exposure: (won(supplyTok) * won(q[0])),
          volume: won(m.volume),
          vol24: v24.v,
          trades24: v24.n,
        });
        const ticks = d.prepare("SELECT t, price FROM tick WHERE sym = ? AND t >= ? ORDER BY t").all(s.sym, now - 14 * DAY) as { t: number; price: number }[];
        const daily = d.prepare("SELECT t AS time, o AS open, h AS high, l AS low, c AS close FROM daily WHERE sym = ? ORDER BY t").all(s.sym) as Candle[];
        const tape = d.prepare("SELECT tx, t, side, who, krw, shares, price FROM trade WHERE sym = ? ORDER BY block DESC, log DESC LIMIT 50").all(s.sym);
        const ex_ = (size: number, since: number) =>
          d.prepare("SELECT t AS time, o AS open, h AS high, l AS low, c AS close FROM intra WHERE sym = ? AND size = ? AND t >= ? ORDER BY t").all(s.sym, size, since) as Candle[];
        publish(`stocks/${s.sym}.json`, {
          updatedAt: now,
          m1: mergeCandles(ex_(60, now - 2 * DAY), candles(ticks.filter((k) => k.t >= now - 2 * DAY), 60)),
          m5: mergeCandles(ex_(300, now - 7 * DAY), candles(ticks.filter((k) => k.t >= now - 7 * DAY), 300)),
          h1: mergeCandles(ex_(3600, now - 30 * DAY), candles(ticks, 3600)),
          d1: daily,
          tape,
        });
      }
      publish("stocks/wallets.json", { updatedAt: now, wallets: positions(d.prepare("SELECT who, sym, side, krw, shares FROM trade ORDER BY block, log").all() as PosRow[]) });
      const lpHist = d.prepare("SELECT t, price, nav FROM lp WHERE t >= ? ORDER BY t").all(now - 90 * DAY);
      const tape = d.prepare("SELECT tx, t, sym, side, who, krw, shares, price FROM trade ORDER BY block DESC, log DESC LIMIT 30").all();
      const nNav = won(nav);
      publish("stocks.json", {
        updatedAt: now,
        fx,
        tradeBps: Number(tradeBps),
        lpShare,
        markets,
        vault: {
          cash: won(cash),
          liability: won(liability),
          nav: nNav,
          lpPrice: won(lpPrice),
          supply: won(supply),
          utilisation: won(cash) ? won(liability) / won(cash) : 0,
          fees7d: fees7,
          apr: nNav ? (fees7 / nNav) * (365 / 7) * 100 : 0,
          vol24,
          history: lpHist,
        },
        tape,
      });
      const open = markets.filter((m) => m.tradable).length;
      return { summary: `${open}/${markets.length} tradable · vault ₩${Math.round(nNav).toLocaleString("en")} · 24h ₩${Math.round(vol24).toLocaleString("en")}` };
    },
  };
}

type PosRow = { who: string; sym: string; side: string; krw: number; shares: number };
/**
 * Average-cost positions per wallet from Jangteo trades: a buy adds its won (fee included) and
 * shares; a sell takes away cost in proportion to the shares sold. Tokens moved between wallets
 * aren't trades, so a receiver's cost is unknown (shown as such).
 */
export function positions(rows: PosRow[]): Record<string, Record<string, { shares: number; cost: number }>> {
  const out: Record<string, Record<string, { shares: number; cost: number }>> = {};
  for (const r of rows) {
    const w = (out[r.who] ??= {});
    const p = (w[r.sym] ??= { shares: 0, cost: 0 });
    if (r.side === "buy") {
      p.shares += r.shares;
      p.cost += r.krw;
    } else {
      const f = p.shares > 0 ? Math.min(1, r.shares / p.shares) : 1;
      p.cost -= p.cost * f;
      p.shares = Math.max(0, p.shares - r.shares);
    }
    if (p.shares < 1e-12) delete w[r.sym];
  }
  return out;
}

// ───────────────────────────────── seed ────────────────────────────────

const SEED_CAP = parseEther("50000000");
const erc = parseAbi(["function drip()", "function lastDrip(address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);

/**
 * Protocol-owned liquidity: each team wallet draws its free daily test won and adds it to the
 * vault until the vault holds ₩50M. Team wallets are never ranked for points.
 */
export function stocksSeedTask(wallets: { label: string; address: Address; key: Hex }[]): Task {
  return {
    id: "stocks:seed",
    title: "Stocks vault seed",
    everyMs: 60 * 60_000,
    jitterMs: 5 * 60_000,
    timeoutMs: 10 * 60_000,
    lane: "stocks:seed",
    async run(): Promise<TaskResult> {
      const a = stocksAddresses();
      const tkrw = gyeDeployment()?.tkrw;
      if (!a || !tkrw) return { summary: "Stocks not deployed", nextAt: Date.now() + 6 * 3600_000 };
      const nav = await giwa.readContract({ address: a.stocks, abi: stocksAbi, functionName: "nav" });
      if (nav >= SEED_CAP) return { summary: `vault at ₩${formatEther(nav)}: seeding done` };
      const now = Math.floor(Date.now() / 1000);
      const done: string[] = [];
      for (const w of wallets) {
        try {
          const last = await giwa.readContract({ address: tkrw, abi: erc, functionName: "lastDrip", args: [w.address] });
          if (last !== 0n && now < Number(last) + DAY) continue;
          const before = await giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [w.address] });
          await write({ key: w.key, address: tkrw, abi: erc, functionName: "drip" });
          // GIWA reads can trail a write by a block: wait until the drip shows before depositing it.
          for (let i = 0; i < 20; i++) {
            if ((await giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [w.address] })) >= before + parseEther("1000000")) break;
            await new Promise((r) => setTimeout(r, 1500));
          }
          const allowance = await giwa.readContract({ address: tkrw, abi: erc, functionName: "allowance", args: [w.address, a.stocks] });
          if (allowance < parseEther("1000000")) await write({ key: w.key, address: tkrw, abi: erc, functionName: "approve", args: [a.stocks, maxUint256] });
          const { hash } = await write({ key: w.key, address: a.stocks, abi: stocksAbi, functionName: "deposit", args: [parseEther("1000000"), 0n] });
          done.push(`${w.label} +₩1,000,000 ${explorerTx(hash)}`);
        } catch (err) {
          done.push(`${w.label}: ${reason(err).slice(0, 80)}`);
        }
      }
      return { summary: done.length ? done.join("\n") : "every team wallet already seeded today" };
    },
  };
}

// ──────────────────────────────── verify ───────────────────────────────

/** Keeps the 16 j-tokens (created by the exchange) verified on GIWA's explorer. */
export function stocksVerifyTask(store: Store): Task {
  return {
    id: "stocks:verify",
    title: "Stock token verification",
    everyMs: 60 * 60_000,
    jitterMs: 60_000,
    timeoutMs: 20 * 60_000,
    lane: "forge",
    async run(): Promise<TaskResult> {
      const a = stocksAddresses();
      if (!a) return { summary: "Stocks not deployed" };
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { encodeAbiParameters } = await import("viem");
      const exec = promisify(execFile);
      const done = new Set(store.get<string[]>("stocks:verified") ?? []);
      const out: string[] = [];
      for (const s of STOCKS) {
        const m = await giwa.readContract({ address: a.stocks, abi: stocksAbi, functionName: "marketOf", args: [symId(s.sym)] });
        const t = m.token.toLowerCase();
        if (done.has(t)) continue;
        const name = `Jangteo ${s.name}`;
        const args = encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "bytes32" }], [name, s.ticker, symId(s.sym)]);
        try {
          await exec(
            "forge",
            ["verify-contract", m.token, "src/stocks/StockToken.sol:StockToken", "--verifier", "blockscout", "--verifier-url", "https://sepolia-explorer.giwa.io/api/", "--constructor-args", args, "--watch"],
            { cwd: resolve(config.root, "../contracts"), timeout: 180_000 },
          );
          done.add(t);
          out.push(`verified ${s.ticker}`);
        } catch (err) {
          const msg = reason(err);
          if (/already verified/i.test(msg)) done.add(t);
          else out.push(`${s.ticker}: ${msg.slice(0, 80)}`);
        }
      }
      store.set("stocks:verified", [...done]);
      return { summary: out.length ? out.join("\n") : `all ${done.size} stock tokens verified` };
    },
  };
}
