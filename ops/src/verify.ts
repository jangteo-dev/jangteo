import { execFile } from "node:child_process";
import { openAsBlob } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { encodeAbiParameters, parseAbi, type Address } from "viem";
import { giwa, reason } from "./chain.ts";
import { config } from "./config.ts";
import type { Store } from "./engine/db.ts";
import type { Task, TaskResult } from "./engine/scheduler.ts";
import { launchpadAddresses, stallAddresses } from "./stalls.ts";

const run = promisify(execFile);
const EXPLORER = "https://sepolia-explorer.giwa.io/api/v2";
const UA = { "user-agent": "Mozilla/5.0 (jangteo-ops)" };

const factoryAbi = parseAbi(["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"]);
const ttAbi = parseAbi(["function tokenCount() view returns (uint256)", "function tokens(uint256) view returns (address)"]);
const erc20 = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function totalSupply() view returns (uint256)"]);

async function verified(a: string): Promise<boolean> {
  const j = (await (await fetch(`${EXPLORER}/addresses/${a}`, { headers: UA, signal: AbortSignal.timeout(15_000) })).json()) as { is_verified?: boolean };
  return !!j.is_verified;
}

async function creator(a: string): Promise<Address> {
  const j = (await (await fetch(`${EXPLORER}/addresses/${a}`, { headers: UA, signal: AbortSignal.timeout(15_000) })).json()) as { creation_transaction_hash: `0x${string}` };
  return (await giwa.getTransaction({ hash: j.creation_transaction_hash })).from;
}

/**
 * Keeps every contract Jangteo creates verified on GIWA's explorer, not just the ones deployed by
 * hand: 장터 스왑 pairs (Uniswap's own source, standard JSON input) and test tokens issued through
 * the offerings' token factory. Ppeongtwigi tokens have their own task (pump:verify).
 */
export function verifyTask(store: Store): Task {
  return {
    id: "verify:auto",
    title: "Explorer verification",
    everyMs: 15 * 60_000,
    jitterMs: 60_000,
    timeoutMs: 10 * 60_000,
    lane: "forge",
    async run(): Promise<TaskResult> {
      const done = new Set(store.get<string[]>("verify:done") ?? []);
      const out: string[] = [];
      const lp = launchpadAddresses();
      if (lp) {
        const n = Number(await giwa.readContract({ address: lp.swapFactory, abi: factoryAbi, functionName: "allPairsLength" }));
        for (let i = 0; i < n; i++) {
          const pair = (await giwa.readContract({ address: lp.swapFactory, abi: factoryAbi, functionName: "allPairs", args: [BigInt(i)] })).toLowerCase();
          if (done.has(pair)) continue;
          if (await verified(pair)) {
            done.add(pair);
            continue;
          }
          const form = new FormData();
          form.set("compiler_version", "v0.5.16+commit.9c3226ce");
          form.set("license_type", "gnu_gpl_v3");
          form.set("contract_name", "UniswapV2Pair");
          form.set("autodetect_constructor_args", "true");
          form.set("files[0]", await openAsBlob(resolve(config.root, "../contracts/external/uniswap/UniswapV2Core.standard-input.json"), { type: "application/json" }), "core.json");
          const res = await fetch(`${EXPLORER}/smart-contracts/${pair}/verification/via/standard-input`, { method: "POST", body: form, headers: UA });
          out.push(`pair ${pair.slice(0, 10)}… ${res.ok ? "submitted" : `HTTP ${res.status}`}`);
        }
      }
      const tf = stallAddresses()?.tokenFactory;
      if (tf) {
        const n = Number(await giwa.readContract({ address: tf, abi: ttAbi, functionName: "tokenCount" }));
        for (let i = 0; i < n; i++) {
          const t = await giwa.readContract({ address: tf, abi: ttAbi, functionName: "tokens", args: [BigInt(i)] });
          if (done.has(t.toLowerCase())) continue;
          if (await verified(t)) {
            done.add(t.toLowerCase());
            continue;
          }
          const [name, symbol, supply, who] = await Promise.all([
            giwa.readContract({ address: t, abi: erc20, functionName: "name" }),
            giwa.readContract({ address: t, abi: erc20, functionName: "symbol" }),
            giwa.readContract({ address: t, abi: erc20, functionName: "totalSupply" }),
            creator(t),
          ]);
          const args = encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }], [name, symbol, supply, who]);
          try {
            await run(
              "forge",
              ["verify-contract", t, "src/cheongyak/TestTokenFactory.sol:IssuedToken", "--verifier", "blockscout", "--verifier-url", "https://sepolia-explorer.giwa.io/api/", "--skip-is-verified-check", "--constructor-args", args, "--watch"],
              { cwd: resolve(config.root, "../contracts"), timeout: 180_000 },
            );
            out.push(`verified ${symbol}`);
          } catch (err) {
            out.push(`${symbol}: ${reason(err).slice(0, 100)}`);
          }
        }
      }
      store.set("verify:done", [...done]);
      return { summary: out.length ? out.join("\n") : `all verified (${done.size} tracked)` };
    },
  };
}
