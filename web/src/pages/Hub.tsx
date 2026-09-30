import { useApp, useChain } from "../app";
import { Bojagi, type Seat } from "../components/Bojagi";
import { Odds } from "../components/Odds";
import { listCircles, readCircle } from "../lib/gye";
import { listMarkets, yesShare } from "../lib/sangjang";
import { seatsOf } from "../lib/seats";
import { useLang } from "../i18n";
import { YutBoard } from "../components/YutBoard";
import { listOfferings, stage } from "../lib/cheongyak";
import { cyAddrs } from "./CyList";
import { listWithBook } from "./JgList";
import { PopGauge } from "../components/PumpVisuals";
import { PriceBoard } from "../components/PriceBoard";
import { SeasonBand } from "../components/SeasonBand";
import { listAllLaunches, readCurve } from "../lib/pump";
import { won } from "../lib/gye";
import { fmtUnits } from "../lib/jangoe";
import { fmtComp, offeringStatus } from "./CyList";

const STORY: Seat[] = [
  { state: "paid", tookPot: true },
  { state: "paid" },
  { state: "waiting" },
  { state: "paid", tookPot: true },
  { state: "paid" },
  { state: "paid" },
  { state: "waiting" },
  { state: "paid" },
];

export function Hub() {
  const { deployment } = useApp();
  const { t, lang } = useLang();
  const h = t.hub;
  const { data: markets } = useChain(async () => (deployment?.sangjang ? listMarkets(deployment.sangjang) : []), [deployment]);
  const { data: circle } = useChain(async () => {
    if (!deployment) return null;
    const list = await listCircles(deployment);
    for (const a of list.slice(0, 10)) {
      const c = await readCircle(a);
      if (c.phase === "Active" || c.phase === "Filling") return c;
    }
    return null;
  }, [deployment]);

  const { data: offerings } = useChain(async () => {
    const a = cyAddrs(deployment);
    return a ? listOfferings(a) : [];
  }, [deployment]);
  const { data: jgMarkets } = useChain(async () => (deployment?.jangoe ? listWithBook(deployment.jangoe) : []), [deployment]);
  const jgTop = (jgMarkets ?? []).filter((x) => x.m.status === "Open").sort((a, b) => b.bids.length + b.asks.length - (a.bids.length + a.asks.length))[0];
  const { data: pumpData } = useChain(async () => (deployment?.pump ? Promise.all([listAllLaunches(deployment), readCurve(deployment.pump)]) : null), [deployment]);
  const now = Date.now() / 1000;
  const liveOfferings = (offerings ?? []).filter((o) => o.status !== "Cancelled" && stage(o) !== "closed").slice(0, 3);
  const top = (markets ?? [])
    .filter((m) => m.status === "Open" && m.closesAt > now)
    .sort((a, b) => Number(b.yesPool + b.noPool - (a.yesPool + a.noPool)))
    .slice(0, 5);

  return (
    <main className="hub">
      <section className="hub__hero">
        <p className="hub__ko" lang={lang} aria-hidden>
          {lang === "ko" ? "장터" : "Jangteo"}
        </p>
        <div className="hub__split">
          <div className="hub__intro">
            <h1>{h.h1}</h1>
            <p className="lede">{h.lede}</p>
            <div className="hub__cta">
              <a className="btn btn--ink" href="#/market">
                {h.ctaMarket}
              </a>
              <a className="btn btn--line" href="#/swap">
                {h.ctaSwap}
              </a>
            </div>
          </div>
          <PriceBoard />
        </div>
      </section>

      <SeasonBand />

      <section className="stalls" aria-label={h.marketsAria}>
        <a className="stall" href="#/gye">
          <div className="stall__visual">
            {circle ? (
              <Bojagi seed={circle.address} size={circle.size} seats={seatsOf(circle, t)} animate title={t.bojagi.live(circle.name)} />
            ) : (
              <Bojagi seed="jangteo" size={8} seats={STORY} animate title={t.bojagi.example8} />
            )}
          </div>
          <p className="stall__ko" lang="ko">계</p>
          <h2>{h.gyeTitle}</h2>
          <p>{h.gyeBody}</p>
          <span className="stall__go">{h.gyeGo}</span>
        </a>

        <a className="stall" href="#/listings">
          <div className="stall__visual stall__visual--odds">
            {top.length ? (
              <ul className="oddlist">
                {top.map((m) => (
                  <li key={m.id}>
                    <span>{m.symbol}</span>
                    <Odds yesPool={m.yesPool} noPool={m.noPool} size="sm" />
                    <em>{m.yesPool + m.noPool === 0n ? h.new : h.pctYes(Math.round(yesShare(m) * 100))}</em>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">{h.soon}</p>
            )}
          </div>
          <p className="stall__ko" lang="ko">상장</p>
          <h2>{h.sjTitle}</h2>
          <p>{h.sjBody}</p>
          <span className="stall__go">{h.sjGo}</span>
        </a>

        <a className="stall" href="#/cheongyak">
          <div className="stall__visual stall__visual--book">
            {liveOfferings.length ? (
              (() => {
                const o = liveOfferings[0];
                const eq = o.equalBps / 100;
                return (
                  <div className="alloc">
                    <p className="alloc__name">
                      {o.symbol}
                      <small>{offeringStatus(o, t, lang)}</small>
                    </p>
                    <div className="alloc__bar" role="img" aria-label={h.allocAria(eq)}>
                      <i className="alloc__eq" style={{ flexGrow: eq }}>
                        <b>{eq}%</b>
                        <span>{h.allocEqual}</span>
                      </i>
                      <i className="alloc__dep" style={{ flexGrow: 100 - eq }}>
                        <b>{100 - eq}%</b>
                        <span>{h.allocDeposit}</span>
                      </i>
                    </div>
                    <p className="alloc__foot">{o.subscribers ? `${fmtComp(o.competition)} : 1` : h.allocFirst}</p>
                  </div>
                );
              })()
            ) : (
              <p className="empty">{t.cy.hubEmpty}</p>
            )}
          </div>
          <p className="stall__ko" lang="ko">청약</p>
          <h2>{t.cy.hubTitle}</h2>
          <p>{t.cy.hubBody}</p>
          <span className="stall__go">{t.cy.hubGo}</span>
        </a>

        <a className="stall" href="#/yut">
          <div className="stall__visual">
            <YutBoard
              pieces={[
                { player: 0, piece: 0, pos: 3 },
                { player: 0, piece: 1, pos: 22 },
                { player: 0, piece: 2, pos: 22 },
                { player: 1, piece: 0, pos: 12 },
                { player: 1, piece: 1, pos: 26 },
              ]}
              me={null}
              label={t.yut.boardAria}
            />
          </div>
          <p className="stall__ko" lang="ko">윷놀이</p>
          <h2>{t.yut.hubTitle}</h2>
          <p>{t.yut.hubBody}</p>
          <span className="stall__go">{t.yut.hubGo}</span>
        </a>

        <a className="stall" href="#/ppeongtwigi">
          <div className="stall__visual stall__visual--book">
            {pumpData ? (
              (() => {
                const live = pumpData[0].filter((l) => !l.graduated).sort((a, b) => b.progress - a.progress);
                const top = live[0] ?? pumpData[0][0];
                return top ? (
                  <PopGauge
                    progress={top.progress}
                    raised={Number(top.realEth) / 1e18}
                    threshold={Number(pumpData[1].threshold) / 1e18}
                    graduated={top.graduated}
                    label={t.pm.gauge}
                    size={240}
                    caption={`${top.symbol} · ${(Number(top.realEth) / 1e18).toFixed(3)} / ${Number(pumpData[1].threshold) / 1e18} ETH`}
                  />
                ) : (
                  <p className="empty">{t.pm.hubEmpty}</p>
                );
              })()
            ) : (
              <p className="empty">{t.pm.hubEmpty}</p>
            )}
          </div>
          <p className="stall__ko" lang="ko">뻥튀기</p>
          <h2>{t.pm.hubTitle}</h2>
          <p>{t.pm.hubBody}</p>
          <span className="stall__go">{t.pm.hubGo}</span>
        </a>

        <a className="stall" href="#/insa">
          <div className="stall__visual stall__visual--book">
            <span className="frame stall__frame">
              <img src={`${import.meta.env.BASE_URL}insa/tal-cover.svg`} alt="" width={220} height={220} loading="lazy" />
            </span>
          </div>
          <p className="stall__ko" lang="ko">인사동</p>
          <h2>{t.ins.hubTitle}</h2>
          <p>{t.ins.hubBody}</p>
          <span className="stall__go">{t.ins.hubGo}</span>
        </a>

        <a className="stall" href={jgTop ? `#/jangoe/${jgTop.m.id}` : "#/jangoe"}>
          <div className="stall__visual stall__visual--book">
            {jgTop && jgTop.bids.length + jgTop.asks.length > 0 ? (
              <div className="minibook">
                <p className="minibook__name">{jgTop.m.name}</p>
                <ul>
                  {[...jgTop.asks.slice(0, 3)].reverse().map((o) => (
                    <li key={o.id} className="is-ask">
                      <span>{won(o.price)}</span>
                      <span>{fmtUnits(o.left)}</span>
                    </li>
                  ))}
                  {jgTop.bids.slice(0, 3).map((o) => (
                    <li key={o.id} className="is-bid">
                      <span>{won(o.price)}</span>
                      <span>{fmtUnits(o.left)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="empty">{t.jg.hubEmpty}</p>
            )}
          </div>
          <div className="stall__text">
            <p className="stall__ko" lang="ko">장외</p>
            <h2>{t.jg.hubTitle}</h2>
            <p>{t.jg.hubBody}</p>
            <span className="stall__go">{t.jg.hubGo}</span>
          </div>
        </a>
      </section>
    </main>
  );
}
