import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The indexer's own database, apart from the ops store: it takes a steady stream of writes and
 * must never slow the Telegram bot or the keepers down.
 *
 *   cursor   the last block whose events are fully stored, per stream; everything at or below
 *            it is complete, so a restart resumes exactly where it stopped
 *   factory  every DEX factory followed (V2 pairs, V3 pools) and how far its creations are read
 *   pool     every pool, with its latest state
 *   swap     every swap in every pool, with the transaction's sender
 *   trade    every 장터 뻥튀기 curve trade
 *   token    token metadata and icons from GIWA's explorer
 */
export class IndexDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS cursor (name TEXT PRIMARY KEY, block INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS factory (
        address TEXT PRIMARY KEY, kind TEXT NOT NULL, dex TEXT NOT NULL,
        created_block INTEGER NOT NULL, scanned_block INTEGER NOT NULL, pairs_known INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pool (
        address TEXT PRIMARY KEY, factory TEXT NOT NULL, kind TEXT NOT NULL, dex TEXT NOT NULL,
        token0 TEXT NOT NULL, token1 TEXT NOT NULL, fee INTEGER NOT NULL DEFAULT 3000,
        created_block INTEGER NOT NULL, backfilled_block INTEGER NOT NULL,
        r0 TEXT NOT NULL DEFAULT '0', r1 TEXT NOT NULL DEFAULT '0', sqrt_price TEXT NOT NULL DEFAULT '0',
        updated_block INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS swap (
        block INTEGER NOT NULL, log INTEGER NOT NULL, pool TEXT NOT NULL, tx TEXT NOT NULL, ts INTEGER NOT NULL,
        sender TEXT, amount0 TEXT NOT NULL, amount1 TEXT NOT NULL, price REAL NOT NULL,
        PRIMARY KEY (block, log)
      );
      CREATE INDEX IF NOT EXISTS swap_pool_ts ON swap(pool, ts);
      CREATE INDEX IF NOT EXISTS swap_sender ON swap(sender);
      CREATE TABLE IF NOT EXISTS trade (
        block INTEGER NOT NULL, log INTEGER NOT NULL, token TEXT NOT NULL, tx TEXT NOT NULL, ts INTEGER NOT NULL,
        sender TEXT, is_buy INTEGER NOT NULL, eth TEXT NOT NULL, tokens TEXT NOT NULL, real_eth TEXT NOT NULL, sold TEXT NOT NULL,
        PRIMARY KEY (block, log)
      );
      CREATE INDEX IF NOT EXISTS trade_token_ts ON trade(token, ts);
      CREATE TABLE IF NOT EXISTS token (
        address TEXT PRIMARY KEY, name TEXT, symbol TEXT, decimals INTEGER, icon TEXT,
        holders INTEGER, supply TEXT, dead TEXT, updated INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  cursor(name: string): number | null {
    const r = this.db.prepare("SELECT block FROM cursor WHERE name = ?").get(name) as { block: number } | undefined;
    return r ? r.block : null;
  }

  setCursor(name: string, block: number) {
    this.db.prepare("INSERT INTO cursor (name, block) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET block = excluded.block").run(name, block);
  }

  /** Runs `fn` in one transaction: a range is either stored whole or not at all. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
