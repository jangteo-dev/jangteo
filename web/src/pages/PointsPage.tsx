import { useState } from "react";
import { isAddress, type Address } from "viem";
import { useApp, useChain } from "../app";
import { dateKst, useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { shortAddr } from "../lib/chain";
import { DailyCard, type Today } from "../components/DailyCard";
import { InviteCard } from "../components/InviteCard";
import { VerifyNow } from "../components/VerifyNow";

type Part = "swap" | "lp" | "bridge" | "cheongyak" | "jangoe" | "pump" | "insa" | "yut" | "gye" | "sangjang" | "daily" | "days" | "invite";
const PARTS: Part[] = ["swap", "lp", "bridge", "cheongyak", "jangoe", "pump", "insa", "yut", "gye", "sangjang", "daily", "days", "invite"];

interface Entry {
  address: Address;
  total: number;
  parts: Record<Part, number>;
  activeDays: number;
  verified: boolean;
  team: boolean;
  invites?: number;
  rank: number | null;
}
interface PointsFile {
  season: { id: number; name: string; startsAt: number; endsAt: number };
  rules: Record<string, number>;
  updatedAt: number;
  entries: Entry[];
  today?: { day: number; wallets: Record<string, Today> };
  totals: { participants: number; verified: number; points: number };
}

/** Published by Jangteo ops every 5 minutes, next to the app. */
async function loadPoints(): Promise<PointsFile | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}points.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as PointsFile) : null;
  } catch {
    return null;
  }
}

/** Season boundaries are whole days in Korea: show dates only, the end as its last day. */
const dayKst = (t: number, lang: "en" | "ko") =>
  new Date(t * 1000).toLocaleDateString(lang === "ko" ? "ko-KR" : "en-GB", { dateStyle: lang === "ko" ? "long" : "medium", timeZone: "Asia/Seoul" });

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export function PointsPage() {
  const { account, deployment } = useApp();
  const { t, lang } = useLang();
  const s = t.pt;
  const { data, error } = useChain(loadPoints, []);
  const [q, setQ] = useState("");

  if (error) return <main className="page"><p className="empty">{s.unavailable}</p></main>;
  if (data === undefined) return <main className="page"><p className="empty">{s.loading}</p></main>;
  if (data === null) return <main className="page"><p className="empty">{s.unavailable}</p></main>;

  const ranked = data.entries.filter((e) => e.rank !== null);
  const team = data.entries.filter((e) => e.team && e.total > 0);
  const mine = account ? data.entries.find((e) => same(e.address, account)) : undefined;
  const found = isAddress(q) ? data.entries.find((e) => same(e.address, q)) : undefined;
  // Files published before invites existed have no invite part.
  for (const e of data.entries) e.parts.invite ??= 0;
  const max = Math.max(1, ...ranked.map((e) => e.total), ...team.map((e) => e.total));

  return (
    <main className="page points">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">포인트</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
        <p className="airdrop-note">{s.airdrop}</p>
      </header>

      <div className="seasonbar">
        <span className="seasonbar__name">
          {s.season(lang === "ko" ? `시즌 ${data.season.id}` : `Season ${data.season.id}`, dayKst(data.season.startsAt, lang), "")}
        </span>
        <span className="seasonbar__meta">
          {s.participants(data.totals.participants, data.totals.verified)} · {s.updated(dateKst(data.updatedAt, lang))}
        </span>
      </div>

      <div className="points__body">
        <section className="board" aria-labelledby="board-h">
          <h2 id="board-h" className="board__h">{s.top1000}</h2>
          {ranked.length === 0 && <p className="empty">{s.none}</p>}
          {ranked.length > 0 && (
            <table className="boardTable">
              <thead>
                <tr>
                  <th scope="col" className="num">{s.rank}</th>
                  <th scope="col">{s.wallet}</th>
                  <th scope="col">{s.mix}</th>
                  <th scope="col" className="num">{s.days}</th>
                  <th scope="col" className="num">{s.points}</th>
                </tr>
              </thead>
              <tbody>
                {ranked.slice(0, 1000).map((e) => (
                  <Row key={e.address} e={e} max={max} me={same(e.address, account ?? undefined)} s={s} />
                ))}
              </tbody>
            </table>
          )}
          {team.length > 0 && (
            <details className="board__team" open={ranked.length === 0}>
              <summary>
                {s.team} · {s.teamNote}
              </summary>
              <table className="boardTable">
                <tbody>
                  {team.map((e) => (
                    <Row key={e.address} e={e} max={max} me={same(e.address, account ?? undefined)} s={s} />
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </section>

        <aside className="points__side">
          {deployment?.daily && deployment.gate && (
            <DailyCard daily={deployment.daily} gate={deployment.gate} today={account ? data.today?.wallets[account.toLowerCase()] : undefined} />
          )}
          <MyCard entry={mine} connected={!!account} s={s} />
          {deployment?.invite && <InviteCard invite={deployment.invite} points={mine?.parts.invite ?? 0} friends={mine?.invites ?? 0} />}

          <form className="form points__search" onSubmit={(e) => e.preventDefault()}>
            <label>
              <span>{s.search}</span>
              <input value={q} onChange={(e) => setQ(e.target.value.trim())} placeholder={s.searchPh} spellCheck={false} />
            </label>
            {isAddress(q) && (found ? <Breakdown e={found} s={s} /> : <p className="form__note">{s.notFound}</p>)}
          </form>

          <section className="rules pointrules" aria-labelledby="rules-h">
            <h2 id="rules-h">{s.rulesH}</h2>
            <ul>
              {s.rules({ inviteShare: 0.1, inviteCap: 5000, inviteWelcome: 50, ...data.rules }).map(([k, text]) => (
                <li key={k}>
                  <i className={`dot dot--${k}`} aria-hidden />
                  <b>{s.parts[k]}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rules" aria-labelledby="fair-h">
            <h2 id="fair-h">{s.fairH}</h2>
            <ol className="docs__steps">
              {s.fair.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Row({ e, max, me, s }: { e: Entry; max: number; me: boolean; s: Dict["pt"] }) {
  return (
    <tr className={me ? "is-you" : ""}>
      <td className="num boardTable__rank">{e.rank ?? "—"}</td>
      <td>
        <span className="boardTable__who">
          {shortAddr(e.address)}
          {me && <span className="you">{s.you}</span>}
          {e.team && <span className="tag">{s.team}</span>}
        </span>
      </td>
      <td>
        <Mix e={e} width={(e.total / max) * 100} s={s} />
      </td>
      <td className="num">{e.activeDays}</td>
      <td className="num boardTable__pts">{fmt(e.total)}</td>
    </tr>
  );
}

/** A bar as long as the score, split by where the points came from. */
function Mix({ e, width, s }: { e: Entry; width: number; s: Dict["pt"] }) {
  const pos = PARTS.map((p) => [p, Math.max(0, e.parts[p])] as const).filter(([, v]) => v > 0);
  const sum = pos.reduce((a, [, v]) => a + v, 0) || 1;
  return (
    <span className="mix" style={{ width: `${Math.max(4, width)}%` }} title={pos.map(([p, v]) => `${s.parts[p]} ${fmt(v)}`).join(" · ")}>
      {pos.map(([p, v]) => (
        <i key={p} className={`dot--${p}`} style={{ flexGrow: v / sum }} />
      ))}
    </span>
  );
}

function Breakdown({ e, s }: { e: Entry; s: Dict["pt"] }) {
  return (
    <dl className="breakdown">
      {PARTS.filter((p) => e.parts[p] !== 0).map((p) => (
        <div key={p}>
          <dt>
            <i className={`dot dot--${p}`} aria-hidden /> {s.parts[p]}
          </dt>
          <dd>{fmt(e.parts[p])}</dd>
        </div>
      ))}
    </dl>
  );
}

function MyCard({ entry, connected, s }: { entry?: Entry; connected: boolean; s: Dict["pt"] }) {
  if (!connected) return <div className="mycard"><p>{s.connect}</p></div>;
  return (
    <div className="mycard">
      <div className="mycard__nums">
        <div>
          <span>{s.yourRank}</span>
          <b>{entry?.rank ? `#${entry.rank}` : s.unranked}</b>
        </div>
        <div>
          <span>{s.yourPoints}</span>
          <b>{fmt(entry?.total ?? 0)} P</b>
        </div>
      </div>
      {(!entry || !entry.verified) && (
        <VerifyNow reason={s.notVerified} />
      )}
      {entry ? <Breakdown e={entry} s={s} /> : <p className="form__note">{s.noActivity}</p>}
    </div>
  );
}
