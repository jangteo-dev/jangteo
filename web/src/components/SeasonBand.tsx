import { useChain } from "../app";
import { useLang } from "../i18n";
import { shortAddr } from "../lib/chain";

interface PointsLite {
  season: { id: number; endsAt: number };
  rules: Record<string, number>;
  totals: { verified: number };
  entries: { address: string; total: number; rank: number | null }[];
}

async function loadPoints(): Promise<PointsLite | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}points.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as PointsLite) : null;
  } catch {
    return null;
  }
}

/** 시즌 포인트 on the front page: the three quickest ways to earn, and where they may lead. */
export function SeasonBand() {
  const { t } = useLang();
  const s = t.sb;
  const { data } = useChain(loadPoints, []);
  const r = data?.rules ?? {};
  const top = (data?.entries ?? []).filter((e) => e.rank !== null).slice(0, 5);
  return (
    <section className="seasonband" aria-labelledby="seasonband-h">
      <header className="seasonband__head">
        <p className="seasonband__tag">
          <span className="seasonlink__dot" aria-hidden />
          {data ? s.live(data.season.id) : s.season}
        </p>
        <h2 id="seasonband-h">{s.h2}</h2>
        <p className="seasonband__lede">{s.lede}</p>
      </header>
      <div className="seasonband__body">
      <ul className="seasonband__ways">
        <li>
          <a href="#/points">
            <b>{s.questsT}</b>
            <span>{s.questsB(r.dailyQuest ?? 20, r.dailyAll ?? 50)}</span>
          </a>
        </li>
        <li>
          <a href="#/points">
            <b>{s.spinT}</b>
            <span>{s.spinB}</span>
          </a>
        </li>
        <li>
          <a href="#/points">
            <b>{s.inviteT}</b>
            <span>{s.inviteB(Math.round((r.inviteShare ?? 0.1) * 100), r.inviteWelcome ?? 50)}</span>
          </a>
        </li>
      </ul>
      <aside className="seasonband__top" aria-labelledby="seasonband-top">
        <h3 id="seasonband-top">{s.topH}</h3>
        {top.length === 0 ? (
          <p className="form__note">{s.topEmpty}</p>
        ) : (
          <ol>
            {top.map((e) => (
              <li key={e.address}>
                <span className="seasonband__rank">{e.rank}</span>
                <span className="seasonband__who">{shortAddr(e.address)}</span>
                <b>{Math.round(e.total).toLocaleString("en-US")} P</b>
              </li>
            ))}
          </ol>
        )}
        <a href="#/points">{s.topAll}</a>
      </aside>
      </div>
      <footer className="seasonband__foot">
        <a className="btn btn--ink" href="#/points">
          {s.cta}
        </a>
        <p className="seasonband__note">{s.note}</p>
      </footer>
    </section>
  );
}
