import { Agent } from "node:https";
import { Bot, GrammyError, type Context } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { config } from "../config.ts";
import { extensions } from "../extensions.ts";
import type { Store } from "../engine/db.ts";
import type { Hub } from "../engine/notify.ts";
import type { Scheduler } from "../engine/scheduler.ts";
import { logger } from "../engine/log.ts";
import { esc, gyeView, home, radarView, sangjangView, taskView, tasksView, walletsView, type View } from "./views.ts";

export { esc };

const log = logger("tg");

/** Telegram caps messages at 4096 chars; split on line boundaries. */
export function chunks(text: string, max = 3900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > max) {
      if (cur) out.push(cur);
      cur = line.slice(0, max);
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

const opts = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export function startBot(sched: Scheduler, store: Store, hub: Hub) {
  if (!config.telegram.token) {
    log.warn("TELEGRAM_BOT_TOKEN not set — bot disabled, notifications go to the log only");
    return null;
  }
  // IPv4-only keep-alive agent: this host's IPv6 route to Telegram intermittently hangs for 10s,
  // and reusing one TLS connection saves ~300ms per API call.
  const agent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000, family: 4, maxSockets: 8 });
  const bot = new Bot(config.telegram.token, {
    client: { baseFetchConfig: { agent, compress: true }, timeoutSeconds: 40 },
  });
  const owners = new Set(config.telegram.owners);

  // Owner-only. Anyone else gets their numeric id back (so an owner can be added) and nothing more.
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id && owners.has(id)) return next();
    log.warn(`blocked update from ${id} (@${ctx.from?.username ?? "?"})`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Access denied" }).catch(() => {});
    else if (ctx.message?.text?.startsWith("/start")) await ctx.reply(`Access denied. Your id: ${id}`);
  });

  const render: Record<string, (arg: string) => Promise<View> | View> = {
    home: () => home(sched, store),
    wallets: () => walletsView(),
    radar: () => radarView(store),
    gye: () => gyeView(),
    sj: () => sangjangView(),
    tasks: (p) => tasksView(sched, Number(p) || 0),
  };
  for (const v of extensions.privateViews ?? []) render[v.id] = () => v.render(sched, store) as Promise<View>;

  const send = async (ctx: Context, v: View) => ctx.reply(v.text.slice(0, 4000), { ...opts, reply_markup: v.kb });

  const edit = async (ctx: Context, v: View) => {
    try {
      await ctx.editMessageText(v.text.slice(0, 4000), { ...opts, reply_markup: v.kb });
    } catch (err) {
      // Refreshing an unchanged view is not an error.
      if (!(err instanceof GrammyError && err.description.includes("message is not modified"))) throw err;
    }
  };

  bot.command(["start", "menu", "dashboard", "status"], async (ctx) => send(ctx, await home(sched, store)));
  bot.command("wallets", async (ctx) => send(ctx, await walletsView()));
  for (const v of extensions.privateViews ?? []) bot.command(v.command, async (ctx) => send(ctx, (await v.render(sched, store)) as View));
  bot.command("radar", async (ctx) => send(ctx, radarView(store)));
  bot.command("gye", async (ctx) => send(ctx, await gyeView()));
  bot.command("tasks", async (ctx) => send(ctx, tasksView(sched, 0)));
  bot.command("sangjang", async (ctx) => send(ctx, await sangjangView()));

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [kind, ...rest] = data.split(":");
    const arg = rest.join(":");
    try {
      if (kind === "v") {
        const [view, p = ""] = arg.split(":");
        // Stop the button spinner first; the view may need a few RPC reads.
        await ctx.answerCallbackQuery({ text: view === "home" ? "Refreshing…" : undefined });
        await edit(ctx, await (render[view] ?? render.home)(p));
      } else if (kind === "t") {
        await ctx.answerCallbackQuery();
        await edit(ctx, taskView(sched, arg));
      } else if (kind === "r") {
        const ok = sched.runNow(arg);
        await ctx.answerCallbackQuery({ text: ok ? `Running ${arg}…` : "Unknown task" });
        if (!ok) return;
        await edit(ctx, taskView(sched, arg));
        // Updates are handled one at a time, so the wait for the result runs detached:
        // other buttons stay responsive while the task works.
        void (async () => {
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (!sched.list().find((t) => t.task.id === arg)?.running) break;
          }
          await edit(ctx, taskView(sched, arg)).catch(() => {});
        })();
      } else if (kind === "p") {
        const paused = !!sched.list().find((t) => t.task.id === arg)?.state.paused;
        sched.setPaused(arg, !paused);
        await ctx.answerCallbackQuery({ text: paused ? "Resumed" : "Paused" });
        await edit(ctx, taskView(sched, arg));
      } else {
        await ctx.answerCallbackQuery();
      }
    } catch (err) {
      log.error(`callback ${data} failed`, err);
      await ctx.answerCallbackQuery({ text: "Failed — see log" }).catch(() => {});
    }
  });

  bot.catch((err) => log.error("bot error", err.error));

  hub.addSink(async (text, level) => {
    const html = `${level === "alert" ? "🔔 " : ""}${esc(text)}`;
    for (const id of owners) {
      for (const part of chunks(html)) {
        await bot.api.sendMessage(id, part, { ...opts, reply_markup: { inline_keyboard: [[{ text: "📊 Dashboard", callback_data: "v:home" }]] } });
      }
    }
  });

  void bot.api
    .setMyCommands([
      { command: "menu", description: "Dashboard" },
      { command: "wallets", description: "Balances and addresses" },
      ...(extensions.privateViews ?? []).map((v) => ({ command: v.command, description: v.description })),
      { command: "radar", description: "Mainnet and changes" },
      { command: "gye", description: "Gye circles" },
      { command: "tasks", description: "All tasks" },
    ])
    .catch(() => {});
  // Concurrent runner: a slow dashboard render or task run never queues other taps behind it.
  // The single owner is the only user, so per-chat ordering is not needed.
  let runner: RunnerHandle | null = null;
  void (async () => {
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    await bot.init();
    runner = run(bot, { runner: { fetch: { timeout: 25 }, maxRetryTime: 24 * 3600_000, retryInterval: "exponential" } });
    log.info(`telegram @${bot.botInfo.username} online (concurrent runner, IPv4 keep-alive)`);
  })().catch((err) => log.error("telegram start failed", err));
  return { stop: async () => void (await runner?.stop()) };
}
