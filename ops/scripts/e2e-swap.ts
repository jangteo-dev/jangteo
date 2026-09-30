// Live check of 장터 스왑: FARM1 swaps tKRW → HANJI (direct), then HANJI → ONGGI (two hops via tKRW).
// cd ops && node scripts/e2e-swap.ts
import { maxUint256, parseAbi, parseEther, type Address } from "viem";
import { giwa, write } from "../src/chain.ts";
import { config, gyeDeployment } from "../src/config.ts";
import { launchpadAddresses } from "../src/stalls.ts";

const me = config.wallets.farm[0];
const { swapRouter: router, swapFactory: factory } = launchpadAddresses()!;
const tkrw = gyeDeployment()!.tkrw;
const HANJI = "0xCAE9aA66E6d41E344aEc0DB59C2b8B93D7F2953A" as Address;
const ONGGI = "0x451cB13ecd199Bd06Da0f1F1496e79D3B97Cb363" as Address;
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const r = parseAbi([
  "function getAmountsOut(uint256, address[]) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256, uint256, address[], address, uint256) returns (uint256[])",
]);
const f = parseAbi(["function feeTo() view returns (address)"]);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const bal = (t: Address) => giwa.readContract({ address: t, abi: erc, functionName: "balanceOf", args: [me.address] });

console.log("feeTo", await giwa.readContract({ address: factory, abi: f, functionName: "feeTo" }));
for (const t of [tkrw, HANJI]) await write({ key: me.key, address: t, abi: erc, functionName: "approve", args: [router, maxUint256] });
await sleep(3000);
for (const [amt, path] of [
  [parseEther("1000"), [tkrw, HANJI]],
  [parseEther("5"), [HANJI, tkrw, ONGGI]],
] as const) {
  const out = await giwa.readContract({ address: router, abi: r, functionName: "getAmountsOut", args: [amt, [...path]] });
  const before = await bal(path[path.length - 1]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  await write({ key: me.key, address: router, abi: r, functionName: "swapExactTokensForTokens", args: [amt, (out.at(-1)! * 99n) / 100n, [...path], me.address, deadline] });
  await sleep(3000);
  console.log(path.length - 1, "hop(s): quoted", out.at(-1), "got", (await bal(path[path.length - 1])) - before);
}
