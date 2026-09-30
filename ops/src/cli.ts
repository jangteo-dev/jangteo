import { resolve } from "node:path";
import { config } from "./config.ts";
import { Store } from "./engine/db.ts";
import { Hub } from "./engine/notify.ts";
import { buildScheduler } from "./main.ts";
import { loadExtensions } from "./extensions.ts";

// Run one task immediately and print its result: pnpm once watch:mainnet
const id = process.argv[2];
await loadExtensions();
const store = new Store(resolve(config.dataDir, "ops.sqlite"));
const sched = buildScheduler(store, new Hub());
const entry = sched.list().find((t) => t.task.id === id);
if (!entry) {
  console.log("tasks:\n" + sched.list().map((t) => `  ${t.task.id}`).join("\n"));
  process.exit(id ? 1 : 0);
}
try {
  const r = await entry.task.run();
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
