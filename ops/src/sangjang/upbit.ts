/** Upbit / Bithumb / Binance public data used to curate and resolve listing markets. */

const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) jangteo/1.0", accept: "application/json" };

export interface Notice {
  id: number;
  title: string;
  /** Notice publication time, ms since epoch. */
  at: number;
}

export interface ListingNotice extends Notice {
  tickers: string[];
  /** The title also says the listing was cancelled or delayed: a human must decide. */
  cancelled: boolean;
}

/** Tickers are the parenthesised all-caps codes, e.g. "바이프로스트(BFC)". */
const TICKER = /\(([A-Z0-9]{2,15})\)/g;
const NOT_A_TICKER = new Set(["KRW", "BTC", "USDT", "ETH"]);

/**
 * A KRW listing notice looks like one of:
 *   "바이프로스트(BFC) KRW, USDT 마켓 디지털 자산 추가"
 *   "클러스터프로토콜(CP) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)"
 * Anything without KRW, or about delisting / warnings / networks, is not a listing.
 */
export function parseListing(n: Notice): ListingNotice | null {
  const t = n.title;
  const isAdd = t.includes("신규 거래지원") || t.includes("디지털 자산 추가");
  if (!isAdd || !t.includes("KRW")) return null;
  if (t.includes("거래지원 종료") || t.includes("유의")) return null;
  // Only look at the part before the first market list / suffix for the listed assets.
  const head = t.split(/ 신규 거래지원| KRW| 마켓/)[0];
  const tickers = [...head.matchAll(TICKER)].map((m) => m[1]).filter((x) => !NOT_A_TICKER.has(x));
  if (!tickers.length) return null;
  return { ...n, tickers, cancelled: /취소|연기/.test(t) };
}

async function json<T>(url: string, fetcher: typeof fetch): Promise<T> {
  const res = await fetcher(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function recentNotices(fetcher: typeof fetch = fetch, pages = 2): Promise<Notice[]> {
  const out: Notice[] = [];
  for (let p = 1; p <= pages; p++) {
    const d = await json<{ data: { notices: { id: number; title: string; listed_at: string }[] } }>(
      `https://api-manager.upbit.com/api/v1/announcements?os=web&page=${p}&per_page=20&category=trade`,
      fetcher,
    );
    for (const n of d.data.notices) out.push({ id: n.id, title: n.title, at: Date.parse(n.listed_at) });
  }
  return out;
}

export async function upbitKrw(fetcher: typeof fetch = fetch): Promise<Set<string>> {
  const d = await json<{ market: string }[]>("https://api.upbit.com/v1/market/all", fetcher);
  return new Set(d.filter((m) => m.market.startsWith("KRW-")).map((m) => m.market.slice(4)));
}

// Privacy coins are barred from Korean exchanges by the Travel Rule regime, so they can never list.
const SKIP = /^(ZEC|XMR|DASH|ZEN|SCRT|FIRO|ARRR|BEAM|DERO|USDC|USDT|FDUSD|TUSD|DAI|USDP|USD1|PYUSD|EUR|EURI|AEUR|WBTC|WBETH|BETH|BNSOL|PAXG|XUSD|RLUSD)$|UP$|DOWN$|BULL$|BEAR$/;

export interface Candidate {
  symbol: string;
  binanceVolumeUsd: number;
  onBithumb: boolean;
  score: number;
}

/**
 * Coins with real liquidity elsewhere but no Upbit KRW market yet: Binance USDT volume, with a
 * boost for coins Korean traders can already buy on Bithumb (the usual path to an Upbit listing).
 */
export async function listingCandidates(fetcher: typeof fetch = fetch): Promise<Candidate[]> {
  const [upbit, bithumb, binance] = await Promise.all([
    upbitKrw(fetcher),
    json<{ data: Record<string, unknown> }>("https://api.bithumb.com/public/ticker/ALL_KRW", fetcher).then((d) => new Set(Object.keys(d.data).filter((k) => k !== "date"))),
    json<{ symbol: string; quoteVolume: string }[]>("https://api.binance.com/api/v3/ticker/24hr", fetcher),
  ]);
  const vol = new Map<string, number>();
  for (const t of binance) if (t.symbol.endsWith("USDT")) vol.set(t.symbol.slice(0, -4), Number(t.quoteVolume));
  const all = new Set([...vol.keys(), ...bithumb]);
  return [...all]
    // Binance's tokenized equities (NVDAB, TSLAB, SNDKB…) are stocks, not listable coins.
    .filter((s) => !upbit.has(s) && !SKIP.test(s) && /^[A-Z0-9]{2,12}$/.test(s) && !(/^[A-Z]{4,7}B$/.test(s) && !bithumb.has(s)))
    .map((s) => {
      const v = vol.get(s) ?? 0;
      const b = bithumb.has(s);
      return { symbol: s, binanceVolumeUsd: v, onBithumb: b, score: v * (b ? 3 : 1) };
    })
    .filter((c) => c.binanceVolumeUsd > 2_000_000 || (c.onBithumb && c.binanceVolumeUsd > 250_000))
    .sort((a, b) => b.score - a.score);
}
