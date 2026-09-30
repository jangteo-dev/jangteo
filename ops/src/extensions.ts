import type { Store } from "./engine/db.ts";
import type { Scheduler, Task } from "./engine/scheduler.ts";

/** A dashboard screen: text plus an inline keyboard (grammy's, kept loose here). */
export interface ExtraView {
  id: string;
  button: string;
  command: string;
  description: string;
  render: (sched: Scheduler, store: Store) => Promise<{ text: string; kb: unknown }>;
}

interface Extensions {
  privateTasks?: (store: Store) => Task[];
  privateViews?: ExtraView[];
}

/** Operator-only additions from src/private, which the public repository does not include. */
export const extensions: Extensions = {};

/** Call once at startup, before building the scheduler (loaded by path so the typecheck never needs it). */
export async function loadExtensions() {
  const path = "./private/index.ts";
  Object.assign(extensions, await import(path).catch(() => ({})));
}
