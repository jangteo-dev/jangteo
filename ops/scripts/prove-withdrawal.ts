// Proves (or claims, once the 7-day window has passed) one GIWA → Ethereum withdrawal with the
// deployer's L1 ETH. Waits until the withdrawal is ready.  node scripts/prove-withdrawal.ts <GIWA tx hash>
import { createPublicClient, createWalletClient, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { giwaSepolia, sepolia } from "viem/chains";
import { getWithdrawals, publicActionsL1, publicActionsL2, walletActionsL1 } from "viem/op-stack";
import { config } from "../src/config.ts";

const l2Tx = process.argv[2] as Hex;
const l1 = createPublicClient({ chain: sepolia, transport: fallback(config.rpc.l1.map((u) => http(u))) }).extend(publicActionsL1());
const l2 = createPublicClient({ chain: giwaSepolia, transport: fallback(config.rpc.giwa.map((u) => http(u))) }).extend(publicActionsL2());
const wallet = createWalletClient({ account: privateKeyToAccount(config.wallets.deployer!.key), chain: sepolia, transport: fallback(config.rpc.l1.map((u) => http(u))) }).extend(walletActionsL1());

const receipt = await l2.getTransactionReceipt({ hash: l2Tx });
const [w] = getWithdrawals(receipt);
for (;;) {
  const status = await l1.getWithdrawalStatus({ receipt, targetChain: giwaSepolia } as never);
  console.log(new Date().toISOString(), status);
  if (status === "ready-to-prove") {
    const game = await l1.getGame({ l2BlockNumber: receipt.blockNumber, targetChain: giwaSepolia } as never);
    const args = await l2.buildProveWithdrawal({ withdrawal: w, game } as never);
    const hash = await wallet.proveWithdrawal(args as never);
    console.log("prove tx", hash, (await l1.waitForTransactionReceipt({ hash })).status);
    break;
  }
  if (status === "ready-to-finalize") {
    const hash = await wallet.finalizeWithdrawal({ withdrawal: w, targetChain: giwaSepolia } as never);
    console.log("finalize tx", hash, (await l1.waitForTransactionReceipt({ hash })).status);
    break;
  }
  if (status !== "waiting-to-prove") break;
  await new Promise((r) => setTimeout(r, 60_000));
}
process.exit(0);
