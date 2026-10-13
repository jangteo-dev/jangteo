import { parseEther, parseUnits } from "viem";
import { STOCKS, type Stock } from "./catalog.ts";

/**
 * Live stock prices for 장터 주식. Naver Finance is the source (it reports Korean prices through
 * KRX and Nextrade sessions, US prices in the regular session, and whether each market is open);
 * Yahoo Finance is the second opinion. A price is used only if both agree.
 */

const UA = { "user-agent": "Mozilla/5.0 (jangteo-ops)" };
const NAVER = "https://polling.finance.naver.com/api/realtime";

export interface Quote {
  sym: string;
  price: bigint; // tKRW wei per share
  priceNum: number; // the same, in won (display only)
  local: number; // in the stock's own currency
  prevClose: number; // own currency
  changePct: number;
  open: boolean;
  tradedAt: number; // unix seconds, from the source
}

/** "1,608,000" → "1608000"; "-0.52" stays. Anything that isn't a plain decimal → null. */
export function cleanNum(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/,/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

/** Won price → wei. US: dollars × won per dollar, kept exact to 6 decimals each. */
export function toWei(local: string, region: 0 | 1, usdKrw?: string): bigint {
  if (region === 0) return parseEther(local);
  if (!usdKrw) throw new Error("no USD/KRW rate");
  return parseUnits(local, 6) * parseUnits(usdKrw, 6) * 10n ** 6n;
}

/** Two quotes agree if they are within `tolBps` of each other. */
export function agree(a: number, b: number, tolBps: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  return (Math.abs(a - b) * 10_000) / Math.min(a, b) <= tolBps;
}

interface NaverItem {
  itemCode?: string;
  reutersCode?: string;
  closePrice?: string;
  compareToPreviousClosePrice?: string;
  fluctuationsRatio?: string;
  marketStatus?: string;
  localTradedAt?: string;
  tradeStopType?: { name?: string };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function naver(kind: "domestic" | "worldstock", codes: string[]): Promise<Map<string, NaverItem>> {
  const j = await getJson<{ datas?: NaverItem[] }>(`${NAVER}/${kind}/stock/${codes.join(",")}`);
  return new Map((j.datas ?? []).map((d) => [(d.itemCode ?? d.reutersCode)!, d]));
}

/** USD/KRW from Naver, checked against Yahoo's KRW=X (they must agree within 1%). */
export async function usdKrw(): Promise<string> {
  const [n, y] = await Promise.all([
    getJson<{ result?: { closePrice?: string } }>("https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW"),
    getJson<{ chart?: { result?: { meta?: { regularMarketPrice?: number } }[] } }>("https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1d&range=1d").catch(() => null),
  ]);
  const nv = cleanNum(n.result?.closePrice);
  if (!nv) throw new Error("Naver USD/KRW unreadable");
  const yv = y?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (yv !== undefined && !agree(Number(nv), yv, 100)) throw new Error(`USD/KRW sources disagree: Naver ${nv}, Yahoo ${yv}`);
  return Number(nv).toFixed(4);
}

/** Yahoo's last price per symbol, and whether Yahoo itself sees the regular session running. */
export async function yahoo(symbols: string[]): Promise<Map<string, { price: number; at: number }>> {
  const j = await getJson<{ spark?: { result?: { symbol: string; response?: { meta?: { regularMarketPrice?: number; regularMarketTime?: number } }[] }[] } }>(
    `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.join(",")}&range=1d&interval=5m`,
  );
  const out = new Map<string, { price: number; at: number }>();
  for (const r of j.spark?.result ?? []) {
    const m = r.response?.[0]?.meta;
    if (m?.regularMarketPrice) out.set(r.symbol, { price: m.regularMarketPrice, at: m.regularMarketTime ?? 0 });
  }
  return out;
}

export interface FeedResult {
  quotes: Quote[];
  skipped: { sym: string; why: string }[];
  fx: string | null;
}

/**
 * Every stock's price, open flag and change. A stock is "open" only when Naver says its market is
 * OPEN and it is trading (not halted). Its price is skipped (left out of the post) when Naver and
 * Yahoo disagree: within 3% when Yahoo's own quote is fresh (≤ 10 min), within 10% otherwise
 * (Yahoo doesn't follow Korea's Nextrade evening session). Yahoo being down doesn't stop posting.
 */
export async function readFeed(now = Date.now() / 1000): Promise<FeedResult> {
  const kr = STOCKS.filter((s) => s.region === 0);
  const us = STOCKS.filter((s) => s.region === 1);
  const [nk, nu, fx, y] = await Promise.all([
    naver("domestic", kr.map((s) => s.naver)),
    naver("worldstock", us.map((s) => s.naver)),
    usdKrw().catch((e: Error) => e),
    yahoo(STOCKS.map((s) => s.yahoo)).catch(() => null),
  ]);
  const quotes: Quote[] = [];
  const skipped: FeedResult["skipped"] = [];
  for (const s of STOCKS) {
    const n = (s.region === 0 ? nk : nu).get(s.naver);
    const local = cleanNum(n?.closePrice);
    if (!n || !local) {
      skipped.push({ sym: s.sym, why: "no Naver price" });
      continue;
    }
    if (s.region === 1 && fx instanceof Error) {
      skipped.push({ sym: s.sym, why: fx.message });
      continue;
    }
    const yq = y?.get(s.yahoo);
    if (yq) {
      const tol = now - yq.at <= 600 ? 300 : 1000;
      if (!agree(Number(local), yq.price, tol)) {
        skipped.push({ sym: s.sym, why: `Naver ${local} vs Yahoo ${yq.price}` });
        continue;
      }
    }
    const change = Number(cleanNum(n.compareToPreviousClosePrice) ?? 0);
    const price = toWei(local, s.region, fx instanceof Error ? undefined : fx);
    quotes.push({
      sym: s.sym,
      price,
      priceNum: Number(price / 10n ** 12n) / 1e6,
      local: Number(local),
      prevClose: Number(local) - change,
      changePct: Number(cleanNum(n.fluctuationsRatio) ?? 0),
      open: n.marketStatus === "OPEN" && (n.tradeStopType?.name ?? "TRADING") === "TRADING",
      tradedAt: n.localTradedAt ? Math.floor(Date.parse(n.localTradedAt) / 1000) : 0,
    });
  }
  return { quotes, skipped, fx: fx instanceof Error ? null : fx };
}

export const bySym = (sym: string): Stock => STOCKS.find((s) => s.sym === sym)!;
