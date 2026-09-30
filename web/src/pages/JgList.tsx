import { useApp, useChain } from "../app";
import { countdown, useLang, type Lang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { won } from "../lib/gye";
import { book, listMarkets, readOffers, type JgMarket } from "../lib/jangoe";

export function kindLabel(m: JgMarket, t: Dict) {
  return m.meta.kind === "cheongyak" ? t.jg.kindCheongyak : m.meta.kind === "points" ? t.jg.kindPoints : t.jg.kindOther;
}

export function marketStatus(m: JgMarket, t: Dict, lang: Lang) {
  if (m.status === "Voided") return t.jg.voided;
  if (m.status === "Settling") return Date.now() / 1000 < m.deliverBy ? t.jg.delivering(countdown(m.deliverBy, lang)) : t.jg.delivered;
  return t.jg.trading;
}

/** Every market with its best bid and ask. */
export async function listWithBook(addr: `0x${string}`) {
  const markets = await listMarkets(addr);
  return Promise.all(markets.map(async (m) => ({ m, ...book(await readOffers(addr, m.id)) })));
}

export function JgList() {
  const { deployment } = useApp();
  const { t, lang } = useLang();
  const s = t.jg;
  const addr = deployment?.jangoe;
  const { data, error } = useChain(async () => (addr ? listWithBook(addr) : []), [addr]);

  return (
    <main className="page listings">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">장외</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
      </header>
      {deployment && !addr && <p className="empty">{s.notDeployed}</p>}
      {error && <p className="empty">{s.readError(error)}</p>}
      {data && data.length === 0 && <p className="empty">{s.none}</p>}
      <ul className="rows">
        {data?.map(({ m, bestBid, bestAsk, bids, asks }) => (
          <li key={m.id}>
            <a className="jgrow" href={`#/jangoe/${m.id}`}>
              <span className="jgrow__name">
                {m.name}
                <small>{kindLabel(m, t)}</small>
              </span>
              <span className="jgrow__quote">
                <span className="jgrow__bid">
                  <small>{s.bid}</small>
                  {bestBid ? won(bestBid) : s.noQuote}
                </span>
                <span className="jgrow__ask">
                  <small>{s.ask}</small>
                  {bestAsk ? won(bestAsk) : s.noQuote}
                </span>
              </span>
              <span className="jgrow__meta">
                {s.offersN(bids.length + asks.length)} · {s.tradesN(m.trades)}
              </span>
              <span className="jgrow__status">{marketStatus(m, t, lang)}</span>
            </a>
          </li>
        ))}
      </ul>
      <section className="rules jg__how" aria-labelledby="jg-how">
        <h2 id="jg-how">{s.howH}</h2>
        <ol className="docs__steps">
          {s.how.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
