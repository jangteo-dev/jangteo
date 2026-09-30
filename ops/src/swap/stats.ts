import { existsSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits, parseAbi, parseAbiItem, type Address } from "viem";
import { giwa } from "../chain.ts";
import { config, gyeDeployment } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import { launchpadAddresses } from "../stalls.ts";

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const factoryAbi = parseAbi(["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)", "function feeTo() view returns (address)"]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const SWAP = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");

/** Uniswap V2: 0.30% per swap; with feeTo set, 0.25% stays with LPs and 0.05% is minted to the treasury. */
export const FEE = { total: 0.003, lp: 0.0025, protocol: 0.0005 };
const DAY = 86_400;
const CHUNK = 100_000n;

export interface PoolStats {
  pair: Address;
  token0: Address;
  token1: Address;
  symbol0: string;
  symbol1: string;
  /** Unit of every value below: won when a route to tKRW prices the pool, else ETH for WETH pools. */
  unit: "KRW" | "ETH" | null;
  tvl: number | null;
  volume24h: number | null;
  volume7d: number | null;
  lpFees24h: number | null;
  lpFees7d: number | null;
  protocolFees7d: number | null;
  /** Yearly return for LPs from fees, from the 7-day average (24h when the pool is younger). */
  apr: number | null;
  swaps24h: number;
  swaps7d: number;
  treasuryLpShare: number;
  treasuryLpValue: number | null;
}

export interface SwapStats {
  updatedAt: number;
  fee: typeof FEE;
  pools: PoolStats[];
  totals: { tvl: number; volume24h: number; volume7d: number; lpFees7d: number; protocolFees7d: number; treasuryLpValue: number };
}

/** Token prices in won: tKRW = 1, tokens paired with tKRW by reserves, WETH-paired tokens via WETH/tKRW. */
export function prices(pools: { token0: Address; token1: Address; r0: number; r1: number }[], tkrw: Address) {
  const p = new Map<string, number>([[tkrw.toLowerCase(), 1]]);
  for (let pass = 0; pass < 2; pass++) {
    for (const x of pools) {
      const [a, b] = [x.token0.toLowerCase(), x.token1.toLowerCase()];
      if (!x.r0 || !x.r1) continue;
      if (p.has(a) && !p.has(b)) p.set(b, (p.get(a)! * x.r0) / x.r1);
      if (p.has(b) && !p.has(a)) p.set(a, (p.get(b)! * x.r1) / x.r0);
    }
  }
  return p;
}

/** Every pair of the 장터 스왑 factory with reserves, supply and the treasury's LP balance. */
export async function readPairs(factory: Address) {
  const [n, feeTo] = await Promise.all([
    giwa.readContract({ address: factory, abi: factoryAbi, functionName: "allPairsLength" }),
    giwa.readContract({ address: factory, abi: factoryAbi, functionName: "feeTo" }),
  ]);
  const pairs = await Promise.all(Array.from({ length: Number(n) }, (_, i) => giwa.readContract({ address: factory, abi: factoryAbi, functionName: "allPairs", args: [BigInt(i)] })));
  const raw = await Promise.all(
    pairs.map(async (pair) => {
      const [token0, token1, [r0, r1], supply, treasuryLp] = await Promise.all([
        giwa.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
        giwa.readContract({ address: pair, abi: pairAbi, functionName: "token1" }),
        giwa.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
        giwa.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" }),
        giwa.readContract({ address: pair, abi: pairAbi, functionName: "balanceOf", args: [feeTo] }),
      ]);
      const meta = async (t: Address) =>
        Promise.all([giwa.readContract({ address: t, abi: erc20, functionName: "symbol" }), giwa.readContract({ address: t, abi: erc20, functionName: "decimals" })]);
      const [[symbol0, d0], [symbol1, d1]] = await Promise.all([meta(token0), meta(token1)]);
      return { pair, token0, token1, symbol0, symbol1, d0, d1, r0: Number(formatUnits(r0, d0)), r1: Number(formatUnits(r1, d1)), supply, treasuryLp };
    }),
  );
  return { pairs, raw };
}

export async function computeSwapStats(): Promise<SwapStats | null> {
  const lp = launchpadAddresses();
  const tkrw = gyeDeployment()?.tkrw;
  if (!lp || !tkrw) return null;
  const { pairs, raw } = await readPairs(lp.swapFactory);
  const price = prices(raw, tkrw);
  const px = (t: Address) => price.get(t.toLowerCase()) ?? null;

  // Every Swap of the last 7 days, all pairs at once, in chunks the RPC accepts.
  const head = await giwa.getBlock();
  const now = Number(head.timestamp);
  const from = head.number > BigInt(7 * DAY) ? head.number - BigInt(7 * DAY) : 0n;
  const logs: { address: Address; blockNumber: bigint; args: { amount0In?: bigint; amount1In?: bigint } }[] = [];
  for (let b = from; b <= head.number && pairs.length; b += CHUNK) {
    const to = b + CHUNK - 1n > head.number ? head.number : b + CHUNK - 1n;
    const chunk = await giwa.getLogs({ address: pairs, event: SWAP, fromBlock: b, toBlock: to });
    for (const l of chunk) logs.push({ address: l.address, blockNumber: l.blockNumber, args: l.args });
  }
  // 1-second blocks: a log's age is the block distance.
  const ageOf = (bn: bigint) => Number(head.number - bn);

  const pools: PoolStats[] = raw.map((x) => {
    let p0 = px(x.token0);
    let p1 = px(x.token1);
    let unit: PoolStats["unit"] = p0 !== null && p1 !== null ? "KRW" : null;
    // 장터 뻥튀기 graduates into WETH pools that no won route reaches: count those in ETH instead.
    if (!unit && (x.token0.toLowerCase() === WETH.toLowerCase() || x.token1.toLowerCase() === WETH.toLowerCase())) {
      const w0 = x.token0.toLowerCase() === WETH.toLowerCase();
      const tokenPerWeth = w0 ? x.r0 / x.r1 : x.r1 / x.r0; // ETH per token
      p0 = w0 ? 1 : tokenPerWeth;
      p1 = w0 ? tokenPerWeth : 1;
      unit = "ETH";
    }
    const priced = unit !== null;
    const tvl = priced ? x.r0 * p0! + x.r1 * p1! : null;
    let v24 = 0;
    let v7 = 0;
    let s24 = 0;
    let s7 = 0;
    for (const l of logs) {
      if (l.address.toLowerCase() !== x.pair.toLowerCase()) continue;
      const a = l.args;
      // Value a swap by what went in, which is what the fee is charged on.
      const vin = Number(formatUnits(a.amount0In!, x.d0)) * (p0 ?? 0) + Number(formatUnits(a.amount1In!, x.d1)) * (p1 ?? 0);
      s7++;
      v7 += vin;
      if (ageOf(l.blockNumber) <= DAY) {
        s24++;
        v24 += vin;
      }
    }
    const firstSwapAge = Math.max(
      1,
      ...logs.filter((l) => l.address.toLowerCase() === x.pair.toLowerCase()).map((l) => ageOf(l.blockNumber)),
    );
    const days = Math.min(7, Math.max(1, firstSwapAge / DAY));
    const share = x.supply > 0n ? Number((x.treasuryLp * 1_000_000n) / x.supply) / 1_000_000 : 0;
    return {
      unit,
      pair: x.pair,
      token0: x.token0,
      token1: x.token1,
      symbol0: x.symbol0,
      symbol1: x.symbol1,
      tvl,
      volume24h: priced ? v24 : null,
      volume7d: priced ? v7 : null,
      lpFees24h: priced ? v24 * FEE.lp : null,
      lpFees7d: priced ? v7 * FEE.lp : null,
      protocolFees7d: priced ? v7 * FEE.protocol : null,
      apr: priced && tvl ? ((v7 * FEE.lp) / days) * 365 / tvl : null,
      swaps24h: s24,
      swaps7d: s7,
      treasuryLpShare: share,
      treasuryLpValue: tvl !== null ? tvl * share : null,
    };
  });
  // Totals are in won; ETH-denominated pools are listed but not added to them.
  const sum = (k: keyof PoolStats) => pools.filter((p) => p.unit === "KRW").reduce((a, p) => a + ((p[k] as number | null) ?? 0), 0);
  return {
    updatedAt: now,
    fee: FEE,
    pools,
    totals: {
      tvl: sum("tvl"),
      volume24h: sum("volume24h"),
      volume7d: sum("volume7d"),
      lpFees7d: sum("lpFees7d"),
      protocolFees7d: sum("protocolFees7d"),
      treasuryLpValue: sum("treasuryLpValue"),
    },
  };
}

/** Publishes swap-stats.json into the web docroot (atomic rename) and keeps a copy in the store. */
export function swapStatsTask(store: Store): Task {
  return {
    id: "swap:stats",
    title: "Jangteo Swap stats",
    everyMs: 10 * 60_000,
    jitterMs: 20_000,
    timeoutMs: 5 * 60_000,
    lane: "giwa:read",
    async run(): Promise<TaskResult> {
      const stats = await computeSwapStats();
      if (!stats) return { summary: "Jangteo Swap not deployed", nextAt: Date.now() + 30 * 60_000 };
      store.set("swap:stats", stats);
      if (existsSync(config.webroot)) {
        const out = resolve(config.webroot, "swap-stats.json");
        writeFileSync(`${out}.tmp`, JSON.stringify(stats));
        renameSync(`${out}.tmp`, out);
      }
      const t = stats.totals;
      const krw = (v: number) => `₩${Math.round(v).toLocaleString("en-US")}`;
      return { summary: `${stats.pools.length} pools · TVL ${krw(t.tvl)} · 24h vol ${krw(t.volume24h)} · treasury LP ${krw(t.treasuryLpValue)}` };
    },
  };
}
