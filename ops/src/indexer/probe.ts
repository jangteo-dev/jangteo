import { encodeAbiParameters, encodePacked, keccak256, pad, parseAbi, toHex, zeroAddress, type Address, type Hex, type StateOverride } from "viem";
import type { IndexDb } from "./db.ts";
import { call, rpc, transient } from "./rpc.ts";

const WETH = "0x4200000000000000000000000000000000000006";

export const aggregatorAbi = parseAbi([
  "struct Hop { address pool; uint8 kind; uint24 fee; }",
  "function swap(address[] path, Hop[] hops, uint256 amountIn, uint256 minOut, address to, uint256 deadline) payable returns (uint256)",
]);

/** Aggregator hop kinds: a standard V2 pair, a V2 pair whose swap() has no data argument, a V3 pool, a KachiSwap pair. */
export const KIND = { V2: 0, V2_NO_DATA: 1, V3: 2, KACHI: 3 } as const;
const FEES = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 10_000];

/**
 * How the aggregator must call each DEX, learned per factory by simulating a small swap through the
 * aggregator into that factory's deepest pool: the first (kind, fee) that goes through is the pair's
 * real swap signature and its fee (fees are tried from low to high, so the first one the pair's K
 * check accepts is the fee it charges). A WETH pool is simulated with plain ETH; any other pool with
 * the prober's token balance and allowance set by state override, since many GIWA DEXes pair
 * everything against their own WETH copy. Stored in the cursor table as kind·1e6 + fee, or -1 when
 * nothing works; factories with no usable pool are tried again later.
 */
export async function probeFactories(db: IndexDb, aggregator: Address, from: Address) {
  const factories = db.db.prepare("SELECT address, kind FROM factory").all() as { address: string; kind: string }[];
  let learned = 0;
  for (const f of factories) {
    if (db.cursor(`route:${f.address}`) !== null) continue;
    const pools = db.db
      .prepare(`SELECT address, token0, token1, r0, r1 FROM pool WHERE factory = ? ORDER BY length(r0) + length(r1) DESC LIMIT 40`)
      .all(f.address) as { address: string; token0: string; token1: string; r0: string; r1: string }[];
    // A WETH pool if there is one with reserves, else the deepest pool.
    const pool = pools.find((p) => (p.token0 === WETH || p.token1 === WETH) && (f.kind === "v3" || (p.r0 !== "0" && p.r1 !== "0"))) ?? pools.find((p) => f.kind === "v3" || (p.r0 !== "0" && p.r1 !== "0"));
    if (!pool) continue;
    const viaEth = pool.token0 === WETH || pool.token1 === WETH;
    const tokenIn = (viaEth ? WETH : pool.token0) as Address;
    const tokenOut = (tokenIn === pool.token0 ? pool.token1 : pool.token0) as Address;
    const held = BigInt(tokenIn === pool.token0 ? pool.r0 : pool.r1);
    // V3 pools keep no reserves in this table: a small fixed amount does.
    const amount = f.kind === "v3" || held === 0n ? 10n ** 12n : held / 1000n > 10n ** 15n && viaEth ? 10n ** 15n : held / 1000n || 1n;
    let override: StateOverride | undefined;
    if (!viaEth) {
      override = await fundOverride(tokenIn, from, aggregator, amount);
      if (!override) {
        db.setCursor(`route:${f.address}`, -1);
        continue;
      }
    }
    const tries: [number, number][] = f.kind === "v3" ? [[KIND.V3, 0]] : [
          // KachiSwap first: a plain V2 guess with a high fee can pass its K check on some trades and
          // then fail others, while a non-Kachi pair rejects the KACHI kind outright (no poolType()).
          [KIND.KACHI, 0],
          ...[KIND.V2, KIND.V2_NO_DATA].flatMap((k) => FEES.map((fee) => [k, fee] as [number, number])),
        ];
    let found = -1;
    for (const [kind, fee] of tries) {
      const ok = await call(
        () =>
          rpc
            .simulateContract({
              address: aggregator,
              abi: aggregatorAbi,
              functionName: "swap",
              args: [[viaEth ? zeroAddress : tokenIn, tokenOut], [{ pool: pool.address as Address, kind, fee }], amount, 1n, from, 2n ** 40n],
              value: viaEth ? amount : 0n,
              account: from,
              stateOverride: override,
            })
            .then(() => true)
            .catch((e: unknown) => {
              // Rate limits must retry, not read as "this kind does not work".
              if (transient(e)) throw e;
              return false;
            }),
        "probe",
      );
      if (ok) {
        found = kind * 1_000_000 + fee;
        break;
      }
    }
    db.setCursor(`route:${f.address}`, found);
    learned++;
  }
  return learned;
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const MARK = 0x5eed_1234_5678n;
const word = (v: bigint) => pad(toHex(v), { size: 32 });
const mapKey = (k: Address | Hex, slot: bigint | Hex) =>
  keccak256(encodeAbiParameters([{ type: typeof k === "string" && k.length === 42 ? "address" : "bytes32" }, { type: typeof slot === "bigint" ? "uint256" : "bytes32" }], [k, slot] as never));

/** Where a token may keep `balanceOf(owner)` and `allowance(owner, spender)`. */
function layouts(owner: Address, spender: Address): { bal: Hex; allow: Hex }[] {
  const out: { bal: Hex; allow: Hex }[] = [];
  // Plain Solidity mappings, balances at slot n and allowances at any slot up to 9.
  for (let b = 0n; b < 10n; b++) for (let a = 0n; a < 10n; a++) out.push({ bal: mapKey(owner, b), allow: mapKey(spender, mapKey(owner, a)) });
  // OpenZeppelin 5 upgradeable (ERC-7201 namespace "openzeppelin.storage.ERC20").
  const ns = BigInt("0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00");
  out.push({ bal: mapKey(owner, ns), allow: mapKey(spender, mapKey(owner, ns + 1n)) });
  // Solady ERC20: seeded slots.
  out.push({
    bal: keccak256(encodePacked(["address", "uint96"], [owner, 0x87a211a2n])),
    allow: keccak256(encodePacked(["address", "uint96", "address"], [owner, 0x7f5e9f20n, spender])),
  });
  return out;
}

/**
 * A state override that gives `owner` `amount` of `token` and lets `spender` pull it, found by
 * trying the usual storage layouts. Undefined when the token keeps its books somewhere unusual.
 */
async function fundOverride(token: Address, owner: Address, spender: Address, amount: bigint): Promise<StateOverride | undefined> {
  const probe = (fn: "balanceOf" | "allowance", slot: Hex) =>
    call(
      () =>
        rpc
          .readContract({
            address: token,
            abi: erc20,
            functionName: fn,
            args: (fn === "balanceOf" ? [owner] : [owner, spender]) as never,
            stateOverride: [{ address: token, stateDiff: [{ slot, value: word(MARK) }] }],
          })
          .catch(() => 0n),
      "probe",
    );
  const all = layouts(owner, spender);
  let bal: Hex | undefined;
  for (const b of new Set(all.map((l) => l.bal))) {
    if ((await probe("balanceOf", b)) === MARK) {
      bal = b;
      break;
    }
  }
  if (!bal) return undefined;
  for (const l of all.filter((x) => x.bal === bal)) {
    if ((await probe("allowance", l.allow)) === MARK) {
      return [{ address: token, stateDiff: [{ slot: bal, value: word(amount * 2n) }, { slot: l.allow, value: word(amount * 2n) }] }];
    }
  }
  return undefined;
}

/** A factory's learned (kind, fee), or null when it has not been probed or cannot be routed. */
export function routeOf(db: IndexDb, factory: string): { kind: number; fee: number } | null {
  const v = db.cursor(`route:${factory}`);
  if (v === null || v < 0) return null;
  return { kind: Math.floor(v / 1_000_000), fee: v % 1_000_000 };
}
