import { useState } from "react";
import { useChain } from "../app";
import { dateKst, useLang } from "../i18n";

type Stall = "swap" | "pump" | "insa" | "bridge" | "cheongyak" | "jangoe" | "sangjang" | "gye" | "yut" | "daily" | "invite";
interface StatsFile {
  updatedAt: number;
  since: number;
  totals: { tx: number; users: number; community: number; verified: number; eth: number; krw: number; communityTx: number };
  stalls: Record<Stall, { tx: number; users: number; eth: number; krw: number }>;
  counts: { launches: number; graduated: number; nftMinted: number; nftSold: number; games: number; circles: number; offerings: number };
  days: { day: number; tx: number; users: number; newUsers: number; eth: number; krw: number }[];
}

/** Published by Jangteo ops with the points, from the same on-chain events. */
async function loadStats(): Promise<StatsFile | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}stats.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as StatsFile) : null;
  } catch {
    return null;
  }
}

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
const eth = (n: number) => (n >= 100 ? n0(n) : n.toLocaleString("en-US", { maximumFractionDigits: 3 }));
const STALLS: Stall[] = ["swap", "pump", "insa", "bridge", "cheongyak", "jangoe", "sangjang", "gye", "yut", "daily", "invite"];
type Metric = "tx" | "users" | "eth";

export function StatsPage() {
  const { t, lang } = useLang();
  const s = t.st;
  const { data } = useChain(loadStats, []);
  const [metric, setMetric] = useState<Metric>("tx");

  if (data === undefined) return <main className="page"><p className="empty">{s.loading}</p></main>;
  if (!data) return <main className="page"><p className="empty">{s.unavailable}</p></main>;
  const tt = data.totals;
  const days = data.days.slice(-30);
  const max = Math.max(1, ...days.map((d) => d[metric]));
  const dayLabel = (d: number) => new Date(d * 86400_000).toLocaleDateString(lang === "ko" ? "ko-KR" : "en-GB", { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <main className="page stats">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">통계</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
      </header>

      <dl className="stats__kpis">
        <div>
          <dt>{s.tx}</dt>
          <dd>{n0(tt.tx)}</dd>
          <small>{s.communityTx(n0(tt.communityTx))}</small>
        </div>
        <div>
          <dt>{s.users}</dt>
          <dd>{n0(tt.community)}</dd>
          <small>{s.verified(n0(tt.verified))}</small>
        </div>
        <div>
          <dt>{s.ethVol}</dt>
          <dd>{eth(tt.eth)} ETH</dd>
          <small>{s.ethNote}</small>
        </div>
        <div>
          <dt>{s.krwVol}</dt>
          <dd>₩{n0(tt.krw)}</dd>
          <small>{s.krwNote}</small>
        </div>
      </dl>

      <section className="stats__chart" aria-labelledby="daily-h">
        <header>
          <h2 id="daily-h">{s.daily}</h2>
          <div className="segmented" role="tablist">
            {(["tx", "users", "eth"] as Metric[]).map((m) => (
              <button key={m} role="tab" aria-selected={metric === m} className={metric === m ? "is-on" : ""} onClick={() => setMetric(m)}>
                {s.metric[m]}
              </button>
            ))}
          </div>
        </header>
        <div className="bars" role="img" aria-label={s.daily}>
          {days.map((d) => (
            <div key={d.day} className="bars__col" title={`${dayLabel(d.day)} · ${metric === "eth" ? `${eth(d.eth)} ETH` : n0(d[metric])}`}>
              <span className="bars__val">{d[metric] > 0 ? (metric === "eth" ? eth(d.eth) : n0(d[metric])) : ""}</span>
              <i style={{ height: `${(d[metric] / max) * 100}%` }} />
              <span className="bars__day">{dayLabel(d.day)}</span>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="stalls-h">
        <h2 id="stalls-h">{s.byStall}</h2>
        <div className="stats__tablewrap">
          <table className="boardTable">
            <thead>
              <tr>
                <th scope="col">{s.stall}</th>
                <th scope="col" className="num">{s.tx}</th>
                <th scope="col" className="num">{s.users}</th>
                <th scope="col" className="num">ETH</th>
                <th scope="col" className="num">₩</th>
              </tr>
            </thead>
            <tbody>
              {STALLS.filter((k) => data.stalls[k].tx > 0).map((k) => (
                <tr key={k}>
                  <td>{s.stalls[k]}</td>
                  <td className="num">{n0(data.stalls[k].tx)}</td>
                  <td className="num">{n0(data.stalls[k].users)}</td>
                  <td className="num">{data.stalls[k].eth ? eth(data.stalls[k].eth) : "—"}</td>
                  <td className="num">{data.stalls[k].krw ? n0(data.stalls[k].krw) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="counts-h">
        <h2 id="counts-h">{s.countsH}</h2>
        <dl className="stats__counts">
          {(Object.keys(data.counts) as (keyof StatsFile["counts"])[]).map((k) => (
            <div key={k}>
              <dt>{s.counts[k]}</dt>
              <dd>{n0(data.counts[k])}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="form__note">{s.foot(dateKst(data.updatedAt, lang))}</p>
    </main>
  );
}
