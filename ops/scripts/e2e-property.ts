// Live end-to-end check of 장터 부동산 on the e2e registry (rent every 10 minutes, sales from 60 s).
//  A. TRADER1 lists a property; FARM1 and TRADER2 buy it out; the sale closes; FARM1 lists shares,
//     TRADER3 buys part, FARM1 takes the rest back; after one rent period everyone's rent is
//     checked to the won; TRADER1 sells the property and every holder redeems.
//  B. A sale that misses its minimum fails and the buyer is refunded in full.
// Every amount is asserted exactly. The ops keeper (property-e2e:keeper) may close sales or book
// rent before this script does: both orders are handled.   cd ops && node scripts/e2e-property.ts
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { formatEther, maxUint256, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { giwa, reason, write } from "../src/chain.ts";
import { gyeDeployment } from "../src/config.ts";
import { PS, propertyAbi, propertyAddress } from "../src/property.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../../keys/keeper.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2) as [string, string]),
);
const wallet = (name: string) => ({ name, key: env[`GIWA_${name}_KEY`] as Hex, address: privateKeyToAccount(env[`GIWA_${name}_KEY`] as Hex).address });
const issuer = wallet("TRADER1");
const f1 = wallet("FARM1");
const t2 = wallet("TRADER2");
const t3 = wallet("TRADER3");
const reg = propertyAddress("property-e2e")!;
const tkrw = gyeDeployment()!.tkrw;
const W = (won: number) => parseEther(String(won));
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function drip()", "function transfer(address,uint256) returns (bool)"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const bal = (who: Address) => giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [who] });
const prop = (id: bigint) => giwa.readContract({ address: reg, abi: propertyAbi, functionName: "property", args: [id] });
const shares = async (id: bigint, who: Address) => giwa.readContract({ address: (await prop(id)).share, abi: erc, functionName: "balanceOf", args: [who] });

/** GIWA reads can trail a write by a block: poll until the condition holds. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1500);
  }
}
/** Balance change caused by `fn`, read once the chain shows it. */
async function delta(who: Address, fn: () => Promise<unknown>, expect: bigint, what: string) {
  const before = await bal(who);
  await fn();
  const after = await until(() => bal(who), (b) => b - before === expect, `${what}: Δ ${formatEther(expect)}`);
  log(`✓ ${what}: ${formatEther(after - before)} tKRW`);
}
const tx = (w: { key: Hex }, functionName: string, args: unknown[]) => write({ key: w.key, address: reg, abi: propertyAbi, functionName: functionName as never, args: args as never });
async function close(id: bigint) {
  const p0 = await prop(id);
  // Wait for chain time (not ours) to pass the deadline, unless the sale already sold out.
  if (p0.sold < p0.totalShares) await until(async () => (await giwa.getBlock()).timestamp, (t) => t >= p0.endAt, "chain time past the deadline", 180_000);
  if ((await prop(id)).status === PS.Funding) {
    try {
      await tx(f1, "finalize", [id]);
    } catch (err) {
      log(`finalize by script skipped (${reason(err)}), keeper may have closed it`);
    }
  }
  return until(() => prop(id), (p) => p.status !== PS.Funding, "sale closed", 180_000);
}

// ── setup: test won and approvals ──
for (const w of [issuer, f1, t2, t3]) {
  if ((await bal(w.address)) < W(300_000)) await write({ key: w.key, address: tkrw, abi: erc, functionName: "drip" }).catch((e) => log(`${w.name} drip: ${reason(e)}`));
  if ((await giwa.readContract({ address: tkrw, abi: erc, functionName: "allowance", args: [w.address, reg] })) < W(10_000_000)) {
    await write({ key: w.key, address: tkrw, abi: erc, functionName: "approve", args: [reg, maxUint256] });
  }
}
await until(() => giwa.readContract({ address: tkrw, abi: erc, functionName: "allowance", args: [t3.address, reg] }), (a) => a > 0n, "approvals");

const terms = { totalShares: 100n, minShares: 50n, price: W(1_000), duration: 300n, rentPerPeriod: W(10_000), reserveMonths: 3n };
// ── A. full life cycle ── (E2E_PART=B skips it)
if (process.env.E2E_PART !== "B") {
const meta = JSON.stringify({ name: "E2E Officetel", location: "QA", kind: "apartment", images: ["/property/gangnam.svg"] });
const { result } = await tx(issuer, "create", [terms, meta]);
const id = result as bigint;
log(`property #${id} created`);
await until(() => giwa.readContract({ address: reg, abi: propertyAbi, functionName: "count" }), (n) => n > id, "property visible");

await delta(f1.address, () => tx(f1, "buy", [id, 60n]), -W(60_000), "FARM1 buys 60 shares");
await delta(issuer.address, async () => {
  await tx(t2, "buy", [id, 40n]); // sells out
  await close(id);
}, W(68_000), "issuer paid 100,000 − 2% fee − 30,000 reserve");
let p = await prop(id);
assert.equal(p.status, PS.Active);
assert.equal(p.reserve, W(30_000));
log("✓ active, reserve ₩30,000");

// Shares may only go to verified wallets: a plain transfer to a fresh address must fail.
const shareAbi = parseAbi(["function transfer(address,uint256) returns (bool)"]);
await assert.rejects(
  giwa.simulateContract({ account: f1.address, address: p.share, abi: shareAbi, functionName: "transfer", args: ["0x000000000000000000000000000000000000dEaD", 1n] }),
  /NotEligible|0xf8eb54de/, // NotEligible() from the registry hook; the share ABI can't name it
);
log("✓ transfer to an unverified wallet refused");

// Market: FARM1 lists 10 at ₩1,200, TRADER3 buys 4, FARM1 takes 6 back.
const lc = await giwa.readContract({ address: reg, abi: propertyAbi, functionName: "listingCount" });
await tx(f1, "list", [id, 10n, W(1_200)]);
const lid = await until(() => giwa.readContract({ address: reg, abi: propertyAbi, functionName: "listingCount" }), (n) => n > lc, "listing").then((n) => n - 1n);
await delta(f1.address, () => tx(t3, "buyListing", [lid, 4n]), W(4_752), "FARM1 receives 4 × 1,200 − 1% fee");
await tx(f1, "cancelListing", [lid]);
await until(() => shares(id, f1.address), (s) => s === 56n, "FARM1 holds 56 again");
assert.equal(await shares(id, t3.address), 4n);
log("✓ market: 56 / 40 / 4");

// Rent: wait for the first period, then each holder's rent must be exact.
p = await prop(id);
const due = Number(p.lastPeriodAt) + 600 + 5;
log(`waiting ${due - Math.floor(Date.now() / 1000)} s for the first rent period…`);
while (Math.floor(Date.now() / 1000) < due) await sleep(5_000);
for (const [w, want] of [[f1, 5_600], [t2, 4_000], [t3, 400]] as const) {
  const c = await until(() => giwa.readContract({ address: reg, abi: propertyAbi, functionName: "claimable", args: [id, w.address] }), (v) => v === W(want), `${w.name} rent`);
  log(`✓ ${w.name} can claim ${formatEther(c)}`);
}
await delta(f1.address, () => tx(f1, "claimRent", [id]), W(5_600), "FARM1 claims rent");

// Exit: TRADER1 sells for ₩150,000. Rent booked so far comes out of the reserve, the rest of the
// reserve goes back, and the pool is the sale minus the 1% exit fee.
const before = await bal(issuer.address);
await tx(issuer, "sell", [id, W(150_000)]);
p = await until(() => prop(id), (x) => x.status === PS.Sold, "sold");
const periods = (p.rentPaid) / W(10_000);
assert.equal(p.pool, W(148_500));
const back = W(30_000) - p.rentPaid;
await until(() => bal(issuer.address), (b) => before - b === W(150_000) - back, "reserve returned");
log(`✓ sold: ${periods} rent period(s) paid, reserve returned ₩${formatEther(back)}, pool ₩148,500`);

await delta(f1.address, () => tx(f1, "redeem", [id, 56n]), W(83_160), "FARM1 redeems 56 shares");
await delta(t2.address, () => tx(t2, "redeem", [id, 40n]), W(59_400), "TRADER2 redeems 40 shares");
await delta(t3.address, () => tx(t3, "redeem", [id, 4n]), W(5_940), "TRADER3 redeems 4 shares");
for (const w of [f1, t2, t3]) {
  const c = await giwa.readContract({ address: reg, abi: propertyAbi, functionName: "claimable", args: [id, w.address] });
  if (c > 0n) await delta(w.address, () => tx(w, "claimRent", [id]), c, `${w.name} claims remaining rent after the sale`);
}
p = await until(() => prop(id), (x) => x.rentUnclaimed === 0n && x.redeemed === 100n, "all claimed");
log("✓ every share redeemed, every won of rent claimed");
}

// ── B. failed sale ──
const { result: r2 } = await tx(issuer, "create", [{ ...terms, minShares: 90n, duration: 60n }, JSON.stringify({ name: "E2E Failed Sale", kind: "land", images: [] })]);
const id2 = r2 as bigint;
await until(() => giwa.readContract({ address: reg, abi: propertyAbi, functionName: "count" }), (n) => n > id2, "second property");
await tx(f1, "buy", [id2, 10n]);
const end = Number((await prop(id2)).endAt) + 3;
while (Math.floor(Date.now() / 1000) < end) await sleep(3_000);
const q = await close(id2);
assert.equal(q.status, PS.Failed);
await delta(f1.address, () => tx(f1, "refund", [id2]), W(10_000), "FARM1 refunded in full");

// ── the registry holds exactly what it owes (other runs' properties included), plus rounding dust ──
let owed = await giwa.readContract({ address: reg, abi: propertyAbi, functionName: "feesAccrued" });
const total = await giwa.readContract({ address: reg, abi: propertyAbi, functionName: "count" });
for (let i = 0n; i < total; i++) {
  const x = await prop(i);
  if (x.status === PS.Funding) owed += x.sold * x.price;
  else if (x.status === PS.Failed) owed += x.refundable;
  else if (x.status === PS.Active) owed += x.reserve + x.rentUnclaimed;
  else owed += x.rentUnclaimed + x.pool - (x.pool * x.redeemed) / x.exitSupply;
}
const held = await bal(reg);
log(`registry holds ₩${formatEther(held)}, owes ₩${formatEther(owed)}`);
assert.ok(held >= owed && held - owed < 1000n, "holdings match what is owed");
log("✓ E2E PASSED");
process.exit(0);
