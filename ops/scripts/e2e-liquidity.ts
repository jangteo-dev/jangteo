// Live check of 장터 스왑 liquidity + protocol fee: FARM2 adds to HANJI/tKRW, FARM1 swaps through it,
// FARM2 removes half, and the treasury (factory feeTo) must now hold LP tokens.
// cd ops && node scripts/e2e-liquidity.ts
import { maxUint256, parseAbi, parseEther, type Address } from "viem";
import { giwa, write } from "../src/chain.ts";
import { config, gyeDeployment } from "../src/config.ts";
import { launchpadAddresses } from "../src/stalls.ts";

const [f1, f2] = config.wallets.farm;
const { swapRouter: router, swapFactory: factory } = launchpadAddresses()!;
const tkrw = gyeDeployment()!.tkrw;
const HANJI = "0xCAE9aA66E6d41E344aEc0DB59C2b8B93D7F2953A" as Address;
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function totalSupply() view returns (uint256)"]);
const r = parseAbi([
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
  "function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
]);
const f = parseAbi(["function getPair(address,address) view returns (address)", "function feeTo() view returns (address)"]);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 600);

const pair = await giwa.readContract({ address: factory, abi: f, functionName: "getPair", args: [tkrw, HANJI] });
const treasury = await giwa.readContract({ address: factory, abi: f, functionName: "feeTo" });
const lpOf = (a: Address) => giwa.readContract({ address: pair, abi: erc, functionName: "balanceOf", args: [a] });
for (const t of [tkrw, HANJI, pair]) await write({ key: f2.key, address: t, abi: erc, functionName: "approve", args: [router, maxUint256] });
await sleep(3000);

console.log("HANJI held by FARM2", await giwa.readContract({ address: HANJI, abi: erc, functionName: "balanceOf", args: [f2.address] }));
await write({ key: f2.key, address: router, abi: r, functionName: "addLiquidity", args: [HANJI, tkrw, parseEther("100"), parseEther("20000"), 0n, 0n, f2.address, dl()] });
await sleep(3000);
const lp = await lpOf(f2.address);
console.log("FARM2 LP after add", lp, "treasury LP", await lpOf(treasury));

// Volume through the pool so k grows and the protocol fee has something to mint.
for (const [amt, path] of [
  [parseEther("3000"), [tkrw, HANJI]],
  [parseEther("15"), [HANJI, tkrw]],
] as const) {
  await write({ key: f1.key, address: router, abi: r, functionName: "swapExactTokensForTokens", args: [amt, 0n, [...path], f1.address, dl()] });
  await sleep(2000);
}
await write({ key: f2.key, address: router, abi: r, functionName: "removeLiquidity", args: [HANJI, tkrw, lp / 2n, 0n, 0n, f2.address, dl()] });
await sleep(3000);
console.log("FARM2 LP after removing half", await lpOf(f2.address), "treasury LP", await lpOf(treasury));
