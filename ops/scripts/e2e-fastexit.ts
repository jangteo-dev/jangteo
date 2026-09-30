// Live check of 장터 빠른 출금: TRADER1 exits 0.01 ETH on GIWA and we time the payout on Ethereum.
// cd ops && node scripts/e2e-fastexit.ts   (giwa-ops must be running: its bridge:fastfill pays)
import { readFileSync } from "node:fs";
import { formatEther, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { l1, write } from "../src/chain.ts";

const env = Object.fromEntries(readFileSync(new URL("../../keys/keeper.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2) as [string, string]));
const key = env.GIWA_TRADER1_KEY as Hex;
const me = privateKeyToAccount(key).address;
const exit = JSON.parse(readFileSync(new URL("../../contracts/deployments/91342.fastexit.json", import.meta.url), "utf8")).fastExit as Address;
const abi = parseAbi(["function exit(address to) payable returns (uint256)", "function quote(uint256) view returns (uint256, uint256)"]);
const before = await l1.getBalance({ address: me });
const t0 = Date.now();
const { hash } = await write({ key, address: exit, abi, functionName: "exit", args: [me], value: parseEther("0.01") });
console.log("exit on GIWA", hash);
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const now = await l1.getBalance({ address: me });
  if (now > before) {
    console.log(`paid on Ethereum after ${Math.round((Date.now() - t0) / 1000)} s: +${formatEther(now - before)} ETH`);
    break;
  }
  if (Date.now() - t0 > 6 * 60_000) {
    console.log("no payout after 6 min");
    break;
  }
}
process.exit(0);
