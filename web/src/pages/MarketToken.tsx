import { useState } from "react";
import { type Address } from "viem";
import { useApp, useChain } from "../app";
import { TvChart } from "../components/TvChart";
import { QuickTrade } from "../components/QuickTrade";
import { countdown, useLang } from "../i18n";
import { explorer, shortAddr } from "../lib/chain";
import { CURVE, dexLabel, holdings, krw, loadHistory, loadMarket, tradeLink } from "../lib/market";
import type { PumpTrade } from "../lib/pump";
import { fmtTiny } from "../lib/tiny";
import { Spark, TokenIcon } from "./MarketPage";

const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
const tone = (v: number | null) => (v === null || v === 0 ? "" : v > 0 ? "is-bid" : "is-ask");

export function MarketToken({ token }: { token: Address }) {
  const { account, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.mk;
  const [quick, setQuick] = useState<"buy" | "sell" | null>(null);
  const { data: m } = useChain(loadMarket, []);
  const { data: hist } = useChain(() => loadHistory(token), [token, tick]);
  const x = m?.tokens.find((k) => k.address.toLowerCase() === token.toLowerCase());
  const { data: mine } = useChain(async () => (account && x ? holdings(account, [x]) : []), [account, x?.address, tick]);

  if (m === undefined) return <main className="page"><p className="empty">{s.loading}</p></main>;
  if (!m || !x) return <main className="page"><p className="empty">{s.unavailable}</p></main>;

  const trades: PumpTrade[] = (hist ?? []).map((h) => ({
    venue: CURVE.has(h.venue) ? "curve" : "pool",
    trader: h.trader as Address,
    isBuy: h.isBuy,
    eth: BigInt(h.eth),
    tokens: BigInt(h.tokens),
    realEth: 0n,
    price: h.price,
    at: h.at,
    hash: h.hash as `0x${string}`,
  }));
  const link = tradeLink(x);
  const ago = (at: number) => countdown(2 * (Date.now() / 1000) - at, lang);
  const held = mine?.[0];

  return (
    <main className="page mtoken">
      <a className="back" href="#/market">{s.back}</a>
      <header className="mtoken__head">
        <TokenIcon t={x} size={72} />
        <div className="mtoken__title">
          <h1>
            {x.name} <span className="pumptoken__sym">{x.symbol}</span>
          </h1>
          <p className="mtoken__price">
            <b>{krw(x.priceKrw, lang)}</b>
            {x.priceEth !== null && <span>{fmtTiny(x.priceEth)} ETH</span>}
            <span className={tone(x.change24h)}>{pct(x.change24h)}</span>
          </p>
          {x.suspicious && <p className="form__note form__note--warn">{s.suspicious}</p>}
        </div>
        <div className="mtoken__act">
          {link ? (
            <>
              <span className="mtoken__trade">
                <button type="button" className="btn ticket__go is-buy" onClick={() => setQuick("buy")}>
                  {s.buy}
                </button>
                <button type="button" className="btn ticket__go is-sell" onClick={() => setQuick("sell")}>
                  {s.sell}
                </button>
              </span>
              <a className="mtoken__full" href={link}>
                {x.curve ? s.pumpHere : s.fullTrade}
              </a>
            </>
          ) : (
            <p className="form__note">{s.elsewhere}</p>
          )}
          {held && <p className="form__note">{s.youHold(held.amount.toLocaleString("en-US", { maximumFractionDigits: 2 }), krw(held.amount * (x.priceKrw ?? 0), lang))}</p>}
        </div>
      </header>

      <dl className="pumpfigs mtoken__stats">
        <div>
          <dt>{s.colMcap}</dt>
          <dd>{krw(x.mcapKrw, lang)}</dd>
        </div>
        <div>
          <dt>{s.fdv}</dt>
          <dd>{krw(x.fdvKrw, lang)}</dd>
        </div>
        <div>
          <dt>{s.colLiq}</dt>
          <dd>{krw(x.liquidityKrw, lang)}</dd>
        </div>
        <div>
          <dt>{s.colVol}</dt>
          <dd>{krw(x.volume24hKrw, lang)}</dd>
        </div>
        <div>
          <dt>{s.trades24}</dt>
          <dd>{x.trades24h.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>{s.colHolders}</dt>
          <dd>{x.holders?.toLocaleString("en-US") ?? "—"}</dd>
        </div>
        <div>
          <dt>{s.col7d}</dt>
          <dd className={tone(x.change7d)}>{pct(x.change7d)}</dd>
        </div>
        <div>
          <dt>{s.col7dChart}</dt>
          <dd>
            <Spark v={x.spark} w={140} h={34} />
          </dd>
        </div>
      </dl>

      <section className="pumpblock">
        <h2>{s.chartH}</h2>
        <TvChart
          trades={trades}
          symbol={x.symbol}
          circulating={x.priceKrw && x.mcapKrw ? x.mcapKrw / x.priceKrw : 0}
          labels={{ price: t.pm.price, mcap: t.pm.mcap, volume: t.pm.volume, graduated: s.graduated, empty: t.pm.chartEmpty }}
        />
      </section>

      <div className="mtoken__lists">
        <section className="pumpblock">
          <h2>{s.venuesH}</h2>
          <table className="tradesTable">
            <tbody>
              {x.venues.slice(0, 10).map((v) => (
                <tr key={v.pool + v.dex}>
                  <td>
                    <b>{dexLabel(v.dex, lang)}</b> <span className="tag">{v.kind.toUpperCase()}</span>
                  </td>
                  <td>
                    <a href={`${explorer}/address/${v.pool}`} target="_blank" rel="noreferrer">
                      {shortAddr(v.pool)}
                    </a>
                  </td>
                  <td className="num">{krw(v.liquidityKrw, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {x.venues.length > 10 && <p className="form__note">{s.moreVenues(x.venues.length - 10)}</p>}
        </section>
        <section className="pumpblock">
          <h2>{s.tradesH}</h2>
          <div className="scrollx">
            <table className="tradesTable">
              <tbody>
                {trades
                  .slice(-40)
                  .reverse()
                  .map((tr) => (
                    <tr key={tr.hash + tr.at + String(tr.tokens)}>
                      <td className={tr.isBuy ? "is-bid" : "is-ask"}>{tr.isBuy ? s.buy : s.sell}</td>
                      <td>{tr.trader ? shortAddr(tr.trader) : "—"}</td>
                      <td className="num">{krw((Number(tr.eth) / 1e18) * m.ethKrw, lang)}</td>
                      <td className="num">{fmtTiny(tr.price)} ETH</td>
                      <td className="num">
                        <a href={`${explorer}/tx/${tr.hash}`} target="_blank" rel="noreferrer">
                          {t.pm.age(ago(tr.at))}
                        </a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <p className="form__note">
        <a href={`${explorer}/token/${x.address}`} target="_blank" rel="noreferrer">
          {s.contract}
        </a>
      </p>
      {quick && x && <QuickTrade token={x} side={quick} onClose={() => setQuick(null)} />}
    </main>
  );
}
