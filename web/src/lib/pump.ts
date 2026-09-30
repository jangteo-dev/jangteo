import { formatEther, getAddress, parseAbiItem, parseEther, type Address, type WalletClient } from "viem";
import { JangteoPumpAbi, PumpTokenAbi } from "./abi";
import { chain, client, confirmed, logsInRange, currentUrl, mustHold } from "./chain";

export const SUPPLY = 1_000_000_000n * 10n ** 18n;
const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
const PAIR = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Curve constants, read once from the contract (they are immutable). */
export interface Curve {
  threshold: bigint;
  virtualEth: bigint;
  virtualTokens: bigint;
  curveSupply: bigint;
  maxCreatorBuy: bigint;
}

/** Curves differ between contracts (v1: 1.4 ETH virtual, v2: 2 ETH), so each is cached by address. */
const curveCache = new Map<string, Promise<Curve>>();
export function readCurve(pump: Address): Promise<Curve> {
  const k = pump.toLowerCase();
  const hit = curveCache.get(k);
  if (hit) return hit;
  const p = Promise.all([
    client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "threshold" }),
    client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "virtualEth" }),
    client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "virtualTokens" }),
    client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "curveSupply" }),
    client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "maxCreatorBuy" }),
  ]).then(([threshold, virtualEth, virtualTokens, curveSupply, maxCreatorBuy]) => ({ threshold, virtualEth, virtualTokens, curveSupply, maxCreatorBuy }));
  curveCache.set(k, p);
  p.catch(() => curveCache.delete(k));
  return p;
}

/** Every 뻥튀기 contract, newest first: v2 (new launches) then v1 (coins launched before 2026-09-26). */
export const pumpsOf = (d: { pump?: Address; pumpV1?: Address } | null | undefined): Address[] => [d?.pump, d?.pumpV1].filter((x): x is Address => !!x);

/** Which contract a coin launched on. */
export async function pumpOf(d: { pump?: Address; pumpV1?: Address } | null | undefined, token: Address): Promise<Address | null> {
  for (const p of pumpsOf(d)) {
    const l = await client.readContract({ address: p, abi: JangteoPumpAbi, functionName: "launch", args: [token] }).catch(() => null);
    if (l && l.creator !== "0x0000000000000000000000000000000000000000") return p;
  }
  return null;
}

/** Launches on every contract, newest first. */
export async function listAllLaunches(d: { pump?: Address; pumpV1?: Address } | null | undefined): Promise<PumpLaunch[]> {
  const all = (await Promise.all(pumpsOf(d).map((p) => listLaunches(p)))).flat();
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** What the creator wrote about the token. Links are shown only if they are https. */
export interface PumpMeta {
  image?: string;
  about?: string;
  site?: string;
  x?: string;
  telegram?: string;
}

export interface PumpLaunch {
  token: Address;
  /** The 뻥튀기 contract this coin launched on (v1 or v2). */
  pump: Address;
  name: string;
  symbol: string;
  creator: Address;
  pair: Address;
  createdAt: number;
  graduatedAt: number;
  graduated: boolean;
  realEth: bigint;
  sold: bigint;
  creatorFees: bigint;
  volume: bigint;
  trades: number;
  meta: PumpMeta;
  /** ETH per token, as a float for display. */
  price: number;
  /** Price × supply, in ETH. */
  marketCap: number;
  /** 0–1 of the way to graduation. */
  progress: number;
}

function parseMeta(raw: string): PumpMeta {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const out: PumpMeta = {};
    for (const k of ["image", "about", "site", "x", "telegram"] as const) {
      const v = j[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, k === "about" ? 600 : 300);
    }
    for (const k of ["image", "site", "x", "telegram"] as const) if (out[k] && !/^https:\/\//i.test(out[k]!)) delete out[k];
    if (out.image) out.image = currentUrl(out.image);
    return out;
  } catch {
    return {};
  }
}

/** Spot price on the curve (ETH per token) for a given state; after graduation the last price. */
export function curvePrice(c: Curve, realEth: bigint, sold: bigint) {
  return Number(formatEther(c.virtualEth + realEth)) / Number(formatEther(c.virtualTokens - sold));
}

export async function readLaunch(pump: Address, token: Address): Promise<PumpLaunch> {
  const [c, l, meta, name, symbol] = await Promise.all([
    readCurve(pump),
    client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "launch", args: [token] }),
    client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "metadata", args: [token] }),
    client.readContract({ address: token, abi: PumpTokenAbi, functionName: "name" }),
    client.readContract({ address: token, abi: PumpTokenAbi, functionName: "symbol" }),
  ]);
  // A graduated launch reads realEth 0 on the curve; from then on its price is the pool's.
  const realEth = l.graduated ? c.threshold : l.realEth;
  let price = curvePrice(c, realEth, l.sold);
  let circulating = SUPPLY;
  if (l.graduated) {
    const [[r0, r1], t0, burned] = await Promise.all([
      client.readContract({ address: l.pair, abi: PAIR, functionName: "getReserves" }),
      client.readContract({ address: l.pair, abi: PAIR, functionName: "token0" }),
      client.readContract({ address: token, abi: PumpTokenAbi, functionName: "balanceOf", args: [DEAD] }),
    ]);
    const [rt, rw] = t0.toLowerCase() === token.toLowerCase() ? [r0, r1] : [r1, r0];
    if (rt > 0n) price = Number(formatEther(rw)) / Number(formatEther(rt));
    circulating = SUPPLY - burned;
  }
  return {
    token,
    pump,
    name,
    symbol,
    creator: l.creator,
    pair: l.pair,
    createdAt: Number(l.createdAt),
    graduatedAt: Number(l.graduatedAt),
    graduated: l.graduated,
    realEth,
    sold: l.sold,
    creatorFees: l.creatorFees,
    volume: l.volume,
    trades: l.trades,
    meta: parseMeta(meta),
    price,
    // Burned tokens are gone for good, so they are not part of the market cap.
    marketCap: price * Number(formatEther(circulating)),
    progress: l.graduated ? 1 : Number((l.realEth * 10_000n) / c.threshold) / 10_000,
  };
}

/** What a launch's creator has earned in all: 0.5% of every curve trade, in ETH (claimed or not). */
export const creatorEarned = (l: Pick<PumpLaunch, "volume">) => (l.volume * 50n) / 10_000n;

export async function listLaunches(pump: Address): Promise<PumpLaunch[]> {
  const n = Number(await client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "tokenCount" }));
  const tokens = await Promise.all(Array.from({ length: n }, (_, i) => client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "tokens", args: [BigInt(i)] })));
  return (await Promise.all(tokens.map((t) => readLaunch(pump, t)))).reverse();
}

const TRADE = parseAbiItem(
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEth, uint256 sold)",
);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SWAP = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
const SYNC = parseAbiItem("event Sync(uint112 reserve0, uint112 reserve1)");

export interface PumpTrade {
  /** Where it traded: the bonding curve, or the 장터 스왑 pool after graduation. */
  venue: "curve" | "pool";
  trader: Address;
  isBuy: boolean;
  eth: bigint;
  tokens: bigint;
  price: number;
  realEth: bigint;
  at: number;
  hash: `0x${string}`;
}

/** GIWA makes a block a second, so a launch's first block is about `now − age` blocks back. */
async function launchBlock(createdAt: number) {
  const head = await client.getBlock();
  const back = BigInt(Math.max(0, Number(head.timestamp) - createdAt + 60));
  return { head, from: head.number > back ? head.number - back : 0n };
}

const logsInChunks = logsInRange;

export async function readTrades(pump: Address, l: PumpLaunch): Promise<PumpTrade[]> {
  const c = await readCurve(pump);
  const { head, from } = await launchBlock(l.createdAt);
  const logs = await logsInChunks(from, head.number, (c, a, b) => c.getLogs({ address: pump, event: TRADE, args: { token: l.token }, fromBlock: a, toBlock: b }));
  const curveTrades: PumpTrade[] = logs.map((x) => ({
    venue: "curve",
    trader: x.args.trader!,
    isBuy: x.args.isBuy!,
    eth: x.args.ethAmount!,
    tokens: x.args.tokenAmount!,
    realEth: x.args.realEth!,
    price: curvePrice(c, x.args.realEth!, x.args.sold!),
    at: Number(head.timestamp) - Number(head.number - x.blockNumber!),
    hash: x.transactionHash!,
  }));
  if (!l.graduated) return curveTrades;

  // After graduation: every pool swap, priced from the reserves the pool synced to in that swap.
  const since = head.number - BigInt(Math.max(0, Number(head.timestamp) - l.graduatedAt + 60));
  const [swaps, syncs, t0] = await Promise.all([
    logsInChunks(since, head.number, (c, a, b) => c.getLogs({ address: l.pair, event: SWAP, fromBlock: a, toBlock: b })),
    logsInChunks(since, head.number, (c, a, b) => c.getLogs({ address: l.pair, event: SYNC, fromBlock: a, toBlock: b })),
    client.readContract({ address: l.pair, abi: PAIR, functionName: "token0" }),
  ]);
  const tokenIs0 = t0.toLowerCase() === l.token.toLowerCase();
  const recent = swaps.slice(-80);
  // Routers receive the tokens or ETH on the trader's behalf; the transaction sender is the trader.
  const senders = await Promise.all(recent.map((x) => client.getTransaction({ hash: x.transactionHash! }).then((tx) => getAddress(tx.from)).catch(() => x.args.to!)));
  const poolTrades: PumpTrade[] = recent.map((x, i) => {
    const sync = syncs.find((y) => y.transactionHash === x.transactionHash && y.logIndex! < x.logIndex!);
    const [rt, rw] = sync ? (tokenIs0 ? [sync.args.reserve0!, sync.args.reserve1!] : [sync.args.reserve1!, sync.args.reserve0!]) : [1n, 0n];
    const a = x.args;
    const tokenOut = tokenIs0 ? a.amount0Out! : a.amount1Out!;
    const tokenIn = tokenIs0 ? a.amount0In! : a.amount1In!;
    const ethIn = tokenIs0 ? a.amount1In! : a.amount0In!;
    const ethOut = tokenIs0 ? a.amount1Out! : a.amount0Out!;
    const isBuy = tokenOut > 0n;
    return {
      venue: "pool",
      trader: senders[i],
      isBuy,
      eth: isBuy ? ethIn : ethOut,
      tokens: isBuy ? tokenOut : tokenIn,
      realEth: 0n,
      price: rt > 0n ? Number(formatEther(rw)) / Number(formatEther(rt)) : 0,
      at: Number(head.timestamp) - Number(head.number - x.blockNumber!),
      hash: x.transactionHash!,
    };
  });
  return [...curveTrades, ...poolTrades];
}

export interface Holder {
  address: Address;
  balance: bigint;
  share: number;
}

/** Balances rebuilt from transfers; the curve, the pool and the burn address are labelled apart. */
export async function readHolders(l: PumpLaunch): Promise<Holder[]> {
  const { head, from } = await launchBlock(l.createdAt);
  const logs = await logsInChunks(from, head.number, (c, a, b) => c.getLogs({ address: l.token, event: TRANSFER, fromBlock: a, toBlock: b }));
  const bal = new Map<string, bigint>();
  for (const x of logs) {
    const f = x.args.from!.toLowerCase();
    const t = x.args.to!.toLowerCase();
    if (f !== "0x0000000000000000000000000000000000000000") bal.set(f, (bal.get(f) ?? 0n) - x.args.value!);
    bal.set(t, (bal.get(t) ?? 0n) + x.args.value!);
  }
  return [...bal.entries()]
    .filter(([, b]) => b > 0n)
    .map(([a, b]) => ({ address: getAddress(a), balance: b, share: Number((b * 1_000_000n) / SUPPLY) / 1_000_000 }))
    .sort((x, y) => (y.balance > x.balance ? 1 : -1));
}

export async function tokenBalance(token: Address, who: Address) {
  return client.readContract({ address: token, abi: PumpTokenAbi, functionName: "balanceOf", args: [who] });
}

export async function quoteBuy(pump: Address, token: Address, eth: bigint) {
  const [out, used, refund] = await client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "quoteBuy", args: [token, eth] });
  return { out, used, refund };
}

export async function quoteSell(pump: Address, token: Address, amount: bigint) {
  return client.readContract({ address: pump, abi: JangteoPumpAbi, functionName: "quoteSell", args: [token, amount] });
}

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return { hash, rc };
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
const less = (v: bigint, bps: number) => (v * BigInt(10_000 - bps)) / 10_000n;

export const pumpTx = {
  async create(wallet: WalletClient, pump: Address, name: string, symbol: string, meta: PumpMeta, devBuy: string) {
    const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => typeof v === "string" && v.trim()));
    const { rc } = await send(wallet, {
      account: wallet.account!,
      chain,
      address: pump,
      abi: JangteoPumpAbi,
      functionName: "create",
      args: [name.trim(), symbol.trim().toUpperCase(), Object.keys(clean).length ? JSON.stringify(clean) : ""],
      value: devBuy ? parseEther(devBuy) : 0n,
    });
    // Launched(address indexed token, …) is the pump's first log: the token is topic 1.
    const log = rc.logs.find((x) => x.address.toLowerCase() === pump.toLowerCase());
    return `0x${log!.topics[1]!.slice(26)}` as Address;
  },
  async buy(wallet: WalletClient, pump: Address, token: Address, eth: bigint, minOut: bigint, slippageBps: number) {
    return send(wallet, {
      account: wallet.account!,
      chain,
      address: pump,
      abi: JangteoPumpAbi,
      functionName: "buy",
      args: [token, less(minOut, slippageBps), deadline()],
      value: eth,
    });
  },
  async sell(wallet: WalletClient, pump: Address, token: Address, amount: bigint, minOut: bigint, slippageBps: number) {
    const owner = wallet.account!.address;
    await mustHold(token, owner, amount);
    const allowance = await client.readContract({ address: token, abi: PumpTokenAbi, functionName: "allowance", args: [owner, pump] });
    if (allowance < amount) {
      await send(wallet, { account: wallet.account!, chain, address: token, abi: PumpTokenAbi, functionName: "approve", args: [pump, 2n ** 256n - 1n] });
    }
    return send(wallet, {
      account: wallet.account!,
      chain,
      address: pump,
      abi: JangteoPumpAbi,
      functionName: "sell",
      args: [token, amount, less(minOut, slippageBps), deadline()],
    });
  },
  claimCreatorFees(wallet: WalletClient, pump: Address, token: Address) {
    return send(wallet, { account: wallet.account!, chain, address: pump, abi: JangteoPumpAbi, functionName: "claimCreatorFees", args: [token] });
  },
};

export const fmtEth = (v: bigint | number, digits = 4) => {
  const n = typeof v === "bigint" ? Number(formatEther(v)) : v;
  return n.toLocaleString("en-US", { maximumFractionDigits: n > 0 && n < 0.001 ? 6 : digits });
};

/** Tiny ETH prices read better in gwei-ish scientific form: 0.0000000213 → 2.13e-8. */
export const fmtPrice = (p: number) => (p === 0 ? "0" : p < 0.0001 ? p.toExponential(3) : p.toPrecision(4));

export const fmtTokens = (v: bigint) => {
  const n = Number(formatEther(v));
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
