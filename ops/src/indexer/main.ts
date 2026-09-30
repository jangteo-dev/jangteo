// 장터 indexer: follows every DEX pool on GIWA and the 장터 뻥튀기 curve block by block, and keeps
// market.json in the web docroot fresh. Runs as its own service (giwa-indexer).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, type Address } from "viem";
import { config, gyeDeployment } from "../config.ts";
import { logger } from "../engine/log.ts";

const log = logger("indexer");
import { pumpAbi } from "../pump.ts";
import { IndexDb } from "./db.ts";
import { MarketBuilder } from "./market.ts";
import { probeFactories } from "./probe.ts";
import { call, rpc } from "./rpc.ts";
import { Stream } from "./stream.ts";

const EXPLORER = "https://sepolia-explorer.giwa.io/api/v2";
const deployments = (f: string) => {
  const p = resolve(config.root, "../contracts/deployments", f);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

async function createdBlock(address: string): Promise<number | null> {
  try {
    const a = (await (await fetch(`${EXPLORER}/addresses/${address}`, { signal: AbortSignal.timeout(10_000) })).json()) as { creation_transaction_hash?: string };
    if (!a.creation_transaction_hash) return null;
    const t = (await (await fetch(`${EXPLORER}/transactions/${a.creation_transaction_hash}`, { signal: AbortSignal.timeout(10_000) })).json()) as { block_number?: number };
    return t.block_number ?? null;
  } catch {
    return null;
  }
}

/** Verified DEX factories on GIWA's explorer, checked on-chain before they are followed. */
async function explorerFactories(): Promise<{ address: string; name: string }[]> {
  const out = new Map<string, string>();
  for (const q of ["V2Factory", "V3Factory", "PancakeFactory", "SwapFactory"]) {
    try {
      const j = (await (await fetch(`${EXPLORER}/smart-contracts?q=${q}`, { signal: AbortSignal.timeout(15_000) })).json()) as { items?: { address: { hash: string; name: string } }[] };
      for (const it of j.items ?? []) if (!/Oracle|Morpho|Launch(?!pad)/i.test(it.address.name)) out.set(it.address.hash.toLowerCase(), it.address.name);
    } catch {
      /* try again next hour */
    }
  }
  return [...out].map(([address, name]) => ({ address, name }));
}

/** A readable DEX name from a factory's contract name: NaruswapV2Factory → Naruswap. */
const dexName = (contract: string, address: string) => {
  const base = contract.replace(/(V2|V3)?Factory$/i, "").replace(/^Uniswap$/i, "Uniswap");
  return base === "Uniswap" || base === "" ? `Uniswap ${address.slice(2, 6)}` : base;
};

async function main() {
  const db = new IndexDb(resolve(config.dataDir, "index.sqlite"));
  const lp = deployments("91342.launchpad.json") as { swapFactory: string };
  // 뻥튀기 v1 (old coins) and v2 (new launches since 2026-09-26), each with its own curve.
  const pumpAddrs = ["91342.pump.json", "91342.pump2.json"].map((f) => deployments(f) as { pump: Address } | null).filter((x): x is { pump: Address } => !!x?.pump).map((x) => x.pump);
  const tkrw = gyeDeployment()!.tkrw.toLowerCase();
  const head0 = Number(await call(() => rpc.getBlockNumber(), "head"));
  const fallbackStart = head0 - 120 * 86_400;

  const pumps = await Promise.all(pumpAddrs.map(async (address) => ({ address, created: (await createdBlock(address)) ?? fallbackStart })));
  const stream = new Stream(db, pumps);
  stream.addFactory(lp.swapFactory, "v2", "장터 스왑", (await createdBlock(lp.swapFactory)) ?? fallbackStart);

  const addExplorerFactories = async () => {
    for (const f of await explorerFactories()) {
      if (db.db.prepare("SELECT 1 FROM factory WHERE address = ?").get(f.address)) continue;
      // Candidates that turned out not to be DEX factories are remembered, not re-probed.
      if (db.cursor(`notdex:${f.address}`) !== null) continue;
      const kind = await Stream.kindOf(f.address as Address);
      if (!kind) {
        db.setCursor(`notdex:${f.address}`, 1);
        continue;
      }
      const created = (await createdBlock(f.address)) ?? fallbackStart;
      stream.addFactory(f.address, kind, dexName(f.name, f.address), created);
      log.info(`following ${kind} factory ${f.name} ${f.address} from block ${created}`);
    }
  };
  // New factories are looked for in the background; startup never waits on the explorer.
  void addExplorerFactories().catch((e) => log.warn(`factories: ${String(e).slice(0, 160)}`));

  // How the aggregator calls each DEX, learned by simulation; new factories are tried every 10 min.
  const aggFile = resolve(config.root, "../contracts/deployments/91342.aggregator.json");
  if (existsSync(aggFile)) {
    const agg = (JSON.parse(readFileSync(aggFile, "utf8")) as { aggregator: Address }).aggregator;
    const from = (process.env.GIWA_DEPLOYER_ADDRESS ?? "0x9537052aCdCaa426D06318e06b560364DEc6aDB4") as Address;
    void (async () => {
      for (;;) {
        const n = await probeFactories(db, agg, from).catch((e) => (log.warn(`probe: ${String(e).slice(0, 160)}`), 0));
        if (n) log.info(`learned how to route ${n} DEX factories`);
        await new Promise((r) => setTimeout(r, 10 * 60_000));
      }
    })();
  }

  const pumpView = parseAbi(["function threshold() view returns (uint256)", "function virtualEth() view returns (uint256)", "function virtualTokens() view returns (uint256)"]);
  const curves = await Promise.all(
    pumpAddrs.map(async (address) => {
      const [threshold, virtualEth, virtualTokens] = await Promise.all(
        (["threshold", "virtualEth", "virtualTokens"] as const).map((functionName) => call(() => rpc.readContract({ address, abi: pumpView, functionName }))),
      );
      return { address: address.toLowerCase(), threshold, virtualEth, virtualTokens };
    }),
  );
  // 뻥튀기 launches of every contract, refreshed on their own loop; builds read the cache.
  type Launch = { token: string; pump: string; graduated: boolean; realEth: bigint; sold: bigint; createdAt: number };
  let launchCache: Launch[] = [];
  const refreshLaunches = async () => {
    const all: Launch[] = [];
    for (const address of pumpAddrs) {
      const n = Number(await call(() => rpc.readContract({ address, abi: pumpAbi, functionName: "tokenCount" }), "launches", true));
      if (!n) continue;
      const tokens = (await call(
        () => rpc.multicall({ contracts: Array.from({ length: n }, (_, i) => ({ address, abi: pumpAbi, functionName: "tokens", args: [BigInt(i)] }) as const), allowFailure: false }),
        "launches",
        true,
      )) as Address[];
      const ls = await call(
        () => rpc.multicall({ contracts: tokens.map((t) => ({ address, abi: pumpAbi, functionName: "launch", args: [t] }) as const), allowFailure: false }),
        "launches",
        true,
      );
      tokens.forEach((t, i) => all.push({ token: t.toLowerCase(), pump: address.toLowerCase(), graduated: ls[i].graduated, realEth: ls[i].realEth, sold: ls[i].sold, createdAt: Number(ls[i].createdAt) }));
    }
    launchCache = all;
  };
  await refreshLaunches().catch(() => {});
  void (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      await refreshLaunches().catch((e) => log.warn(`launches: ${String(e).slice(0, 120)}`));
    }
  })();
  const launches = async () => launchCache;
  const market = new MarketBuilder(db, tkrw, { curves, launches });

  let lastDiscover = 0;
  let lastFactories = Date.now();
  let lastLag = -1;
  let lagNow = -1;

  // Who sent each trade matters only for profit and loss: resolved alongside, never in the way.
  void (async () => {
    for (;;) {
      const n = await stream.resolveSenders().catch(() => 0);
      if (n === 0) await new Promise((r) => setTimeout(r, 3000));
    }
  })();

  // Metadata and V3 holdings refresh on their own loops; builds only read the cache.
  void (async () => {
    for (;;) {
      const n = await market.refreshMeta().catch((e) => (log.warn(`meta: ${String(e).slice(0, 160)}`), 0));
      await new Promise((r) => setTimeout(r, n ? 1000 : 60_000));
    }
  })();
  void (async () => {
    for (;;) {
      await market.refreshAnchors().catch((e) => log.warn(`anchors: ${String(e).slice(0, 160)}`));
      await new Promise((r) => setTimeout(r, 10 * 60_000));
    }
  })();
  void (async () => {
    for (;;) {
      await market.refreshV3().catch((e) => log.warn(`v3: ${String(e).slice(0, 160)}`));
      await new Promise((r) => setTimeout(r, 30_000));
    }
  })();

  // The market is rebuilt on its own loop, so a slow build never holds the block stream back.
  void (async () => {
    for (;;) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const t0 = Date.now();
        const m = await market.build(now);
        if (Date.now() - t0 > 5000) log.warn(`market build took ${Date.now() - t0} ms`);
        if (existsSync(config.webroot)) {
          const out = resolve(config.webroot, "market.json");
          const { routes, ...rest } = m;
          writeFileSync(`${out}.tmp`, JSON.stringify({ ...rest, lag: Math.max(0, lagNow), live: lagNow === 0 }));
          renameSync(`${out}.tmp`, out);
          // The aggregator's pool graph, for the swap page's route search.
          const rf = resolve(config.webroot, "routes.json");
          writeFileSync(`${rf}.tmp`, JSON.stringify({ updatedAt: m.updatedAt, pools: routes }));
          renameSync(`${rf}.tmp`, rf);
          // One history file per priced token, for its chart and trade list.
          const dir = resolve(config.webroot, "market");
          mkdirSync(dir, { recursive: true });
          for (const t of m.tokens) {
            if (t.priceEth === null) continue;
            const f = resolve(dir, `${t.address}.json`);
            writeFileSync(`${f}.tmp`, JSON.stringify({ updatedAt: m.updatedAt, trades: market.tradesFor(t.address) }));
            renameSync(`${f}.tmp`, f);
          }
        }
      } catch (err) {
        log.warn(`market: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
  })();
  for (;;) {
    try {
      const target = await stream.refreshHead();
      if (Date.now() - lastFactories > 3600_000) {
        await addExplorerFactories();
        lastFactories = Date.now();
      }
      if (Date.now() - lastDiscover > 60_000) {
        const n = await stream.discover(400);
        if (n) log.info(`${n} new pools`);
        lastDiscover = Date.now();
      }
      let behind = await stream.step(target);
      // Catch up in a tight loop; once live, one step a second keeps pace with GIWA's 1s blocks.
      // Catch up in a tight loop, re-reading the head every so often.
      const t0 = Date.now();
      while (behind > 0 && Date.now() - t0 < 30_000) behind = await stream.step(target);
      lagNow = behind;
      if (behind === 0) db.setCursor("live", target);
      if (behind !== lastLag && (behind === 0 || lastLag === 0 || lastLag === -1)) {
        log.info(behind === 0 ? `live at block ${target}` : `catching up, ${behind} blocks behind`);
        lastLag = behind;
      }
      if (behind === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      log.warn(`${String((err as Error)?.message ?? err).split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

void main();
