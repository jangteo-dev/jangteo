import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.ts";

/** A team wallet from the secrets file by label (FARM1, TRADER2, STOCKS_REPORTER…), or null. */
export function teamWallet(label: string): { label: string; address: Address; key: Hex } | null {
  try {
    const env = readFileSync(resolve(config.root, "../keys/keeper.env"), "utf8");
    const key = env.match(new RegExp(`^GIWA_${label}_KEY=(0x[0-9a-fA-F]{64})$`, "m"))?.[1] as Hex | undefined;
    return key ? { label, address: privateKeyToAccount(key).address, key } : null;
  } catch {
    return null;
  }
}
