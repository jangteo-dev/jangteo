import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { giwaSepolia } from "viem/chains";
import { config } from "../config.ts";

/**
 * GIWA's public RPC rate-limits bursts, so every indexer call goes through one limiter: at most
 * `RATE` requests a second across the process, and a rate-limit answer backs off and retries
 * instead of failing the range (a failed range would mean a gap).
 */
const RATE = Number(process.env.INDEXER_RPS ?? 8);

let urgentWaiting = 0;

/**
 * Background work (sender lookups, metadata, V3 holdings, discovery) has its own small bucket:
 * the ops keepers share this server's IP and GIWA's rate limit, so the indexer must always leave
 * them room. The block stream, which is what "live" depends on, uses the endpoint buckets below.
 */
const BG_RATE = Number(process.env.INDEXER_BG_RPS ?? 2);
let bgTokens = BG_RATE;
let bgLast = Date.now();

async function slot(urgent: boolean) {
  if (urgent) {
    await endpointSlot();
    return;
  }
  for (;;) {
    if (urgentWaiting > 0) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    const now = Date.now();
    bgTokens = Math.min(BG_RATE, bgTokens + ((now - bgLast) / 1000) * BG_RATE);
    bgLast = now;
    if (bgTokens >= 1) {
      bgTokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.ceil(((1 - bgTokens) / BG_RATE) * 1000)));
  }
}

export const rpc: PublicClient = createPublicClient({
  chain: giwaSepolia,
  transport: fallback(config.rpc.giwa.map((u) => http(u, { timeout: 30_000, retryCount: 0 }))),
}) as PublicClient;

// Word boundaries matter: a bare "503" also matches inside hex addresses quoted in a revert message.
const transient = (e: unknown) =>
  /rate limit|timeout|timed out|fetch failed|ECONNRESET|\b(?:502|503|429)\b|socket/i.test(
    String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e) + String((e as { details?: string })?.details ?? ""),
  );

export { transient };

/** Runs one RPC call under the limiter, retrying transient failures with backoff until it succeeds. */
export async function call<T>(fn: () => Promise<T>, what = "rpc", urgent = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await slot(urgent);
    try {
      return await fn();
    } catch (err) {
      if (!transient(err) || attempt > 12) throw new Error(`${what}: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, Math.min(15_000, 400 * 2 ** attempt)));
    }
  }
}

/**
 * GIWA runs two public endpoints (standard and flashblocks), each with its own rate limit. The
 * block stream spreads its log queries over both, each paced by its own bucket, which doubles
 * how fast a backfill can go without pushing either endpoint past its limit.
 */
const endpoints = config.rpc.giwa.map((url) => ({
  client: createPublicClient({ chain: giwaSepolia, transport: http(url, { timeout: 30_000, retryCount: 0 }) }) as PublicClient,
  tokens: RATE,
  last: Date.now(),
}));

async function endpointSlot() {
  for (;;) {
    const now = Date.now();
    for (const e of endpoints) {
      e.tokens = Math.min(RATE, e.tokens + ((now - e.last) / 1000) * RATE);
      e.last = now;
    }
    const best = endpoints.reduce((a, b) => (b.tokens > a.tokens ? b : a));
    if (best.tokens >= 1) {
      best.tokens -= 1;
      return best;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Like `call`, for the block stream: runs on whichever endpoint has room, retrying on the other. */
export async function callAny<T>(fn: (c: PublicClient) => Promise<T>, what = "rpc"): Promise<T> {
  urgentWaiting++;
  try {
    for (let attempt = 0; ; attempt++) {
      const e = await endpointSlot();
      try {
        return await fn(e.client);
      } catch (err) {
        if (!transient(err) || attempt > 12) throw new Error(`${what}: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
        e.tokens = -RATE; // that endpoint is hot: give it a second before it is picked again
        await new Promise((r) => setTimeout(r, Math.min(8000, 200 * 2 ** attempt)));
      }
    }
  } finally {
    urgentWaiting--;
  }
}
