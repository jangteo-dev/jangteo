import { useApp, useChain } from "../app";
import { countdown, useLang, type Lang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { won } from "../lib/gye";
import { listProperties, localized, yieldPct, type Property } from "../lib/property";

export const fmtN = (v: bigint) => v.toLocaleString("en-US");
export const fmtPct = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function propStatus(p: Property, t: Dict, lang: Lang) {
  const s = t.pr;
  if (p.status === "Funding") return Date.now() / 1000 < p.endAt && p.sold < p.totalShares ? s.stFunding(countdown(p.endAt, lang)) : s.stFundingDone;
  if (p.status === "Active") return s.stActive;
  if (p.status === "Failed") return s.stFailed;
  return s.stSold;
}

/** The two labels every property carries: who vouches for it, and that it is not real. */
export function PropBadges({ p, s }: { p: Property; s: Dict["pr"] }) {
  return (
    <span className="prop__badges">
      <span className={p.verified ? "prop__badge prop__badge--ok" : "prop__badge prop__badge--warn"}>{p.verified ? s.verified : s.unverified}</span>
      <span className="prop__badge">{s.simulated}</span>
    </span>
  );
}

export function PropList() {
  const { deployment } = useApp();
  const { t, lang } = useLang();
  const s = t.pr;
  const addr = deployment?.property;
  const { data, error } = useChain(async () => (addr ? listProperties(addr) : []), [addr]);

  return (
    <main className="page listings prop">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">부동산</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
        {addr && (
          <p>
            <a className="btn btn--ink" href="#/property/new">{s.newCta}</a>
          </p>
        )}
      </header>
      {deployment && !addr && <p className="empty">{s.notDeployed}</p>}
      {error && <p className="empty">{s.readError(error)}</p>}
      {data && data.length === 0 && <p className="empty">{s.none}</p>}
      <ul className="propgrid">
        {data?.map((p) => {
          const l = localized(p.meta, lang);
          const pct = p.totalShares === 0n ? 0 : Number((p.sold * 10_000n) / p.totalShares) / 100;
          return (
            <li key={p.id}>
              <a className="propcard" href={`#/property/${p.id}`}>
                <span className="propcard__img">
                  {p.meta.images[0] ? <img src={p.meta.images[0]} alt="" loading="lazy" /> : <span className="propcard__noimg" aria-hidden>{s.kinds[p.meta.kind]}</span>}
                </span>
                <span className="propcard__body">
                  <PropBadges p={p} s={s} />
                  <b className="propcard__name">{l.name}</b>
                  <small className="propcard__loc">
                    {s.kinds[p.meta.kind]}
                    {l.location && ` · ${l.location}`}
                  </small>
                  <span className="propcard__facts">
                    <span>
                      <small>{s.price}</small>
                      {won(p.price)}
                    </span>
                    <span>
                      <small>{s.yield}</small>
                      {p.rentPerPeriod === 0n ? s.noRent : `${fmtPct(yieldPct(p))}%`}
                    </span>
                  </span>
                  {p.status === "Funding" && (
                    <span className="propbar" role="img" aria-label={s.soldOf(fmtN(p.sold), fmtN(p.totalShares))}>
                      <i style={{ width: `${pct}%` }} />
                      <i className="propbar__cap" style={{ left: `${Number((p.minShares * 10_000n) / p.totalShares) / 100}%` }} />
                    </span>
                  )}
                  <small className="propcard__status">{propStatus(p, t, lang)}</small>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      <section className="rules" aria-labelledby="pr-how">
        <h2 id="pr-how">{s.howH}</h2>
        <ol className="docs__steps">
          {s.how.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
