import { InlineKeyboard } from "grammy";
import { extensions } from "../extensions.ts";
import { formatEther, type Address } from "viem";
import { abi, ADDR, giwa, l1, TESTNET_FAUCET_ATTESTER } from "../chain.ts";
import { config, gyeDeployment } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Scheduler } from "../engine/scheduler.ts";
import { readMarkets, sangjangAddress } from "../sangjang/tasks.ts";
import { kst } from "../engine/time.ts";
import { jangoeAbi, jangoeAddress } from "../jangoe.ts";
import type { SwapStats } from "../swap/stats.ts";
import { pumpSummary } from "../pump.ts";
import { fx, krwPlus } from "../engine/fx.ts";
import { fastRevenue, type AggRevenue } from "../revenue/extra.ts";

/** ETH amounts on Telegram carry their won and dollar value, like won amounts carry ETH. */
function ethPlus(v: number) {
  const { ethKrw, usdKrw } = fx();
  const e = v.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  if (!ethKrw || !usdKrw || v === 0) return `${e} ETH`;
  return `${e} ETH (≈₩${Math.round(v * ethKrw).toLocaleString("en-US")} · $${((v * ethKrw) / usdKrw).toFixed(2)})`;
}

/** The aggregator's routing fees and the bridge: fast-exit float, payouts, their fees. */
function bridgeLines(store: Store) {
  const a = store.get<AggRevenue>("revenue:agg");
  const f = fastRevenue(store);
  return [
    `<b>🔀 Aggregator</b> ${a ? `${a.swaps} routed swaps · vol ${ethPlus(a.volumeEth)} · fees ${ethPlus(a.feeEth)}` : "pending"}`,
    `<b>🌉 Bridge</b> fast float ${ethPlus(Number(formatEther(f.floatWei)))} · ${f.paid}/${f.exits} fast exits paid · fees ${ethPlus(f.feesEth)} · ${f.openStandard} standard withdrawals open`,
  ];
}

/** 장터 뻥튀기: launches, graduations, curve volume and unswept fees, all in ETH. */
async function pumpLine() {
  const p = await within(pumpSummary(), 4000, null);
  if (!p) return "<b>🍿 Ppeongtwigi</b> not deployed";
  const e = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });
  return `<b>🍿 Ppeongtwigi</b> ${p.launches} launches · ${p.graduated} graduated · vol ${e(p.volume)} ETH · fees pending ${e(p.pendingFees)} ETH`;
}

/** 인사동: mints, sales and what Jangteo earned from NFTs; Tal's mint progress. */
function insaLine(store: Store) {
  const s = store.get<{ mints: number; sales: number; volume: string; marketFees: string; mintIncome: string; collections: number; tal: { supply: number; maxSupply: number; revealed: boolean | null } | null }>("insa:stats");
  if (!s) return "<b>🖼 Insadong</b> pending";
  const e = (w: string) => Number(w) / 1e18;
  const tal = s.tal ? ` · Tal ${s.tal.supply}/${s.tal.maxSupply}${s.tal.revealed ? " revealed" : ""}` : "";
  return `<b>🖼 Insadong</b> ${s.collections} collections · ${s.mints} minted · ${s.sales} sales · vol ${ethPlus(e(s.volume))} · earned ${ethPlus(e(s.marketFees) + e(s.mintIncome))}${tal}`;
}

/** 장터 포인트: how many verified people are ranked, and the top of the board. */
function pointsLine(store: Store) {
  const p = store.get<{ totals: { participants: number; verified: number; points: number }; top: { address: string; total: number }[] }>("points:latest");
  if (!p) return "<b>🏅 Points</b> pending";
  const top = p.top.slice(0, 3).map((e, i) => `${i + 1}. ${e.address.slice(0, 6)}…${e.address.slice(-4)} ${e.total.toLocaleString("en-US")}P`);
  return `<b>🏅 Points S1</b> ${p.totals.verified} verified of ${p.totals.participants} wallets${top.length ? ` · ${top.join(" · ")}` : " · no ranked players yet"}`;
}

/** 장터 스왑 in one line: liquidity, volume, and the treasury's cut (LP tokens from the 0.05% protocol fee). */
function swapLine(store: Store) {
  const st = store.get<SwapStats>("swap:stats");
  if (!st) return "<b>💱 Swap</b> stats pending";
  const w = krwPlus;
  const t = st.totals;
  return `<b>💱 Swap</b> ${st.pools.length} pools · TVL ${w(t.tvl)} · 24h ${w(t.volume24h)} · treasury LP ${w(t.treasuryLpValue)} (+${w(t.protocolFees7d)} 7d)`;
}
import { cheongyakAbi, cheongyakV2Abi, launchpadAddresses, stallAddresses, yutAbi } from "../stalls.ts";
import { krw, pendingFees, revenue, revenueTotal } from "../revenue/fees.ts";

export interface View {
  text: string;
  kb: InlineKeyboard;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const eth = (w: bigint) => Number(formatEther(w)).toFixed(4);
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ago(t: number) {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function until(t: number) {
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return "due";
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  return `in ${(s / 3600).toFixed(1)}h`;
}

/** Never let one slow RPC hold a dashboard render hostage. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

const NAV = () =>
  new InlineKeyboard()
    .text("🔄 Refresh", "v:home")
    .text("💰 Wallets", "v:wallets")
    .row()
    .text("🛰 Radar", "v:radar")
    .row()
    .text("🧵 Gye", "v:gye")
    .text("📈 Listings", "v:sj")
    .row()
    .text("⚙️ Tasks", "v:tasks:0")
    .row()
    .add(...extensions.privateViews?.map((v) => InlineKeyboard.text(v.button, `v:${v.id}`)) ?? []);

export const back = (kb: InlineKeyboard) => kb.row().text("‹ Dashboard", "v:home");

function wallets() {
  const d = config.wallets.deployer;
  return [...(d ? [{ label: "DEPLOYER", address: d.address }] : []), ...config.wallets.farm.map((f) => ({ label: f.label, address: f.address }))];
}

async function balances() {
  return Promise.all(
    wallets().map(async (w) => {
      const [a, b] = await Promise.all([within(l1.getBalance({ address: w.address }), 4000, -1n), within(giwa.getBalance({ address: w.address }), 4000, -1n)]);
      return { ...w, l1: a, l2: b };
    }),
  );
}

function taskHealth(sched: Scheduler) {
  const all = sched.list();
  const failing = all.filter((t) => t.state.failures > 0 && !t.state.paused);
  const paused = all.filter((t) => t.state.paused);
  return { all, failing, paused, ok: all.length - failing.length - paused.length };
}

export async function home(sched: Scheduler, store: Store): Promise<View> {
  const h = taskHealth(sched);
  const bals = await balances();
  const loopAge = sched.lastTick ? Math.round((Date.now() - sched.lastTick) / 1000) : -1;
  const d = gyeDeployment();
  const mainnet = store.get<string[]>("mainnet:found") ?? [];
  const lastChange = store.recent(1, "change")[0];
  const stats = store.get<{ total_addresses: string; transactions_today: string }>("explorer:stats");
  const rev = revenue(store);
  const stalls = stallAddresses();
  const lp = launchpadAddresses();
  const [offeringsV1, games, offeringsV2] = await Promise.all([
    stalls ? within(giwa.readContract({ address: stalls.cheongyak, abi: cheongyakAbi, functionName: "offeringCount" }), 4000, 0n) : 0n,
    stalls ? within(giwa.readContract({ address: stalls.yut, abi: yutAbi, functionName: "gameCount" }), 4000, 0n) : 0n,
    lp ? within(giwa.readContract({ address: lp.cheongyakV2, abi: cheongyakV2Abi, functionName: "offeringCount" }), 4000, 0n) : 0n,
  ]);
  const offerings = offeringsV1 + offeringsV2;
  const pending = await within(pendingFees(), 5000, { gye: 0n, sangjang: 0n, cheongyak: 0n, yut: 0n, jangoe: 0n });
  const jg = jangoeAddress();
  const [jMarkets, jTrades] = jg
    ? await Promise.all([
        within(giwa.readContract({ address: jg, abi: jangoeAbi, functionName: "marketCount" }), 4000, 0n),
        within(giwa.readContract({ address: jg, abi: jangoeAbi, functionName: "tradeCount" }), 4000, 0n),
      ])
    : [0n, 0n];

  const lines = [
    `<b>GIWA Ops</b>${config.dryRun ? " · DRY-RUN" : ""} · ${kst(Date.now())}`,
    `${loopAge >= 0 && loopAge < 30 ? "🟢" : "🔴"} loop ${loopAge >= 0 ? `${loopAge}s ago` : "not started"} · ✅ ${h.ok}  ⚠️ ${h.failing.length}  ⏸ ${h.paused.length}`,
    "",
    "<b>💰 Wallets</b> (L1 / GIWA ETH)",
    ...bals.map((b) => `<code>${b.label.padEnd(8)}</code> ${b.l1 < 0n ? "?" : eth(b.l1)} / ${b.l2 < 0n ? "?" : eth(b.l2)}`),
    "",
    "<b>🪪 UP ID</b>",
    ...config.wallets.farm.map((f) => {
      const name = store.get<string>(`upid:${f.address}`);
      return `<code>${f.label.padEnd(8)}</code> ${name ? esc(name) : "—"}`;
    }),
    "",
    "<b>🛰 Radar</b>",
    `Mainnet: ${mainnet.length ? `🚨 ${esc(mainnet[0])}` : "not live yet"}`,
    `Last change: ${lastChange ? `${esc(lastChange.subject)} ${ago(lastChange.at)}` : "none since baseline"}`,
    stats ? `Testnet: ${Number(stats.total_addresses).toLocaleString("en")} addresses · ${Number(stats.transactions_today).toLocaleString("en")} tx today` : "",
    "",
    "<b>💰 Revenue</b> (fees to treasury)",
    `Collected ${krw(revenueTotal(rev))}`,
    `• Gye ${krw(BigInt(rev.gye))}\n• Listings ${krw(BigInt(rev.sangjang))}\n• Offerings ${krw(BigInt(rev.cheongyak))}\n• Yut ${krw(BigInt(rev.yut))}\n• Premarket ${krw(BigInt(rev.jangoe))}`,
    `Pending in contracts ${krw(pending.gye + pending.sangjang + pending.cheongyak + pending.yut + pending.jangoe)}${rev.lastSweep ? ` · last sweep ${kst(rev.lastSweep)}` : ""}`,
    "",
    "<b>🧵 Gye</b>",
    d ? `Live · factory <code>${short(d.factory)}</code> · https://jangteo.org` : "Not deployed yet (auto-deploys when the deployer has gas)",
    "",
    swapLine(store),
    ...bridgeLines(store),
    pointsLine(store),
    await pumpLine(),
    insaLine(store),
    `<b>🏷 Offerings</b> ${offerings} · <b>🎲 Yut</b> ${games} games · <b>🤝 Premarket</b> ${jMarkets} markets, ${jTrades} trades`,
    ...(h.failing.length ? ["", "<b>⚠️ Failing</b>", ...h.failing.map((t) => `<code>${t.task.id}</code> ${esc(t.state.last_result.slice(0, 80))}`)] : []),
  ].filter((l) => l !== undefined);

  return { text: lines.join("\n"), kb: NAV() };
}

export async function walletsView(): Promise<View> {
  const bals = await balances();
  const lines = [
    "<b>💰 Wallets</b>",
    "",
    ...bals.flatMap((b) => [
      `<b>${b.label}</b>`,
      `<code>${b.address}</code>`,
      `L1 Sepolia ${b.l1 < 0n ? "?" : eth(b.l1)} · GIWA ${b.l2 < 0n ? "?" : eth(b.l2)} ETH`,
      "",
    ]),
    "Send Sepolia ETH to any address above; it is bridged to GIWA automatically. The deployer tops up the farm wallets.",
  ];
  const kb = new InlineKeyboard();
  for (const b of bals) kb.url(`🔎 ${b.label}`, `https://sepolia-explorer.giwa.io/address/${b.address}`);
  kb.row().text("⤵️ Bridge now", "r:bridge:deployer").text("⛽ Top up farms", "r:fund:topup");
  return { text: lines.join("\n"), kb: back(kb.row().text("🔄", "v:wallets")) };
}


export function radarView(store: Store): View {
  const mainnet = store.get<string[]>("mainnet:found") ?? [];
  const changes = store.recent(6, "change");
  const lines = [
    "<b>🛰 Radar</b>",
    "",
    `Mainnet endpoints: ${mainnet.length ? mainnet.map(esc).join("\n") : "none answering yet"}`,
    "",
    "<b>Recent changes</b>",
    ...(changes.length ? changes.map((c) => `• ${kst(c.at)} ${esc(c.detail.split("\n")[0].slice(0, 110))}`) : ["none since baseline"]),
  ];
  const kb = new InlineKeyboard()
    .text("▶ Mainnet check", "r:watch:mainnet")
    .text("▶ GitHub", "r:watch:github")
    .row()
    .text("▶ Docs index", "r:watch:docs-index")
    .text("▶ FAQ / token", "r:watch:docs-faq");
  return { text: lines.join("\n"), kb: back(kb.row().text("🔄", "v:radar")) };
}

export async function gyeView(): Promise<View> {
  const d = gyeDeployment();
  const kb = new InlineKeyboard().url("🌐 jangteo.org", "https://jangteo.org");
  if (!d) {
    return {
      text: "<b>🧵 Gye</b>\n\nNot deployed yet. <code>gye:deploy</code> runs automatically once the deployer holds 0.002 ETH on GIWA.",
      kb: back(kb.row().text("▶ Deploy check", "r:gye:deploy")),
    };
  }
  const count = await giwa.readContract({ address: d.factory, abi: abi.gyeFactory, functionName: "circleCount" }).catch(() => 0n);
  const page = count ? await giwa.readContract({ address: d.factory, abi: abi.gyeFactory, functionName: "circles", args: [0n, count] }) : [];
  const PH = ["—", "filling", "active", "done", "cancelled"];
  const rows = await Promise.all(
    page.slice(-10).map(async (c) => {
      const [phase, round] = await Promise.all([
        giwa.readContract({ address: c, abi: abi.gyeCircle, functionName: "phase" }),
        giwa.readContract({ address: c, abi: abi.gyeCircle, functionName: "round" }),
      ]);
      return `• <code>${short(c)}</code> ${PH[phase] ?? phase}${phase === 2 ? ` · round ${round}` : ""}`;
    }),
  );
  kb.url("🔎 Factory", `https://sepolia-explorer.giwa.io/address/${d.factory}`);
  return {
    text: [`<b>🧵 Gye</b>`, "", `Factory <code>${d.factory}</code>`, `${count} circles`, ...rows].join("\n"),
    kb: back(kb.row().text("▶ Keeper now", "r:keeper:gye").text("🔄", "v:gye")),
  };
}

export async function sangjangView(): Promise<View> {
  const addr = sangjangAddress();
  const kb = new InlineKeyboard().url("🌐 Markets", "https://jangteo.org/#/listings");
  if (!addr) return { text: "<b>📈 Listings</b>\n\nNot deployed.", kb: back(kb) };
  const ms = await within(readMarkets(addr), 8000, []);
  const won = (x: bigint) => krwPlus(Number(x / 10n ** 18n));
  const rows = ms
    .filter((m) => m.statusName !== "Voided")
    .map((m) => {
      const pool = m.yesPool + m.noPool;
      const pct = pool ? Math.round(Number((m.yesPool * 100n) / pool)) : null;
      return `• <b>${esc(m.sym)}</b> ${m.statusName}${pct === null ? " · no bets" : ` · ${pct}% yes · ${won(pool)}`}`;
    });
  kb.row().text("▶ Resolve now", "r:sangjang:resolve").text("▶ Curate", "r:sangjang:curate");
  return {
    text: [`<b>📈 Upbit listing markets</b>`, `<code>${addr}</code>`, "", ...(rows.length ? rows : ["no markets"])].join("\n"),
    kb: back(kb.row().text("🔄", "v:sj")),
  };
}

const PAGE = 8;

export function tasksView(sched: Scheduler, page: number): View {
  const all = sched.list();
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(p * PAGE, p * PAGE + PAGE);
  const lines = [`<b>⚙️ Tasks</b> (${p + 1}/${pages})`, ""];
  const kb = new InlineKeyboard();
  for (const { task, state, running } of slice) {
    const flag = state.paused ? "⏸" : running ? "🔄" : state.failures ? "⚠️" : "✅";
    lines.push(`${flag} <code>${task.id}</code> · ${ago(state.last_run)} · next ${state.paused ? "paused" : until(state.next_run)}`);
    kb.text(`${flag} ${task.id}`, `t:${task.id}`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text("‹ Prev", `v:tasks:${p - 1}`);
    if (p < pages - 1) kb.text("Next ›", `v:tasks:${p + 1}`);
  }
  return { text: lines.join("\n"), kb: back(kb) };
}

export function taskView(sched: Scheduler, id: string): View {
  const t = sched.list().find((x) => x.task.id === id);
  if (!t) return { text: `Task <code>${esc(id)}</code> not found.`, kb: back(new InlineKeyboard()) };
  const { task, state, running } = t;
  const text = [
    `<b>${esc(task.title)}</b>`,
    `<code>${task.id}</code>`,
    "",
    `Status: ${state.paused ? "⏸ paused" : running ? "🔄 running" : state.failures ? `⚠️ ${state.failures} failure(s)` : "✅ ok"}`,
    `Last run: ${ago(state.last_run)} · last ok ${ago(state.last_ok)}`,
    `Next: ${state.paused ? "paused" : until(state.next_run)} · every ${Math.round(task.everyMs / 60_000)}m`,
    "",
    esc(state.last_result.slice(0, 1500)),
  ].join("\n");
  const kb = new InlineKeyboard()
    .text("▶ Run now", `r:${id}`)
    .text(state.paused ? "▶ Resume" : "⏸ Pause", `p:${id}`)
    .row()
    .text("🔄", `t:${id}`)
    .text("‹ Tasks", "v:tasks:0")
    .text("‹ Dashboard", "v:home");
  return { text, kb };
}
