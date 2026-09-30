import { createPublicClient, fallback, http, parseAbi, type Address, type Hex, type WalletClient } from "viem";
import { sepolia } from "viem/chains";
import { getWithdrawals, publicActionsL1, publicActionsL2, walletActionsL1, type WalletActionsL1 } from "viem/op-stack";
import { chain, client, confirmed } from "./chain";

/** Ethereum Sepolia, where deposits start. */
export const l1 = createPublicClient({
  chain: sepolia,
  transport: fallback([http("https://ethereum-sepolia-rpc.publicnode.com"), http("https://sepolia.gateway.tenderly.co"), http("https://11155111.rpc.thirdweb.com")]),
}).extend(publicActionsL1());
const l2 = client.extend(publicActionsL2());

const bridgeAbi = parseAbi([
  "function deposit(address to) payable",
  "function quote(uint256 amount) view returns (uint256 received, uint256 fee)",
  "function feeBps() view returns (uint16)",
  "function minDeposit() view returns (uint256)",
]);

/** Fee and minimum of a front door: the deposit one on Ethereum, or the withdrawal one on GIWA. */
export async function bridgeTerms(bridge: Address, on: "l1" | "giwa" = "l1") {
  const c = on === "l1" ? l1 : client;
  const [feeBps, minDeposit] = await Promise.all([
    c.readContract({ address: bridge, abi: bridgeAbi, functionName: "feeBps" }),
    c.readContract({ address: bridge, abi: bridgeAbi, functionName: "minDeposit" }),
  ]);
  return { feeBps, minDeposit };
}

export async function balances(who: Address) {
  const [onL1, onGiwa] = await Promise.all([l1.getBalance({ address: who }), client.getBalance({ address: who })]);
  return { onL1, onGiwa };
}

/**
 * Sends the deposit from Ethereum Sepolia, then puts the wallet back on GIWA so the rest of
 * Jangteo keeps working. Returns the L1 hash once it is mined.
 */
export async function deposit(wallet: WalletClient, bridge: Address, to: Address, amount: bigint) {
  await wallet.switchChain({ id: sepolia.id });
  try {
    const hash = await wallet.writeContract({ account: wallet.account!, chain: sepolia, address: bridge, abi: bridgeAbi, functionName: "deposit", args: [to], value: amount });
    const rc = await l1.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
    return hash;
  } finally {
    await wallet.switchChain({ id: chain.id }).catch(() => {});
  }
}

/** Resolves when `who`'s GIWA balance has grown by at least `expect` over `before`. */
export async function waitArrival(who: Address, before: bigint, expect: bigint, onTick?: (sec: number) => void) {
  const t0 = Date.now();
  for (;;) {
    const now = await client.getBalance({ address: who }).catch(() => before);
    if (now - before >= expect) return Math.round((Date.now() - t0) / 1000);
    onTick?.(Math.round((Date.now() - t0) / 1000));
    await new Promise((r) => setTimeout(r, 5000));
    if (Date.now() - t0 > 15 * 60_000) throw new Error("timeout");
  }
}

// ───────────────────────────── withdrawals (GIWA → Ethereum) ─────────────────────────────

export type WithdrawalStatus = "waiting-to-prove" | "ready-to-prove" | "waiting-to-finalize" | "ready-to-finalize" | "finalized";

export interface Withdrawal {
  l2Tx: Hex;
  hash: Hex;
  from: Address;
  to: Address;
  amount: string;
  fee: string;
  startedAt: number;
  status: WithdrawalStatus;
  proveTx?: Hex;
  finalizeTx?: Hex;
  prover?: Address;
  nextAt?: number;
  relayed: boolean;
  kind?: "fast";
  id?: string;
  fillTx?: Hex;
  filledAt?: number;
}

/** Withdrawals through Jangteo's front doors, as the ops keeper last saw them, and the fast float. */
export async function loadWithdrawals(): Promise<Withdrawal[]> {
  return (await loadWithdrawalFile()).withdrawals;
}

export async function loadWithdrawalFile(): Promise<{ withdrawals: Withdrawal[]; fastLiquidity: bigint }> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}withdrawals.json`, { cache: "no-store" });
    if (!res.ok) return { withdrawals: [], fastLiquidity: 0n };
    const j = (await res.json()) as { withdrawals: Withdrawal[]; fastLiquidity?: string };
    return { withdrawals: j.withdrawals, fastLiquidity: BigInt(j.fastLiquidity ?? "0") };
  } catch {
    return { withdrawals: [], fastLiquidity: 0n };
  }
}

const fastAbi = parseAbi([
  "function exit(address to) payable returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function flatFee() view returns (uint256)",
  "function minExit() view returns (uint256)",
  "function maxExit() view returns (uint256)",
]);

export async function fastTerms(exit: Address) {
  const [feeBps, flatFee, minExit, maxExit] = await Promise.all(
    (["feeBps", "flatFee", "minExit", "maxExit"] as const).map((f) => client.readContract({ address: exit, abi: fastAbi, functionName: f })),
  );
  return { feeBps: Number(feeBps), flatFee: flatFee as bigint, minExit: minExit as bigint, maxExit: maxExit as bigint };
}

/** 장터 빠른 출금: the whole amount enters GIWA's withdrawal; Jangteo pays `to` on Ethereum within minutes. */
export async function fastExit(wallet: WalletClient, exit: Address, to: Address, amount: bigint) {
  const hash = await wallet.writeContract({ account: wallet.account!, chain, address: exit, abi: fastAbi, functionName: "exit", args: [to], value: amount });
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return hash;
}

/** Starts a withdrawal on GIWA: `amount` less 0.5% goes to `to` on Ethereum Sepolia. */
export async function withdraw(wallet: WalletClient, door: Address, to: Address, amount: bigint) {
  const hash = await wallet.writeContract({ account: wallet.account!, chain, address: door, abi: bridgeAbi, functionName: "deposit", args: [to], value: amount });
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return hash;
}

/** The withdrawal's live state on L1, read straight from GIWA's portal. */
export async function withdrawalStatus(l2Tx: Hex): Promise<WithdrawalStatus> {
  const receipt = await client.getTransactionReceipt({ hash: l2Tx });
  return l1.getWithdrawalStatus({ receipt, targetChain: chain } as never);
}

type L1Wallet = WalletClient & WalletActionsL1;

async function onL1(wallet: WalletClient, fn: (w: L1Wallet) => Promise<Hex>) {
  await wallet.switchChain({ id: sepolia.id });
  try {
    const hash = await fn(wallet.extend(walletActionsL1()) as unknown as L1Wallet);
    const rc = await l1.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
    return hash;
  } finally {
    await wallet.switchChain({ id: chain.id }).catch(() => {});
  }
}

/** Step 2: prove the withdrawal on Ethereum against the dispute game that covers its block. */
export async function proveWithdrawal(wallet: WalletClient, l2Tx: Hex) {
  const receipt = await client.getTransactionReceipt({ hash: l2Tx });
  const [w] = getWithdrawals(receipt);
  const game = await l1.getGame({ l2BlockNumber: receipt.blockNumber, targetChain: chain } as never);
  const args = await l2.buildProveWithdrawal({ withdrawal: w, game } as never);
  return onL1(wallet, (x) => x.proveWithdrawal({ ...(args as object), account: wallet.account!, chain: sepolia } as never));
}

/** Step 3: once the 7-day proof window has passed, release the ETH on Ethereum. */
export async function claimWithdrawal(wallet: WalletClient, l2Tx: Hex) {
  const receipt = await client.getTransactionReceipt({ hash: l2Tx });
  const [w] = getWithdrawals(receipt);
  return onL1(wallet, (x) => x.finalizeWithdrawal({ withdrawal: w, targetChain: chain, account: wallet.account!, chain: sepolia } as never));
}
