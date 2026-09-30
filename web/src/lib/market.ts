import { parseAbi, type Address } from "viem";
import { client } from "./chain";
import { fmtTiny } from "./tiny";

export interface Venue {
  dex: string;
  pool: string;
  kind: string;
  liquidityKrw: number;
  quote: string;
}

export interface MarketToken {
  address: Address;
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
  venues: Venue[];
  curve: { progress: number } | null;
  graduated: boolean;
  createdAt: number | null;
  suspicious: boolean;
  anchor?: boolean;
}

export interface Flow {
  spentKrw: number;
  receivedKrw: number;
  bought: number;
  sold: number;
}

export interface MarketFile {
  updatedAt: number;
  ethKrw: number;
  block: number;
  live: boolean;
  lag: number;
  totals: { tokens: number; pools: number; dexes: number; liquidityKrw: number; volume24hKrw: number };
  tokens: MarketToken[];
  flows: Record<string, Record<string, Flow>>;
}

export interface HistoryTrade {
  at: number;
  price: number;
  eth: string;
  tokens: string;
  isBuy: boolean;
  trader: string;
  venue: string;
  hash: string;
}

/** Written by Jangteo's indexer every few seconds, next to the app. */
export async function loadMarket(): Promise<MarketFile | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}market.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as MarketFile) : null;
  } catch {
    return null;
  }
}

export async function loadHistory(token: string): Promise<HistoryTrade[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}market/${token.toLowerCase()}.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as { trades: HistoryTrade[] }).trades : [];
  } catch {
    return [];
  }
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** The connected wallet's balance of every priced token, in one multicall. */
export async function holdings(who: Address, tokens: MarketToken[]) {
  const priced = tokens.filter((t) => t.priceEth !== null);
  const res = await client.multicall({
    contracts: priced.map((t) => ({ address: t.address, abi: erc20, functionName: "balanceOf", args: [who] }) as const),
    allowFailure: true,
  });
  return priced
    .map((t, i) => ({ token: t, raw: res[i].status === "success" ? (res[i].result as bigint) : 0n }))
    .filter((x) => x.raw > 0n)
    .map((x) => ({ ...x, amount: Number(x.raw) / 10 ** x.token.decimals }));
}

/** Venue names the indexer uses for 장터 뻥튀기's bonding curve (older data says 장터 펌프). */
export const CURVE = new Set(["장터 뻥튀기", "장터 펌프"]);

/** A DEX name for the current language: Jangteo's own venues are never shown in Hangul in English. */
export function dexLabel(d: string, lang: "en" | "ko"): string {
  if (d === "장터 스왑") return lang === "ko" ? d : "Jangteo Swap";
  if (CURVE.has(d)) return lang === "ko" ? "장터 뻥튀기" : "Jangteo Ppeongtwigi";
  return d;
}

/** Where the connected wallet can trade a token from Jangteo today. */
export function tradeLink(t: MarketToken): string | null {
  if (t.curve) return `#/ppeongtwigi/${t.address}`;
  // Any pool on any GIWA DEX: the swap page routes through 장터 스왑 or the aggregator.
  if (t.venues.length > 0 && !t.anchor) return `#/trade/${t.address}`;
  return null;
}

/** ₩ amounts compact enough for a table: ₩12.3억, ₩4,120만 in Korean; ₩1.2B, ₩41.2M in English. */
export function krw(v: number | null, lang: "en" | "ko"): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (lang === "ko") {
    if (a >= 1e16) return `₩${(v / 1e16).toLocaleString("en-US", { maximumFractionDigits: 2 })}경`;
    if (a >= 1e12) return `₩${(v / 1e12).toFixed(2)}조`;
    if (a >= 1e8) return `₩${(v / 1e8).toFixed(2)}억`;
    if (a >= 1e4) return `₩${(v / 1e4).toLocaleString("en-US", { maximumFractionDigits: a >= 1e6 ? 0 : 1 })}만`;
  } else {
    if (a >= 1e15) return `₩${(v / 1e12).toExponential(2)}T`;
    if (a >= 1e12) return `₩${(v / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `₩${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `₩${(v / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `₩${(v / 1e3).toFixed(1)}K`;
  }
  if (a >= 1) return `₩${v.toLocaleString("en-US", { maximumFractionDigits: a >= 100 ? 0 : 2 })}`;
  return `₩${fmtTiny(v)}`;
}
