import { hexToString, maxUint256, parseUnits, type Address, type WalletClient } from "viem";
import { GyeWonAbi, SangjangMarketAbi } from "./abi";
import { chain, client, confirmed, mustHold } from "./chain";

export const STATUS = ["None", "Open", "Proposed", "Disputed", "Resolved", "Voided"] as const;
export type Status = (typeof STATUS)[number];

export interface Market {
  id: number;
  symbol: string;
  createdAt: number;
  closesAt: number;
  cap: bigint;
  status: Status;
  yes: boolean;
  announcedAt: number;
  proposedAt: number;
  yesPool: bigint;
  noPool: bigint;
  effYes: bigint;
  effNo: bigint;
  fee: bigint;
}

export interface Position {
  bets: { at: number; yes: boolean; amount: bigint }[];
  yesStake: bigint;
  noStake: bigint;
  staked: bigint;
  claimable: bigint;
  claimed: boolean;
}

const sym = (b: `0x${string}`) => hexToString(b, { size: 32 }).replace(/\0+$/, "");

function toMarket(id: number, m: Awaited<ReturnType<typeof rawMarket>>): Market {
  return {
    id,
    symbol: sym(m.symbol),
    createdAt: Number(m.createdAt),
    closesAt: Number(m.closesAt),
    cap: m.cap,
    status: STATUS[m.status],
    yes: m.yes,
    announcedAt: Number(m.announcedAt),
    proposedAt: Number(m.proposedAt),
    yesPool: m.yesPool,
    noPool: m.noPool,
    effYes: m.effYes,
    effNo: m.effNo,
    fee: m.fee,
  };
}

function rawMarket(addr: Address, id: number) {
  return client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "market", args: [BigInt(id)] });
}

export async function listMarkets(addr: Address): Promise<Market[]> {
  const n = Number(await client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "marketCount" }));
  const raw = await Promise.all(Array.from({ length: n }, (_, i) => rawMarket(addr, i)));
  return raw.map((m, i) => toMarket(i, m)).reverse();
}

export async function readMarket(addr: Address, id: number) {
  const [m, window, feeBps, bond] = await Promise.all([
    rawMarket(addr, id),
    client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "challengeWindow" }),
    client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "feeBps" }),
    client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "disputeBond" }),
  ]);
  return { market: toMarket(id, m), window: Number(window), feeBps: Number(feeBps), bond };
}

export async function readPosition(addr: Address, id: number, who: Address): Promise<Position> {
  const [bets, claimable, staked, claimed] = await Promise.all([
    client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "betsOf", args: [BigInt(id), who] }),
    client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "claimable", args: [BigInt(id), who] }),
    client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "staked", args: [BigInt(id), who] }),
    client.readContract({ address: addr, abi: SangjangMarketAbi, functionName: "claimed", args: [BigInt(id), who] }),
  ]);
  const bs = bets.map((b) => ({ at: Number(b.at), yes: b.yes, amount: b.amount }));
  return {
    bets: bs,
    yesStake: bs.filter((b) => b.yes).reduce((s, b) => s + b.amount, 0n),
    noStake: bs.filter((b) => !b.yes).reduce((s, b) => s + b.amount, 0n),
    staked,
    claimable,
    claimed,
  };
}

/** Share of the pool on YES, 0..1; 0.5 for an empty market. */
export function yesShare(m: Pick<Market, "yesPool" | "noPool">) {
  const t = m.yesPool + m.noPool;
  return t === 0n ? 0.5 : Number((m.yesPool * 10_000n) / t) / 10_000;
}

/** What 1 won returns if `side` wins at current pools (after the fee on the losing pool). */
export function multiple(m: Pick<Market, "yesPool" | "noPool">, side: boolean, feeBps: number, extra = 0n) {
  const win = (side ? m.yesPool : m.noPool) + extra;
  const lose = side ? m.noPool : m.yesPool;
  if (win === 0n) return null;
  const net = (lose * BigInt(10_000 - feeBps)) / 10_000n;
  return 1 + Number((net * 10_000n) / win) / 10_000;
}

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return hash;
}

export const sangjang = {
  async bet(wallet: WalletClient, addr: Address, token: Address, id: number, yes: boolean, won: string) {
    const amount = parseUnits(won, 18);
    const owner = wallet.account!.address;
    await mustHold(token, owner, amount);
    const allowance = await client.readContract({ address: token, abi: GyeWonAbi, functionName: "allowance", args: [owner, addr] });
    if (allowance < amount) {
      await send(wallet, { account: wallet.account!, chain, address: token, abi: GyeWonAbi, functionName: "approve", args: [addr, maxUint256] });
    }
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: SangjangMarketAbi, functionName: "bet", args: [BigInt(id), yes, amount] });
  },
  claim(wallet: WalletClient, addr: Address, id: number) {
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: SangjangMarketAbi, functionName: "claim", args: [BigInt(id)] });
  },
  finalize(wallet: WalletClient, addr: Address, id: number) {
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: SangjangMarketAbi, functionName: "finalize", args: [BigInt(id)] });
  },
  async dispute(wallet: WalletClient, addr: Address, token: Address, id: number, bond: bigint) {
    const owner = wallet.account!.address;
    await mustHold(token, owner, bond);
    const allowance = await client.readContract({ address: token, abi: GyeWonAbi, functionName: "allowance", args: [owner, addr] });
    if (allowance < bond) {
      await send(wallet, { account: wallet.account!, chain, address: token, abi: GyeWonAbi, functionName: "approve", args: [addr, maxUint256] });
    }
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: SangjangMarketAbi, functionName: "dispute", args: [BigInt(id)] });
  },
};

export const UPBIT_NOTICES = "https://upbit.com/service_center/notice";
