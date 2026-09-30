import { formatUnits, hexToString, maxUint256, parseUnits, stringToHex, zeroAddress, type Address, type WalletClient } from "viem";
import { CheongyakAbi, CheongyakV2Abi, GyeWonAbi, TestTokenFactoryAbi } from "./abi";
import { chain, client, confirmed, mustHold } from "./chain";
import { won } from "./gye";

export const WETH: Address = "0x4200000000000000000000000000000000000006";

export const CY_STATUS_V1 = ["None", "Scheduled", "Settling", "Settled", "Cancelled"] as const;
export const CY_STATUS = ["None", "Scheduled", "Settling", "Settled", "Failed", "Cancelled"] as const;
export type CyStatus = (typeof CY_STATUS)[number];

const ERC20_META = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Issuer profile, stored on-chain as JSON. Every field is optional and shown only when present. */
export interface Profile {
  about?: string;
  site?: string;
  x?: string;
  telegram?: string;
  discord?: string;
  logo?: string;
}

/** Where an offering lives: v2 is the current launchpad, v1 the first contract (read-only history). */
export interface CyRef {
  v: 1 | 2;
  id: number;
}

export const cyHref = (r: CyRef) => (r.v === 2 ? `#/cheongyak/${r.id}` : `#/cheongyak/v1/${r.id}`);

export interface Offering extends CyRef {
  addr: Address;
  issuer: Address;
  token: Address;
  quote: Address;
  symbol: string;
  quoteSymbol: string;
  name: string;
  totalTokens: bigint;
  price: bigint;
  startAt: number;
  endAt: number;
  equalBps: number;
  feeBps: number;
  minDeposit: bigint;
  maxDeposit: bigint;
  softCap: bigint;
  tgeBps: number;
  cliff: number;
  vesting: number;
  liqBps: number;
  lpLock: number;
  status: CyStatus;
  verified: boolean;
  subscribers: number;
  totalDeposit: bigint;
  allocated: bigint;
  raised: bigint;
  settledAt: number;
  issuerPaid: boolean;
  pair: Address;
  lpAmount: bigint;
  liqQuote: bigint;
  liqTokens: bigint;
  lpWithdrawn: boolean;
  profile: Profile;
  /** Demand ÷ supply, the 경쟁률 Korean IPO coverage quotes. */
  competition: number;
}

export type Stage = "upcoming" | "open" | "closed";

export function stage(o: Offering, now = Date.now() / 1000): Stage {
  if (o.status === "Scheduled" && now < o.startAt) return "upcoming";
  if (o.status === "Scheduled" && now < o.endAt) return "open";
  return "closed";
}

/** Formats an amount of the offering's quote token: tKRW as won, anything else by symbol. */
export function money(o: Pick<Offering, "quote" | "quoteSymbol">, tkrw: Address | undefined, v: bigint) {
  if (tkrw && o.quote.toLowerCase() === tkrw.toLowerCase()) return won(v);
  const n = Number(formatUnits(v, 18));
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 })} ${o.quoteSymbol}`;
}

export const hardCap = (o: Pick<Offering, "totalTokens" | "price">) => (o.totalTokens * o.price) / 10n ** 18n;

function parseProfile(raw: string): Profile {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const out: Profile = {};
    for (const k of ["about", "site", "x", "telegram", "discord", "logo"] as const) {
      const v = j[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, k === "about" ? 1200 : 200);
    }
    // Links must be http(s): nothing else is ever rendered as a link.
    for (const k of ["site", "x", "telegram", "discord", "logo"] as const) if (out[k] && !/^https:\/\//i.test(out[k]!)) delete out[k];
    return out;
  } catch {
    return {};
  }
}

const symbols = new Map<string, Promise<string>>();
function symbolOf(token: Address) {
  const k = token.toLowerCase();
  if (!symbols.has(k)) symbols.set(k, client.readContract({ address: token, abi: ERC20_META, functionName: "symbol" }).catch(() => "?"));
  return symbols.get(k)!;
}

const nameOf = (h: `0x${string}`) => hexToString(h, { size: 32 }).replace(/\0+$/, "");
const compOf = (deposit: bigint, total: bigint, price: bigint) => {
  const cap = (total * price) / 10n ** 18n;
  return cap === 0n ? 0 : Number((deposit * 100n) / cap) / 100;
};

async function readV2(addr: Address, id: number): Promise<Offering> {
  const [o, meta] = await Promise.all([
    client.readContract({ address: addr, abi: CheongyakV2Abi, functionName: "offering", args: [BigInt(id)] }),
    client.readContract({ address: addr, abi: CheongyakV2Abi, functionName: "metadata", args: [BigInt(id)] }),
  ]);
  const [symbol, quoteSymbol] = await Promise.all([symbolOf(o.t.token), symbolOf(o.t.quote)]);
  return {
    v: 2,
    id,
    addr,
    issuer: o.issuer,
    token: o.t.token,
    quote: o.t.quote,
    symbol,
    quoteSymbol,
    name: nameOf(o.t.name),
    totalTokens: o.t.totalTokens,
    price: o.t.price,
    startAt: Number(o.t.startAt),
    endAt: Number(o.t.endAt),
    equalBps: o.t.equalBps,
    feeBps: o.feeBps,
    minDeposit: o.t.minDeposit,
    maxDeposit: o.t.maxDeposit,
    softCap: o.t.softCap,
    tgeBps: o.t.tgeBps,
    cliff: o.t.cliff,
    vesting: o.t.vesting,
    liqBps: o.t.liqBps,
    lpLock: o.t.lpLock,
    status: CY_STATUS[o.status],
    verified: o.verified,
    subscribers: o.subscribers,
    totalDeposit: o.totalDeposit,
    allocated: o.allocated,
    raised: o.raised,
    settledAt: Number(o.settledAt),
    issuerPaid: o.issuerPaid,
    pair: o.pair,
    lpAmount: o.lpAmount,
    liqQuote: o.liqQuote,
    liqTokens: o.liqTokens,
    lpWithdrawn: o.lpWithdrawn,
    profile: parseProfile(meta),
    competition: compOf(o.totalDeposit, o.t.totalTokens, o.t.price),
  };
}

async function readV1(addr: Address, tkrw: Address, id: number): Promise<Offering> {
  const o = await client.readContract({ address: addr, abi: CheongyakAbi, functionName: "offering", args: [BigInt(id)] });
  const symbol = await symbolOf(o.token);
  return {
    v: 1,
    id,
    addr,
    issuer: o.issuer,
    token: o.token,
    quote: tkrw,
    symbol,
    quoteSymbol: "tKRW",
    name: nameOf(o.name),
    totalTokens: o.totalTokens,
    price: o.price,
    startAt: Number(o.startAt),
    endAt: Number(o.endAt),
    equalBps: o.equalBps,
    feeBps: o.feeBps,
    minDeposit: o.minDeposit,
    maxDeposit: o.maxDeposit,
    softCap: 0n,
    tgeBps: 10_000,
    cliff: 0,
    vesting: 0,
    liqBps: 0,
    lpLock: 0,
    status: CY_STATUS_V1[o.status],
    verified: false,
    subscribers: o.subscribers,
    totalDeposit: o.totalDeposit,
    allocated: o.allocated,
    raised: o.raised,
    settledAt: 0,
    issuerPaid: o.issuerPaid,
    pair: zeroAddress,
    lpAmount: 0n,
    liqQuote: 0n,
    liqTokens: 0n,
    lpWithdrawn: false,
    profile: {},
    competition: compOf(o.totalDeposit, o.totalTokens, o.price),
  };
}

export interface CyAddrs {
  v1?: Address;
  v2?: Address;
  tkrw: Address;
}

export async function readOffering(a: CyAddrs, r: CyRef): Promise<Offering> {
  if (r.v === 2) return readV2(a.v2!, r.id);
  return readV1(a.v1!, a.tkrw, r.id);
}

/** Every offering, newest first; v2 before the earlier contract's. */
export async function listOfferings(a: CyAddrs): Promise<Offering[]> {
  const count = async (addr: Address | undefined, abi: typeof CheongyakAbi | typeof CheongyakV2Abi) =>
    addr ? Number(await client.readContract({ address: addr, abi, functionName: "offeringCount" })) : 0;
  const [n2, n1] = await Promise.all([count(a.v2, CheongyakV2Abi), count(a.v1, CheongyakAbi)]);
  const v2 = await Promise.all(Array.from({ length: n2 }, (_, i) => readV2(a.v2!, i)));
  const v1 = await Promise.all(Array.from({ length: n1 }, (_, i) => readV1(a.v1!, a.tkrw, i)));
  return [...v2.reverse(), ...v1.reverse()];
}

export interface Allocation {
  deposit: bigint;
  tokens: bigint;
  cost: bigint;
  released: bigint;
  refunded: boolean;
  /** Tokens unlocked now and not yet collected, and refund still owed. */
  claimableTokens: bigint;
  claimableRefund: bigint;
}

export async function readAllocation(o: Offering, who: Address): Promise<Allocation> {
  if (o.v === 2) {
    const [a, [tokens, refund]] = await Promise.all([
      client.readContract({ address: o.addr, abi: CheongyakV2Abi, functionName: "allocationOf", args: [BigInt(o.id), who] }),
      client.readContract({ address: o.addr, abi: CheongyakV2Abi, functionName: "claimable", args: [BigInt(o.id), who] }),
    ]);
    return { ...a, claimableTokens: tokens, claimableRefund: refund };
  }
  const a = await client.readContract({ address: o.addr, abi: CheongyakAbi, functionName: "allocationOf", args: [BigInt(o.id), who] });
  const open = o.status === "Settled" && !a.claimed;
  return {
    deposit: a.deposit,
    tokens: a.tokens,
    cost: a.cost,
    released: a.claimed ? a.tokens : 0n,
    refunded: a.claimed,
    claimableTokens: open ? a.tokens : 0n,
    claimableRefund: open ? a.deposit - a.cost : 0n,
  };
}

/** Tokens of an allocation unlocked at time `t`, mirroring CheongyakV2._vested. */
export function vestedAt(o: Offering, total: bigint, t: number): bigint {
  if (o.status !== "Settled") return 0n;
  if (o.v === 1) return total;
  if (t < o.settledAt) return 0n;
  const tge = (total * BigInt(o.tgeBps)) / 10_000n;
  const cliffEnd = o.settledAt + o.cliff;
  if (t < cliffEnd) return tge;
  if (o.vesting === 0) return total;
  const elapsed = t - cliffEnd;
  if (elapsed >= o.vesting) return total;
  return tge + ((total - tge) * BigInt(Math.floor(elapsed))) / BigInt(o.vesting);
}

export const isVesting = (o: Pick<Offering, "tgeBps" | "cliff" | "vesting">) => o.tgeBps < 10_000 && (o.cliff > 0 || o.vesting > 0);

/**
 * What a deposit would get if the offering closed now: the equal share (capped by demand) plus a
 * pro-rata share of what is left. An estimate — later subscribers change both parts.
 */
export function estimate(o: Offering, deposit: bigint, isNew: boolean) {
  const want = (deposit * 10n ** 18n) / o.price;
  const n = BigInt(o.subscribers + (isNew ? 1 : 0));
  const equalPool = (o.totalTokens * BigInt(o.equalBps)) / 10_000n;
  const each = n === 0n ? 0n : equalPool / n;
  const eq = want < each ? want : each;
  const demand = ((o.totalDeposit + (isNew ? deposit : 0n)) * 10n ** 18n) / o.price;
  const left = o.totalTokens - (each * n < equalPool ? each * n : equalPool);
  const remDemand = demand > each * n ? demand - each * n : 0n;
  const prop = remDemand === 0n ? 0n : remDemand <= left ? want - eq : ((want - eq) * left) / remDemand;
  const tokens = eq + prop;
  return { tokens, cost: (tokens * o.price) / 10n ** 18n };
}

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

const abiOf = (o: Pick<Offering, "v">) => (o.v === 2 ? CheongyakV2Abi : CheongyakAbi);

export interface NewOffering {
  token: Address;
  quote: Address;
  name: string;
  total: string;
  price: string;
  startInMin: number;
  hours: number;
  equalPct: number;
  min: string;
  max: string;
  softCap: string;
  tgePct: number;
  cliffDays: number;
  vestingDays: number;
  liqPct: number;
  lockDays: number;
  profile: Profile;
}

const DAY = 86_400;

export const cheongyak = {
  async subscribe(wallet: WalletClient, o: Offering, amount: string) {
    const v = parseUnits(amount, 18);
    await approve(wallet, o.quote, o.addr, v);
    return send(wallet, { account: wallet.account!, chain, address: o.addr, abi: abiOf(o), functionName: "subscribe", args: [BigInt(o.id), v] });
  },
  claim(wallet: WalletClient, o: Offering) {
    return send(wallet, { account: wallet.account!, chain, address: o.addr, abi: abiOf(o), functionName: "claim", args: [BigInt(o.id)] });
  },
  settle(wallet: WalletClient, o: Offering) {
    return send(wallet, { account: wallet.account!, chain, address: o.addr, abi: abiOf(o), functionName: "settle", args: [BigInt(o.id), 200] });
  },
  cancel(wallet: WalletClient, o: Offering) {
    return send(wallet, { account: wallet.account!, chain, address: o.addr, abi: abiOf(o), functionName: "cancel", args: [BigInt(o.id)] });
  },
  payIssuer(wallet: WalletClient, o: Offering) {
    return send(wallet, { account: wallet.account!, chain, address: o.addr, abi: abiOf(o), functionName: "payIssuer", args: [BigInt(o.id)] });
  },
  withdrawLp(wallet: WalletClient, o: Offering) {
    return send(wallet, { account: wallet.account!, chain, address: o.addr, abi: CheongyakV2Abi, functionName: "withdrawLp", args: [BigInt(o.id)] });
  },
  setProfile(wallet: WalletClient, o: Offering, p: Profile) {
    return send(wallet, {
      account: wallet.account!,
      chain,
      address: o.addr,
      abi: CheongyakV2Abi,
      functionName: "setMetadata",
      args: [BigInt(o.id), profileJson(p)],
    });
  },
  async mintToken(wallet: WalletClient, factory: Address, name: string, symbol: string, supply: string) {
    const { rc } = await send(wallet, {
      account: wallet.account!,
      chain,
      address: factory,
      abi: TestTokenFactoryAbi,
      functionName: "create",
      args: [name, symbol, parseUnits(supply, 18)],
    });
    // TokenCreated(address indexed token, …): the token is the first indexed topic.
    const log = rc.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase());
    return `0x${log!.topics[1]!.slice(26)}` as Address;
  },
  async create(wallet: WalletClient, addr: Address, o: NewOffering) {
    const total = parseUnits(o.total, 18);
    const liqBps = Math.round(o.liqPct * 100);
    await approve(wallet, o.token, addr, total + (total * BigInt(liqBps)) / 10_000n);
    const start = BigInt(Math.floor(Date.now() / 1000) + Math.round(o.startInMin * 60) + 30);
    const vesting = o.tgePct < 100;
    return send(wallet, {
      account: wallet.account!,
      chain,
      address: addr,
      abi: CheongyakV2Abi,
      functionName: "create",
      args: [
        {
          token: o.token,
          quote: o.quote,
          name: stringToHex(o.name.slice(0, 31), { size: 32 }),
          totalTokens: total,
          price: parseUnits(o.price, 18),
          startAt: start,
          endAt: start + BigInt(Math.round(o.hours * 3600)),
          equalBps: Math.round(o.equalPct * 100),
          minDeposit: parseUnits(o.min, 18),
          maxDeposit: parseUnits(o.max, 18),
          softCap: o.softCap ? parseUnits(o.softCap, 18) : 0n,
          tgeBps: Math.round(o.tgePct * 100),
          cliff: vesting ? o.cliffDays * DAY : 0,
          vesting: vesting ? o.vestingDays * DAY : 0,
          liqBps,
          lpLock: liqBps ? o.lockDays * DAY : 0,
        },
        profileJson(o.profile),
      ],
    });
  },
};

function profileJson(p: Profile) {
  const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, v!.trim()]));
  return Object.keys(clean).length ? JSON.stringify(clean) : "";
}

export async function tokenInfo(token: Address, who?: Address) {
  const [symbol, name, balance] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_META, functionName: "symbol" }),
    client.readContract({ address: token, abi: ERC20_META, functionName: "name" }),
    who ? client.readContract({ address: token, abi: ERC20_META, functionName: "balanceOf", args: [who] }) : Promise.resolve(0n),
  ]);
  return { symbol, name, balance };
}
