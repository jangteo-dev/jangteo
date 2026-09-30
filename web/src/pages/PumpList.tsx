import { useState } from "react";
import { useApp, useChain } from "../app";
import { PopGauge, TokenMark } from "../components/PumpVisuals";
import { countdown, useLang, type Lang } from "../i18n";
import { listAllLaunches, readCurve, fmtEth, type PumpLaunch } from "../lib/pump";

type Tab = "new" | "near" | "graduated" | "volume";

/** "3m", "2h 5m": time since `at`, in the same words the countdowns use. */
export const ago = (at: number, lang: Lang) => countdown(2 * (Date.now() / 1000) - at, lang);

export function PumpList() {
  const { deployment } = useApp();
  const { t, lang } = useLang();
  const s = t.pm;
  const pump = deployment?.pump;
  // Coins from every 뻥튀기 contract (v2 now, v1 before 2026-09-26), newest first.
  const { data, error } = useChain(async () => (pump ? Promise.all([listAllLaunches(deployment), readCurve(pump)]) : null), [pump]);
  const [tab, setTab] = useState<Tab>("new");

  if (deployment && !pump) return <main className="page"><p className="empty">{s.notDeployed}</p></main>;
  const launches = data?.[0] ?? [];
  const curve = data?.[1];
  const live = launches.filter((l) => !l.graduated);
  const rows: PumpLaunch[] =
    tab === "new"
      ? live
      : tab === "near"
        ? [...live].sort((a, b) => b.progress - a.progress)
        : tab === "graduated"
          ? launches.filter((l) => l.graduated)
          : [...launches].sort((a, b) => (b.volume > a.volume ? 1 : -1));

  return (
    <main className="page pump">
      <header className="pump__head">
        <div>
          <p className="listings__ko" lang="ko">뻥튀기</p>
          <h1>{s.h1}</h1>
          <p className="lede">{s.lede}</p>
        </div>
        <a className="btn btn--ink pump__launch" href="#/ppeongtwigi/new">
          {s.launch}
        </a>
      </header>

      {curve && <PopSpot launches={launches} threshold={Number(curve.threshold) / 1e18} />}

      <div className="tabs" role="tablist">
        {(["new", "near", "graduated", "volume"] as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {k === "new" ? s.tabNew : k === "near" ? s.tabNear : k === "graduated" ? s.tabGraduated : s.tabVolume}
          </button>
        ))}
      </div>

      {error && <p className="empty">{s.readError(error)}</p>}
      {data && launches.length === 0 && (
        <p className="empty">
          {s.firstOne} <a href="#/ppeongtwigi/new">{s.launch}</a>
        </p>
      )}
      {data && launches.length > 0 && rows.length === 0 && <p className="empty">{s.none}</p>}

      <ul className="rows">
        {rows.map((l) => (
          <li key={l.token}>
            <a className="pumprow" href={`#/ppeongtwigi/${l.token}`}>
              <TokenMark l={l} size={52} />
              <span className="pumprow__name">
                {l.name}
                <small>
                  {l.symbol} · {s.age(ago(l.createdAt, lang))}
                </small>
              </span>
              <span className="pumprow__mcap">
                <small>{s.mcap}</small>
                {fmtEth(l.marketCap, 2)} ETH
              </span>
              <span className="pumprow__progress">
                {l.graduated ? (
                  <span className="gradtag">{s.graduatedTag}</span>
                ) : (
                  <>
                    <small>
                      {s.progress} {(l.progress * 100).toFixed(1)}%
                    </small>
                    <span className="gradbar" aria-hidden>
                      <i style={{ width: `${Math.max(1.5, l.progress * 100)}%` }} />
                    </span>
                    <small className="pumprow__left">{s.toPop(fmtEth(BigInt(Math.max(0, Math.round((1 - l.progress) * 4.2e18))), 2))}</small>
                  </>
                )}
              </span>
              <span className="pumprow__trades">{s.trades(l.trades)}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** The launch closest to popping, on the machine's dial, with the whole launchpad in numbers. */
function PopSpot({ launches, threshold }: { launches: PumpLaunch[]; threshold: number }) {
  const { t } = useLang();
  const s = t.pm;
  const live = launches.filter((l) => !l.graduated);
  const top = [...live].sort((a, b) => b.progress - a.progress)[0] ?? launches.filter((l) => l.graduated).sort((a, b) => b.graduatedAt - a.graduatedAt)[0];
  const vol = launches.reduce((a, l) => a + l.volume, 0n);
  return (
    <section className="popspot" aria-labelledby="popspot-h">
      <div className="popspot__card">
        <h2 id="popspot-h">{s.spotH}</h2>
        {top ? (
          <>
            <PopGauge progress={top.progress} raised={Number(top.realEth) / 1e18} threshold={threshold} graduated={top.graduated} label={s.gauge} />
            <a className="popspot__token" href={`#/ppeongtwigi/${top.token}`}>
              <TokenMark l={top} size={44} />
              <span>
                <b>{top.name}</b>
                <small>
                  {top.symbol} · {s.mcap} {fmtEth(top.marketCap, 2)} ETH
                </small>
              </span>
              <span className="btn btn--ink popspot__buy">{s.buyNow}</span>
            </a>
            {top.graduated && <p className="form__note">{s.popped}</p>}
          </>
        ) : (
          <p className="empty">{s.spotNone}</p>
        )}
      </div>
      <dl className="popspot__stats">
        <div>
          <dt>{s.statLaunches}</dt>
          <dd>{launches.length}</dd>
        </div>
        <div>
          <dt>{s.statLive}</dt>
          <dd>{live.length}</dd>
        </div>
        <div>
          <dt>{s.statGrad}</dt>
          <dd>{launches.length - live.length}</dd>
        </div>
        <div>
          <dt>{s.statVol}</dt>
          <dd>{fmtEth(vol, 2)} ETH</dd>
        </div>
        <p className="popspot__note">{s.curveNote}</p>
      </dl>
    </section>
  );
}
