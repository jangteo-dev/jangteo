import { maxUint256, parseAbi, parseUnits, zeroAddress, type Address, type WalletClient } from "viem";
import { chain, client, confirmed, mustHold } from "./chain";

/**
 * 장터 스왑 limit orders and DCA (JangteoOrders). Every pair on the trade page is quoted in ETH:
 * a bid sells ETH for the token, an ask sells the token for ETH. Prices are ETH per whole token.
 *
 * The contract's `minRate` is raw tokenOut per raw tokenIn × 1e18, so for a token with `d` decimals
 * at price P (ETH per token, as P18 = P × 1e18):
 *   bid (ETH → token):  minRate = 10^d × 1e18 / P18
 *   ask (token → ETH):  minRate = P18 × 1e18 / 10^d
 */
const abi = parseAbi([
  "function createLimit(address tokenIn, address tokenOut, uint256 amount, uint256 minRate, uint64 expiry) payable returns (uint256)",
  "function createDca(address tokenIn, address tokenOut, uint256 amount, uint32 slices, uint32 interval, uint256 minRate) payable returns (uint256)",
  "function cancel(uint256 id)",
  "function feeBps() view returns (uint16)",
]);
const erc20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const E18 = 10n ** 18n;

export interface BookOrder {
  id: number;
  owner: Address;
  tokenIn: Address;
  tokenOut: Address;
  total: string;
  remaining: string;
  minRate: string;
  expiry: number;
  slices: number;
  done: number;
  interval: number;
  nextAt: number;
}
export interface Fill {
  id: number;
  amountIn: string;
  amountOut: string;
  at: number;
  tx: string;
}

export async function loadOrders(): Promise<{ open: BookOrder[]; fills: Fill[] }> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}orders.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as { open: BookOrder[]; fills: Fill[] }) : { open: [], fills: [] };
  } catch {
    return { open: [], fills: [] };
  }
}

export const isEth = (a: string) => a.toLowerCase() === zeroAddress;

export function rateFor(side: "buy" | "sell", priceEth: string, decimals: number): bigint {
  const p18 = parseUnits(priceEth, 18);
  if (p18 === 0n) return 0n;
  const unit = 10n ** BigInt(decimals);
  return side === "buy" ? (unit * E18) / p18 : (p18 * E18) / unit;
}

/** The ETH-per-token price an order is asking for, and its remaining size in tokens. */
export function priceOf(o: BookOrder, decimals: number): { side: "buy" | "sell"; price: number; size: number } {
  const unit = 10 ** decimals;
  const rate = Number(o.minRate) / 1e18;
  if (isEth(o.tokenIn)) {
    // bid: rate = raw tokens per raw wei
    const price = rate > 0 ? unit / 1e18 / rate : 0;
    return { side: "buy", price, size: price > 0 ? Number(o.remaining) / 1e18 / price : 0 };
  }
  return { side: "sell", price: (rate * unit) / 1e18, size: Number(o.remaining) / unit };
}

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return hash;
}

async function approve(wallet: WalletClient, token: Address, spender: Address, amount: bigint) {
  await mustHold(token, wallet.account!.address, amount);
  const account = wallet.account!;
  const a = await client.readContract({ address: token, abi: erc20, functionName: "allowance", args: [account.address, spender] });
  if (a < amount) await send(wallet, { account, chain, address: token, abi: erc20, functionName: "approve", args: [spender, maxUint256] });
}

export async function placeLimit(wallet: WalletClient, orders: Address, tokenIn: Address, tokenOut: Address, amount: bigint, minRate: bigint, days: number) {
  const account = wallet.account!;
  if (!isEth(tokenIn)) await approve(wallet, tokenIn, orders, amount);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
  return send(wallet, { account, chain, address: orders, abi, functionName: "createLimit", args: [tokenIn, tokenOut, amount, minRate, expiry], value: isEth(tokenIn) ? amount : 0n });
}

export async function placeDca(wallet: WalletClient, orders: Address, tokenIn: Address, tokenOut: Address, amount: bigint, slices: number, interval: number, minRate: bigint) {
  const account = wallet.account!;
  if (!isEth(tokenIn)) await approve(wallet, tokenIn, orders, amount);
  return send(wallet, { account, chain, address: orders, abi, functionName: "createDca", args: [tokenIn, tokenOut, amount, slices, interval, minRate], value: isEth(tokenIn) ? amount : 0n });
}

export async function cancelOrder(wallet: WalletClient, orders: Address, id: number) {
  return send(wallet, { account: wallet.account!, chain, address: orders, abi, functionName: "cancel", args: [BigInt(id)] });
}
