type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < min) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const tail = extra === undefined ? "" : ` ${extra instanceof Error ? extra.stack ?? extra.message : JSON.stringify(extra, bigintSafe)}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line + tail);
}

export function bigintSafe(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

export function logger(scope: string) {
  return {
    debug: (m: string, x?: unknown) => emit("debug", scope, m, x),
    info: (m: string, x?: unknown) => emit("info", scope, m, x),
    warn: (m: string, x?: unknown) => emit("warn", scope, m, x),
    error: (m: string, x?: unknown) => emit("error", scope, m, x),
  };
}

export type Logger = ReturnType<typeof logger>;
