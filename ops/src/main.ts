import { setDefaultResultOrder } from "node:dns";
import { resolve } from "node:path";
import { config } from "./config.ts";
import { Store } from "./engine/db.ts";
import { Hub } from "./engine/notify.ts";
import { Scheduler } from "./engine/scheduler.ts";
import { extensions, loadExtensions } from "./extensions.ts";
import { logger } from "./engine/log.ts";
import { bridgeTask, topUpTask } from "./funding.ts";
import { gyeDeployTask, gyeKeeperTask } from "./keeper/gye.ts";
import { curateTask, resolveTask } from "./sangjang/tasks.ts";
import { feeSweepTask } from "./revenue/fees.ts";
import { cheongyakTask, yutTimeoutTask } from "./stalls.ts";
import { jangoeCuratorTask, jangoeSettleTask } from "./jangoe.ts";
import { withdrawRelayTask } from "./bridge/withdrawals.ts";
import { fastFillTask } from "./bridge/fastfill.ts";
import { extraRevenueTask } from "./revenue/extra.ts";
import { ordersTask } from "./swap/orders.ts";
import { insaIndexTask } from "./nft/index.ts";
import { qaDailyTask } from "./qa/daily.ts";
import { healthTask } from "./qa/health.ts";
import { talTask } from "./nft/tal.ts";
import { verifyTask } from "./verify.ts";
import { swapStatsTask } from "./swap/stats.ts";
import { pointsTask } from "./points/engine.ts";
import { pumpVerifyTask } from "./pump.ts";
import { refreshFx } from "./engine/fx.ts";
import { yutBotTask } from "./yut/bot.ts";
import { startBot } from "./bot/telegram.ts";

const log = logger("main");

export function buildScheduler(store: Store, hub: Hub) {
  // 2 s ticks keep the 윷 bot and keepers responsive; each tick is only a few SQLite reads.
  const sched = new Scheduler(store, hub, { tickMs: 2_000 });
  const { deployer, farm } = config.wallets;

  // funding
  // The deployer's L1 ETH is the fast-withdrawal float (장터 빠른 출금): it stays on Ethereum.
  for (const w of farm) sched.register(bridgeTask(w));
  if (deployer && farm.length) sched.register(topUpTask(deployer, farm));

  // Operator-only tasks that are not part of Jangteo itself live in src/private (not published).
  for (const t of extensions.privateTasks?.(store) ?? []) sched.register(t);

  sched.register(swapStatsTask(store));
  sched.register(pointsTask(store));
  sched.register(pumpVerifyTask(store));
  sched.register(verifyTask(store));

  // 장터 브릿지 withdrawals: proven and claimed on L1 by the deployer when the fee covers it.
  if (deployer) sched.register(withdrawRelayTask(deployer, store));
  if (deployer) sched.register(fastFillTask(deployer, store));
  if (deployer) sched.register(extraRevenueTask(deployer, store));
  if (deployer) sched.register(ordersTask(deployer, store));
  sched.register(insaIndexTask(store));
  sched.register(qaDailyTask(store));
  sched.register(healthTask(store));
  if (deployer) sched.register(talTask(store));

  // Gye
  if (deployer) {
    sched.register(gyeDeployTask(deployer));
    sched.register(gyeKeeperTask(deployer));
    // 상장 listing markets
    sched.register(curateTask(deployer));
    sched.register(resolveTask(deployer, store));
    // 청약 + 윷놀이
    sched.register(cheongyakTask(deployer));
    sched.register(yutTimeoutTask(deployer));
    // 장외 premarket
    sched.register(jangoeCuratorTask(deployer));
    sched.register(jangoeSettleTask(deployer));
    const house = farm.find((f) => f.label === (process.env.YUT_BOT_WALLET ?? "FARM2"));
    if (house) sched.register(yutBotTask(house, store));
    // revenue
    sched.register(feeSweepTask(deployer, store));
  }
  return sched;
}

async function main() {
  // Prefer IPv4 for every outbound call (Telegram, RPCs, GitHub): IPv6 routes here stall intermittently.
  setDefaultResultOrder("ipv4first");
  await loadExtensions();
  const store = new Store(resolve(config.dataDir, "ops.sqlite"));
  const hub = new Hub();
  hub.addSink(async (text, level) => log.info(`notify[${level}] ${text.split("\n")[0]}`));
  const sched = buildScheduler(store, hub);
  const bot = startBot(sched, store, hub);
  sched.start();
  // Upbit KRW rates for the ETH/USD equivalents shown next to every won amount on Telegram.
  void refreshFx();
  setInterval(() => void refreshFx(), 60_000);
  await hub.send(`🟢 GIWA Ops online — ${sched.list().length} tasks${config.dryRun ? " (dry-run)" : ""}`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} — draining`);
    await sched.stop();
    await bot?.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));
}

if (import.meta.main) void main();
