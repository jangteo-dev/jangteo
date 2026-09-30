import { formatUnits, maxUint256, parseAbi, parseUnits, zeroAddress, type Address, type WalletClient } from "viem";
import { chain, client, confirmed, mustHold } from "./chain";

/** Native ETH is shown as its own token; the router wraps it on the way in and out. */
export const ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const WETH: Address = "0x4200000000000000000000000000000000000006";

const factoryAbi = parseAbi([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function feeTo() view returns (address)",
]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256, uint256)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256)",
  "function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256, uint256)",
]);
const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

export interface Token {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
}

export interface Pool {
  pair: Address;
  token0: Token;
  token1: Token;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
}

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
/** The address a token trades as inside pools. */
export const wrapped = (a: Address) => (same(a, ETH) ? WETH : a);

const tokenCache = new Map<string, Promise<Token>>();
export function readToken(address: Address): Promise<Token> {
  if (same(address, ETH)) return Promise.resolve({ address: ETH, symbol: "ETH", name: "Ether", decimals: 18 });
  const k = address.toLowerCase();
  if (!tokenCache.has(k)) {
    const p = Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20Abi, functionName: "name" }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]).then(([symbol, name, decimals]) => ({ address, symbol, name, decimals }));
    p.catch(() => tokenCache.delete(k));
    tokenCache.set(k, p);
  }
  return tokenCache.get(k)!;
}

export async function listPools(factory: Address): Promise<Pool[]> {
  const n = Number(await client.readContract({ address: factory, abi: factoryAbi, functionName: "allPairsLength" }));
  const pairs = await Promise.all(Array.from({ length: n }, (_, i) => client.readContract({ address: factory, abi: factoryAbi, functionName: "allPairs", args: [BigInt(i)] })));
  const pools = await Promise.all(
    pairs.map(async (pair) => {
      const [t0, t1, [r0, r1], totalSupply] = await Promise.all([
        client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
        client.readContract({ address: pair, abi: pairAbi, functionName: "token1" }),
        client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
        client.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" }),
      ]);
      const [token0, token1] = await Promise.all([readToken(t0), readToken(t1)]);
      return { pair, token0, token1, reserve0: r0, reserve1: r1, totalSupply };
    }),
  );
  return pools.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n);
}

/** Tokens worth offering in the picker: ETH, the bases, and everything with a live pool. */
export function tokenList(pools: Pool[], bases: Token[]): Token[] {
  const out = new Map<string, Token>();
  out.set(ETH.toLowerCase(), { address: ETH, symbol: "ETH", name: "Ether", decimals: 18 });
  for (const t of [...bases, ...pools.flatMap((p) => [p.token0, p.token1])]) out.set(t.address.toLowerCase(), t);
  return [...out.values()];
}

export async function balanceOf(token: Address, who: Address) {
  if (same(token, ETH)) return client.getBalance({ address: who });
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

export interface Quote {
  path: Address[];
  amountIn: bigint;
  amountOut: bigint;
  /** Output at the pools' current prices with no size effect, for price impact. */
  ideal: bigint;
  impactBps: number;
}

const reservesFor = (pools: Pool[], a: Address, b: Address) => {
  const p = pools.find((x) => (same(x.token0.address, a) && same(x.token1.address, b)) || (same(x.token0.address, b) && same(x.token1.address, a)));
  if (!p) return null;
  return same(p.token0.address, a) ? [p.reserve0, p.reserve1] : [p.reserve1, p.reserve0];
};

/** Best of: direct, or one hop through a base token. */
export async function bestQuote(router: Address, pools: Pool[], bases: Address[], tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null> {
  const a = wrapped(tokenIn);
  const b = wrapped(tokenOut);
  if (same(a, b) || amountIn === 0n) return null;
  const paths: Address[][] = [[a, b], ...bases.filter((m) => !same(m, a) && !same(m, b)).map((m) => [a, m, b])];
  const usable = paths.filter((p) => p.slice(1).every((t, i) => reservesFor(pools, p[i], t)));
  const quotes = await Promise.all(
    usable.map(async (path) => {
      try {
        const amounts = await client.readContract({ address: router, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path] });
        let ideal = amountIn;
        for (let i = 0; i < path.length - 1; i++) {
          const [rin, rout] = reservesFor(pools, path[i], path[i + 1])!;
          ideal = (ideal * rout) / rin;
        }
        const out = amounts[amounts.length - 1];
        const impactBps = ideal === 0n ? 10_000 : Number(((ideal - out) * 10_000n) / ideal);
        return { path, amountIn, amountOut: out, ideal, impactBps } satisfies Quote;
      } catch {
        return null;
      }
    }),
  );
  return quotes.filter((q): q is Quote => !!q).sort((x, y) => (y.amountOut > x.amountOut ? 1 : -1))[0] ?? null;
}

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return { hash, rc };
}

export async function swap(wallet: WalletClient, router: Address, tokenIn: Address, tokenOut: Address, q: Quote, slippageBps: number) {
  const account = wallet.account!;
  const min = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  if (same(tokenIn, ETH)) {
    return send(wallet, { account, chain, address: router, abi: routerAbi, functionName: "swapExactETHForTokens", args: [min, q.path, account.address, deadline], value: q.amountIn });
  }
  await mustHold(tokenIn, account.address, q.amountIn);
  const allowance = await client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [account.address, router] });
  if (allowance < q.amountIn) await send(wallet, { account, chain, address: tokenIn, abi: erc20Abi, functionName: "approve", args: [router, maxUint256] });
  const fn = same(tokenOut, ETH) ? "swapExactTokensForETH" : "swapExactTokensForTokens";
  return send(wallet, { account, chain, address: router, abi: routerAbi, functionName: fn, args: [q.amountIn, min, q.path, account.address, deadline] });
}

export const parseAmount = (v: string, t: Token) => {
  try {
    return v ? parseUnits(v, t.decimals) : 0n;
  } catch {
    return 0n;
  }
};

export const fmtAmount = (v: bigint, t: Pick<Token, "decimals">, max = 6) => {
  const n = Number(formatUnits(v, t.decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : max });
};

/** Price of one `base` in `quote`, from a pool's reserves. */
export function poolPrice(p: Pool, base: Address) {
  const [rb, rq, db, dq] = same(p.token0.address, base)
    ? [p.reserve0, p.reserve1, p.token0.decimals, p.token1.decimals]
    : [p.reserve1, p.reserve0, p.token1.decimals, p.token0.decimals];
  return Number(formatUnits(rq, dq)) / Number(formatUnits(rb, db));
}

export const isZero = (a: Address) => same(a, zeroAddress);

// ───────────────────────────── liquidity ─────────────────────────────

/** Pool of two tokens (ETH counts as WETH), if one exists with liquidity. */
export const findPool = (pools: Pool[], a: Address, b: Address) => {
  const [x, y] = [wrapped(a), wrapped(b)];
  return pools.find((p) => (same(p.token0.address, x) && same(p.token1.address, y)) || (same(p.token0.address, y) && same(p.token1.address, x)));
};

/** Reserves of a pool ordered as (a, b). */
export const reservesOf = (p: Pool, a: Address): [bigint, bigint] => (same(p.token0.address, wrapped(a)) ? [p.reserve0, p.reserve1] : [p.reserve1, p.reserve0]);

/** The other side of a deposit at the pool's current price (Uniswap's `quote`). */
export const pairedAmount = (p: Pool, a: Address, amountA: bigint) => {
  const [ra, rb] = reservesOf(p, a);
  return ra === 0n ? 0n : (amountA * rb) / ra;
};

/** LP tokens a deposit mints, and the pool share after it. */
export function mintPreview(p: Pool | undefined, a: Address, amountA: bigint, amountB: bigint) {
  if (!p || p.totalSupply === 0n) {
    const lp = sqrt(amountA * amountB);
    return { lp: lp > 1000n ? lp - 1000n : 0n, share: 1 };
  }
  const [ra, rb] = reservesOf(p, a);
  const lpA = (amountA * p.totalSupply) / ra;
  const lpB = (amountB * p.totalSupply) / rb;
  const lp = lpA < lpB ? lpA : lpB;
  return { lp, share: Number((lp * 1_000_000n) / (p.totalSupply + lp)) / 1_000_000 };
}

function sqrt(v: bigint) {
  if (v < 2n) return v;
  let x = v;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + v / x) / 2n;
  }
  return x;
}

export interface Position {
  pool: Pool;
  lp: bigint;
  share: number;
  amount0: bigint;
  amount1: bigint;
}

export async function readPositions(pools: Pool[], who: Address): Promise<Position[]> {
  const bals = await Promise.all(pools.map((p) => client.readContract({ address: p.pair, abi: pairAbi, functionName: "balanceOf", args: [who] })));
  return pools
    .map((pool, i) => {
      const lp = bals[i];
      return {
        pool,
        lp,
        share: pool.totalSupply ? Number((lp * 1_000_000n) / pool.totalSupply) / 1_000_000 : 0,
        amount0: pool.totalSupply ? (lp * pool.reserve0) / pool.totalSupply : 0n,
        amount1: pool.totalSupply ? (lp * pool.reserve1) / pool.totalSupply : 0n,
      };
    })
    .filter((x) => x.lp > 0n);
}

async function approveIfNeeded(wallet: WalletClient, token: Address, spender: Address, amount: bigint) {
  await mustHold(token, wallet.account!.address, amount);
  const account = wallet.account!;
  const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
  if (allowance < amount) await send(wallet, { account, chain, address: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
}

const deadlineIn = (min: number) => BigInt(Math.floor(Date.now() / 1000) + min * 60);
const less = (v: bigint, bps: number) => (v * BigInt(10_000 - bps)) / 10_000n;

export async function addLiquidity(wallet: WalletClient, router: Address, a: Address, b: Address, amountA: bigint, amountB: bigint, slippageBps: number, isNew: boolean) {
  const account = wallet.account!;
  // A new pool is priced by the deposit itself, so there is nothing to slip against.
  const bps = isNew ? 0 : slippageBps;
  if (same(a, ETH) || same(b, ETH)) {
    const [token, amtT, amtE] = same(a, ETH) ? [b, amountB, amountA] : [a, amountA, amountB];
    await approveIfNeeded(wallet, token, router, amtT);
    return send(wallet, {
      account,
      chain,
      address: router,
      abi: routerAbi,
      functionName: "addLiquidityETH",
      args: [token, amtT, less(amtT, bps), less(amtE, bps), account.address, deadlineIn(20)],
      value: amtE,
    });
  }
  await approveIfNeeded(wallet, a, router, amountA);
  await approveIfNeeded(wallet, b, router, amountB);
  return send(wallet, {
    account,
    chain,
    address: router,
    abi: routerAbi,
    functionName: "addLiquidity",
    args: [a, b, amountA, amountB, less(amountA, bps), less(amountB, bps), account.address, deadlineIn(20)],
  });
}

/** Burns `lp` and pays both sides out; a WETH side is paid as ETH when `asEth` is set. */
export async function removeLiquidity(wallet: WalletClient, router: Address, pos: Position, lp: bigint, slippageBps: number, asEth: boolean) {
  const account = wallet.account!;
  const p = pos.pool;
  const out0 = (lp * p.reserve0) / p.totalSupply;
  const out1 = (lp * p.reserve1) / p.totalSupply;
  await approveIfNeeded(wallet, p.pair, router, lp);
  const wethSide = same(p.token0.address, WETH) ? 0 : same(p.token1.address, WETH) ? 1 : -1;
  if (asEth && wethSide >= 0) {
    const [token, amtT, amtE] = wethSide === 0 ? [p.token1.address, out1, out0] : [p.token0.address, out0, out1];
    return send(wallet, {
      account,
      chain,
      address: router,
      abi: routerAbi,
      functionName: "removeLiquidityETH",
      args: [token, lp, less(amtT, slippageBps), less(amtE, slippageBps), account.address, deadlineIn(20)],
    });
  }
  return send(wallet, {
    account,
    chain,
    address: router,
    abi: routerAbi,
    functionName: "removeLiquidity",
    args: [p.token0.address, p.token1.address, lp, less(out0, slippageBps), less(out1, slippageBps), account.address, deadlineIn(20)],
  });
}

// ───────────────────────────── stats ─────────────────────────────

export interface PoolStats {
  /** Won when the pool has a route to tKRW; ETH for 뻥튀기's WETH pools. */
  unit: "KRW" | "ETH" | null;
  pair: Address;
  tvl: number | null;
  volume24h: number | null;
  volume7d: number | null;
  lpFees24h: number | null;
  lpFees7d: number | null;
  protocolFees7d: number | null;
  apr: number | null;
  swaps24h: number;
  swaps7d: number;
}

export interface SwapStats {
  updatedAt: number;
  fee: { total: number; lp: number; protocol: number };
  pools: PoolStats[];
  totals: { tvl: number; volume24h: number; volume7d: number; lpFees7d: number; protocolFees7d: number };
}

/** Volume, fees and APR, indexed by Jangteo ops every 10 minutes and served next to the app. */
export async function loadStats(): Promise<SwapStats | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}swap-stats.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as SwapStats) : null;
  } catch {
    return null;
  }
}

export const statsFor = (st: SwapStats | null | undefined, pair: Address) => st?.pools.find((x) => same(x.pair, pair));

/** A stats value in its pool's own unit. */
export const statValue = (st: Pick<PoolStats, "unit">, v: number) =>
  st.unit === "ETH" ? `${v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 4 : 2 })} ETH` : `₩${Math.round(v).toLocaleString("en-US")}`;
