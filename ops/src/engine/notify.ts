import { logger } from "./log.ts";

const log = logger("notify");

export type Level = "info" | "alert";

export interface Notifier {
  send(text: string, level?: Level): Promise<void>;
}

type Sink = (text: string, level: Level) => Promise<void>;

/**
 * Fans messages out to sinks (Telegram, console). The same text is suppressed for
 * `dedupeMs`, and at most `burst` messages go out per minute so a failing loop can
 * never flood the chat.
 */
export class Hub implements Notifier {
  private sinks: Sink[] = [];
  private seen = new Map<string, number>();
  private sentAt: number[] = [];

  private readonly opts: { dedupeMs?: number; burst?: number; now?: () => number };

  constructor(opts: { dedupeMs?: number; burst?: number; now?: () => number } = {}) {
    this.opts = opts;
  }

  addSink(s: Sink) {
    this.sinks.push(s);
  }

  async send(text: string, level: Level = "info") {
    const now = (this.opts.now ?? Date.now)();
    const last = this.seen.get(text);
    if (last !== undefined && now - last < (this.opts.dedupeMs ?? 10 * 60_000)) return;
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.sentAt.length >= (this.opts.burst ?? 12) && level !== "alert") {
      log.warn(`rate limited: ${text.slice(0, 80)}`);
      return;
    }
    this.seen.set(text, now);
    this.sentAt.push(now);
    if (this.seen.size > 500) this.seen = new Map([...this.seen].slice(-250));
    for (const s of this.sinks) {
      try {
        await s(text, level);
      } catch (err) {
        log.error("sink failed", err);
      }
    }
  }
}
