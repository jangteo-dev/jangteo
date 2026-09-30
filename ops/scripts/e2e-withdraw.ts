// Live check of 장터 브릿지 withdrawals: TRADER1 starts a GIWA → Sepolia withdrawal through the
// Jangteo front door and prints its status on L1. Proving and claiming are the ops keeper's job.
// cd ops && node scripts/e2e-withdraw.ts
import { readFileSync } from "node:fs";
import { createPublicClient, formatEther, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, giwaSepolia } from "viem/chains";
import { getWithdrawals, publicActionsL1 } from "viem/op-stack";
import { giwa, write } from "../src/chain.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../../keys/keeper.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2) as [string, string]),
);
const key = env.GIWA_TRADER1_KEY as Hex;
const me = privateKeyToAccount(key).address;
const withdraw = JSON.parse(readFileSync(new URL("../../contracts/deployments/91342.withdraw.json", import.meta.url), "utf8")).withdraw as Address;
const abi = parseAbi(["function deposit(address to) payable"]);
const l1 = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") }).extend(publicActionsL1());

console.log("GIWA balance", formatEther(await giwa.getBalance({ address: me })));
const { hash } = await write({ key, address: withdraw, abi, functionName: "deposit", args: [me], value: parseEther("0.002") });
const receipt = await giwa.waitForTransactionReceipt({ hash: hash! });
const [w] = getWithdrawals(receipt);
console.log("initiated", hash, "withdrawal", w.withdrawalHash, "value", formatEther(w.value));
console.log("status", await l1.getWithdrawalStatus({ receipt, targetChain: giwaSepolia }));
