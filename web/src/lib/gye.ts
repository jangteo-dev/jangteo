import { formatUnits, maxUint256, parseUnits, type Address, type WalletClient } from "viem";
import { GyeCircleAbi, GyeFactoryAbi, GyeReputationAbi, GyeWonAbi, DojangGateAbi } from "./abi";
import { client, chain, DOJANG, type Deployment, confirmed, mustHold } from "./chain";

export const PHASES = ["None", "Filling", "Active", "Completed", "Cancelled"] as const;
export const MODES = ["Ordered", "Random", "Auction"] as const;
export type Mode = (typeof MODES)[number];

/** The Korean name of each way to give out the pot; titles and explanations live in i18n. */
export const MODE_KO: Record<Mode, string> = { Ordered: "번호계", Random: "추첨계", Auction: "낙찰계" };

export interface Member {
  address: Address;
  exists: boolean;
  received: boolean;
  defaulted: boolean;
  receivedRound: number;
  holdbackBps: number;
  missed: number;
  paidMask: bigint;
  escrow: bigint;
  debt: bigint;
  owed: bigint;
  claimable: bigint;
  creditUsd: bigint;
}

export interface Circle {
  address: Address;
  phase: (typeof PHASES)[number];
  mode: Mode;
  name: string;
  token: Address;
  contribution: bigint;
  size: number;
  roundDuration: number;
  maxDiscountBps: number;
  feeBps: number;
  fillDeadline: number;
  creator: Address;
  round: number;
  deadline: number;
  roundCollected: bigint;
  bestBidder: Address;
  bestBid: bigint;
  members: Member[];
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function bytes32ToName(b: `0x${string}`) {
  const hex = b.slice(2).replace(/(00)+$/, "");
  const bytes = new Uint8Array(hex.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
  return new TextDecoder().decode(bytes);
}

export function nameToBytes32(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s.slice(0, 31));
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0")}`;
}

export const paidRound = (m: Member, round: number) => round > 0 && (m.paidMask & (1n << BigInt(round - 1))) !== 0n;

export async function listCircles(d: Deployment): Promise<Address[]> {
  const n = await client.readContract({ address: d.factory, abi: GyeFactoryAbi, functionName: "circleCount" });
  if (n === 0n) return [];
  const page = await client.readContract({ address: d.factory, abi: GyeFactoryAbi, functionName: "circles", args: [0n, n] });
  return [...page].reverse();
}

export async function readCircle(address: Address): Promise<Circle> {
  const [s, addrs] = await Promise.all([
    client.readContract({ address, abi: GyeCircleAbi, functionName: "snapshot" }),
    client.readContract({ address, abi: GyeCircleAbi, functionName: "members" }),
  ]);
  const ms = await Promise.all(addrs.map((a) => client.readContract({ address, abi: GyeCircleAbi, functionName: "memberOf", args: [a] })));
  return {
    address,
    phase: PHASES[s.phase],
    mode: MODES[s.config.mode],
    name: bytes32ToName(s.config.name),
    token: s.config.token,
    contribution: s.config.contribution,
    size: s.config.size,
    roundDuration: s.config.roundDuration,
    maxDiscountBps: s.config.maxDiscountBps,
    feeBps: s.feeBps,
    fillDeadline: Number(s.config.fillDeadline),
    creator: s.creator,
    round: s.round,
    deadline: Number(s.deadline),
    roundCollected: s.roundCollected,
    bestBidder: s.bestBidder === ZERO ? ZERO : s.bestBidder,
    bestBid: s.bestBid,
    members: ms.map((m, i) => ({ address: addrs[i], ...m, paidMask: BigInt(m.paidMask) })),
  };
}

export interface Record_ {
  completed: number;
  late: number;
  defaults: number;
  active: number;
  provenUsd: bigint;
  creditInUse: bigint;
  lossUsd: bigint;
  holdbackBps: number;
  availableCredit: bigint;
  maxConcurrent: number;
}

export async function readRecord(d: Deployment, who: Address): Promise<Record_> {
  const [r, hb, credit, maxC] = await Promise.all([
    client.readContract({ address: d.reputation, abi: GyeReputationAbi, functionName: "recordOf", args: [who] }),
    client.readContract({ address: d.reputation, abi: GyeReputationAbi, functionName: "holdbackBps", args: [who] }),
    client.readContract({ address: d.reputation, abi: GyeReputationAbi, functionName: "availableCredit", args: [who] }),
    client.readContract({ address: d.reputation, abi: GyeReputationAbi, functionName: "maxConcurrent", args: [who] }),
  ]);
  return { ...r, holdbackBps: hb, availableCredit: credit, maxConcurrent: maxC };
}

export async function readIdentity(d: Deployment, who: Address) {
  const [eligible, upbit, testnet, eth, won, lastDrip] = await Promise.all([
    client.readContract({ address: d.gate, abi: DojangGateAbi, functionName: "isEligible", args: [who] }),
    client.readContract({ address: DOJANG.scroll, abi: SCROLL, functionName: "isVerified", args: [who, DOJANG.upbit] }).catch(() => false),
    client.readContract({ address: DOJANG.scroll, abi: SCROLL, functionName: "isVerified", args: [who, DOJANG.testnet] }).catch(() => false),
    client.getBalance({ address: who }),
    client.readContract({ address: d.tkrw, abi: GyeWonAbi, functionName: "balanceOf", args: [who] }),
    client.readContract({ address: d.tkrw, abi: GyeWonAbi, functionName: "lastDrip", args: [who] }),
  ]);
  return { eligible, upbit, testnet, eth, won, lastDrip: Number(lastDrip) };
}

const SCROLL = [
  { type: "function", name: "isVerified", stateMutability: "view", inputs: [{ name: "addr", type: "address" }, { name: "attesterId", type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;
const FAUCET_EXT = [
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "payAndIssueEAS", stateMutability: "payable", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

// ───────────────────────────── writes ─────────────────────────────

// viem's per-ABI generics don't survive a shared helper; each call site passes a typed literal.
/** The circle a createCircle transaction made (the factory's CircleCreated event, first topic). */
export async function circleFromTx(hash: `0x${string}`, factory: Address): Promise<`0x${string}` | null> {
  const rc = await client.getTransactionReceipt({ hash }).catch(() => null);
  const log = rc?.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase() && l.topics.length === 4);
  return log?.topics[1] ? (`0x${log.topics[1].slice(26)}` as `0x${string}`) : null;
}

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return hash;
}

async function ensureAllowance(wallet: WalletClient, token: Address, spender: Address, amount: bigint) {
  await mustHold(token, wallet.account!.address, amount);
  const owner = wallet.account!.address;
  const allowance = await client.readContract({ address: token, abi: GyeWonAbi, functionName: "allowance", args: [owner, spender] });
  if (allowance >= amount) return;
  await send(wallet, { account: wallet.account!, chain, address: token, abi: GyeWonAbi, functionName: "approve", args: [spender, maxUint256] });
}

export const actions = {
  async verifyTestnet(wallet: WalletClient) {
    const fee = await client.readContract({ address: DOJANG.faucetExtension, abi: FAUCET_EXT, functionName: "fee" });
    return send(wallet, { account: wallet.account!, chain, address: DOJANG.faucetExtension, abi: FAUCET_EXT, functionName: "payAndIssueEAS", value: fee });
  },
  drip(wallet: WalletClient, d: Deployment) {
    return send(wallet, { account: wallet.account!, chain, address: d.tkrw, abi: GyeWonAbi, functionName: "drip" });
  },
  async join(wallet: WalletClient, c: Circle) {
    await ensureAllowance(wallet, c.token, c.address, c.contribution);
    return send(wallet, { account: wallet.account!, chain, address: c.address, abi: GyeCircleAbi, functionName: "join" });
  },
  leave(wallet: WalletClient, c: Circle) {
    return send(wallet, { account: wallet.account!, chain, address: c.address, abi: GyeCircleAbi, functionName: "leave" });
  },
  async contribute(wallet: WalletClient, c: Circle) {
    await ensureAllowance(wallet, c.token, c.address, c.contribution);
    return send(wallet, { account: wallet.account!, chain, address: c.address, abi: GyeCircleAbi, functionName: "contribute" });
  },
  bid(wallet: WalletClient, c: Circle, discount: bigint) {
    return send(wallet, { account: wallet.account!, chain, address: c.address, abi: GyeCircleAbi, functionName: "bid", args: [discount] });
  },
  settle(wallet: WalletClient, c: Circle) {
    return send(wallet, { account: wallet.account!, chain, address: c.address, abi: GyeCircleAbi, functionName: "settle" });
  },
  claim(wallet: WalletClient, c: Circle) {
    return send(wallet, { account: wallet.account!, chain, address: c.address, abi: GyeCircleAbi, functionName: "claim" });
  },
  cancel(wallet: WalletClient, c: Circle) {
    return send(wallet, { account: wallet.account!, chain, address: c.address, abi: GyeCircleAbi, functionName: "cancel" });
  },
  async repay(wallet: WalletClient, c: Circle, amount: bigint) {
    await ensureAllowance(wallet, c.token, c.address, amount);
    return send(wallet, { account: wallet.account!, chain, address: c.address, abi: GyeCircleAbi, functionName: "repayDebt", args: [amount] });
  },
  async create(
    wallet: WalletClient,
    d: Deployment,
    cfg: { name: string; contributionWon: string; size: number; mode: Mode; roundSeconds: number; maxDiscountPct: number; fillDays: number },
  ) {
    const contribution = parseUnits(cfg.contributionWon, 18);
    await ensureAllowance(wallet, d.tkrw, d.factory, contribution);
    const now = Math.floor(Date.now() / 1000);
    return send(wallet, {
      account: wallet.account!,
      chain,
      address: d.factory,
      abi: GyeFactoryAbi,
      functionName: "createCircle",
      args: [
        {
          token: d.tkrw,
          contribution,
          size: cfg.size,
          mode: MODES.indexOf(cfg.mode),
          roundDuration: cfg.roundSeconds,
          maxDiscountBps: cfg.mode === "Auction" ? Math.round(cfg.maxDiscountPct * 100) : 0,
          fillDeadline: BigInt(now + Math.round(cfg.fillDays * 86400)),
          name: nameToBytes32(cfg.name),
        },
        true,
      ],
    });
  },
};

// ───────────────────────────── format ─────────────────────────────

export const won = (v: bigint) => `₩${Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
export const usd = (v: bigint) => `$${Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

type ErrorCopy = Record<string, string> & { rejected: string; reverted: string; generic: string };

/** Turns wallet and contract errors into one sentence in the reader's language. */
export function friendlyError(err: unknown, copy: ErrorCopy): string {
  const e = err as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  const text = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
  const name = e?.cause?.data?.errorName ?? text.match(/reverted with the following reason:\s*(\w+)/)?.[1] ?? "";
  for (const k of Object.keys(copy)) {
    if (["rejected", "reverted", "generic", "wouldFail", "slippage"].includes(k)) continue;
    if (name === k || new RegExp(`\\b${k}\\b`).test(text)) return copy[k];
  }
  if (/User rejected|User denied|rejected the request/i.test(text)) return copy.rejected;
  if (/reverted on-chain/.test(text)) return copy.reverted;
  // Custom errors we did not name above: slippage guards, then anything a simulation refused.
  if (/Slippage|InsufficientOutput|TooLittle|INSUFFICIENT_OUTPUT/i.test(`${name} ${text}`)) return copy.slippage;
  if (/reverted with the following signature|execution reverted|reverted for an unknown reason/i.test(text)) return copy.wouldFail;
  return e?.shortMessage?.split("\n")[0] ?? copy.generic;
}
