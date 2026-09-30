// Live check of the 장터 스왑 aggregator: TRADER1 buys a Naruswap token with ETH, sells it back,
// and the treasury receives the 0.1% routing fee.
// cd ops && node scripts/e2e-aggregator.ts
import { readFileSync } from "node:fs";
import { maxUint256, parseAbi, parseEther, formatEther, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { giwa, write } from "../src/chain.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../../keys/keeper.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2) as [string, string]),
);
const key = env.GIWA_TRADER1_KEY as Hex;
const me = privateKeyToAccount(key).address;
const agg = JSON.parse(readFileSync(new URL("../../contracts/deployments/91342.aggregator.json", import.meta.url), "utf8")).aggregator as Address;
const treasury = env.GIWA_DEPLOYER_ADDRESS as Address;
const TOKEN = "0xaEF40Bb184aA7e367ff535671B2263670a1f5Eac" as Address;
const hops = [{ pool: "0xC3558e02DA63D4E9693AddD10e0c4551B30303a6" as Address, kind: 1, fee: 3000 }];
const abi = parseAbi([
  "struct Hop { address pool; uint8 kind; uint24 fee; }",
  "function quote(address[] path, Hop[] hops, uint256 amountIn) returns (uint256)",
  "function swap(address[] path, Hop[] hops, uint256 amountIn, uint256 minOut, address to, uint256 deadline) payable returns (uint256)",
]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

const amt = parseEther("0.002");
const t0 = await giwa.getBalance({ address: treasury });
const { result: q } = await giwa.simulateContract({ address: agg, abi, functionName: "quote", args: [[zeroAddress, TOKEN], hops, amt], account: me });
console.log("quote", formatEther(q));
const b0 = await giwa.readContract({ address: TOKEN, abi: erc, functionName: "balanceOf", args: [me] });
const buy = await write({ key, address: agg, abi, functionName: "swap", args: [[zeroAddress, TOKEN], hops, amt, (q * 99n) / 100n, me, deadline()], value: amt });
await sleep(3000);
const got = (await giwa.readContract({ address: TOKEN, abi: erc, functionName: "balanceOf", args: [me] })) - b0;
console.log("buy", buy.hash, "got", formatEther(got), got === q ? "(= quote)" : "");
console.log("treasury +", formatEther((await giwa.getBalance({ address: treasury })) - t0), "ETH");

await write({ key, address: TOKEN, abi: erc, functionName: "approve", args: [agg, maxUint256] });
await sleep(3000);
const { result: q2 } = await giwa.simulateContract({ address: agg, abi, functionName: "quote", args: [[TOKEN, zeroAddress], hops, got], account: me });
const e0 = await giwa.getBalance({ address: me });
const sell = await write({ key, address: agg, abi, functionName: "swap", args: [[TOKEN, zeroAddress], hops, got, (q2 * 99n) / 100n, me, deadline()] });
console.log("sell", sell.hash, "quote", formatEther(q2), "ETH; balance delta incl. gas", formatEther((await giwa.getBalance({ address: me })) - e0));
