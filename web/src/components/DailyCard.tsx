import { useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { useApp, useChain } from "../app";
import { countdown, useLang } from "../i18n";
import { chain, client, confirmed } from "../lib/chain";
import { VerifyNow } from "./VerifyNow";

const dailyAbi = parseAbi([
  "function spin() returns (uint256)",
  "function today() view returns (uint256)",
  "function spinBlock(address, uint256) view returns (uint256)",
  "function streak(address) view returns (uint256)",
  "function lastDay(address) view returns (uint256)",
  "function result(address who, uint256 day) view returns (bool ready, uint256 reward)",
  "function rewardFor(bytes32 nextBlockHash, address who, uint256 day) pure returns (uint256)",
]);
const gateAbi = parseAbi(["function isEligible(address) view returns (bool)"]);

/** The wheel's faces, clockwise from the top. */
const FACES = [10, 50, 20, 200, 30, 100, 20, 500, 10, 30];
const SEG = 360 / FACES.length;
const COLORS = ["var(--paper-lo)", "var(--jjok)", "var(--paper)", "var(--hong)", "var(--paper-lo)", "var(--nok)", "var(--paper)", "var(--hwang)", "var(--paper-lo)", "var(--paper)"];
const INK = (i: number) => ([1, 3, 5, 7].includes(i) ? "#fff" : "var(--ink)");

export type Quest = "swap" | "curve" | "yut" | "bridge" | "insa";
export interface Today {
  spun: boolean;
  reward: number | null;
  streak: number;
  quests: Record<Quest, boolean>;
}

const QUESTS: { k: Quest; href: string; pts: number }[] = [
  { k: "swap", href: "#/swap", pts: 20 },
  { k: "curve", href: "#/ppeongtwigi", pts: 20 },
  { k: "yut", href: "#/yut", pts: 20 },
  { k: "insa", href: "#/insa", pts: 20 },
  { k: "bridge", href: "#/swap?tab=bridge", pts: 30 },
];

/**
 * 오늘의 룰렛: one spin a Korean day for verified wallets, revealed by the next block, plus the day's
 * four quests. The spin state is read from the chain; quests come from the season engine's file.
 */
export function DailyCard({ daily, gate, today }: { daily: Address; gate: Address; today?: Today }) {
  const { account, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.pt;
  const [angle, setAngle] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [shown, setShown] = useState<number | null>(null);

  const { data: st } = useChain(
    async () => {
      const day = await client.readContract({ address: daily, abi: dailyAbi, functionName: "today" });
      if (!account) return { day, block: 0n, streak: 0n, lastDay: 0n, verified: false, ready: false, reward: 0n };
      const [block, streak, lastDay, verified, [ready, reward]] = await Promise.all([
        client.readContract({ address: daily, abi: dailyAbi, functionName: "spinBlock", args: [account, day] }),
        client.readContract({ address: daily, abi: dailyAbi, functionName: "streak", args: [account] }),
        client.readContract({ address: daily, abi: dailyAbi, functionName: "lastDay", args: [account] }),
        client.readContract({ address: gate, abi: gateAbi, functionName: "isEligible", args: [account] }),
        client.readContract({ address: daily, abi: dailyAbi, functionName: "result", args: [account, day] }),
      ]);
      // blockhash() only reaches 256 blocks back; older spins are revealed from the block itself.
      if (block > 0n && !ready) {
        const next = await client.getBlock({ blockNumber: block + 1n }).catch(() => null);
        if (next) {
          const r = await client.readContract({ address: daily, abi: dailyAbi, functionName: "rewardFor", args: [next.hash, account, day] });
          return { day, block, streak, lastDay, verified, ready: true, reward: r };
        }
      }
      return { day, block, streak, lastDay, verified, ready, reward };
    },
    [account, daily, tick],
  );

  const spunToday = !!st && st.block > 0n;
  // A streak only counts if yesterday (or today) was spun.
  const streak = st && st.lastDay + 1n >= st.day ? Number(st.streak) : 0;
  useEffect(() => {
    if (st?.ready && !spinning) setShown(Number(st.reward));
  }, [st?.ready, st?.reward, spinning]);

  const land = (reward: number) => {
    const faces = FACES.map((f, i) => (f === reward ? i : -1)).filter((i) => i >= 0);
    const i = faces[Math.floor(Math.random() * faces.length)];
    // The pointer is at the top: turn so face i's centre sits under it, after five full turns.
    setAngle((a) => a - (a % 360) + 360 * 5 + (360 - (i * SEG + SEG / 2)));
  };

  const spin = async () => {
    if (!account || !st) return;
    const ok = await run(s.dSpinning, s.dSpun, async (w) => {
      const hash = await w.writeContract({ account: w.account!, chain, address: daily, abi: dailyAbi, functionName: "spin" });
      await confirmed(hash);
    });
    if (!ok) return;
    setSpinning(true);
    setShown(null);
    setAngle((a) => a + 360 * 3);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const [ready, reward] = await client.readContract({ address: daily, abi: dailyAbi, functionName: "result", args: [account, st.day] });
      if (ready) {
        land(Number(reward));
        setTimeout(() => (setShown(Number(reward)), setSpinning(false)), 3200);
        return;
      }
    }
    setSpinning(false);
  };

  const nextReset = st ? (Number(st.day) + 1) * 86400 - 9 * 3600 : 0;
  const done = QUESTS.filter((q) => today?.quests[q.k]).length;

  return (
    <section className="daily" aria-labelledby="daily-h">
      <header className="daily__head">
        <h2 id="daily-h">{s.dTitle}</h2>
        {st && <span className="daily__reset">{s.dReset(countdown(nextReset, lang))}</span>}
      </header>

      <div className="daily__wheelwrap">
        <div className="daily__pointer" aria-hidden />
        <svg className="daily__wheel" viewBox="-100 -100 200 200" style={{ transform: `rotate(${angle}deg)` }} aria-hidden>
          {FACES.map((f, i) => {
            const a0 = ((i * SEG - 90) * Math.PI) / 180;
            const a1 = (((i + 1) * SEG - 90) * Math.PI) / 180;
            const mid = (((i + 0.5) * SEG - 90) * Math.PI) / 180;
            return (
              <g key={i}>
                <path d={`M0 0 L${96 * Math.cos(a0)} ${96 * Math.sin(a0)} A96 96 0 0 1 ${96 * Math.cos(a1)} ${96 * Math.sin(a1)} Z`} fill={COLORS[i]} stroke="var(--seam)" strokeWidth="0.6" />
                <text x={66 * Math.cos(mid)} y={66 * Math.sin(mid)} fill={INK(i)} fontSize="13" textAnchor="middle" dominantBaseline="middle" transform={`rotate(${(i + 0.5) * SEG} ${66 * Math.cos(mid)} ${66 * Math.sin(mid)})`}>
                  {f}
                </text>
              </g>
            );
          })}
          <circle r="16" fill="var(--paper-hi)" stroke="var(--seam)" />
          <text y="1" fontSize="10" textAnchor="middle" dominantBaseline="middle" fill="var(--ink-2)">
            P
          </text>
        </svg>
      </div>

      <div className="daily__result" aria-live="polite">
        {shown !== null ? <b>{s.dWon(shown)}</b> : spunToday && !st?.ready ? <span>{s.dRevealing}</span> : null}
        {streak > 0 && <span className="daily__streak">{s.dStreak(streak)}</span>}
      </div>

      {!account ? (
        <p className="form__note">{s.connect}</p>
      ) : st && !st.verified ? (
        <VerifyNow reason={s.dVerify} />
      ) : (
        <button className="btn btn--ink btn--wide" disabled={!st || spunToday || spinning} onClick={() => void spin()}>
          {spunToday ? s.dDone : s.dSpin}
        </button>
      )}

      <h3 className="daily__qh">
        {s.dQuests} <span>{s.dProgress(done)}</span>
      </h3>
      <ul className="daily__quests">
        {QUESTS.map((q) => (
          <li key={q.k} className={today?.quests[q.k] ? "is-done" : ""}>
            <a href={q.href}>
              <i aria-hidden>{today?.quests[q.k] ? "✓" : ""}</i>
              <span>{s.dQuest[q.k]}</span>
              <b>+{q.pts}</b>
            </a>
          </li>
        ))}
        <li className={`daily__bonus ${done === 4 ? "is-done" : ""}`}>
          <span>{s.dAll}</span>
          <b>+50</b>
        </li>
      </ul>
      <p className="form__note">{s.dNote}</p>
    </section>
  );
}
