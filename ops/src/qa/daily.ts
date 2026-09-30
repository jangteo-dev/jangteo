import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { config } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";

/**
 * Every night at 03:00 KST the live site is clicked through with a real wallet (TRADER2, testnet
 * ETH and test won): swap, trade, limit order, liquidity, 뻥튀기, quick buy, an NFT listing and
 * offer, the dashboard; then every internal link and the Content-Security-Policy are checked.
 * Telegram hears the result, and an alert names every flow that failed.
 */
const FLOWS = ["swap", "tradeBuy", "tradeSell", "limit", "swapToHanji", "poolAdd", "poolRemove", "pumpBuy", "pumpSell", "quickBuy", "insaList", "insaOffer", "dashboard"];
const ENV = {
  PUMP_TOKEN: "0x8e617b1b615ade4e8d0058aa4ac223f522369e40", // Hotteok Club, on 뻥튀기 v2
  INSA_ITEM: "0xC5bc819D3C387dA93CFCEDE4C51f84C4d554dA36/3", // TRADER2's Opening Day
};

/** The next 03:00 in Korea, as epoch milliseconds. */
export function next3amKst(now = Date.now()): number {
  const kst = new Date(now + 9 * 3600_000);
  const t = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 3) - 9 * 3600_000;
  return t > now ? t : t + 86_400_000;
}

function runScript(args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], { cwd: resolve(config.root), env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", () => (clearTimeout(kill), done(out)));
  });
}

/** "name: PASS …" / "name: FAIL …" lines from the scripts. */
export function results(out: string): { name: string; ok: boolean; detail: string }[] {
  return [...out.matchAll(/^(\w+): (PASS|FAIL) ?(.*)$/gm)].map((m) => ({ name: m[1], ok: m[2] === "PASS", detail: m[3].slice(0, 160) }));
}

export function qaDailyTask(store: Store): Task {
  return {
    id: "qa:daily",
    title: "Nightly site check (real clicks)",
    everyMs: 86_400_000,
    timeoutMs: 45 * 60_000,
    async run(): Promise<TaskResult> {
      const last = store.get<number>("qa:last") ?? 0;
      // Runs only at its hour; a restart during the day just waits for the next 03:00 KST.
      if (Date.now() - last < 20 * 3600_000 || Math.abs(Date.now() - (next3amKst() - 86_400_000)) > 30 * 60_000) {
        return { summary: `next run ${new Date(next3amKst()).toISOString()}`, nextAt: next3amKst() };
      }
      store.set("qa:last", Date.now());
      const ui = await runScript(["scripts/ui-e2e.ts", FLOWS.join(","), "--wallet=t2"], ENV, 35 * 60_000);
      const site = await runScript(["scripts/ui-links.ts"], {}, 10 * 60_000);
      const r = results(ui + "\n" + site);
      const missing = FLOWS.filter((f) => !r.some((x) => x.name === f));
      const failed = [...r.filter((x) => !x.ok), ...missing.map((name) => ({ name, ok: false, detail: "did not run (script stopped early)" }))];
      store.set("qa:results", { at: Date.now(), results: r, failed });
      const passed = r.filter((x) => x.ok).length;
      const summary =
        failed.length === 0
          ? `🧪 Nightly check: all ${passed} passed (${FLOWS.length} click flows, links, CSP)`
          : `🧪 Nightly check: ${failed.length} FAILED, ${passed} passed\n${failed.map((f) => `• ${f.name}: ${f.detail}`).join("\n")}`;
      return { summary, notify: failed.length ? "alert" : "info", nextAt: next3amKst() };
    },
  };
}
