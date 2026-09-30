import { useMemo, useState } from "react";
import { useApp, useChain } from "../app";
import { TokenMark } from "../components/PumpVisuals";
import { QuickTrade } from "../components/QuickTrade";
import { useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { CURVE, holdings, krw, loadMarket, tradeLink, type MarketToken } from "../lib/market";
import { fmtTiny } from "../lib/tiny";

type Filter = "all" | "tradable" | "pump" | "swap" | "other" | "mine";
type Sort = "mcap" | "volume" | "liquidity" | "gainers" | "losers" | "new" | "holders";

/** Below this much liquidity a price is too easy to move for its market cap to mean anything. */
export const THIN_KRW = 100_000;
export const isThin = (x: MarketToken) => x.priceEth !== null && x.liquidityKrw < THIN_KRW;

const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
const tone = (v: number | null) => (v === null || v === 0 ? "" : v > 0 ? "is-bid" : "is-ask");

export function TokenIcon({ t, size = 32 }: { t: Pick<MarketToken, "address" | "symbol" | "icon">; size?: number }) {
  return <TokenMark l={{ token: t.address, symbol: t.symbol, meta: { image: t.icon ?? undefined } }} size={size} />;
}

/** Seven days as one line; red when the week ended higher, blue when lower. */
export function Spark({ v, w = 96, h = 32 }: { v: number[]; w?: number; h?: number }) {
  if (v.length < 2) return <span className="spark spark--none" />;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo || hi || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((x - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
  const up = v[v.length - 1] >= v[0];
  return (
    <svg className={`spark ${up ? "spark--up" : "spark--down"}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} />
    </svg>
  );
}

export function MarketPage() {
  const { account, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.mk;
  const { data: m, error } = useChain(loadMarket, []);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("volume");
  const [hideSpam, setHideSpam] = useState(true);
  const [quick, setQuick] = useState<{ x: MarketToken; side: "buy" | "sell" } | null>(null);
  const { data: mine } = useChain(async () => (account && m ? holdings(account, m.tokens) : []), [account, m?.updatedAt, tick]);

  const rows = useMemo(() => {
    if (!m) return [];
    const ql = q.trim().toLowerCase();
    const mineSet = new Set((mine ?? []).map((x) => x.token.address.toLowerCase()));
    let r = m.tokens.filter((x) => {
      if (hideSpam && x.suspicious && filter !== "mine") return false;
      if (ql && !`${x.name} ${x.symbol} ${x.address}`.toLowerCase().includes(ql)) return false;
      switch (filter) {
        case "tradable":
          return tradeLink(x) !== null;
        case "pump":
          return !!x.curve || x.venues.some((v) => CURVE.has(v.dex)) || x.graduated;
        case "swap":
          return x.venues.some((v) => v.dex === "장터 스왑");
        case "other":
          return x.venues.some((v) => v.dex !== "장터 스왑" && !CURVE.has(v.dex));
        case "mine":
          return mineSet.has(x.address.toLowerCase());
        default:
          return true;
      }
    });
    const key: Record<Sort, (x: MarketToken) => number> = {
      mcap: (x) => x.mcapKrw ?? -1,
      volume: (x) => x.volume24hKrw,
      liquidity: (x) => x.liquidityKrw,
      gainers: (x) => x.change24h ?? -Infinity,
      losers: (x) => -(x.change24h ?? Infinity),
      new: (x) => x.createdAt ?? 0,
      holders: (x) => x.holders ?? -1,
    };
    // Thin markets rank after real ones for every ordering, then by the chosen key.
    // Quote assets and thin markets rank after real ones for every ordering, then by the chosen key.
    const tier = (x: MarketToken) => (x.anchor ? 2 : isThin(x) ? 1 : 0);
    r = [...r].sort((a, b) => tier(a) - tier(b) || key[sort](b) - key[sort](a));
    return r;
  }, [m, q, filter, sort, hideSpam, mine]);

  if (error) return <main className="page"><p className="empty">{s.unavailable}</p></main>;
  if (m === undefined) return <main className="page"><p className="empty">{s.loading}</p></main>;
  if (m === null) return <main className="page"><p className="empty">{s.unavailable}</p></main>;

  const sorts: [Sort, string][] = [
    ["mcap", s.sortMcap],
    ["volume", s.sortVolume],
    ["liquidity", s.sortLiquidity],
    ["gainers", s.sortGainers],
    ["losers", s.sortLosers],
    ["new", s.sortNew],
    ["holders", s.sortHolders],
  ];
  const filters: [Filter, string][] = [
    ["all", s.filterAll],
    ["tradable", s.filterTradable],
    ["pump", s.filterPump],
    ["swap", s.filterSwap],
    ["other", s.filterOther],
    ["mine", s.filterMine],
  ];

  return (
    <main className="page market">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">마켓</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
      </header>

      <div className="marketbar">
        <span className={`livedot ${m.live ? "is-live" : ""}`}>{m.live ? s.live(m.block.toLocaleString("en-US")) : s.catching(m.lag.toLocaleString("en-US"))}</span>
        <span>{s.ethRate(`₩${Math.round(m.ethKrw).toLocaleString("en-US")}`)}</span>
      </div>

      <dl className="swaptotals market__totals">
        <div>
          <dt>{s.tokens}</dt>
          <dd>{m.totals.tokens.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>{s.dexes}</dt>
          <dd>{m.totals.dexes}</dd>
        </div>
        <div>
          <dt>{s.liquidity}</dt>
          <dd>{krw(m.totals.liquidityKrw, lang)}</dd>
        </div>
        <div>
          <dt>{s.volume}</dt>
          <dd>{krw(m.totals.volume24hKrw, lang)}</dd>
        </div>
      </dl>

      <div className="market__controls">
        <input className="market__search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={s.search} aria-label={s.search} spellCheck={false} />
        <div className="chips market__filters" role="tablist">
          {filters.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={`chip ${filter === k ? "is-on" : ""}`} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="market__sorts">
          <span>{s.sortBy}</span>
          {sorts.map(([k, label]) => (
            <button key={k} aria-pressed={sort === k} className={`chip chip--sm ${sort === k ? "is-on" : ""}`} onClick={() => setSort(k)}>
              {label}
            </button>
          ))}
          <label className="check market__spam">
            <input type="checkbox" checked={hideSpam} onChange={(e) => setHideSpam(e.target.checked)} />
            <span>{s.hideSpam}</span>
          </label>
        </div>
      </div>

      {filter === "mine" ? (
        <Holdings m={m.tokens} flows={m.flows} s={s} lang={lang} />
      ) : (
        <div className="scrollx">
          <table className="markettable">
            <thead>
              <tr>
                <th scope="col" className="num">#</th>
                <th scope="col">{s.colToken}</th>
                <th scope="col" className="num">{s.colPrice}</th>
                <th scope="col" className="num">{s.col24h}</th>
                <th scope="col" className="num">{s.col7d}</th>
                <th scope="col" className="num">{s.colMcap}</th>
                <th scope="col" className="num">{s.colLiq}</th>
                <th scope="col" className="num">{s.colVol}</th>
                <th scope="col" className="num">{s.colHolders}</th>
                <th scope="col">{s.col7dChart}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map((x, i) => (
                <Row key={x.address} x={x} i={i} s={s} lang={lang} onQuick={(t, side) => setQuick({ x: t, side })} />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">{s.none}</p>}
        </div>
      )}
      {quick && <QuickTrade token={m?.tokens.find((k) => k.address === quick.x.address) ?? quick.x} side={quick.side} onClose={() => setQuick(null)} />}
    </main>
  );
}

function Row({ x, i, s, lang, onQuick }: { x: MarketToken; i: number; s: Dict["mk"]; lang: "en" | "ko"; onQuick: (x: MarketToken, side: "buy" | "sell") => void }) {
  const link = tradeLink(x);
  return (
    <tr onClick={() => (location.hash = `#/market/${x.address}`)} className="markettable__row">
      <td className="num markettable__rank">{i + 1}</td>
      <td>
        <a className="markettoken" href={`#/market/${x.address}`} onClick={(e) => e.stopPropagation()}>
          <TokenIcon t={x} />
          <span className="markettoken__names">
            <b>{x.symbol}</b>
            <small>{x.name}</small>
          </span>
          {x.curve && <span className="tag tag--curve">{s.onCurve(`${x.curve.progress.toFixed(1)}%`)}</span>}
          {x.graduated && <span className="tag">{s.graduated}</span>}
          {x.anchor && (
            <span className="tag" title={s.anchorNote}>
              {s.anchor}
            </span>
          )}
          {!x.anchor && isThin(x) && (
            <span className="tag tag--thin" title={s.thinNote}>
              {s.thin}
            </span>
          )}
          {x.suspicious && (
            <span className="tag tag--warn" title={s.suspicious}>
              !
            </span>
          )}
        </a>
      </td>
      <td className="num">
        {x.priceKrw !== null ? (
          <span className="marketprice">
            {krw(x.priceKrw, lang)}
            <small className="marketprice__eth">{fmtTiny(x.priceEth!)} ETH</small>
            <small className={`marketprice__chg ${tone(x.change24h)}`}>{pct(x.change24h)}</small>
          </span>
        ) : (
          <span className="muted">{s.noMarket}</span>
        )}
      </td>
      <td className={`num ${tone(x.change24h)}`}>{pct(x.change24h)}</td>
      <td className={`num ${tone(x.change7d)}`}>{pct(x.change7d)}</td>
      <td className={`num ${isThin(x) || x.anchor ? "muted" : ""}`}>{x.anchor ? "—" : krw(x.mcapKrw, lang)}</td>
      <td className="num">{x.liquidityKrw ? krw(x.liquidityKrw, lang) : "—"}</td>
      <td className="num">{x.volume24hKrw ? krw(x.volume24hKrw, lang) : "—"}</td>
      <td className="num">{x.holders !== null ? x.holders.toLocaleString("en-US") : "—"}</td>
      <td>
        <Spark v={x.spark} w={72} h={28} />
      </td>
      <td className="num">
        {link && (
          <span className="markettable__quick">
            <button type="button" className="qbtn is-buy" onClick={(e) => (e.stopPropagation(), onQuick(x, "buy"))}>
              {s.buy}
            </button>
            <button type="button" className="qbtn is-sell" onClick={(e) => (e.stopPropagation(), onQuick(x, "sell"))}>
              {s.sell}
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

function Holdings({ m, flows, s, lang }: { m: MarketToken[]; flows: Record<string, Record<string, { spentKrw: number; receivedKrw: number }>>; s: Dict["mk"]; lang: "en" | "ko" }) {
  const { account, tick } = useApp();
  const { data } = useChain(async () => (account ? holdings(account, m) : []), [account, m.length, tick]);
  if (!account) return <p className="empty">{s.connect}</p>;
  const mine = flows[account.toLowerCase()] ?? {};
  return (
    <div className="scrollx">
      <table className="markettable">
        <thead>
          <tr>
            <th scope="col">{s.colToken}</th>
            <th scope="col" className="num">{s.hAmount}</th>
            <th scope="col" className="num">{s.colPrice}</th>
            <th scope="col" className="num">{s.hValue}</th>
            <th scope="col" className="num">{s.hCost}</th>
            <th scope="col" className="num">{s.hPnl}</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? [])
            .map((h) => ({ ...h, value: h.amount * (h.token.priceKrw ?? 0), f: mine[h.token.address.toLowerCase()] }))
            .sort((a, b) => b.value - a.value)
            .map((h) => {
              // Profit = what it is worth now + what selling already brought − what buying cost.
              const pnl = h.f ? h.value + h.f.receivedKrw - h.f.spentKrw : null;
              const pnlPct = h.f && h.f.spentKrw > 0 ? pnl! / h.f.spentKrw : null;
              return (
                <tr key={h.token.address} className="markettable__row" onClick={() => (location.hash = `#/market/${h.token.address}`)}>
                  <td>
                    <span className="markettoken">
                      <TokenIcon t={h.token} />
                      <span className="markettoken__names">
                        <b>{h.token.symbol}</b>
                        <small>{h.token.name}</small>
                      </span>
                    </span>
                  </td>
                  <td className="num">{h.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                  <td className="num">{krw(h.token.priceKrw, lang)}</td>
                  <td className="num">{krw(h.value, lang)}</td>
                  <td className="num">{h.f ? krw(h.f.spentKrw, lang) : "—"}</td>
                  <td className={`num ${tone(pnl)}`}>
                    {pnl === null ? (
                      <span className="muted">{s.hNoFlows}</span>
                    ) : (
                      <>
                        {pnl >= 0 ? "+" : "−"}
                        {krw(Math.abs(pnl), lang)}
                        {pnlPct !== null && <small className="pnlpct">{pct(pnlPct)}</small>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      {data && data.length === 0 && <p className="empty">{s.none}</p>}
    </div>
  );
}
