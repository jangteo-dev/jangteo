import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/engine/db.ts";
import { Hub } from "../src/engine/notify.ts";
import { Scheduler, backoff, type Task } from "../src/engine/scheduler.ts";

const flush = () => new Promise((r) => setTimeout(r, 10));

function rig(now = { t: 1_000_000 }) {
  const store = new Store(":memory:");
  const sent: string[] = [];
  const hub = new Hub({ now: () => now.t });
  hub.addSink(async (t) => void sent.push(t));
  const sched = new Scheduler(store, hub, { now: () => now.t });
  return { store, sent, hub, sched, now };
}

test("due task runs once and is rescheduled by its interval", async () => {
  const { sched, store, now } = rig();
  let runs = 0;
  sched.register({ id: "a", title: "A", everyMs: 60_000, run: async () => ({ summary: `run ${++runs}` }) });
  assert.deepEqual(sched.tick(), ["a"]);
  await flush();
  assert.equal(runs, 1);
  assert.equal(store.task("a").next_run, now.t + 60_000);
  assert.deepEqual(sched.tick(), [], "not due yet");
  now.t += 60_000;
  assert.deepEqual(sched.tick(), ["a"]);
});

test("nextAt from the task overrides the interval", async () => {
  const { sched, store } = rig();
  sched.register({ id: "a", title: "A", everyMs: 1, run: async () => ({ summary: "x", nextAt: 42 }) });
  sched.tick();
  await flush();
  assert.equal(store.task("a").next_run, 42);
});

test("tasks sharing a lane never overlap", async () => {
  const { sched } = rig();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mk = (id: string): Task => ({ id, title: id, everyMs: 1000, lane: "wallet", run: async () => (await gate, { summary: id }) });
  sched.register(mk("a"));
  sched.register(mk("b"));
  assert.deepEqual(sched.tick(), ["a"]);
  assert.deepEqual(sched.tick(), [], "b waits for the lane");
  release();
  await flush();
  assert.deepEqual(sched.tick(), ["b"]);
});

test("failures back off and alert once on the 3rd, then announce recovery", async () => {
  const { sched, store, sent, now } = rig();
  let fail = true;
  sched.register({ id: "f", title: "F", everyMs: 3600_000, run: async () => { if (fail) throw new Error("boom"); return { summary: "ok" }; } });
  for (let i = 1; i <= 4; i++) {
    sched.tick();
    await flush();
    assert.equal(store.task("f").failures, i);
    assert.equal(store.task("f").next_run, now.t + backoff(3600_000, i));
    now.t = store.task("f").next_run;
  }
  assert.equal(sent.filter((s) => s.includes("failed 3x")).length, 1);
  fail = false;
  sched.tick();
  await flush();
  assert.ok(sent.some((s) => s.includes("recovered")));
  assert.equal(store.task("f").failures, 0);
});

test("paused tasks do not run; runNow forces a run", async () => {
  const { sched } = rig();
  let runs = 0;
  sched.register({ id: "p", title: "P", everyMs: 1e9, run: async () => ({ summary: String(++runs) }) });
  sched.setPaused("p", true);
  assert.deepEqual(sched.tick(), []);
  sched.setPaused("p", false);
  sched.tick();
  await flush();
  assert.equal(runs, 1);
  assert.equal(sched.runNow("p"), true);
  await flush();
  assert.equal(runs, 2);
  assert.equal(sched.runNow("nope"), false);
});

test("backoff grows but never exceeds the task interval", () => {
  assert.equal(backoff(3600_000, 1), 30_000);
  assert.equal(backoff(3600_000, 3), 120_000);
  assert.equal(backoff(60_000, 10), 60_000);
  assert.equal(backoff(10_000, 1), 30_000);
});

test("hub dedupes identical messages and rate-limits bursts (alerts bypass)", async () => {
  const now = { t: 0 };
  const hub = new Hub({ now: () => now.t, burst: 2 });
  const got: string[] = [];
  hub.addSink(async (t) => void got.push(t));
  await hub.send("same");
  await hub.send("same");
  await hub.send("b");
  await hub.send("c");
  await hub.send("urgent", "alert");
  assert.deepEqual(got, ["same", "b", "urgent"]);
  now.t += 11 * 60_000;
  await hub.send("same");
  assert.equal(got.at(-1), "same");
});

test("store kv round-trips bigint as string", () => {
  const s = new Store(":memory:");
  s.set("k", { v: 5n });
  assert.deepEqual(s.get("k"), { v: "5" });
});

test("a throwing tick does not kill the loop", async () => {
  const store = new Store(":memory:");
  let runs = 0;
  const s2 = new Scheduler(store, new Hub(), { tickMs: 5 });
  s2.register({ id: "u", title: "U", everyMs: 60_000, run: async () => ({ summary: String(++runs) }) });
  const orig = store.task.bind(store);
  let fail = 3;
  store.task = (id: string) => {
    if (fail-- > 0) throw new Error("database is locked");
    return orig(id);
  };
  s2.start();
  await new Promise((r) => setTimeout(r, 80));
  await s2.stop(100);
  assert.equal(runs, 1, "loop survived three failing ticks and then ran the task");
});

test("Telegram-facing times are Korea time", async () => {
  const { kst } = await import("../src/engine/time.ts");
  // 2026-09-23T04:05:00Z is 13:05 in Seoul
  assert.equal(kst(Date.UTC(2026, 8, 23, 4, 5)), "09-23 13:05 KST");
  // midnight rollover: 15:30Z is 00:30 next day in Seoul
  assert.equal(kst(Date.UTC(2026, 8, 23, 15, 30)), "09-24 00:30 KST");
});
