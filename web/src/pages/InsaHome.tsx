import { useApp, useChain } from "../app";
import { Eth, Frame, Seal, since, TalReel } from "../components/InsaBits";
import { countdown, dateKst, useLang } from "../i18n";
import { fmtEthStr, isTba, loadIndex, phaseState, type Collection } from "../lib/insa";

export function InsaHome() {
  const { deployment, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.ins;
  const { data, error } = useChain(loadIndex, [tick]);

  if (deployment && !deployment.insaMarket) return <main className="page"><p className="empty">{s.notDeployed}</p></main>;
  const cols = [...(data?.collections ?? [])].sort((a, b) => (BigInt(b.volume) > BigInt(a.volume) ? 1 : BigInt(b.volume) < BigInt(a.volume) ? -1 : b.supply - a.supply));
  const tal = data?.collections.find((c) => c.address.toLowerCase() === data.featured?.toLowerCase());

  return (
    <main className="page insa">
      <header className="insa__head">
        <div>
          <p className="listings__ko" lang="ko">인사동</p>
          <h1>{s.h1}</h1>
          <p className="lede">{s.lede}</p>
        </div>
        <a className="btn btn--ink" href="#/insa/new">
          {s.launch}
        </a>
      </header>

      {tal && <Featured c={tal} />}

      <section className="insa__cols" aria-labelledby="cols-h">
        <h2 id="cols-h">{s.collections}</h2>
        {error && <p className="empty">{error}</p>}
        {data && cols.length === 0 && <p className="empty">{s.none}</p>}
        {!data && !error && <p className="empty">{s.loading}</p>}
        {cols.length > 0 && (
          <ol className="coltable">
            <li className="coltable__head" aria-hidden>
              <span>{s.colName}</span>
              <span>{s.floor}</span>
              <span>{s.topOffer}</span>
              <span>{s.vol24}</span>
              <span>{s.volume}</span>
              <span>{s.owners}</span>
              <span>{s.items}</span>
            </li>
            {cols.map((c, i) => (
              <li key={c.address}>
                <a href={`#/insa/c/${c.address}`}>
                  <span className="coltable__rank">{i + 1}</span>
                  <Frame src={c.image} alt="" className="frame--thumb" />
                  <span className="coltable__name">
                    <b>
                      {c.name} {c.verified && <Seal title={s.verifiedNote} />}
                    </b>
                    <small>{c.symbol}</small>
                  </span>
                  <span data-k={s.floor}>{c.floor ? `${fmtEthStr(c.floor)} ETH` : "—"}</span>
                  <span data-k={s.topOffer}>{c.topOffer ? `${fmtEthStr(c.topOffer)} ETH` : "—"}</span>
                  <span data-k={s.vol24}>{fmtEthStr(c.volume24h, 3)} ETH</span>
                  <span data-k={s.volume}>{fmtEthStr(c.volume, 3)} ETH</span>
                  <span data-k={s.owners}>{c.owners.toLocaleString(lang === "ko" ? "ko-KR" : "en-US")}</span>
                  <span data-k={s.items}>
                    {c.supply.toLocaleString(lang === "ko" ? "ko-KR" : "en-US")}
                    {c.maxSupply ? <small> / {c.maxSupply.toLocaleString(lang === "ko" ? "ko-KR" : "en-US")}</small> : null}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="insa__sales" aria-labelledby="sales-h">
        <h2 id="sales-h">{s.recentSales}</h2>
        {data && data.recentSales.length === 0 && <p className="empty">{s.noSales}</p>}
        <ul className="salestrip">
          {data?.recentSales.map((x) => (
            <li key={`${x.collection}-${x.id}-${x.at}`}>
              <a href={`#/insa/c/${x.collection}/${x.id}`}>
                <Frame src={x.image} alt="" className="frame--sale" />
                <span>
                  <b>
                    {x.name} #{x.id}
                  </b>
                  <Eth wei={x.price} ethKrw={data.ethKrw} />
                  <small>{s.ago(since(x.at, lang))}</small>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

/** Jangteo's own drop, with its phases on a line and the mint progress. */
function Featured({ c }: { c: Collection }) {
  const { t, lang } = useLang();
  const s = t.ins;
  const phaseTitle = (i: number) => (c.name === "Tal" ? [s.gtdPhase, s.listPhase, s.publicPhase][i] : undefined) ?? s.phaseN(i + 1);
  const pct = c.maxSupply ? Math.min(100, (c.supply / c.maxSupply) * 100) : 0;
  return (
    <section className="talspot" aria-labelledby="talspot-h">
      <TalReel />
      <div className="talspot__body">
        <p className="talspot__kicker">{s.featured}</p>
        <h2 id="talspot-h">
          {s.talName} <Seal title={s.verifiedNote} />
        </h2>
        <p>{s.talLede}</p>
        <p className="talspot__perk">{s.talPerks}</p>
        {c.phases && (
          <ol className="phaseline">
            {c.phases.map((p, i) => {
              const st = phaseState(p);
              return (
                <li key={i} className={`is-${st}`}>
                  <b>{phaseTitle(i)}</b>
                  <span>{BigInt(p.price) === 0n ? s.free : `${fmtEthStr(p.price)} ETH`}</span>
                  <small>{isTba(p) ? s.tba : st === "upcoming" ? s.opensIn(countdown(p.start, lang)) : st === "live" ? (p.end ? s.endsIn(countdown(p.end, lang)) : s.live) : s.ended}</small>
                  {!isTba(p) && <small className="phaseline__at">{dateKst(p.start, lang)}</small>}
                </li>
              );
            })}
          </ol>
        )}
        {c.phases?.every(isTba) && <p className="talspot__count">{s.tbaNote}</p>}
        <div className="mintbar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${Math.max(0.8, pct)}%` }} />
        </div>
        <p className="talspot__count">{s.minted(c.supply, c.maxSupply ?? 0)}</p>
        <a className="btn btn--ink" href={`#/insa/c/${c.address}`}>
          {c.phases?.some((p) => phaseState(p) !== "ended") && (c.maxSupply ?? 0) > c.supply ? s.mintNow : s.viewCollection}
        </a>
      </div>
    </section>
  );
}
