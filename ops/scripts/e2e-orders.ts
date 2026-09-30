// Live check of 장터 limit orders + DCA on BBMP/ETH: TRADER2 places bids (one crossing the market,
// which the keeper must fill), TRADER1 places asks and a DCA. cd ops && node scripts/e2e-orders.ts
import { readFileSync } from "node:fs";
import { maxUint256, parseAbi, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { giwa, write, explorerTx } from "../src/chain.ts";

const env = Object.fromEntries(readFileSync(new URL("../../keys/keeper.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2) as [string, string]));
const T1 = env.GIWA_TRADER1_KEY as Hex;
const T2 = env.GIWA_TRADER2_KEY as Hex;
const orders = JSON.parse(readFileSync(new URL("../../contracts/deployments/91342.orders.json", import.meta.url), "utf8")).orders as Address;
const BBMP = "0x468ae171583564E7fC4F594FC54dD2E0aA47491C" as Address;
const abi = parseAbi([
  "function createLimit(address tokenIn, address tokenOut, uint256 amount, uint256 minRate, uint64 expiry) payable returns (uint256)",
  "function createDca(address tokenIn, address tokenOut, uint256 amount, uint32 slices, uint32 interval, uint256 minRate) payable returns (uint256)",
]);
const erc = parseAbi(["function approve(address,uint256) returns (bool)"]);
const m = JSON.parse(readFileSync("/srv/jangteo/current/market.json", "utf8")) as { tokens: { address: string; priceEth: number }[] };
const mid = m.tokens.find((t) => t.address === BBMP.toLowerCase())!.priceEth;
console.log("BBMP mid", mid, "ETH");
const E18 = 10n ** 18n;
const p18 = (p: number) => BigInt(Math.round(p * 1e18));
const bidRate = (p: number) => (E18 * E18) / p18(p); // 18-decimal token
const askRate = (p: number) => p18(p);
const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const [mult, eth] of [[0.97, "0.01"], [0.94, "0.02"], [0.9, "0.03"], [1.03, "0.005"]] as const) {
  const { hash } = await write({ key: T2, address: orders, abi, functionName: "createLimit", args: [zeroAddress, BBMP, bidRate(mid * mult), expiry].length ? [zeroAddress, BBMP, parseEther(eth), bidRate(mid * mult), expiry] : [], value: parseEther(eth) });
  console.log(`bid ${eth} ETH @ ${mult} × mid`, explorerTx(hash));
  await sleep(1500);
}
await write({ key: T1, address: BBMP, abi: erc, functionName: "approve", args: [orders, maxUint256] });
await sleep(2000);
for (const [mult, tokens] of [[1.04, 3_000_000n], [1.08, 5_000_000n], [1.15, 10_000_000n]] as const) {
  const { hash } = await write({ key: T1, address: orders, abi, functionName: "createLimit", args: [BBMP, zeroAddress, tokens * E18, askRate(mid * mult), expiry] });
  console.log(`ask ${tokens} BBMP @ ${mult} × mid`, explorerTx(hash));
  await sleep(1500);
}
const { hash } = await write({ key: T2, address: orders, abi, functionName: "createDca", args: [zeroAddress, BBMP, parseEther("0.006"), 3, 3600, 0n], value: parseEther("0.006") });
console.log("DCA 0.006 ETH in 3 hourly buys", explorerTx(hash));
process.exit(0);
