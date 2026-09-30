import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";

/**
 * Every five minutes: is the site up, and are the files the pages read still fresh? One alert when
 * something breaks, one note when it recovers, nothing in between.
 */
const FILES: [string, number][] = [
  ["market.json", 5 * 60_000], // the indexer writes every few seconds
  ["points.json", 30 * 60_000], // every five minutes
  ["insa-data/index.json", 15 * 60_000], // every ninety seconds
  ["orders.json", 10 * 60_000], // every fifteen seconds
  ["withdrawals.json", 30 * 60_000], // every few minutes
];

export function healthTask(store: Store): Task {
  return {
    id: "health:watch",
    title: "Site and data freshness",
    everyMs: 5 * 60_000,
    timeoutMs: 60_000,
    async run(): Promise<TaskResult> {
      const problems: string[] = [];
      try {
        const res = await fetch("https://jangteo.org/", { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) problems.push(`site answers HTTP ${res.status}`);
      } catch (e) {
        problems.push(`site unreachable (${(e as Error).message.slice(0, 60)})`);
      }
      for (const [f, maxAge] of FILES) {
        const p = resolve(config.webroot, f);
        if (!existsSync(p)) {
          problems.push(`${f} missing`);
          continue;
        }
        const age = Date.now() - statSync(p).mtimeMs;
        if (age > maxAge) problems.push(`${f} is ${Math.round(age / 60_000)} min old`);
      }
      // A broken JSON file would blank its page even when it is fresh.
      try {
        JSON.parse(readFileSync(resolve(config.webroot, "market.json"), "utf8"));
      } catch {
        problems.push("market.json is not valid JSON");
      }
      const key = problems.sort().join(" · ");
      const was = store.get<string>("health:problems") ?? "";
      store.set("health:problems", key);
      if (key && key !== was) return { summary: `🚨 Jangteo health: ${key}`, notify: "alert" };
      if (!key && was) return { summary: `✅ Jangteo health: recovered (${was})`, notify: "info" };
      return { summary: key ? `still: ${key}` : "all fresh" };
    },
  };
}
