import { formatUnits, hexToString, maxUint256, parseUnits, zeroAddress, type Address, type WalletClient } from "viem";
import { GyeWonAbi, JangoeMarketAbi } from "./abi";
import { chain, client, confirmed, mustHold } from "./chain";

export const MARKET_STATUS = ["None", "Open", "Settling", "Voided"] as const;
export const TRADE_STATUS = ["None", "Open", "Delivered", "Defaulted", "Refunded"] as const;
export type MarketStatus = (typeof MARKET_STATUS)[number];
export type TradeStatus = (typeof TRADE_STATUS)[number];
export type Side = "Buy" | "Sell";

const ERC20_SYMBOL = [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;

export interface MarketMeta {
  kind: "cheongyak" | "points" | "other";
  offering?: number;
  about?: string;
}

export interface JgMarket {
  id: number;
  name: string;
  quote: Address;
  collateralBps: number;
  feeBps: number;
  status: MarketStatus;
  token: Address;
  tokenSymbol: string;
  tokensPerUnit: bigint;
  deliverBy: number;
  volume: bigint;
  trades: number;
  meta: MarketMeta;
}

export interface JgOffer {
  id: number;
  side: Side;
  active: boolean;
  maker: Address;
  units: bigint;
  filled: bigint;
  left: bigint;
  price: bigint;
}

export interface JgTrade {
  id: number;
  market: number;
  status: TradeStatus;
  buyer: Address;
  seller: Address;
  units: bigint;
  paid: bigint;
  collateral: bigint;
}

function parseMeta(raw: string): MarketMeta {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const kind = j.kind === "cheongyak" || j.kind === "points" ? j.kind : "other";
    return {
      kind,
      offering: typeof j.offering === "number" ? j.offering : undefined,
      about: typeof j.about === "string" ? j.about.slice(0, 600) : undefined,
    };
  } catch {
    return { kind: "other" };
  }
}

export async function readMarket(addr: Address, id: number): Promise<JgMarket> {
  const [m, meta] = await Promise.all([
    client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "market", args: [BigInt(id)] }),
    client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "marketMeta", args: [BigInt(id)] }),
  ]);
  const tokenSymbol = m.token === zeroAddress ? "" : await client.readContract({ address: m.token, abi: ERC20_SYMBOL, functionName: "symbol" }).catch(() => "?");
  return {
    id,
    name: hexToString(m.name, { size: 32 }).replace(/\0+$/, ""),
    quote: m.quote,
    collateralBps: m.collateralBps,
    feeBps: m.feeBps,
    status: MARKET_STATUS[m.status],
    token: m.token,
    tokenSymbol,
    tokensPerUnit: m.tokensPerUnit,
    deliverBy: Number(m.deliverBy),
    volume: m.volume,
    trades: m.trades,
    meta: parseMeta(meta),
  };
}

export async function listMarkets(addr: Address): Promise<JgMarket[]> {
  const n = Number(await client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "marketCount" }));
  const all = await Promise.all(Array.from({ length: n }, (_, i) => readMarket(addr, i)));
  return all.reverse();
}

export async function readOffers(addr: Address, market: number): Promise<JgOffer[]> {
  const n = await client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "marketOfferCount", args: [BigInt(market)] });
  const ids = await client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "marketOffers", args: [BigInt(market), 0n, n] });
  const offers = await Promise.all(ids.map((i) => client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "offer", args: [i] })));
  return offers.map((o, k) => ({
    id: Number(ids[k]),
    side: o.side === 0 ? "Buy" : "Sell",
    active: o.active,
    maker: o.maker,
    units: o.units,
    filled: o.filled,
    left: o.units - o.filled,
    price: o.price,
  }));
}

/** Best bid (highest active BUY) and best ask (lowest active SELL). */
export function book(offers: JgOffer[]) {
  const live = offers.filter((o) => o.active && o.left > 0n);
  const bids = live.filter((o) => o.side === "Buy").sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : a.id - b.id));
  const asks = live.filter((o) => o.side === "Sell").sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : a.id - b.id));
  return { bids, asks, bestBid: bids[0]?.price, bestAsk: asks[0]?.price };
}

export async function readMyTrades(addr: Address, who: Address, market?: number): Promise<JgTrade[]> {
  const ids = await client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "tradesOf", args: [who] });
  const ts = await Promise.all(ids.map((i) => client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "trade", args: [i] })));
  return ts
    .map((t, k) => ({
      id: Number(ids[k]),
      market: Number(t.market),
      status: TRADE_STATUS[t.status],
      buyer: t.buyer,
      seller: t.seller,
      units: t.units,
      paid: t.paid,
      collateral: t.collateral,
    }))
    .filter((t) => market === undefined || t.market === market)
    .reverse();
}

export async function sellerRecord(addr: Address, who: Address) {
  const [delivered, defaulted] = await Promise.all([
    client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "delivered", args: [who] }),
    client.readContract({ address: addr, abi: JangoeMarketAbi, functionName: "defaulted", args: [who] }),
  ]);
  return { delivered, defaulted };
}

export const valueOf = (units: bigint, price: bigint) => (units * price) / 10n ** 18n;
export const collateralOf = (m: Pick<JgMarket, "collateralBps">, value: bigint) => (value * BigInt(m.collateralBps)) / 10_000n;
export const tokensFor = (m: Pick<JgMarket, "tokensPerUnit">, units: bigint) => (units * m.tokensPerUnit) / 10n ** 18n;
export const fmtUnits = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 });

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return { hash, rc };
}

async function approve(wallet: WalletClient, token: Address, spender: Address, amount: bigint) {
  await mustHold(token, wallet.account!.address, amount);
  const owner = wallet.account!.address;
  const allowance = await client.readContract({ address: token, abi: GyeWonAbi, functionName: "allowance", args: [owner, spender] });
  if (allowance >= amount) return;
  await send(wallet, { account: wallet.account!, chain, address: token, abi: GyeWonAbi, functionName: "approve", args: [spender, maxUint256] });
}

const tx = (wallet: WalletClient, addr: Address, functionName: string, args: unknown[]) =>
  send(wallet, { account: wallet.account!, chain, address: addr, abi: JangoeMarketAbi, functionName, args });

export const jangoe = {
  async post(wallet: WalletClient, addr: Address, m: JgMarket, side: Side, units: string, price: string) {
    const u = parseUnits(units, 18);
    const p = parseUnits(price, 18);
    const v = valueOf(u, p);
    await approve(wallet, m.quote, addr, side === "Buy" ? v : collateralOf(m, v));
    return tx(wallet, addr, "post", [BigInt(m.id), side === "Buy" ? 0 : 1, u, p]);
  },
  async fill(wallet: WalletClient, addr: Address, m: JgMarket, o: JgOffer, units: bigint) {
    const v = valueOf(units, o.price);
    await approve(wallet, m.quote, addr, o.side === "Sell" ? v : collateralOf(m, v));
    return tx(wallet, addr, "fill", [BigInt(o.id), units]);
  },
  cancel: (wallet: WalletClient, addr: Address, offerId: number) => tx(wallet, addr, "cancel", [BigInt(offerId)]),
  async deliver(wallet: WalletClient, addr: Address, m: JgMarket, trades: JgTrade[]) {
    const need = trades.reduce((a, t) => a + tokensFor(m, t.units), 0n);
    await approve(wallet, m.token, addr, need);
    return tx(wallet, addr, "deliver", [trades.map((t) => BigInt(t.id))]);
  },
  claimDefault: (wallet: WalletClient, addr: Address, trades: JgTrade[]) => tx(wallet, addr, "claimDefault", [trades.map((t) => BigInt(t.id))]),
  refund: (wallet: WalletClient, addr: Address, trades: JgTrade[]) => tx(wallet, addr, "refund", [trades.map((t) => BigInt(t.id))]),
};
