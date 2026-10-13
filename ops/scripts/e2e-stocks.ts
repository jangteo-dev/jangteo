// Live end-to-end check of 장터 주식 on GIWA Sepolia, while the Korean market is open.
//  TRADER2 buys Samsung Electronics for ₩100,000, sells half, the vault books are checked to the wei
//  from the trade events; TRADER3 adds liquidity and can't withdraw inside the lock; a buy of a closed
//  US stock is refused; a wallet that only received tokens can still sell them.
//    cd ops && node scripts/e2e-stocks.ts
import assert from "node:assert/strict";
import { decodeEventLog, formatEther, maxUint256, parseAbi, parseEther, type Address, type Hex } from "viem";
import { giwa, reason, write } from "../src/chain.ts";
import { gyeDeployment } from "../src/config.ts";
import { stocksAbi, stocksAddresses, symId } from "../src/stocks/catalog.ts";
import { teamWallet } from "../src/stocks/wallets.ts";

const t2 = teamWallet("TRADER2")!;
const t3 = teamWallet("TRADER3")!;
const { stocks: ex } = stocksAddresses()!;
const tkrw = gyeDeployment()!.tkrw;
const SYM = "005930";
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const read = <T>(functionName: string, args: unknown[] = []) => giwa.readContract({ address: ex, abi: stocksAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(1500);
  }
}
/** The decoded event of `name` in a transaction's receipt. */
async function eventOf(hash: Hex | null, name: string) {
  const rc = await giwa.waitForTransactionReceipt({ hash: hash! });
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== ex.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi: stocksAbi, data: l.data, topics: l.topics });
      if (e.eventName === name) return e.args as Record<string, bigint>;
    } catch {
      /* not ours */
    }
  }
  throw new Error(`${name} not found`);
}

const q = await read<[bigint, bigint, boolean, bigint]>("quoteOf", [symId(SYM)]);
if (!q[2]) {
  console.log("Samsung isn't tradable right now (market closed or price stale) — run this while the Korean market is open.");
  process.exit(2);
}
const token = (await read<{ token: Address }>("marketOf", [symId(SYM)])).token;
for (const w of [t2, t3]) {
  if ((await giwa.readContract({ address: tkrw, abi: erc, functionName: "allowance", args: [w.address, ex] })) < parseEther("10000000")) {
    await write({ key: w.key, address: tkrw, abi: erc, functionName: "approve", args: [ex, maxUint256] });
  }
}
await until(() => giwa.readContract({ address: tkrw, abi: erc, functionName: "allowance", args: [t3.address, ex] }), (a) => a > 0n, "approvals");

// ── buy ──
const bal0 = await giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [ex] });
const fees0 = await read<bigint>("feesAccrued");
const KRW = parseEther("100000");
const { hash: hb } = await write({ key: t2.key, address: ex, abi: stocksAbi, functionName: "buy", args: [symId(SYM), KRW, 0n] });
const b = await eventOf(hb, "Bought");
const fee = (KRW * 30n) / 10_000n;
assert.equal(b.fee, fee);
assert.equal(b.shares, ((KRW - fee) * 10n ** 18n) / b.price);
log(`✓ bought ${formatEther(b.shares)} jSAMSUNG at ₩${formatEther(b.price)} (fee ₩${formatEther(fee)})`);
await until(() => read<bigint>("feesAccrued"), (f) => f - fees0 === (fee * 2_000n) / 10_000n, "protocol fee 20%");
log("✓ 20% of the fee booked for the treasury, 80% stays in the vault");
const held = await until(() => giwa.readContract({ address: token, abi: erc, functionName: "balanceOf", args: [t2.address] }), (x) => x >= b.shares, "shares minted");

// ── sell half ──
const half = b.shares / 2n;
const before = await giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [t2.address] });
const { hash: hs } = await write({ key: t2.key, address: ex, abi: stocksAbi, functionName: "sell", args: [symId(SYM), half, 0n] });
const s = await eventOf(hs, "Sold");
const gross = (half * s.price) / 10n ** 18n;
assert.equal(s.fee, (gross * 30n) / 10_000n);
assert.equal(s.krwOut, gross - s.fee);
await until(() => giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [t2.address] }), (x) => x - before === s.krwOut, "sell paid");
log(`✓ sold ${formatEther(half)} at ₩${formatEther(s.price)} → ₩${formatEther(s.krwOut)}`);
const bal1 = await until(
  () => giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [ex] }),
  (x) => x === bal0 + KRW - s.krwOut,
  "vault balance",
);
log(`✓ vault holds exactly ₩${formatEther(bal1)} = before + paid in − paid out`);

// ── closed market ──
await assert.rejects(giwa.simulateContract({ account: t2.address, address: ex, abi: stocksAbi, functionName: "buy", args: [symId("NVDA"), KRW, 0n] }), /MarketClosed|0x0b5f6bf0/);
log("✓ buying a closed US stock is refused (MarketClosed)");

// ── LP ──
const nav = await read<bigint>("nav");
const supply = await read<bigint>("totalSupply");
const LPK = parseEther("200000");
const { hash: hd } = await write({ key: t3.key, address: ex, abi: stocksAbi, functionName: "deposit", args: [LPK, 0n] });
const dep = await eventOf(hd, "Deposited");
// NAV can move a little between our read and the block (prices update); check against the event's own NAV.
assert.equal(dep.minted, (LPK * supply) / (dep.nav - LPK));
log(`✓ deposit ₩200,000 → ${formatEther(dep.minted)} JSLP at NAV ₩${formatEther(dep.nav - LPK)} (read ₩${formatEther(nav)})`);
await assert.rejects(giwa.simulateContract({ account: t3.address, address: ex, abi: stocksAbi, functionName: "withdraw", args: [dep.minted, 0n] }), /Locked|0x0f2e5b6c/);
await assert.rejects(giwa.simulateContract({ account: t3.address, address: ex, abi: erc, functionName: "transfer", args: [t2.address, 1n] }), /0x0f2e5b6c|Locked/);
log("✓ fresh LP can't be withdrawn or moved inside the 24 h lock");

// ── a holder who only received the token can sell it ──
const rest = held - half;
await write({ key: t2.key, address: token, abi: erc, functionName: "transfer", args: [t3.address, rest] });
await until(() => giwa.readContract({ address: token, abi: erc, functionName: "balanceOf", args: [t3.address] }), (x) => x >= rest, "transfer");
const { hash: hs2 } = await write({ key: t3.key, address: ex, abi: stocksAbi, functionName: "sell", args: [symId(SYM), rest, 0n] }).catch((e) => {
  throw new Error(`sell by receiver: ${reason(e)}`);
});
const s2 = await eventOf(hs2, "Sold");
log(`✓ the receiver sold the transferred ${formatEther(rest)} for ₩${formatEther(s2.krwOut)}`);
log("✓ E2E PASSED");
process.exit(0);
