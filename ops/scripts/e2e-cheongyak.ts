// Live end-to-end check of 청약 v2: FARM2 lists a token with a soft cap, vesting and launch
// liquidity; FARM1 and FARM2 subscribe; the giwa-ops keeper settles it and seeds the 장터 스왑 pool.
// cd ops && node scripts/e2e-cheongyak.ts
import { maxUint256, parseAbi, parseEther, stringToHex, type Address } from "viem";
import { giwa, write } from "../src/chain.ts";
import { config, gyeDeployment } from "../src/config.ts";
import { cheongyakV2Abi, launchpadAddresses, stallAddresses } from "../src/stalls.ts";

const [f1, f2] = config.wallets.farm;
const { cheongyakV2: cy } = launchpadAddresses()!;
const { tokenFactory } = stallAddresses()!;
const tkrw = gyeDeployment()!.tkrw;
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function drip()"]);
const tf = parseAbi(["function create(string,string,uint256) returns (address)"]);
const v2 = parseAbi([
  "struct Terms { address token; address quote; bytes32 name; uint128 totalTokens; uint128 price; uint64 startAt; uint64 endAt; uint16 equalBps; uint128 minDeposit; uint128 maxDeposit; uint128 softCap; uint16 tgeBps; uint32 cliff; uint32 vesting; uint16 liqBps; uint32 lpLock; }",
  "function create(Terms t, string meta) returns (uint256)",
  "function subscribe(uint256 id, uint128 amount)",
  "function claim(uint256 id)",
  "function claimable(uint256 id, address who) view returns (uint256, uint256)",
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bal = (t: Address, a: Address) => giwa.readContract({ address: t, abi: erc, functionName: "balanceOf", args: [a] });

const { result } = await write({ key: f2.key, address: tokenFactory, abi: tf, functionName: "create", args: ["Hanji Labs", "HANJI", parseEther("10000")] });
const token = result as Address;
console.log("token", token);
await sleep(1500);
await write({ key: f2.key, address: token, abi: erc, functionName: "approve", args: [cy, maxUint256] });
await sleep(3000); // reads can land on a node a block behind the approval
const head = await giwa.getBlock();
const start = head.timestamp + 45n;
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
      name: stringToHex("Hanji Labs", { size: 32 }),
      totalTokens: parseEther("1000"),
      price: parseEther("100"),
      startAt: start,
      endAt: start + 150n,
      equalBps: 5000,
      minDeposit: parseEther("1000"),
      maxDeposit: parseEther("50000"),
      softCap: parseEther("30000"),
      tgeBps: 2500,
      cliff: 0,
      vesting: 7 * 86400,
      liqBps: 2000,
      lpLock: 30 * 86400,
    },
    JSON.stringify({ about: "Paper-thin rollup tooling, pressed like hanji.\nTestnet trial of 청약 v2.", site: "https://jangteo.org" }),
  ],
});
console.log("offering", id, "opens", new Date(Number(start) * 1000).toISOString());

for (const [w, amt] of [[f1, "40000"], [f2, "20000"]] as const) {
  if ((await bal(tkrw, w.address)) < parseEther(amt)) await write({ key: w.key, address: tkrw, abi: erc, functionName: "drip" });
  await write({ key: w.key, address: tkrw, abi: erc, functionName: "approve", args: [cy, maxUint256] });
}
await sleep(3000);
while ((await giwa.getBlock()).timestamp < start + 2n) await sleep(3000);
await write({ key: f1.key, address: cy, abi: v2, functionName: "subscribe", args: [id, parseEther("40000")] });
await write({ key: f2.key, address: cy, abi: v2, functionName: "subscribe", args: [id, parseEther("20000")] });
console.log("subscribed 40,000 + 20,000 tKRW; waiting for the keeper to settle…");

for (let i = 0; i < 120; i++) {
  const o = await giwa.readContract({ address: cy, abi: cheongyakV2Abi, functionName: "offering", args: [id] });
  if (o.status === 3 && o.issuerPaid) {
    console.log("settled. allocated", o.allocated, "raised", o.raised, "pool", o.pair, "lp", o.lpAmount, "liqQuote", o.liqQuote, "liqTokens", o.liqTokens);
    break;
  }
  await sleep(10_000);
}
const [tk, rf] = (await giwa.readContract({ address: cy, abi: v2, functionName: "claimable", args: [id, f1.address] })) as [bigint, bigint];
console.log("FARM1 claimable now", tk, "tokens,", rf, "refund");
await write({ key: f1.key, address: cy, abi: v2, functionName: "claim", args: [id] });
console.log("FARM1 HANJI after claim", await bal(token, f1.address));
