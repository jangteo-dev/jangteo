import type { Address, Hex } from "viem";
import { abi, explorerTx, giwa, reason, write } from "../chain.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { formatEther } from "viem";
import { config, gyeDeployment } from "../config.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";

const PHASE_ACTIVE = 2;

/**
 * Circles only advance when someone calls settle() after a round's deadline. Anyone may,
 * so this keeper does it for every circle; nobody's pot waits on a human.
 */
export function gyeKeeperTask(keeper: { address: Address; key: Hex }): Task {
  return {
    id: "keeper:gye",
    title: "Gye keeper",
    everyMs: 60_000,
    jitterMs: 5_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const d = gyeDeployment();
      if (!d) return { summary: "Gye not deployed yet", nextAt: Date.now() + 10 * 60_000 };
      const factory = d.factory;
      const count = await giwa.readContract({ address: factory, abi: abi.gyeFactory, functionName: "circleCount" });
      const settled: string[] = [];
      const failed: string[] = [];
      let active = 0;
      for (let off = 0n; off < count; off += 100n) {
        const page = await giwa.readContract({ address: factory, abi: abi.gyeFactory, functionName: "circles", args: [off, 100n] });
        const due = await Promise.all(
          page.map(async (c) => {
            const phase = await giwa.readContract({ address: c, abi: abi.gyeCircle, functionName: "phase" });
            if (phase !== PHASE_ACTIVE) return null;
            active++;
            return (await giwa.readContract({ address: c, abi: abi.gyeCircle, functionName: "settleable" })) ? c : null;
          }),
        );
        for (const c of due) {
          if (!c) continue;
          try {
            const round = await giwa.readContract({ address: c, abi: abi.gyeCircle, functionName: "round" });
            const { hash } = await write({ key: keeper.key, address: c, abi: abi.gyeCircle, functionName: "settle" });
            settled.push(`${c.slice(0, 10)}… round ${round} ${explorerTx(hash)}`);
          } catch (err) {
            failed.push(`${c.slice(0, 10)}…: ${reason(err)}`);
          }
        }
      }
      if (failed.length) throw new Error(`settle failed: ${failed.join("; ")}`);
      return settled.length
        ? { summary: `settled ${settled.length}: ${settled.join(" · ")}`, notify: "info" }
        : { summary: `${count} circles, ${active} active, none due` };
    },
  };
}

const run = promisify(execFile);
const DEPLOY_SCRIPT = resolve(config.root, "../scripts/deploy-gye.sh");
const DEPLOY_MIN = 2_000_000_000_000_000n; // 0.002 ETH — deploy costs ~0.00001, the rest is keeper gas

/** Deploys Gye by itself the first time the deployer holds gas on GIWA, then goes quiet. */
export function gyeDeployTask(deployer: { address: Address }): Task {
  return {
    id: "gye:deploy",
    title: "Gye deploy",
    everyMs: 10 * 60_000,
    timeoutMs: 15 * 60_000,
    lane: `giwa:${deployer.address}`,
    async run(): Promise<TaskResult> {
      const d = gyeDeployment();
      if (d) return { summary: `deployed — factory ${d.factory}`, nextAt: Date.now() + 24 * 3600_000 };
      const bal = await giwa.getBalance({ address: deployer.address });
      if (bal < DEPLOY_MIN) return { summary: `waiting for deployer gas (${formatEther(bal)} ETH on GIWA)` };
      if (config.dryRun) return { summary: "[dry-run] would deploy Gye now" };
      const { stdout } = await run(DEPLOY_SCRIPT, [], { timeout: 14 * 60_000, maxBuffer: 4 << 20 });
      const now = gyeDeployment();
      if (!now) throw new Error(`deploy script finished without a deployment file: ${stdout.slice(-400)}`);
      return {
        summary: `🎉 Gye deployed on GIWA Sepolia\nfactory ${now.factory}\nreputation ${now.reputation}\ntKRW ${now.tkrw}\nhttps://sepolia-explorer.giwa.io/address/${now.factory}`,
        notify: "alert",
      };
    },
  };
}
