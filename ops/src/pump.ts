import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { encodeAbiParameters, formatEther, parseAbi, type Address, type Hex } from "viem";
import { explorerTx, giwa, reason, write } from "./chain.ts";
import { config } from "./config.ts";
import type { Store } from "./engine/db.ts";
import type { Task, TaskResult } from "./engine/scheduler.ts";
import { launchpadAddresses } from "./stalls.ts";

const run = promisify(execFile);
const WETH = "0x4200000000000000000000000000000000000006" as Address;

/** 뻥튀기 contracts, oldest first: v1 (old coins) and v2 (new launches since 2026-09-26). */
export function allPumps(): { pump: Address; pumpRouter: Address }[] {
  return ["91342.pump.json", "91342.pump2.json"]
    .map((f) => resolve(config.root, "../contracts/deployments", f))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as { pump: Address; pumpRouter: Address });
}

/** The contract new coins launch on. */
export function pumpAddresses(): { pump: Address; pumpRouter: Address } | null {
  return allPumps().at(-1) ?? null;
}

export const pumpAbi = parseAbi([
  "struct Launch { address creator; address pair; uint64 createdAt; uint64 graduatedAt; bool graduated; uint128 realEth; uint128 sold; uint128 creatorFees; uint128 volume; uint32 trades; }",
  "function tokenCount() view returns (uint256)",
  "function tokens(uint256) view returns (address)",
  "function launch(address) view returns (Launch)",
  "function protocolFees() view returns (uint256)",
  "function withdrawProtocolFees()",
]);
const erc20 = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);

export async function pumpSummary() {
  const ps = allPumps();
  if (!ps.length) return null;
  let n = 0, graduated = 0, volume = 0n, pendingFees = 0n;
  for (const a of ps) {
    const c = Number(await giwa.readContract({ address: a.pump, abi: pumpAbi, functionName: "tokenCount" }));
    const tokens = await Promise.all(Array.from({ length: c }, (_, i) => giwa.readContract({ address: a.pump, abi: pumpAbi, functionName: "tokens", args: [BigInt(i)] })));
    const launches = await Promise.all(tokens.map((t) => giwa.readContract({ address: a.pump, abi: pumpAbi, functionName: "launch", args: [t] })));
    n += c;
    graduated += launches.filter((l) => l.graduated).length;
    volume += launches.reduce((s, l) => s + l.volume, 0n);
    pendingFees += await giwa.readContract({ address: a.pump, abi: pumpAbi, functionName: "protocolFees" });
  }
  return { launches: n, graduated, volume, pendingFees };
}

/**
 * Verifies every new 장터 뻥튀기 token on Blockscout, so each one shows its source like the rest of
 * Jangteo. Verified tokens are remembered in the store; a failure is retried on the next run.
 */
export function pumpVerifyTask(store: Store): Task {
  return {
    id: "pump:verify",
    title: "Ppeongtwigi token verification",
    everyMs: 5 * 60_000,
    jitterMs: 20_000,
    timeoutMs: 10 * 60_000,
    lane: "forge",
    async run(): Promise<TaskResult> {
      const ps = allPumps();
      const lp = launchpadAddresses();
      if (!ps.length || !lp) return { summary: "Ppeongtwigi not deployed", nextAt: Date.now() + 30 * 60_000 };
      const done = new Set(store.get<string[]>("pump:verified") ?? []);
      const all: Address[] = [];
      for (const a of ps) {
        const c = Number(await giwa.readContract({ address: a.pump, abi: pumpAbi, functionName: "tokenCount" }));
        for (let i = 0; i < c; i++) all.push(await giwa.readContract({ address: a.pump, abi: pumpAbi, functionName: "tokens", args: [BigInt(i)] }));
      }
      const n = all.length;
      const out: string[] = [];
      for (const token of all) {
        if (done.has(token.toLowerCase())) continue;
        const [name, symbol] = await Promise.all([
          giwa.readContract({ address: token, abi: erc20, functionName: "name" }),
          giwa.readContract({ address: token, abi: erc20, functionName: "symbol" }),
        ]);
        const args = encodeAbiParameters(
          [{ type: "string" }, { type: "string" }, { type: "address" }, { type: "address" }],
          [name, symbol, lp.swapFactory, WETH],
        );
        try {
          const { stdout } = await run(
            "forge",
            [
              "verify-contract",
              token,
              "src/pump/PumpToken.sol:PumpToken",
              "--verifier",
              "blockscout",
              "--verifier-url",
              "https://sepolia-explorer.giwa.io/api/",
              "--constructor-args",
              args,
              "--watch",
            ],
            { cwd: resolve(config.root, "../contracts"), timeout: 180_000 },
          );
          if (/verified|already verified/i.test(stdout)) {
            done.add(token.toLowerCase());
            out.push(`verified ${symbol} ${token.slice(0, 10)}…`);
          }
        } catch (err) {
          const msg = reason(err);
          if (/already verified/i.test(msg)) done.add(token.toLowerCase());
          else out.push(`${symbol}: ${msg.slice(0, 120)}`);
        }
      }
      store.set("pump:verified", [...done]);
      return out.length ? { summary: out.join("\n") } : { summary: `${n} tokens, all verified` };
    },
  };
}

/** Moves 장터 뻥튀기's accrued ETH fees to the treasury (permissionless; the keeper pays gas). */
export async function sweepPumpFees(keeper: { key: Hex }): Promise<string | null> {
  const done: string[] = [];
  for (const a of allPumps()) {
    const fee = await giwa.readContract({ address: a.pump, abi: pumpAbi, functionName: "protocolFees" });
    // Below 0.001 ETH the sweep would cost a noticeable share of itself in gas.
    if (fee < 10n ** 15n) continue;
    const { hash } = await write({ key: keeper.key, address: a.pump, abi: pumpAbi, functionName: "withdrawProtocolFees" });
    done.push(`Ppeongtwigi ${formatEther(fee)} ETH ${explorerTx(hash)}`);
  }
  return done.length ? done.join(" · ") : null;
}
