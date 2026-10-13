import { maxUint256, parseEther, stringToHex, type Address, type Hex, type WalletClient } from "viem";
import { GyeWonAbi } from "./abi";
import { chain, client, confirmed, mustHold } from "./chain";
import { JangteoStocksAbi } from "./stocksAbi";

/** One stock on the board (stocks.json, published by ops every 30 s). Amounts are in won. */
export interface StockRow {
  sym: string;
  region: 0 | 1;
  name: string;
  nameKo: string;
  ticker: string;
  token: Address;
  price: number; // on-chain oracle price, ₩ per share
  updatedAt: number;
  tradable: boolean;
  buyRoom: number;
  buyPaused: boolean;
  open: boolean;
  local: number; // in the stock's own currency
  prevClose: number;
  changePct: number;
  supply: number;
  exposure: number;
  volume: number;
  vol24: number;
  trades24: number;
}

export interface TapeRow {
  tx: string;
  t: number;
  sym?: string;
  side: "buy" | "sell";
  who: string;
  krw: number;
  shares: number;
  price: number;
}

export interface Board {
  updatedAt: number;
  fx: number;
  tradeBps: number;
  lpShare: number;
  markets: StockRow[];
  vault: {
    cash: number;
    liability: number;
    nav: number;
    lpPrice: number;
    supply: number;
    utilisation: number;
    fees7d: number;
    apr: number;
    vol24: number;
    history: { t: number; price: number; nav: number }[];
  };
  tape: TapeRow[];
}

export interface Ohlc {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface StockHistory {
  updatedAt: number;
  m1: Ohlc[];
  m5: Ohlc[];
  h1: Ohlc[];
  d1: Ohlc[];
  tape: TapeRow[];
}

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
};
export const loadBoard = () => get<Board>("stocks.json");
export const loadHistory = (sym: string) => get<StockHistory>(`stocks/${encodeURIComponent(sym)}.json`);

export const symId = (sym: string): Hex => stringToHex(sym, { size: 32 });
export const stockName = (s: Pick<StockRow, "name" | "nameKo">, lang: "en" | "ko") => (lang === "ko" ? s.nameKo : s.name);

/** Korean 상승 red / 하락 blue. */
export const tone = (pct: number) => (pct > 0 ? "is-up" : pct < 0 ? "is-down" : "");
export const fmtWon = (v: number, digits = 0) => `₩${v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
export const fmtShares = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 2 : 6 });
export const fmtPctSigned = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
export const fmtUsd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

/**
 * When a market usually opens next, for the "opens in" hint. Korea: weekdays from 08:00 KST
 * (Nextrade's first session). US: weekdays 09:30 New York time. Holidays aren't known here; the
 * board's live open flag (from the exchange feed) is what actually gates trading.
 */
export function nextOpen(region: 0 | 1, now = Date.now()): number {
  const zone = region === 0 ? "Asia/Seoul" : "America/New_York";
  const [h, m] = region === 0 ? [8, 0] : [9, 30];
  // Walk forward in 15-minute steps until a weekday at the opening minute in that zone.
  for (let t = Math.ceil(now / 900_000) * 900_000; t < now + 8 * 86_400_000; t += 900_000) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    if (p.weekday !== "Sat" && p.weekday !== "Sun" && Number(p.hour) === h && Number(p.minute) === m) return Math.floor(t / 1000);
  }
  return Math.floor(now / 1000);
}

// ───────────────────────────────────── chain ─────────────────────────────────────

const balAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

export interface Wallet {
  holdings: Record<string, bigint>; // sym → shares (wei)
  lp: bigint;
  lockedUntil: number;
  krw: bigint;
}

export async function readWallet(ex: Address, tkrw: Address, markets: Pick<StockRow, "sym" | "token">[], who: Address): Promise<Wallet> {
  const [bals, lp, locked, krw] = await Promise.all([
    Promise.all(markets.map((m) => client.readContract({ address: m.token, abi: balAbi, functionName: "balanceOf", args: [who] }))),
    client.readContract({ address: ex, abi: JangteoStocksAbi, functionName: "balanceOf", args: [who] }),
    client.readContract({ address: ex, abi: JangteoStocksAbi, functionName: "lockedUntil", args: [who] }),
    client.readContract({ address: tkrw, abi: balAbi, functionName: "balanceOf", args: [who] }),
  ]);
  return { holdings: Object.fromEntries(markets.map((m, i) => [m.sym, bals[i]])), lp, lockedUntil: Number(locked), krw };
}

/** Live quote straight from the contract, for the ticket (the board file can be 30 s old). */
export async function readQuote(ex: Address, sym: string) {
  const [price, updatedAt, tradable, buyRoom] = await client.readContract({ address: ex, abi: JangteoStocksAbi, functionName: "quoteOf", args: [symId(sym)] });
  return { price, updatedAt: Number(updatedAt), tradable, buyRoom };
}

export const SLIPPAGE_BPS = 100n; // the price can move between the quote and the block: allow 1%

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return { hash, rc };
}

async function approve(wallet: WalletClient, token: Address, spender: Address, amount: bigint) {
  await mustHold(token, wallet.account!.address, amount);
  const allowance = await client.readContract({ address: token, abi: GyeWonAbi, functionName: "allowance", args: [wallet.account!.address, spender] });
  if (allowance >= amount) return;
  await send(wallet, { account: wallet.account!, chain, address: token, abi: GyeWonAbi, functionName: "approve", args: [spender, maxUint256] });
}

const tx = (wallet: WalletClient, ex: Address, functionName: string, args: unknown[]) =>
  send(wallet, { account: wallet.account!, chain, address: ex, abi: JangteoStocksAbi, functionName, args });

export const stocks = {
  /** Spend `krw` won on `sym`; at least 99% of the shares the current quote gives. */
  async buy(wallet: WalletClient, ex: Address, tkrw: Address, sym: string, krw: string, tradeBps: number) {
    const amount = parseEther(krw);
    const q = await readQuote(ex, sym);
    if (!q.tradable) throw new Error("MarketClosed");
    const expect = ((amount - (amount * BigInt(tradeBps)) / 10_000n) * 10n ** 18n) / q.price;
    await approve(wallet, tkrw, ex, amount);
    return tx(wallet, ex, "buy", [symId(sym), amount, (expect * (10_000n - SLIPPAGE_BPS)) / 10_000n]);
  },
  async sell(wallet: WalletClient, ex: Address, sym: string, shares: bigint, tradeBps: number) {
    const q = await readQuote(ex, sym);
    if (!q.tradable) throw new Error("MarketClosed");
    const gross = (shares * q.price) / 10n ** 18n;
    const expect = gross - (gross * BigInt(tradeBps)) / 10_000n;
    return tx(wallet, ex, "sell", [symId(sym), shares, (expect * (10_000n - SLIPPAGE_BPS)) / 10_000n]);
  },
  async deposit(wallet: WalletClient, ex: Address, tkrw: Address, krw: string) {
    const amount = parseEther(krw);
    await approve(wallet, tkrw, ex, amount);
    return tx(wallet, ex, "deposit", [amount, 0n]);
  },
  withdraw: (wallet: WalletClient, ex: Address, lp: bigint) => tx(wallet, ex, "withdraw", [lp, 0n]),
};
