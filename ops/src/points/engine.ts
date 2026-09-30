import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits, parseAbi, parseAbiItem, type AbiEvent, type Address } from "viem";
import { giwa, l1 } from "../chain.ts";
import { config } from "../config.ts";
import { talAddress } from "../nft/tal.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import { prices, readPairs } from "../swap/stats.ts";

/**
 * 장터 포인트 — Season 1.
 *
 * Points are computed from on-chain events only, every run from scratch, so the numbers are
 * reproducible by anyone reading the chain. Only Dojang-verified addresses (one verified person
 * each) are ranked; everything is valued in won (tKRW).
 */
export const SEASON = {
  id: 1,
  name: "Season 1",
  // Started 2026-09-23 00:00 KST and runs with no end date; endsAt only bounds the arithmetic.
  startsAt: Date.UTC(2026, 8, 22, 15) / 1000,
  endsAt: Date.UTC(2099, 0, 1) / 1000,
};

const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export const RULES = {
  swapPerKrw: 1 / 1000, // 1 P per ₩1,000 swapped
  swapDailyCap: 500,
  lpPerKrwDay: 1 / 1000, // 1 P per ₩1,000 of liquidity held for a day
  cySubscribe: 100, // per offering
  cyPerKrw: 1 / 1000, // per ₩1,000 deposited
  jgPerKrw: 1 / 1000, // per ₩1,000 traded, both sides
  jgDelivered: 50,
  jgDefaulted: -200,
  yutGame: 20,
  yutWin: 10,
  yutDailyGames: 10,
  gyeJoin: 100,
  gyeContribution: 20,
  gyeClean: 300,
  gyeDefault: -300,
  sjPerKrw: 1 / 1000,
  sjWin: 50,
  activeDay: 10,
  talBoost: 0.1, // +10% on the season total while the wallet holds a 탈 Tal
  pumpPerEth: 1000, // 1 P per 0.001 ETH traded on a 뻥튀기 curve
  pumpDailyCap: 500,
  pumpGraduated: 300, // to the creator, when their launch graduates
  pumpLaunch: 20, // to the creator for launching a token, once per KST day
  // 오늘의 룰렛 + daily quests (one of each per KST day)
  dailyQuest: 20, // swap (Jangteo Swap or the aggregator), a 뻥튀기 trade, a yut game
  dailyBridge: 30, // any Jangteo bridge move: deposit, withdrawal or fast exit
  dailyAll: 50, // any four of the five quests on the same day
  streak7: 100, // every 7th spin in a row
  // Volume in ETH (aggregator routes, limit/DCA fills and bridge moves): 1 P per 0.001 ETH
  ethPerEth: 1000,
  bridgePerEth: 1000, // 1 P per 0.001 ETH bridged in or out
  bridgeDailyCap: 300,
  // 인사동 NFTs
  insaMint: 10, // per NFT minted from an Insadong drop
  insaMintCap: 50, // a day
  insaPerEth: 1000, // 1 P per 0.001 ETH of NFT sales, for buyer and seller
  insaDailyCap: 500,
  // 친구 초대: both sides must be Dojang-verified people
  inviteShare: 0.1, // the inviter earns 10% of each invited friend's season points (the friend keeps all of theirs)
  inviteCap: 5000, // most one inviter can earn from invites in a season
  inviteWelcome: 50, // once, to the invited friend, when they have earned anything
};

export type Part = "swap" | "lp" | "bridge" | "cheongyak" | "jangoe" | "pump" | "insa" | "yut" | "gye" | "sangjang" | "daily" | "days" | "invite";
export const PARTS: Part[] = ["swap", "lp", "bridge", "cheongyak", "jangoe", "pump", "insa", "yut", "gye", "sangjang", "daily", "days", "invite"];
export type Quest = "swap" | "curve" | "yut" | "bridge" | "insa";

/** Today's roulette and quests for one wallet, for the Points page. */
export interface Today {
  spun: boolean;
  reward: number | null;
  streak: number;
  quests: Record<Quest, boolean>;
}

export interface Entry {
  address: Address;
  total: number;
  parts: Record<Part, number>;
  activeDays: number;
  verified: boolean;
  team: boolean;
  /** Holds a 탈 Tal, so the total includes RULES.talBoost. */
  tal?: boolean;
  /** Who invited this wallet, and how many verified friends it brought. */
  invitedBy?: Address;
  invites?: number;
  rank: number | null;
}

export type Stall = "swap" | "pump" | "insa" | "bridge" | "cheongyak" | "jangoe" | "sangjang" | "gye" | "yut" | "daily" | "invite";
export interface StallStats {
  tx: number;
  users: number;
  eth: number;
  krw: number;
}
/** 장터 testnet activity, from the same on-chain events as the points. Team and QA wallets are split out. */
export interface StatsFile {
  updatedAt: number;
  since: number;
  totals: { tx: number; users: number; community: number; verified: number; eth: number; krw: number; communityTx: number };
  stalls: Record<Stall, StallStats>;
  counts: { launches: number; graduated: number; nftMinted: number; nftSold: number; games: number; circles: number; offerings: number };
  days: { day: number; tx: number; users: number; newUsers: number; eth: number; krw: number }[];
}

export interface PointsFile {
  season: typeof SEASON;
  rules: typeof RULES;
  updatedAt: number;
  entries: Entry[];
  today: { day: number; wallets: Record<string, Today> };
  totals: { participants: number; verified: number; points: number };
  stats?: StatsFile;
}

const DAY = 86_400;
const KST = 9 * 3600;
const CHUNK = 100_000n;
const kstDay = (t: number) => Math.floor((t + KST) / DAY);
const won = (v: bigint) => Number(formatUnits(v, 18));

function deployment<T>(file: string): T | null {
  const p = resolve(config.root, "../contracts/deployments", file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

/** Every address in contracts/deployments/*.json, plus retired contracts that still have history. */
function ourContracts(): Set<string> {
  const dir = resolve(config.root, "../contracts/deployments");
  const out = new Set(["0xc545732389674e04b66e72e3dc0dcf78f521a88d", "0x300f3e48b664551541c0708c1b68082913f32527"]);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const walk = (v: unknown): void => {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) out.add(v.toLowerCase());
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    try {
      walk(JSON.parse(readFileSync(resolve(dir, f), "utf8")));
    } catch {
      /* not a deployment file */
    }
  }
  return out;
}

const EV = {
  insaCreated: parseAbiItem("event Created(address indexed drop, address indexed creator, string name, string symbol, uint32 maxSupply, uint16 platformBps)"),
  insaMinted: parseAbiItem("event Minted(address indexed to, uint256 indexed phase, uint256 firstId, uint256 quantity, uint256 paid)"),
  insaSold: parseAbiItem("event Sold(address indexed collection, uint256 indexed tokenId, address seller, address buyer, uint256 price, uint256 royalty, uint256 fee, uint256 offerId)"),
  swap: parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"),
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  cySub: parseAbiItem("event Subscribed(uint256 indexed id, address indexed who, uint256 amount, uint256 total)"),
  jgFilled: parseAbiItem("event Filled(uint256 indexed trade, uint256 indexed offer, address buyer, address seller, uint256 units, uint256 paid, uint256 collateral)"),
  jgDelivered: parseAbiItem("event Delivered(uint256 indexed trade, address indexed seller, uint256 tokens, uint256 fee)"),
  jgDefaulted: parseAbiItem("event Defaulted(uint256 indexed trade, address indexed seller, uint256 toBuyer, uint256 fee)"),
  yutCreated: parseAbiItem("event Created(uint256 indexed id, address indexed creator, uint256 stake)"),
  yutJoined: parseAbiItem("event Joined(uint256 indexed id, address indexed player, uint8 firstTurn)"),
  yutFinished: parseAbiItem("event Finished(uint256 indexed id, address indexed winner, uint256 payout, uint256 fee, uint8 reason)"),
  circleCreated: parseAbiItem("event CircleCreated(address indexed circle, address indexed creator, address indexed token, bytes32 name)"),
  gyeJoined: parseAbiItem("event Joined(address indexed member, uint16 holdbackBps)"),
  gyeContributed: parseAbiItem("event Contributed(address indexed member, uint8 indexed round, uint256 amount)"),
  gyeOutcome: parseAbiItem("event Outcome(address indexed account, address indexed circle, uint8 outcome, uint256 usd, bytes32 attestation)"),
  sjBet: parseAbiItem("event BetPlaced(uint256 indexed id, address indexed user, bool yes, uint256 amount, uint64 at)"),
  sjClaimed: parseAbiItem("event Claimed(uint256 indexed id, address indexed user, uint256 payout)"),
  pumpTrade: parseAbiItem(
    "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEth, uint256 sold)",
  ),
  pumpLaunched: parseAbiItem("event Launched(address indexed token, address indexed creator, address pair, string name, string symbol, string metadata)"),
  pumpGraduated: parseAbiItem("event Graduated(address indexed token, address pair, uint256 ethLiquidity, uint256 tokenLiquidity, uint256 burned, uint256 fee, uint256 lp)"),
  spun: parseAbiItem("event Spun(address indexed who, uint256 indexed day, uint256 blockNumber, uint256 streak)"),
  orderCreated: parseAbiItem(
    "event Created(uint256 indexed id, address indexed owner, address tokenIn, address tokenOut, uint256 total, uint256 minRate, uint32 slices, uint32 interval, uint64 expiry)",
  ),
  orderExecuted: parseAbiItem("event Executed(uint256 indexed id, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 remaining)"),
  aggSwapped: parseAbiItem("event Swapped(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee)"),
  bridged: parseAbiItem("event Deposited(address indexed from, address indexed to, uint256 amount, uint256 fee)"),
  invited: parseAbiItem("event Invited(address indexed invitee, address indexed referrer)"),
  exited: parseAbiItem("event Exit(uint256 indexed id, address indexed from, address indexed to, uint256 amount, uint256 amountOut, uint256 fee)"),
};
const dailyAbi = parseAbi(["function rewardFor(bytes32 nextBlockHash, address who, uint256 day) pure returns (uint256)"]);

const WETH_ADDR = "0x4200000000000000000000000000000000000006";
const gateAbi = parseAbi(["function isEligible(address) view returns (bool)"]);

/** Logs of one event from a set of addresses since `from`, chunked to what the RPC accepts. */
async function scan<E extends AbiEvent>(address: Address[], event: E, from: bigint, head: bigint) {
  if (!address.length) return [];
  const out = [];
  for (let b = from; b <= head; b += CHUNK) {
    const to = b + CHUNK - 1n > head ? head : b + CHUNK - 1n;
    out.push(...(await giwa.getLogs({ address, event, fromBlock: b, toBlock: to, strict: true })));
  }
  return out;
}

export async function computePoints(): Promise<PointsFile | null> {
  const base = deployment<{ factory: Address; reputation: Address; gate: Address; tkrw: Address }>("91342.json");
  if (!base) return null;
  const v1 = deployment<{ factory: Address; reputation: Address }>("91342.v1.json");
  const sangjang = deployment<{ market: Address }>("91342.sangjang.json");
  const stalls = deployment<{ cheongyak: Address; yut: Address; yutV1?: Address }>("91342.stalls.json");
  const launch = deployment<{ cheongyakV2: Address; swapFactory: Address }>("91342.launchpad.json");
  const jangoe = deployment<{ jangoe: Address }>("91342.jangoe.json");
  // 뻥튀기 v1 and v2: both count.
  const pumps = ["91342.pump.json", "91342.pump2.json"].map((f) => deployment<{ pump: Address; pumpRouter: Address }>(f)).filter((x): x is { pump: Address; pumpRouter: Address } => !!x);
  const pump = pumps[0] ?? null;

  const head = await giwa.getBlock();
  const now = Math.min(Number(head.timestamp), SEASON.endsAt);
  // 1-second blocks: timestamps follow block numbers exactly enough for daily buckets.
  const timeOf = (bn: bigint) => Number(head.timestamp) - Number(head.number - bn);
  const startBlock = head.number - BigInt(Math.max(0, Number(head.timestamp) - SEASON.startsAt));
  const endBlock = head.number - BigInt(Math.max(0, Number(head.timestamp) - SEASON.endsAt));
  const inSeason = (bn: bigint) => bn >= startBlock && bn <= endBlock;
  // Every Jangteo contract was deployed after Season 1 began, so nothing older needs scanning.
  const from = startBlock;

  // Routers receive the tokens on ETH-out swaps and trade the curve for outside wallets: whoever
  // sent the transaction is the one who traded.
  const routers = new Set(
    [deployment<{ swapRouter: Address }>("91342.launchpad.json")?.swapRouter, ...pumps.map((p) => p.pumpRouter)].filter(Boolean).map((a) => a!.toLowerCase()),
  );
  const senders = new Map<string, Address>();
  const trader = async (who: Address, tx: `0x${string}`): Promise<Address> => {
    if (!routers.has(who.toLowerCase())) return who;
    if (!senders.has(tx)) senders.set(tx, (await giwa.getTransaction({ hash: tx })).from);
    return senders.get(tx)!;
  };
  const pts = new Map<string, Record<Part, number>>();
  // Quests done per wallet per KST day: "addr|day" → quests.
  const quests = new Map<string, Set<Quest>>();
  // Activity for the stats page: one row per (stall, transaction, wallet).
  const acts: { stall: Stall; who: string; tx: string; t: number; eth: number; krw: number }[] = [];
  const act = (stall: Stall, who: Address, tx: string, bn: bigint, eth = 0, krw = 0) =>
    acts.push({ stall, who: who.toLowerCase(), tx, t: timeOf(bn), eth, krw });
  const counts = { launches: 0, graduated: 0, nftMinted: 0, nftSold: 0, games: 0, circles: 0, offerings: 0 };
  const quest = (who: Address, q: Quest, bn: bigint) => {
    if (!inSeason(bn)) return;
    const k = `${who.toLowerCase()}|${kstDay(timeOf(bn))}`;
    if (!quests.has(k)) quests.set(k, new Set());
    quests.get(k)!.add(q);
  };
  const days = new Map<string, Set<number>>();
  const capped = new Map<string, number>(); // key: addr|part|day → used
  const add = (who: Address, part: Part, v: number, bn?: bigint, cap?: number, capKey: string = part) => {
    const k = who.toLowerCase();
    if (!pts.has(k)) pts.set(k, { swap: 0, lp: 0, bridge: 0, cheongyak: 0, jangoe: 0, pump: 0, insa: 0, yut: 0, gye: 0, sangjang: 0, daily: 0, days: 0, invite: 0 });
    let amount = v;
    if (bn !== undefined) {
      const d = kstDay(timeOf(bn));
      if (!days.has(k)) days.set(k, new Set());
      days.get(k)!.add(d);
      if (cap !== undefined) {
        const ck = `${k}|${capKey}|${d}`;
        const used = capped.get(ck) ?? 0;
        amount = Math.max(0, Math.min(v, cap - used));
        capped.set(ck, used + amount);
      }
    }
    pts.get(k)![part] += amount;
  };

  // ── 스왑: swaps and time-weighted liquidity ──
  // Aggregator routes and limit/DCA fills are counted once, from their own events, at their full
  // size; the Jangteo Swap hops inside those transactions are skipped below.
  const agg = deployment<{ aggregator: Address }>("91342.aggregator.json");
  const aggs = [...new Set(["0x300f3e48b664551541c0708C1b68082913f32527", agg?.aggregator].filter(Boolean) as Address[])];
  const aggLogs = (await scan(aggs, EV.aggSwapped, startBlock, head.number)).filter((l) => inSeason(l.blockNumber));
  const routedTx = new Set(aggLogs.map((l) => l.transactionHash));
  const ordersC = deployment<{ orders: Address }>("91342.orders.json");
  // Only the live v2 contract counts. v1 (0xC545…A88D) held test orders before it was replaced;
  // its routes are still skipped so the old contract never earns points itself.
  const orderContracts = [ordersC?.orders].filter(Boolean) as Address[];
  const orderAddrs = new Set(["0xC545732389674E04b66E72e3dC0DCF78F521A88D", ...orderContracts].map((a) => a.toLowerCase()));

  if (launch) {
    const { pairs, raw } = await readPairs(launch.swapFactory);
    const price = prices(raw, base.tkrw);
    const pairSet = new Set(pairs.map((p) => p.toLowerCase()));
    const swaps = (await scan(pairs, EV.swap, startBlock, head.number)).filter((l) => inSeason(l.blockNumber));
    for (const l of swaps) {
      const to = l.args.to.toLowerCase();
      if (pairSet.has(to)) continue; // middle hop of a multi-hop route: counted at the last hop
      if (routedTx.has(l.transactionHash)) continue; // part of an aggregator route or an order fill
      const user = await trader(l.args.to, l.transactionHash);
      quest(user, "swap", l.blockNumber);
      const x = raw.find((p) => p.pair.toLowerCase() === l.address.toLowerCase())!;
      const p0 = price.get(x.token0.toLowerCase());
      const p1 = price.get(x.token1.toLowerCase());
      {
        const w = x.token0.toLowerCase() === WETH_ADDR ? 0 : x.token1.toLowerCase() === WETH_ADDR ? 1 : -1;
        const eth = w < 0 ? 0 : Number(formatUnits(w === 0 ? l.args.amount0In + l.args.amount0Out : l.args.amount1In + l.args.amount1Out, 18));
        const krw = p0 !== undefined && p1 !== undefined && w < 0 ? Number(formatUnits(l.args.amount0In, x.d0)) * p0 + Number(formatUnits(l.args.amount1In, x.d1)) * p1 : 0;
        act("swap", user, l.transactionHash, l.blockNumber, eth, krw);
      }
      if (p0 !== undefined && p1 !== undefined) {
        const value = Number(formatUnits(l.args.amount0In, x.d0)) * p0 + Number(formatUnits(l.args.amount1In, x.d1)) * p1;
        add(user, "swap", value * RULES.swapPerKrw, l.blockNumber, RULES.swapDailyCap);
        continue;
      }
      // Graduated 뻥튀기 pools trade against WETH with no won price: count the ETH side, at the 뻥튀기 rate.
      const w0 = x.token0.toLowerCase() === WETH_ADDR;
      const w1 = x.token1.toLowerCase() === WETH_ADDR;
      if (!w0 && !w1) continue;
      const ethIn = Number(formatUnits(w0 ? l.args.amount0In : l.args.amount1In, 18));
      const ethOut = Number(formatUnits(w0 ? l.args.amount0Out : l.args.amount1Out, 18));
      add(user, "swap", (ethIn || ethOut) * RULES.pumpPerEth, l.blockNumber, RULES.swapDailyCap);
    }
    // Liquidity: replay LP token transfers, integrate balance × time, value at today's pool price.
    const transfers = await scan(pairs, EV.transfer, from, head.number);
    for (const x of raw) {
      const tvl = x.r0 * (price.get(x.token0.toLowerCase()) ?? 0) + x.r1 * (price.get(x.token1.toLowerCase()) ?? 0);
      if (!tvl || x.supply === 0n) continue;
      const krwPerLp = tvl / Number(formatUnits(x.supply, 18));
      const bal = new Map<string, number>();
      const since = new Map<string, number>();
      const accrue = (who: string, until: number) => {
        const b = bal.get(who) ?? 0;
        const t0 = Math.max(since.get(who) ?? until, SEASON.startsAt);
        if (b > 0 && until > t0) add(who as Address, "lp", ((b * krwPerLp * (until - t0)) / DAY) * RULES.lpPerKrwDay);
      };
      for (const l of transfers.filter((t) => t.address.toLowerCase() === x.pair.toLowerCase())) {
        const t = Math.min(timeOf(l.blockNumber), now);
        const v = Number(formatUnits(l.args.value, 18));
        for (const [who, sign] of [
          [l.args.from.toLowerCase(), -1],
          [l.args.to.toLowerCase(), 1],
        ] as const) {
          if (who === "0x0000000000000000000000000000000000000000" || who === x.pair.toLowerCase()) continue;
          accrue(who, t);
          bal.set(who, (bal.get(who) ?? 0) + sign * v);
          since.set(who, t);
        }
      }
      for (const who of bal.keys()) accrue(who, now);
    }
  }

  // ── 청약 ──
  const cyAddrs = [stalls?.cheongyak, launch?.cheongyakV2].filter(Boolean) as Address[];
  const subs = (await scan(cyAddrs, EV.cySub, startBlock, head.number)).filter((l) => inSeason(l.blockNumber));
  const joinedOffering = new Set<string>();
  counts.offerings = new Set(subs.map((l) => `${l.address}|${l.args.id}`.toLowerCase())).size;
  for (const l of subs) {
    act("cheongyak", l.args.who, l.transactionHash, l.blockNumber, 0, won(l.args.amount));
    const k = `${l.address}|${l.args.id}|${l.args.who}`.toLowerCase();
    if (!joinedOffering.has(k)) {
      joinedOffering.add(k);
      add(l.args.who, "cheongyak", RULES.cySubscribe, l.blockNumber);
    }
    add(l.args.who, "cheongyak", won(l.args.amount) * RULES.cyPerKrw, l.blockNumber);
  }

  // ── 장외 ──
  if (jangoe) {
    const [filled, delivered, defaulted] = await Promise.all([
      scan([jangoe.jangoe], EV.jgFilled, startBlock, head.number),
      scan([jangoe.jangoe], EV.jgDelivered, startBlock, head.number),
      scan([jangoe.jangoe], EV.jgDefaulted, startBlock, head.number),
    ]);
    for (const l of filled.filter((x) => inSeason(x.blockNumber))) {
      const v = won(l.args.paid) * RULES.jgPerKrw;
      add(l.args.buyer, "jangoe", v, l.blockNumber);
      add(l.args.seller, "jangoe", v, l.blockNumber);
      act("jangoe", l.args.buyer, l.transactionHash, l.blockNumber, 0, v / RULES.jgPerKrw);
      act("jangoe", l.args.seller, l.transactionHash, l.blockNumber);
    }
    for (const l of delivered.filter((x) => inSeason(x.blockNumber))) add(l.args.seller, "jangoe", RULES.jgDelivered, l.blockNumber);
    for (const l of defaulted.filter((x) => inSeason(x.blockNumber))) add(l.args.seller, "jangoe", RULES.jgDefaulted, l.blockNumber);
  }

  // ── 뻥튀기: curve trades (router trades credit the recipient), graduation bonus to the creator ──
  if (pump) {
    const [trades, launched, graduated] = await Promise.all([
      scan(pumps.map((p) => p.pump), EV.pumpTrade, from, head.number),
      scan(pumps.map((p) => p.pump), EV.pumpLaunched, from, head.number),
      scan(pumps.map((p) => p.pump), EV.pumpGraduated, from, head.number),
    ]);
    for (const l of trades.filter((x) => inSeason(x.blockNumber))) {
      const user = await trader(l.args.trader, l.transactionHash);
      act("pump", user, l.transactionHash, l.blockNumber, Number(formatUnits(l.args.ethAmount, 18)));
      add(user, "pump", Number(formatUnits(l.args.ethAmount, 18)) * RULES.pumpPerEth, l.blockNumber, RULES.pumpDailyCap);
      quest(user, "curve", l.blockNumber);
    }
    const creatorOf = new Map(launched.map((l) => [l.args.token.toLowerCase(), l.args.creator]));
    counts.launches = launched.length;
    counts.graduated = graduated.length;
    for (const l of launched) act("pump", l.args.creator, l.transactionHash, l.blockNumber);
    for (const l of launched.filter((x) => inSeason(x.blockNumber))) add(l.args.creator, "pump", RULES.pumpLaunch, l.blockNumber, RULES.pumpLaunch, "launch");
    for (const l of graduated.filter((x) => inSeason(x.blockNumber))) {
      const c = creatorOf.get(l.args.token.toLowerCase());
      if (c) add(c, "pump", RULES.pumpGraduated, l.blockNumber);
    }
  }

  // ── 윷놀이: finished games only ──
  // Both yut contracts: the first (opener picked at join) and v2 (opener fixed by the next block).
  const yuts = [stalls?.yut, (stalls as { yutV1?: Address } | null)?.yutV1].filter(Boolean) as Address[];
  if (yuts.length) {
    const [created, joined, finished] = await Promise.all([
      scan(yuts, EV.yutCreated, from, head.number),
      scan(yuts, EV.yutJoined, from, head.number),
      scan(yuts, EV.yutFinished, startBlock, head.number),
    ]);
    // Game ids restart per contract: key every game by contract and id.
    const gk = (l: { address: string; args: { id?: bigint } }) => `${l.address.toLowerCase()}|${l.args.id}`;
    const players = new Map<string, Address[]>();
    for (const l of created) players.set(gk(l), [l.args.creator]);
    for (const l of joined) players.get(gk(l))?.push(l.args.player);
    for (const l of created) quest(l.args.creator, "yut", l.blockNumber);
    for (const l of joined) quest(l.args.player, "yut", l.blockNumber);
    for (const l of created) act("yut", l.args.creator, l.transactionHash, l.blockNumber);
    for (const l of joined) act("yut", l.args.player, l.transactionHash, l.blockNumber);
    counts.games = finished.length;
    for (const l of finished.filter((x) => inSeason(x.blockNumber))) {
      const ps = players.get(gk(l)) ?? [];
      if (ps.length < 2) continue;
      for (const p of ps) add(p, "yut", RULES.yutGame, l.blockNumber, RULES.yutGame * RULES.yutDailyGames);
      add(l.args.winner, "yut", RULES.yutWin, l.blockNumber, RULES.yutWin * RULES.yutDailyGames);
    }
  }

  // ── 계 ──
  const factories = [base.factory, v1?.factory].filter(Boolean) as Address[];
  const circles = (await scan(factories, EV.circleCreated, from, head.number)).map((l) => l.args.circle);
  const [gJoined, gContrib, outcomes] = await Promise.all([
    scan(circles, EV.gyeJoined, startBlock, head.number),
    scan(circles, EV.gyeContributed, startBlock, head.number),
    scan([base.reputation, v1?.reputation].filter(Boolean) as Address[], EV.gyeOutcome, startBlock, head.number),
  ]);
  counts.circles = circles.length;
  for (const l of [...gJoined, ...gContrib]) act("gye", l.args.member, l.transactionHash, l.blockNumber);
  for (const l of gJoined.filter((x) => inSeason(x.blockNumber))) add(l.args.member, "gye", RULES.gyeJoin, l.blockNumber);
  for (const l of gContrib.filter((x) => inSeason(x.blockNumber))) add(l.args.member, "gye", RULES.gyeContribution, l.blockNumber);
  for (const l of outcomes.filter((x) => inSeason(x.blockNumber))) {
    if (l.args.outcome === 1) add(l.args.account, "gye", RULES.gyeClean, l.blockNumber);
    if (l.args.outcome === 2) add(l.args.account, "gye", RULES.gyeDefault, l.blockNumber);
  }

  // ── 상장 ──
  if (sangjang) {
    const [bets, claims] = await Promise.all([
      scan([sangjang.market], EV.sjBet, startBlock, head.number),
      scan([sangjang.market], EV.sjClaimed, startBlock, head.number),
    ]);
    for (const l of bets) act("sangjang", l.args.user, l.transactionHash, l.blockNumber, 0, won(l.args.amount));
    for (const l of bets.filter((x) => inSeason(x.blockNumber))) add(l.args.user, "sangjang", won(l.args.amount) * RULES.sjPerKrw, l.blockNumber);
    // A claim larger than zero after resolution is a winning (or refunded) position; one bonus per market.
    const won_ = new Set<string>();
    for (const l of claims.filter((x) => inSeason(x.blockNumber))) {
      const k = `${l.args.id}|${l.args.user}`.toLowerCase();
      if (l.args.payout > 0n && !won_.has(k)) {
        won_.add(k);
        add(l.args.user, "sangjang", RULES.sjWin, l.blockNumber);
      }
    }
  }

  // ── 애그리게이터: routes across every GIWA DEX, valued by their ETH side ──
  const isEth = (a: string) => a.toLowerCase() === "0x0000000000000000000000000000000000000000" || a.toLowerCase() === WETH_ADDR;
  const ethSide = (tokenIn: string, amountIn: bigint, tokenOut: string, amountOut: bigint) =>
    isEth(tokenIn) ? Number(formatUnits(amountIn, 18)) : isEth(tokenOut) ? Number(formatUnits(amountOut, 18)) : 0;
  for (const l of aggLogs) {
    if (orderAddrs.has(l.args.sender.toLowerCase())) continue; // an order fill: credited to its owner below
    quest(l.args.sender, "swap", l.blockNumber);
    const eth = ethSide(l.args.tokenIn, l.args.amountIn, l.args.tokenOut, l.args.amountOut);
    act("swap", l.args.sender, l.transactionHash, l.blockNumber, eth);
    if (eth > 0) add(l.args.sender, "swap", eth * RULES.ethPerEth, l.blockNumber, RULES.swapDailyCap);
  }

  // ── 지정가·적립식: every fill counts for the order's owner ──
  {
    const [made, fills] = await Promise.all([scan(orderContracts, EV.orderCreated, from, head.number), scan(orderContracts, EV.orderExecuted, from, head.number)]);
    const byId = new Map(made.map((l) => [`${l.address.toLowerCase()}|${l.args.id}`, l.args]));
    for (const l of fills.filter((x) => inSeason(x.blockNumber))) {
      const o = byId.get(`${l.address.toLowerCase()}|${l.args.id}`);
      if (!o) continue;
      quest(o.owner, "swap", l.blockNumber);
      const eth = ethSide(o.tokenIn, l.args.amountIn, o.tokenOut, l.args.amountOut);
      act("swap", o.owner, l.transactionHash, l.blockNumber, eth);
      if (eth > 0) add(o.owner, "swap", eth * RULES.ethPerEth, l.blockNumber, RULES.swapDailyCap);
    }
  }

  // ── 브릿지: withdrawals and fast exits on GIWA (deposits from Ethereum are counted further down) ──
  const door = deployment<{ withdraw: Address }>("91342.withdraw.json");
  const fastExit = deployment<{ fastExit: Address }>("91342.fastexit.json");
  const bridgeOut = (who: Address, amount: bigint, bn: bigint, tx: string) => {
    act("bridge", who, tx, bn, Number(formatUnits(amount, 18)));
    if (!inSeason(bn)) return;
    quest(who, "bridge", bn);
    add(who, "bridge", Number(formatUnits(amount, 18)) * RULES.bridgePerEth, bn, RULES.bridgeDailyCap);
  };
  if (door) for (const l of await scan([door.withdraw], EV.bridged, startBlock, head.number)) bridgeOut(l.args.from, l.args.amount, l.blockNumber, l.transactionHash);
  if (fastExit) for (const l of await scan([fastExit.fastExit], EV.exited, startBlock, head.number)) bridgeOut(l.args.from, l.args.amount, l.blockNumber, l.transactionHash);
  // ── 인사동: mints from Insadong drops, and NFT sales (buyer and seller) ──
  const insa = deployment<{ insaFactory: Address; insaMarket: Address }>("91342.insa.json");
  if (insa) {
    const drops = (await scan([insa.insaFactory], EV.insaCreated, from, head.number)).map((l) => l.args.drop);
    if (drops.length) {
      for (const l of (await scan(drops, EV.insaMinted, from, head.number)).filter((x) => inSeason(x.blockNumber))) {
        act("insa", l.args.to, l.transactionHash, l.blockNumber, Number(formatUnits(l.args.paid, 18)));
        counts.nftMinted += Number(l.args.quantity);
        add(l.args.to, "insa", Number(l.args.quantity) * RULES.insaMint, l.blockNumber, RULES.insaMintCap);
        quest(l.args.to, "insa", l.blockNumber);
      }
    }
    for (const l of (await scan([insa.insaMarket], EV.insaSold, from, head.number)).filter((x) => inSeason(x.blockNumber))) {
      const v = Number(formatUnits(l.args.price, 18)) * RULES.insaPerEth;
      counts.nftSold += 1;
      act("insa", l.args.buyer, l.transactionHash, l.blockNumber, Number(formatUnits(l.args.price, 18)));
      act("insa", l.args.seller, l.transactionHash, l.blockNumber);
      for (const who of [l.args.buyer, l.args.seller]) {
        add(who, "insa", v, l.blockNumber, RULES.insaDailyCap);
        quest(who, "insa", l.blockNumber);
      }
    }
  }

  // Deposits start on Ethereum: the recipient on GIWA did the bridging, on the day it was sent.
  const l1Bridge = deployment<{ bridge: Address }>("11155111.bridge.json");
  if (l1Bridge) {
    try {
      const l1Head = await l1.getBlock();
      const l1Start = l1Head.number - BigInt(Math.floor((Number(l1Head.timestamp) - SEASON.startsAt) / 12) + 300);
      for (let b = l1Start; b <= l1Head.number; b += 50_000n) {
        const to = b + 49_999n > l1Head.number ? l1Head.number : b + 49_999n;
        for (const l of await l1.getLogs({ address: l1Bridge.bridge, event: EV.bridged, fromBlock: b, toBlock: to, strict: true })) {
          const t = Number(l1Head.timestamp) - Number(l1Head.number - l.blockNumber) * 12;
          if (t < SEASON.startsAt || t > SEASON.endsAt) continue;
          const k = `${l.args.to.toLowerCase()}|${kstDay(t)}`;
          if (!quests.has(k)) quests.set(k, new Set());
          quests.get(k)!.add("bridge");
          // The GIWA block at the same moment, so the deposit lands on the right Korean day and cap.
          const giwaBn = head.number - BigInt(Math.max(0, Number(head.timestamp) - t));
          act("bridge", l.args.to, l.transactionHash, giwaBn, Number(formatUnits(l.args.amount, 18)));
          add(l.args.to, "bridge", Number(formatUnits(l.args.amount, 18)) * RULES.bridgePerEth, giwaBn, RULES.bridgeDailyCap);
        }
      }
    } catch {
      /* Ethereum unreachable this run: its bridge quests land next run */
    }
  }
  for (const [k, qs] of quests) {
    const [who, d] = k.split("|");
    for (const q of qs) add(who as Address, "daily", q === "bridge" ? RULES.dailyBridge : RULES.dailyQuest);
    if (qs.size >= 4) add(who as Address, "daily", RULES.dailyAll);
    if (!days.has(who)) days.set(who, new Set());
    days.get(who)!.add(Number(d));
  }
  const today = kstDay(Number(head.timestamp));
  const todayRows: Record<string, Today> = {};
  const row = (who: string) => (todayRows[who] ??= { spun: false, reward: null, streak: 0, quests: { swap: false, curve: false, yut: false, bridge: false, insa: false } });
  const dailyC = deployment<{ daily: Address }>("91342.daily.json");
  if (dailyC) {
    const spins = (await scan([dailyC.daily], EV.spun, startBlock, head.number)).filter((l) => inSeason(l.blockNumber));
    const hashes = new Map<bigint, `0x${string}`>();
    for (const l of spins) act("daily", l.args.who, l.transactionHash, l.blockNumber);
    for (const l of spins) {
      const next = l.args.blockNumber + 1n;
      if (next > head.number) continue; // revealed by the next block, counted next run
      if (!hashes.has(next)) hashes.set(next, (await giwa.getBlock({ blockNumber: next })).hash);
      const reward = Number(await giwa.readContract({ address: dailyC.daily, abi: dailyAbi, functionName: "rewardFor", args: [hashes.get(next)!, l.args.who, l.args.day] }));
      add(l.args.who, "daily", reward, l.blockNumber);
      if (l.args.streak % 7n === 0n) add(l.args.who, "daily", RULES.streak7);
      if (Number(l.args.day) === today) Object.assign(row(l.args.who.toLowerCase()), { spun: true, reward, streak: Number(l.args.streak) });
    }
  }
  for (const [k, qs] of quests) {
    const [who, d] = k.split("|");
    if (Number(d) !== today) continue;
    for (const q of qs) row(who).quests[q] = true;
  }

  // ── active days, verification, ranking ──
  for (const [k, d] of days) pts.get(k)!.days = d.size * RULES.activeDay;
  // 친구 초대: everyone in an invite joins the table, so the inviter shows up even before trading.
  const inviteC = deployment<{ invite: Address }>("91342.invite.json");
  const invites = inviteC ? await scan([inviteC.invite], EV.invited, from, head.number) : [];
  for (const l of invites) for (const w of [l.args.invitee, l.args.referrer]) add(w, "invite", 0);
  for (const l of invites) act("invite", l.args.invitee, l.transactionHash, l.blockNumber);
  // Jangteo's own contracts (escrows, locked liquidity, routers) are not people and never earn points.
  const ours = ourContracts();
  const addrs = [...pts.keys()].filter((a) => !ours.has(a)) as Address[];
  const verified = await Promise.all(
    addrs.map((a) => giwa.readContract({ address: base.gate, abi: gateAbi, functionName: "isEligible", args: [a] }).catch(() => false)),
  );
  // The nightly QA traders are ours too: shown with the team, never ranked against real people.
  const qa = [1, 2, 3].map((i) => process.env[`GIWA_TRADER${i}_ADDRESS`]);
  const team = new Set([config.wallets.deployer?.address, ...config.wallets.farm.map((f) => f.address), ...qa].filter(Boolean).map((a) => a!.toLowerCase()));
  const tal = talAddress();
  const holds = tal
    ? await Promise.all(addrs.map((a) => giwa.readContract({ address: tal, abi: balanceAbi, functionName: "balanceOf", args: [a] }).then((b) => b > 0n).catch(() => false)))
    : addrs.map(() => false);

  // Invite credit is worked out on everything else a wallet earned, so it never compounds.
  const idx = new Map(addrs.map((a, i) => [a.toLowerCase(), i]));
  const baseOf = (a: string) => Math.max(0, PARTS.reduce((s, p) => s + (p === "invite" ? 0 : pts.get(a)![p]), 0));
  const invitedBy = new Map<string, Address>();
  const inviteCount = new Map<string, number>();
  for (const l of invites) {
    const friend = l.args.invitee.toLowerCase();
    const inviter = l.args.referrer.toLowerCase();
    const fi = idx.get(friend);
    const ri = idx.get(inviter);
    if (fi === undefined || ri === undefined) continue;
    invitedBy.set(friend, l.args.referrer);
    if (!verified[fi] || team.has(friend)) continue;
    const base = baseOf(friend);
    if (base <= 0) continue;
    if (verified[ri] || team.has(inviter)) pts.get(friend)!.invite += RULES.inviteWelcome;
    if (!verified[ri] || team.has(inviter)) continue;
    const r = pts.get(inviter)!;
    r.invite = Math.min(RULES.inviteCap, r.invite + base * RULES.inviteShare);
    inviteCount.set(inviter, (inviteCount.get(inviter) ?? 0) + 1);
  }

  const entries: Entry[] = addrs.map((a, i) => {
    const parts = pts.get(a)!;
    for (const p of PARTS) parts[p] = Math.round(parts[p] * 10) / 10;
    // Penalties can pull a category negative, never the total.
    const sum = Math.max(0, PARTS.reduce((s, p) => s + parts[p], 0));
    const total = Math.round(holds[i] ? sum * (1 + RULES.talBoost) : sum);
    return { address: a, total, parts, activeDays: days.get(a)?.size ?? 0, verified: verified[i], team: team.has(a), tal: holds[i] || undefined, invitedBy: invitedBy.get(a), invites: inviteCount.get(a), rank: null };
  });
  entries.sort((x, y) => y.total - x.total);
  let r = 0;
  for (const e of entries) if (e.verified && !e.team && e.total > 0) e.rank = ++r;
  // ── stats ──
  const isTeam = (a: string) => team.has(a) || ours.has(a);
  const verifiedSet = new Set(addrs.filter((_, i) => verified[i]).map((a) => a.toLowerCase()));
  const STALLS: Stall[] = ["swap", "pump", "insa", "bridge", "cheongyak", "jangoe", "sangjang", "gye", "yut", "daily", "invite"];
  const stallStats = Object.fromEntries(STALLS.map((k) => [k, { tx: 0, users: 0, eth: 0, krw: 0 }])) as Record<Stall, StallStats>;
  const txAll = new Set<string>();
  const txCommunity = new Set<string>();
  const usersAll = new Set<string>();
  const firstDay = new Map<string, number>();
  const byDay = new Map<number, { tx: Set<string>; users: Set<string>; eth: number; krw: number }>();
  for (const k of STALLS) {
    const rows = acts.filter((a) => a.stall === k);
    stallStats[k].tx = new Set(rows.map((a) => a.tx)).size;
    stallStats[k].users = new Set(rows.filter((a) => !isTeam(a.who)).map((a) => a.who)).size;
  }
  for (const a of acts) {
    const d = kstDay(a.t);
    txAll.add(a.tx);
    usersAll.add(a.who);
    if (!isTeam(a.who)) txCommunity.add(a.tx);
    stallStats[a.stall].eth += a.eth;
    stallStats[a.stall].krw += a.krw;
    if (!firstDay.has(a.who) || firstDay.get(a.who)! > d) firstDay.set(a.who, d);
    if (!byDay.has(d)) byDay.set(d, { tx: new Set(), users: new Set(), eth: 0, krw: 0 });
    const b = byDay.get(d)!;
    b.tx.add(a.tx);
    b.users.add(a.who);
    b.eth += a.eth;
    b.krw += a.krw;
  }
  const community = [...usersAll].filter((a) => !isTeam(a));
  const firstDays = kstDay(SEASON.startsAt);
  const stats: StatsFile = {
    updatedAt: Number(head.timestamp),
    since: SEASON.startsAt,
    totals: {
      tx: txAll.size,
      communityTx: txCommunity.size,
      users: usersAll.size,
      community: community.length,
      verified: community.filter((a) => verifiedSet.has(a)).length,
      eth: STALLS.reduce((x, k) => x + stallStats[k].eth, 0),
      krw: STALLS.reduce((x, k) => x + stallStats[k].krw, 0),
    },
    stalls: stallStats,
    counts,
    days: Array.from({ length: Math.max(1, today - firstDays + 1) }, (_, i) => firstDays + i).map((d) => {
      const b = byDay.get(d);
      return {
        day: d,
        tx: b?.tx.size ?? 0,
        users: b?.users.size ?? 0,
        newUsers: [...firstDay.values()].filter((x) => x === d).length,
        eth: Math.round((b?.eth ?? 0) * 1e6) / 1e6,
        krw: Math.round(b?.krw ?? 0),
      };
    }),
  };

  return {
    stats,
    season: SEASON,
    rules: RULES,
    updatedAt: Number(head.timestamp),
    entries,
    today: { day: today, wallets: todayRows },
    totals: {
      participants: entries.length,
      verified: entries.filter((e) => e.verified).length,
      points: entries.filter((e) => e.rank !== null).reduce((s, e) => s + e.total, 0),
    },
  };
}

/** Recomputes Season points and publishes points.json next to the web app. */
export function pointsTask(store: Store): Task {
  return {
    id: "points:season",
    title: "Jangteo Points",
    everyMs: 5 * 60_000, // quests should tick off soon after they are done
    jitterMs: 20_000,
    timeoutMs: 10 * 60_000,
    lane: "giwa:read",
    async run(): Promise<TaskResult> {
      const f = await computePoints();
      if (!f) return { summary: "not deployed", nextAt: Date.now() + 30 * 60_000 };
      store.set("points:latest", { updatedAt: f.updatedAt, totals: f.totals, top: f.entries.filter((e) => e.rank !== null).slice(0, 5) });
      if (existsSync(config.webroot)) {
        const { stats, ...points } = f;
        const out = resolve(config.webroot, "points.json");
        writeFileSync(`${out}.tmp`, JSON.stringify(points));
        renameSync(`${out}.tmp`, out);
        if (stats) {
          const so = resolve(config.webroot, "stats.json");
          writeFileSync(`${so}.tmp`, JSON.stringify(stats));
          renameSync(`${so}.tmp`, so);
        }
      }
      return { summary: `${f.totals.participants} wallets (${f.totals.verified} verified) · ${f.totals.points.toLocaleString("en-US")} P ranked` };
    },
  };
}
