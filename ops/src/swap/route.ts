import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, zeroAddress, type Address } from "viem";
import { giwa } from "../chain.ts";
import { config } from "../config.ts";

/**
 * The aggregator's route search, for keepers: the same candidates the web tries (direct pools and
 * one hub through the deepest tokens), quoted on-chain in one batch, best output wins. Pools come
 * from the indexer's routes.json.
 */
const WETH = "0x4200000000000000000000000000000000000006";
export const aggAbi = parseAbi([
  "struct Hop { address pool; uint8 kind; uint24 fee; }",
  "function quote(address[] path, Hop[] hops, uint256 amountIn) view returns (uint256)",
]);
type RoutePool = [string, number, number, string, string, number, string];
export interface Route {
  path: Address[]; // address(0) at either end for native ETH
  hops: { pool: Address; kind: number; fee: number }[];
  out: bigint;
  dexes: string[];
}

let cache: { at: number; pools: RoutePool[] } = { at: 0, pools: [] };
function pools(): RoutePool[] {
  if (Date.now() - cache.at > 30_000) {
    try {
      cache = { at: Date.now(), pools: (JSON.parse(readFileSync(resolve(config.webroot, "routes.json"), "utf8")) as { pools: RoutePool[] }).pools };
    } catch {
      /* keep the last good graph */
    }
  }
  return cache.pools;
}

export async function bestRoute(aggregator: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Route | null> {
  const a = (tokenIn === zeroAddress ? WETH : tokenIn).toLowerCase();
  const b = (tokenOut === zeroAddress ? WETH : tokenOut).toLowerCase();
  if (a === b || amountIn === 0n) return null;
  const ps = pools();
  const g = new Map<string, { p: RoutePool; other: string }[]>();
  const depth = new Map<string, number>();
  for (const p of ps) {
    for (const [x, y] of [
      [p[3], p[4]],
      [p[4], p[3]],
    ]) {
      (g.get(x) ?? g.set(x, []).get(x)!).push({ p, other: y });
      depth.set(x, (depth.get(x) ?? 0) + p[5]);
    }
  }
  for (const es of g.values()) es.sort((x, y) => y.p[5] - x.p[5]);
  const between = (x: string, y: string) => (g.get(x) ?? []).filter((e) => e.other === y).slice(0, 3);
  const cands: { path: string[]; hops: RoutePool[] }[] = between(a, b).map((e) => ({ path: [a, b], hops: [e.p] }));
  const hubs = [WETH, ...[...depth].sort((x, y) => y[1] - x[1]).map(([t]) => t)].filter((t, i, all) => all.indexOf(t) === i && t !== a && t !== b).slice(0, 8);
  for (const h of hubs) for (const x of between(a, h).slice(0, 2)) for (const y of between(h, b).slice(0, 2)) cands.push({ path: [a, h, b], hops: [x.p, y.p] });
  if (!cands.length) return null;
  const toCall = (path: string[]) => path.map((t, i) => ((i === 0 && tokenIn === zeroAddress) || (i === path.length - 1 && tokenOut === zeroAddress) ? zeroAddress : (t as Address)));
  const res = await Promise.all(
    cands.slice(0, 24).map((c) =>
      giwa
        .readContract({ address: aggregator, abi: aggAbi, functionName: "quote", args: [toCall(c.path), c.hops.map((p) => ({ pool: p[0] as Address, kind: p[1], fee: p[2] })), amountIn] })
        .catch(() => 0n),
    ),
  );
  let best: Route | null = null;
  cands.slice(0, 24).forEach((c, i) => {
    if (res[i] > 0n && (!best || res[i] > best.out)) {
      best = { path: toCall(c.path), hops: c.hops.map((p) => ({ pool: p[0] as Address, kind: p[1], fee: p[2] })), out: res[i], dexes: c.hops.map((p) => p[6]) };
    }
  });
  return best;
}
