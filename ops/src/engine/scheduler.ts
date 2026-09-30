import type { Store, TaskState } from "./db.ts";
import { logger } from "./log.ts";
import type { Notifier } from "./notify.ts";

const log = logger("sched");

export interface TaskResult {
  /** One line for /status and the event log. */
  summary: string;
  /** Push to Telegram: "info" for notable outcomes, "alert" for things needing a human. */
  notify?: "info" | "alert";
  /** Override the next run time (e.g. an on-chain cooldown ends at a known time). */
  nextAt?: number;
}

export interface Task {
  id: string;
  /** Human label shown in the bot. */
  title: string;
  everyMs: number;
  /** Uniform random delay added to every run, so schedules never look robotic. */
  jitterMs?: number;
  timeoutMs?: number;
  /** Tasks sharing a lane never run concurrently (e.g. one lane per wallet nonce). */
  lane?: string;
  run(): Promise<TaskResult>;
}

interface Running {
  task: Task;
  started: number;
}

export class Scheduler {
  private readonly tasks = new Map<string, Task>();
  private readonly running = new Map<string, Running>();
  private readonly lanes = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Last successful tick, exposed for the dashboard / watchdog. */
  lastTick = 0;

  private readonly store: Store;
  private readonly notifier: Notifier;
  private readonly opts: { tickMs?: number; failureAlertAfter?: number; now?: () => number };

  constructor(store: Store, notifier: Notifier, opts: { tickMs?: number; failureAlertAfter?: number; now?: () => number } = {}) {
    this.store = store;
    this.notifier = notifier;
    this.opts = opts;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  register(task: Task) {
    if (this.tasks.has(task.id)) throw new Error(`duplicate task ${task.id}`);
    this.tasks.set(task.id, task);
    this.store.task(task.id);
  }

  list() {
    return [...this.tasks.values()].map((t) => ({ task: t, state: this.store.task(t.id), running: this.running.has(t.id) }));
  }

  start() {
    const tick = this.opts.tickMs ?? 5_000;
    const loop = () => {
      if (this.stopping) return;
      // A throwing tick (e.g. SQLITE_BUSY) must never stop the loop for good.
      try {
        this.tick();
        this.lastTick = this.now();
      } catch (err) {
        log.error("tick failed", err);
      } finally {
        this.timer = setTimeout(loop, tick);
      }
    };
    loop();
    log.info(`started with ${this.tasks.size} tasks`);
  }

  async stop(graceMs = 20_000) {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const deadline = this.now() + graceMs;
    while (this.running.size && this.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  }

  /** Run every due task whose lane is free. Returns the ids that were started. */
  tick(): string[] {
    const now = this.now();
    const started: string[] = [];
    for (const task of this.tasks.values()) {
      if (this.running.has(task.id)) continue;
      if (task.lane && this.lanes.has(task.lane)) continue;
      const st = this.store.task(task.id);
      if (st.paused || st.next_run > now) continue;
      void this.execute(task, st);
      started.push(task.id);
    }
    return started;
  }

  runNow(id: string): boolean {
    if (!this.tasks.has(id)) return false;
    const st = this.store.task(id);
    st.next_run = 0;
    this.store.saveTask(st);
    this.tick();
    return true;
  }

  setPaused(id: string, paused: boolean): boolean {
    if (!this.tasks.has(id)) return false;
    const st = this.store.task(id);
    st.paused = paused ? 1 : 0;
    this.store.saveTask(st);
    return true;
  }

  private async execute(task: Task, st: TaskState) {
    this.running.set(task.id, { task, started: this.now() });
    if (task.lane) this.lanes.add(task.lane);
    const began = this.now();
    try {
      const result = await withTimeout(task.run(), task.timeoutMs ?? 180_000, task.id);
      const recovered = st.failures >= (this.opts.failureAlertAfter ?? 3);
      st.failures = 0;
      st.last_ok = this.now();
      st.last_result = result.summary;
      st.next_run = result.nextAt ?? this.now() + task.everyMs + jitter(task.jitterMs);
      this.store.log("task", task.id, result.summary);
      if (result.notify) await this.notifier.send(`${task.title}: ${result.summary}`, result.notify);
      if (recovered) await this.notifier.send(`✅ ${task.title} recovered`, "info");
      log.info(`${task.id} ok in ${this.now() - began}ms — ${result.summary}`);
    } catch (err) {
      st.failures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      st.last_result = `ERROR: ${msg}`;
      st.next_run = this.now() + backoff(task.everyMs, st.failures);
      this.store.log("error", task.id, msg);
      log.warn(`${task.id} failed (${st.failures})`, err);
      if (st.failures === (this.opts.failureAlertAfter ?? 3)) {
        await this.notifier.send(`⚠️ ${task.title} failed ${st.failures}x: ${msg.slice(0, 300)}`, "alert");
      }
    } finally {
      st.last_run = began;
      this.store.saveTask(st);
      this.running.delete(task.id);
      if (task.lane) this.lanes.delete(task.lane);
    }
  }
}

export function jitter(max = 0) {
  return max > 0 ? Math.floor(Math.random() * max) : 0;
}

/** 30s, 60s, 2m, 4m… capped at the task's own interval (and at least 30s). */
export function backoff(everyMs: number, failures: number) {
  const b = 30_000 * 2 ** Math.max(0, failures - 1);
  return Math.max(30_000, Math.min(b, everyMs));
}

async function withTimeout<T>(p: Promise<T>, ms: number, id: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${id} timed out after ${ms}ms`)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}
