// Live end-to-end check of 장외: FARM2 lists ONGGI in 청약 v2, the ops curator opens its premarket,
// FARM1 bids for 50 units and FARM2 sells 40 into it, both subscribe, the keeper settles the
// offering, the curator opens delivery, and FARM2 delivers. Also leaves resting orders on the
// points market.  cd ops && node scripts/e2e-jangoe.ts
import { maxUint256, parseAbi, parseEther, stringToHex, type Address } from "viem";
import { giwa, write } from "../src/chain.ts";
import { config, gyeDeployment } from "../src/config.ts";
import { jangoeAbi, jangoeAddress } from "../src/jangoe.ts";
import { cheongyakV2Abi, launchpadAddresses, stallAddresses } from "../src/stalls.ts";

const [f1, f2] = config.wallets.farm;
const cy = launchpadAddresses()!.cheongyakV2;
const mk = jangoeAddress()!;
const { tokenFactory } = stallAddresses()!;
const tkrw = gyeDeployment()!.tkrw;
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function drip()"]);
const tf = parseAbi(["function create(string,string,uint256) returns (address)"]);
const v2 = parseAbi([
  "struct Terms { address token; address quote; bytes32 name; uint128 totalTokens; uint128 price; uint64 startAt; uint64 endAt; uint16 equalBps; uint128 minDeposit; uint128 maxDeposit; uint128 softCap; uint16 tgeBps; uint32 cliff; uint32 vesting; uint16 liqBps; uint32 lpLock; }",
  "function create(Terms t, string meta) returns (uint256)",
  "function subscribe(uint256 id, uint128 amount)",
  "function claim(uint256 id)",
]);
const jg = parseAbi([
  "function post(uint256 market, uint8 side, uint128 units, uint128 price) returns (uint256)",
  "function fill(uint256 offer, uint128 units) returns (uint256)",
  "function deliver(uint256[] ids)",
  "function offerCount() view returns (uint256)",
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bal = (t: Address, a: Address) => giwa.readContract({ address: t, abi: erc, functionName: "balanceOf", args: [a] });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

for (const w of [f1, f2]) {
  if ((await bal(tkrw, w.address)) < parseEther("200000")) await write({ key: w.key, address: tkrw, abi: erc, functionName: "drip" });
  for (const spender of [cy, mk]) await write({ key: w.key, address: tkrw, abi: erc, functionName: "approve", args: [spender, maxUint256] });
}

const { result } = await write({ key: f2.key, address: tokenFactory, abi: tf, functionName: "create", args: ["Onggi Labs", "ONGGI", parseEther("10000")] });
const token = result as Address;
await sleep(3000);
for (const spender of [cy, mk]) await write({ key: f2.key, address: token, abi: erc, functionName: "approve", args: [spender, maxUint256] });
await sleep(3000);
const start = (await giwa.getBlock()).timestamp + 60n;
const id = (await giwa.readContract({ address: cy, abi: cheongyakV2Abi, functionName: "offeringCount" })) as bigint;
await write({
  key: f2.key,
  address: cy,
  abi: v2,
  functionName: "create",
  args: [
    {
      token,
      quote: tkrw,
      name: stringToHex("Onggi Labs", { size: 32 }),
      totalTokens: parseEther("1000"),
      price: parseEther("100"),
      startAt: start,
      endAt: start + 360n,
      equalBps: 5000,
      minDeposit: parseEther("1000"),
      maxDeposit: parseEther("50000"),
      softCap: 0n,
      tgeBps: 10000,
      cliff: 0,
      vesting: 0,
      liqBps: 1000,
      lpLock: 30 * 86400,
    },
    JSON.stringify({ about: "Fermented storage for rollup state. Premarket trial." }),
  ],
});
log("offering", id, "ONGGI", token);

// Wait for the curator to open the premarket for it.
let market = -1;
for (let i = 0; i < 60 && market < 0; i++) {
  const n = Number(await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "marketCount" }));
  for (let k = 0; k < n; k++) {
    const meta = await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "marketMeta", args: [BigInt(k)] });
    if (meta.includes(`"offering":${id}`)) market = k;
  }
  if (market < 0) await sleep(10_000);
}
if (market < 0) throw new Error("curator never opened the market");
log("premarket", market, "open");

const bidId = (await giwa.readContract({ address: mk, abi: jg, functionName: "offerCount" })) as bigint;
await write({ key: f1.key, address: mk, abi: jg, functionName: "post", args: [BigInt(market), 0, parseEther("50"), parseEther("150")] });
await sleep(3000);
await write({ key: f2.key, address: mk, abi: jg, functionName: "post", args: [BigInt(market), 1, parseEther("20"), parseEther("190")] });
await sleep(3000);
const { result: tradeId } = await write({ key: f2.key, address: mk, abi: jg, functionName: "fill", args: [bidId, parseEther("40")] });
log("FARM2 sold 40 units into FARM1's bid at ₩150, trade", tradeId);

// Resting orders on the points market (#0) so it isn't empty.
await write({ key: f1.key, address: mk, abi: jg, functionName: "post", args: [0n, 1, parseEther("1000"), parseEther("12")] });
await write({ key: f2.key, address: mk, abi: jg, functionName: "post", args: [0n, 0, parseEther("500"), parseEther("10")] });
log("points market seeded");

while ((await giwa.getBlock()).timestamp < start + 2n) await sleep(3000);
await write({ key: f1.key, address: cy, abi: v2, functionName: "subscribe", args: [id, parseEther("30000")] });
await write({ key: f2.key, address: cy, abi: v2, functionName: "subscribe", args: [id, parseEther("20000")] });
log("subscribed; waiting for settlement and delivery window…");

for (let i = 0; i < 120; i++) {
  const m = await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "market", args: [BigInt(market)] });
  if (m.status === 2) {
    log("delivery open until", new Date(Number(m.deliverBy) * 1000).toISOString());
    break;
  }
  await sleep(10_000);
}
const h0 = await bal(token, f1.address);
const w0 = await bal(tkrw, f2.address);
await write({ key: f2.key, address: mk, abi: jg, functionName: "deliver", args: [[tradeId as bigint]] });
await sleep(3000);
log("FARM1 ONGGI +", (await bal(token, f1.address)) - h0, " FARM2 tKRW +", (await bal(tkrw, f2.address)) - w0);
const t = await giwa.readContract({ address: mk, abi: jangoeAbi, functionName: "trade", args: [tradeId as bigint] });
log("trade status", t.status, "(2 = delivered)");
