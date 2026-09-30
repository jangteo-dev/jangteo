import type { Store } from "./db.ts";

/**
 * GIWA's RPC is a pool of nodes. One that is a few blocks behind answers "no logs" for blocks it has
 * not seen yet, so a scanner whose cursor moves past them silently misses events. Every scan
 * therefore re-reads the last RESCAN blocks, and events are de-duplicated by transaction and log
 * index. Log pages stay within the main endpoint's 10,000-block limit.
 */
export const RESCAN = 600n; // 10 minutes at 1-second blocks
export const PAGE = 9_999n;

export function scanStart(cursor: number | null | undefined, head: bigint, fallbackBack = 90_000n): bigint {
  const c = cursor === null || cursor === undefined ? head - fallbackBack : BigInt(cursor);
  return c < head - RESCAN ? c : head - RESCAN;
}

/** Event keys seen recently ("tx:logIndex"), persisted so a restart does not double count. */
export class Seen {
  private keys: string[];
  private set: Set<string>;
  private store: Store;
  private name: string;
  private max: number;
  /** False on the first run: nothing was recorded yet, so a re-read would count old events twice. */
  readonly primed: boolean;
  constructor(store: Store, name: string, max = 20_000) {
    this.store = store;
    this.name = name;
    this.max = max;
    const k = store.get<string[]>(`seen:${name}`);
    this.primed = k !== null && k !== undefined;
    this.keys = k ?? [];
    this.set = new Set(this.keys);
  }
  /** Where a counting scan starts: the cursor itself until the first run has recorded keys. */
  start(cursor: number | null | undefined, head: bigint, fallbackBack = 90_000n): bigint {
    return this.primed || cursor === null || cursor === undefined ? scanStart(cursor, head, fallbackBack) : BigInt(cursor);
  }
  /** True the first time a log is offered. */
  fresh(l: { transactionHash: string | null; logIndex: number | null }): boolean {
    const k = `${l.transactionHash}:${l.logIndex}`;
    if (this.set.has(k)) return false;
    this.set.add(k);
    this.keys.push(k);
    return true;
  }
  save() {
    if (this.keys.length > this.max) this.keys = this.keys.slice(-this.max);
    this.store.set(`seen:${this.name}`, this.keys);
  }
}
