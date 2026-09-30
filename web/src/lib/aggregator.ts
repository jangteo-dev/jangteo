import { maxUint256, parseAbi, zeroAddress, type Address, type WalletClient } from "viem";
import { chain, client, confirmed, mustHold } from "./chain";
import { ETH, WETH } from "./swap";

/**
 * 장터 스왑's aggregator: one contract that swaps through any DEX on GIWA. The indexer publishes
 * every routable pool (routes.json); this module searches that graph for direct and one-hub routes,
 * asks the contract to quote them all in one multicall, and sends the best one.
 */
const aggAbi = parseAbi([
  "struct Hop { address pool; uint8 kind; uint24 fee; }",
  // Not a view on-chain (V3 pools are asked by a reverting swap), but safe to eth_call, so it batches.
  "function quote(address[] path, Hop[] hops, uint256 amountIn) view returns (uint256)",
  "function feeFor(address[] path, Hop[] hops, uint256 amountIn) view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function swap(address[] path, Hop[] hops, uint256 amountIn, uint256 minOut, address to, uint256 deadline) payable returns (uint256)",
]);
const erc20Abi = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);

/** [pool, kind, fee, token0, token1, liquidity in ETH, dex] */
export type RoutePool = [string, number, number, string, string, number, string];
export interface Hop {
  pool: Address;
  kind: number;
  fee: number;
}
export interface AggQuote {
  via: "agg";
  path: Address[]; // tokens as the graph sees them (WETH for ETH), for display
  callPath: Address[]; // what the contract takes: address(0) for native ETH
  hops: Hop[];
  dexes: string[];
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  impactBps: number;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export async function loadRoutes(): Promise<RoutePool[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}routes.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as { pools: RoutePool[] }).pools : [];
  } catch {
    return [];
  }
}

type Edge = { p: RoutePool; other: string };

function graph(pools: RoutePool[]) {
  const g = new Map<string, Edge[]>();
  const add = (t: string, e: Edge) => (g.get(t) ?? g.set(t, []).get(t)!).push(e);
  for (const p of pools) {
    add(p[3], { p, other: p[4] });
    add(p[4], { p, other: p[3] });
  }
  for (const es of g.values()) es.sort((a, b) => b.p[5] - a.p[5]);
  return g;
}

/** Tokens reachable through the aggregator, deepest first. */
export function routableTokens(pools: RoutePool[]): Map<string, number> {
  const depth = new Map<string, number>();
  for (const p of pools) for (const t of [p[3], p[4]]) depth.set(t, (depth.get(t) ?? 0) + p[5]);
  return depth;
}

/** Direct pools (up to 3), and routes through the deepest hubs (WETH first), up to ~24 candidates. */
function candidates(pools: RoutePool[], a: string, b: string): { path: string[]; hops: RoutePool[] }[] {
  const g = graph(pools);
  const out: { path: string[]; hops: RoutePool[] }[] = [];
  const between = (x: string, y: string) => (g.get(x) ?? []).filter((e) => e.other === y).slice(0, 3);
  for (const e of between(a, b)) out.push({ path: [a, b], hops: [e.p] });
  const depth = routableTokens(pools);
  const hubs = [WETH.toLowerCase(), ...[...depth].sort((x, y) => y[1] - x[1]).map(([t]) => t)]
    .filter((t, i, all) => all.indexOf(t) === i && t !== a && t !== b)
    .slice(0, 8);
  for (const h of hubs) {
    const l1 = between(a, h).slice(0, 2);
    const l2 = between(h, b).slice(0, 2);
    for (const x of l1) for (const y of l2) out.push({ path: [a, h, b], hops: [x.p, y.p] });
  }
  return out.slice(0, 24);
}

export async function aggQuote(agg: Address, pools: RoutePool[], tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<AggQuote | null> {
  const a = (same(tokenIn, ETH) ? WETH : tokenIn).toLowerCase();
  const b = (same(tokenOut, ETH) ? WETH : tokenOut).toLowerCase();
  if (a === b || amountIn === 0n) return null;
  const cs = candidates(pools, a, b);
  if (!cs.length) return null;
  const toCall = (path: string[]) =>
    path.map((t, i) => ((i === 0 && same(tokenIn, ETH)) || (i === path.length - 1 && same(tokenOut, ETH)) ? zeroAddress : (t as Address)));
  const hopsOf = (hs: RoutePool[]): Hop[] => hs.map((p) => ({ pool: p[0] as Address, kind: p[1], fee: p[2] }));
  // Each route is quoted at full size and at 1/1000 of it: the small one is the no-impact price.
  const small = amountIn / 1000n || 1n;
  const res = await Promise.all(
    cs.flatMap((c) =>
      [amountIn, small].map((amt) =>
        client
          .readContract({ address: agg, abi: aggAbi, functionName: "quote", args: [toCall(c.path), hopsOf(c.hops), amt] })
          .catch(() => 0n),
      ),
    ),
  );
  let best: AggQuote | null = null;
  cs.forEach((c, i) => {
    const out = res[2 * i];
    const tiny = res[2 * i + 1];
    if (out === 0n || (best && out <= best.amountOut)) return;
    const ideal = (tiny * amountIn) / small;
    best = {
      via: "agg",
      path: c.path as Address[],
      callPath: toCall(c.path),
      hops: hopsOf(c.hops),
      dexes: c.hops.map((h) => h[6]),
      amountIn,
      amountOut: out,
      fee: 0n,
      impactBps: ideal > out ? Number(((ideal - out) * 10_000n) / ideal) : 0,
    };
  });
  if (best) {
    const q = best as AggQuote;
    q.fee = await client.readContract({ address: agg, abi: aggAbi, functionName: "feeFor", args: [q.callPath, q.hops, amountIn] }).catch(() => 0n);
  }
  return best;
}

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return { hash, rc };
}

export async function aggSwap(wallet: WalletClient, agg: Address, q: AggQuote, slippageBps: number) {
  const account = wallet.account!;
  const min = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const ethIn = q.callPath[0] === zeroAddress;
  if (!ethIn) {
    await mustHold(q.callPath[0], account.address, q.amountIn);
    const allowance = await client.readContract({ address: q.callPath[0], abi: erc20Abi, functionName: "allowance", args: [account.address, agg] });
    if (allowance < q.amountIn) await send(wallet, { account, chain, address: q.callPath[0], abi: erc20Abi, functionName: "approve", args: [agg, maxUint256] });
  }
  const req = {
    account,
    chain,
    address: agg,
    abi: aggAbi,
    functionName: "swap",
    args: [q.callPath, q.hops, q.amountIn, min, account.address, deadline],
    value: ethIn ? q.amountIn : 0n,
  } as const;
  // Simulate first: a DEX that misbehaves fails here, before the wallet asks for a signature.
  await client.simulateContract(req);
  return send(wallet, req);
}
