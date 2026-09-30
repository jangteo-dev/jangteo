import { useEffect, useMemo, useState } from "react";
import { formatEther, formatUnits, parseEther, parseUnits, zeroAddress, type Address } from "viem";
import { useApp, useChain } from "../app";
import { TvChart } from "../components/TvChart";
import { TokenMark } from "../components/PumpVisuals";
import { TokenPicker } from "../components/TokenPicker";
import { countdown, useLang } from "../i18n";
import { explorer } from "../lib/chain";
import { aggQuote, aggSwap, loadRoutes, type AggQuote } from "../lib/aggregator";
import { CURVE, dexLabel, holdings, krw, loadHistory, loadMarket, type MarketToken } from "../lib/market";
import { cancelOrder, isEth, loadOrders, placeDca, placeLimit, priceOf, rateFor, type BookOrder } from "../lib/orders";
import type { PumpTrade } from "../lib/pump";
import { ETH, balanceOf, type Token } from "../lib/swap";
import { fmtTiny } from "../lib/tiny";

type Side = "buy" | "sell";
type Mode = "market" | "limit" | "dca";
interface Level {
  price: number;
  size: number;
  orders: number; // limit orders at this level; 0 = pool depth only
}

const fmtP = (v: number) => (v === 0 ? "0" : v < 0.0001 ? fmtTiny(v, 4) : v.toLocaleString("en-US", { maximumSignificantDigits: 6 }));
const fmtQ = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v >= 1 ? v.toFixed(2) : fmtTiny(v, 3));
const round4 = (v: number) => (v === 0 ? 0 : Number(v.toPrecision(4)));
/** A price typed as a decimal string, with no exponent (parseUnits rejects 1e-9). */
const plain = (v: number) => v.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 8, maximumFractionDigits: 30 });

/**
 * An exchange view of one token against ETH: chart, a clickable order book of open limit orders
 * with the pools' own depth around the market price, market / limit / DCA tickets, the tape, and
 * the connected wallet's orders.
 */
export function TradePage({ token }: { token: Address }) {
  const { account, deployment, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.ex;
  const agg = deployment?.aggregator;
  const ordersC = deployment?.orders;
  const { data: m } = useChain(loadMarket, [tick]);
  const { data: hist } = useChain(() => loadHistory(token), [token, tick]);
  const { data: book } = useChain(loadOrders, [tick]);
  const { data: routes } = useChain(loadRoutes, []);
  const x = m?.tokens.find((k) => k.address.toLowerCase() === token.toLowerCase());

  const [side, setSide] = useState<Side>("buy");
  const [mode, setMode] = useState<Mode>("market");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState(7);
  const [slices, setSlices] = useState("10");
  const [interval, setIntervalS] = useState(86400);
  const [cap, setCap] = useState("");
  const [q, setQ] = useState<AggQuote | null>(null);
  const [quoting, setQuoting] = useState(false);

  const { data: bal } = useChain(
    async () => (account && x ? { eth: await balanceOf(ETH, account), tok: (await holdings(account, [x]))[0]?.raw ?? 0n } : null),
    [account, x?.address, tick],
  );

  // Bids and asks: open limit orders on this pair, aggregated by price, plus pool depth.
  const { asks, bids, mid } = useMemo(() => {
    const mid = x?.priceEth ?? 0;
    const levels = { buy: new Map<number, Level>(), sell: new Map<number, Level>() };
    for (const o of book?.open ?? []) {
      if (o.slices !== 0) continue;
      const pair = (isEth(o.tokenIn) && o.tokenOut.toLowerCase() === token.toLowerCase()) || (isEth(o.tokenOut) && o.tokenIn.toLowerCase() === token.toLowerCase());
      if (!pair || !x) continue;
      const p = priceOf(o, x.decimals);
      const k = round4(p.price);
      const l = levels[p.side].get(k) ?? { price: k, size: 0, orders: 0 };
      l.size += p.size;
      l.orders += 1;
      levels[p.side].set(k, l);
    }
    // The pools' depth, as if all liquidity sat in one constant-product pool: how much of the
    // token it takes to move the price by each step.
    if (x && mid > 0 && m && x.liquidityKrw > 0) {
      const rEth = x.liquidityKrw / 2 / m.ethKrw;
      const rTok = rEth / mid;
      let prevA = 0;
      let prevB = 0;
      for (const step of [0.0025, 0.005, 0.01, 0.02, 0.035, 0.05, 0.08]) {
        const a = rTok * (1 - 1 / Math.sqrt(1 + step));
        const b = rTok * (1 / Math.sqrt(1 - step) - 1);
        for (const [sd, p, cum, prev] of [
          ["sell", mid * (1 + step), a, prevA],
          ["buy", mid * (1 - step), b, prevB],
        ] as const) {
          const k = round4(p);
          const l = levels[sd].get(k) ?? { price: k, size: 0, orders: 0 };
          l.size += cum - prev;
          levels[sd].set(k, l);
        }
        prevA = a;
        prevB = b;
      }
    }
    const asks = [...levels.sell.values()].sort((a, b) => a.price - b.price).slice(0, 10).reverse();
    const bids = [...levels.buy.values()].sort((a, b) => b.price - a.price).slice(0, 10);
    return { asks, bids, mid };
  }, [book, x, m, token]);

  // Market ticket: the aggregator's best route, re-quoted as the amount changes.
  const dec = x?.decimals ?? 18;
  const amt = (() => {
    try {
      return amount ? (side === "buy" && mode === "market" ? parseEther(amount) : parseUnits(amount, mode === "dca" && side === "buy" ? 18 : dec)) : 0n;
    } catch {
      return 0n;
    }
  })();
  useEffect(() => {
    if (mode !== "market" || !agg || !routes || amt === 0n) {
      setQ(null);
      return;
    }
    let live = true;
    setQuoting(true);
    const tm = setTimeout(() => {
      const [a, b] = side === "buy" ? [ETH, token] : [token, ETH];
      aggQuote(agg, routes, a, b, amt)
        .then((r) => live && setQ(r))
        .catch(() => live && setQ(null))
        .finally(() => live && setQuoting(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [mode, side, amt, agg, routes, token, tick]);

  if (m === undefined) return <main className="page"><p className="empty">{s.loading}</p></main>;
  if (!m || !x) return <main className="page"><p className="empty">{s.unknown}</p></main>;

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
  const onCurve = !!x.curve;
  const maxSize = Math.max(1e-18, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const spread = asks.length && bids.length ? (asks[asks.length - 1].price - bids[0].price) / mid : null;
  const pick = (l: Level, sd: Side) => {
    setMode("limit");
    setSide(sd === "sell" ? "buy" : "sell"); // clicking an ask means buying at it, and vice versa
    setPrice(plain(l.price));
  };
  const priceN = Number(price) || 0;
  const amountN = Number(amount) || 0;
  const tokenBal = bal ? Number(formatUnits(bal.tok, dec)) : 0;
  const ethBal = bal ? Number(formatEther(bal.eth)) : 0;
  const mine = (book?.open ?? []).filter((o) => account && o.owner.toLowerCase() === account.toLowerCase());
  const tokOf = (a: Address) => (isEth(a) ? "ETH" : m.tokens.find((k) => k.address.toLowerCase() === a.toLowerCase())?.symbol ?? `${a.slice(0, 6)}…`);

  const submit = () => {
    if (!ordersC && mode !== "market") return;
    if (mode === "market" && q && agg) return run(s.sending, s.sent, (w) => aggSwap(w, agg, q, 100)).then((ok) => ok && setAmount(""));
    if (mode === "limit") {
      const rate = rateFor(side, price, dec);
      if (side === "buy") {
        const eth = parseEther(plain(priceN * amountN));
        return run(s.placing, s.placed, (w) => placeLimit(w, ordersC!, zeroAddress, token, eth, rate, days)).then((ok) => ok && setAmount(""));
      }
      return run(s.placing, s.placed, (w) => placeLimit(w, ordersC!, token, zeroAddress, parseUnits(amount, dec), rate, days)).then((ok) => ok && setAmount(""));
    }
    if (mode === "dca") {
      const n = Math.max(2, Math.min(365, Number(slices) || 2));
      const rate = cap ? rateFor(side, cap, dec) : 0n;
      const [tin, tout, value] = side === "buy" ? [zeroAddress, token, parseEther(amount)] : [token, zeroAddress, parseUnits(amount, dec)];
      return run(s.placing, s.placed, (w) => placeDca(w, ordersC!, tin as Address, tout as Address, value, n, interval, rate)).then((ok) => ok && setAmount(""));
    }
  };

  const tokenForPicker: Token[] = m.tokens
    .filter((k) => !k.suspicious && !k.anchor && k.venues.length > 0)
    .sort((a, b) => b.liquidityKrw - a.liquidityKrw)
    .slice(0, 200)
    .map((k) => ({ address: k.address, symbol: k.symbol, name: k.name, decimals: k.decimals }));

  return (
    <main className="page ex">
      <header className="ex__head">
        <div className="ex__pair">
          <TokenMark l={{ token: x.address, symbol: x.symbol, meta: { image: x.icon ?? undefined } }} size={40} />
          <div>
            <h1>
              {x.symbol}
              <span>/ETH</span>
            </h1>
            <TokenPicker tokens={tokenForPicker} value={x.address} onChange={(a) => (location.hash = `#/trade/${a}`)} label={s.pair} />
          </div>
        </div>
        <dl className="ex__stats">
          <div>
            <dt>{s.last}</dt>
            <dd className={(x.change24h ?? 0) >= 0 ? "is-bid" : "is-ask"}>
              {fmtP(x.priceEth ?? 0)} <small>ETH</small>
            </dd>
            <dd className="ex__sub">{krw(x.priceKrw, lang)}</dd>
          </div>
          <div>
            <dt>{s.d24}</dt>
            <dd className={(x.change24h ?? 0) >= 0 ? "is-bid" : "is-ask"}>{x.change24h === null ? "—" : `${x.change24h >= 0 ? "+" : ""}${(x.change24h * 100).toFixed(2)}%`}</dd>
          </div>
          <div>
            <dt>{s.vol}</dt>
            <dd>{krw(x.volume24hKrw, lang)}</dd>
          </div>
          <div>
            <dt>{s.liq}</dt>
            <dd>{krw(x.liquidityKrw, lang)}</dd>
          </div>
          <div>
            <dt>{s.mcap}</dt>
            <dd>{krw(x.mcapKrw, lang)}</dd>
          </div>
        </dl>
      </header>

      <div className="ex__grid">
        <section className="ex__chart pumpblock">
          <TvChart
            trades={trades}
            symbol={x.symbol}
            circulating={x.priceKrw && x.mcapKrw ? x.mcapKrw / x.priceKrw : 0}
            labels={{ price: t.pm.price, mcap: t.pm.mcap, volume: t.pm.volume, graduated: t.mk.graduated, empty: t.pm.chartEmpty }}
          />
        </section>

        <section className="ex__book" aria-labelledby="book-h">
          <h2 id="book-h">{s.book}</h2>
          <div className="book__cols">
            <span>{s.priceEth}</span>
            <span>{s.size(x.symbol)}</span>
          </div>
          <ol className="book__side book__side--ask">
            {asks.length === 0 && <li className="book__empty">{s.noAsks}</li>}
            {asks.map((l) => (
              <li key={`a${l.price}`}>
                <button type="button" onClick={() => pick(l, "sell")} title={s.pickAsk}>
                  <i style={{ width: `${(l.size / maxSize) * 100}%` }} aria-hidden />
                  <span className="book__p">{fmtP(l.price)}</span>
                  <span className="book__q">
                    {fmtQ(l.size)}
                    {l.orders > 0 && <em>{l.orders}</em>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className="book__mid">
            <b className={(x.change24h ?? 0) >= 0 ? "is-bid" : "is-ask"}>{fmtP(mid)}</b>
            <span>{krw(x.priceKrw, lang)}</span>
            {spread !== null && <small>{s.spread((spread * 100).toFixed(2))}</small>}
          </div>
          <ol className="book__side book__side--bid">
            {bids.length === 0 && <li className="book__empty">{s.noBids}</li>}
            {bids.map((l) => (
              <li key={`b${l.price}`}>
                <button type="button" onClick={() => pick(l, "buy")} title={s.pickBid}>
                  <i style={{ width: `${(l.size / maxSize) * 100}%` }} aria-hidden />
                  <span className="book__p">{fmtP(l.price)}</span>
                  <span className="book__q">
                    {fmtQ(l.size)}
                    {l.orders > 0 && <em>{l.orders}</em>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <p className="form__note">{s.bookNote}</p>
        </section>

        <section className="ex__ticket" aria-labelledby="ticket-h">
          <h2 id="ticket-h" className="visually-hidden">{s.ticket}</h2>
          {onCurve ? (
            <p className="form__note">
              {s.onCurve} <a href={`#/ppeongtwigi/${x.address}`}>{s.toCurve}</a>
            </p>
          ) : (
            <>
              <div className="ticket__side" role="tablist">
                {(["buy", "sell"] as const).map((sd) => (
                  <button key={sd} role="tab" aria-selected={side === sd} className={`is-${sd}`} onClick={() => setSide(sd)}>
                    {sd === "buy" ? s.buy : s.sell}
                  </button>
                ))}
              </div>
              <div className="ticket__modes" role="tablist">
                {(["market", "limit", "dca"] as const).map((k) => (
                  <button key={k} role="tab" aria-selected={mode === k} onClick={() => setMode(k)}>
                    {s.modes[k]}
                  </button>
                ))}
              </div>
              <form
                className="ticket"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                {mode === "limit" && (
                  <label className="ticket__field">
                    <span>{s.limitPrice}</span>
                    <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder={plain(mid)} />
                    <em>ETH</em>
                  </label>
                )}
                <label className="ticket__field">
                  <span>{mode === "limit" || side === "sell" ? s.amount : mode === "dca" ? s.totalEth : s.spend}</span>
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0" />
                  <em>{mode === "limit" || side === "sell" ? x.symbol : "ETH"}</em>
                </label>
                {account && bal && (
                  <div className="ticket__pcts">
                    <small>{s.avail(side === "buy" ? `${fmtQ(ethBal)} ETH` : `${fmtQ(tokenBal)} ${x.symbol}`)}</small>
                    {[25, 50, 75, 100].map((p) => (
                      <button
                        type="button"
                        key={p}
                        onClick={() => {
                          if (side === "sell") setAmount(plain((tokenBal * p) / 100));
                          else if (mode === "limit" && priceN > 0) setAmount(plain(((ethBal - 0.001) * p) / 100 / priceN));
                          else setAmount(plain(Math.max(0, ((ethBal - 0.001) * p) / 100)));
                        }}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>
                )}
                {mode === "dca" && (
                  <>
                    <div className="ticket__row">
                      <label className="ticket__field">
                        <span>{s.slices}</span>
                        <input inputMode="numeric" value={slices} onChange={(e) => setSlices(e.target.value.replace(/\D/g, ""))} />
                      </label>
                      <label className="ticket__field">
                        <span>{s.every}</span>
                        <select value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
                          {[3600, 4 * 3600, 86400, 7 * 86400].map((v) => (
                            <option key={v} value={v}>
                              {s.intervals[v]}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="ticket__field">
                      <span>{side === "buy" ? s.capBuy : s.capSell}</span>
                      <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d.]/g, ""))} placeholder={s.optional} />
                      <em>ETH</em>
                    </label>
                  </>
                )}
                {mode === "limit" && (
                  <div className="ticket__days">
                    <span>{s.expires}</span>
                    {[1, 7, 30].map((d) => (
                      <button type="button" key={d} className={days === d ? "is-on" : ""} onClick={() => setDays(d)}>
                        {s.daysN(d)}
                      </button>
                    ))}
                  </div>
                )}

                <dl className="swapinfo">
                  {mode === "market" && q && (
                    <>
                      <div>
                        <dt>{s.receive}</dt>
                        <dd>
                          {side === "buy" ? `${fmtQ(Number(formatUnits(q.amountOut, dec)))} ${x.symbol}` : `${fmtP(Number(formatEther(q.amountOut)))} ETH`}
                        </dd>
                      </div>
                      <div>
                        <dt>{s.impact}</dt>
                        <dd className={q.impactBps > 300 ? "is-warn" : ""}>{q.impactBps < 1 ? "< 0.01%" : `${(q.impactBps / 100).toFixed(2)}%`}</dd>
                      </div>
                      <div>
                        <dt>{s.route}</dt>
                        <dd>{[...new Set(q.dexes)].map((d) => dexLabel(d, lang)).join(" + ")}</dd>
                      </div>
                    </>
                  )}
                  {mode === "limit" && priceN > 0 && amountN > 0 && (
                    <div>
                      <dt>{s.total}</dt>
                      <dd>{fmtP(priceN * amountN)} ETH</dd>
                    </div>
                  )}
                  {mode === "dca" && amountN > 0 && (
                    <div>
                      <dt>{s.perSlice}</dt>
                      <dd>
                        {fmtQ(amountN / Math.max(2, Number(slices) || 2))} {side === "buy" ? "ETH" : x.symbol} · {s.intervals[interval]}
                      </dd>
                    </div>
                  )}
                  {mode !== "market" && (
                    <div>
                      <dt>{s.fee}</dt>
                      <dd>{s.feeVal}</dd>
                    </div>
                  )}
                </dl>
                {mode === "limit" && priceN > 0 && mid > 0 && ((side === "buy" && priceN > mid * 1.001) || (side === "sell" && priceN < mid * 0.999)) && (
                  <p className="form__note form__note--warn">{s.crosses}</p>
                )}
                <button
                  className={`btn btn--wide ticket__go is-${side}`}
                  disabled={!account || amt === 0n || (mode === "market" && (!q || quoting)) || (mode === "limit" && priceN <= 0) || (mode !== "market" && !ordersC)}
                >
                  {!account ? s.connect : mode === "market" && quoting && amt > 0n ? s.quoting : mode === "market" && amt > 0n && !q ? s.noRoute : side === "buy" ? s.buyBtn(x.symbol) : s.sellBtn(x.symbol)}
                </button>
                <p className="form__note">{s.modeNote[mode]}</p>
              </form>
            </>
          )}
        </section>
      </div>

      <div className="ex__lower">
        <section className="pumpblock" aria-labelledby="tape-h">
          <h2 id="tape-h">{s.tape}</h2>
          <table className="tape">
            <thead>
              <tr>
                <th>{s.priceEth}</th>
                <th className="num">{s.size(x.symbol)}</th>
                <th className="num">{s.when}</th>
              </tr>
            </thead>
            <tbody>
              {(hist ?? [])
                .slice(-15)
                .reverse()
                .map((h) => (
                  <tr key={h.hash + h.at}>
                    <td className={h.isBuy ? "is-bid" : "is-ask"}>
                      <a href={`${explorer}/tx/${h.hash}`} target="_blank" rel="noreferrer">
                        {fmtP(h.price)}
                      </a>
                    </td>
                    <td className="num">{fmtQ(Number(h.tokens) / 10 ** dec)}</td>
                    <td className="num">{countdown(2 * (Date.now() / 1000) - h.at, lang)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {(hist ?? []).length === 0 && <p className="empty">{s.noTrades}</p>}
        </section>

        <section className="pumpblock" aria-labelledby="mine-h">
          <h2 id="mine-h">{s.mine}</h2>
          {!account && <p className="empty">{s.connect}</p>}
          {account && mine.length === 0 && <p className="empty">{s.noOrders}</p>}
          {mine.length > 0 && (
            <table className="tape myorders">
              <thead>
                <tr>
                  <th>{s.pairCol}</th>
                  <th>{s.typeCol}</th>
                  <th className="num">{s.priceEth}</th>
                  <th className="num">{s.left}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mine.map((o) => (
                  <OrderRow key={o.id} o={o} tok={tokOf} x={x} onCancel={() => void run(s.cancelling, s.cancelled, (w) => cancelOrder(w, ordersC!, o.id))} s={s} lang={lang} />
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="pumpblock">
          <h2>{s.venues}</h2>
          <table className="tape">
            <tbody>
              {x.venues.slice(0, 8).map((v) => (
                <tr key={v.pool + v.dex}>
                  <td>
                    <b>{dexLabel(v.dex, lang)}</b> <span className="tag">{v.kind.toUpperCase()}</span>
                  </td>
                  <td className="num">{krw(v.liquidityKrw, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}

function OrderRow({ o, tok, x, onCancel, s, lang }: { o: BookOrder; tok: (a: Address) => string; x: MarketToken; onCancel: () => void; s: ReturnType<typeof useLang>["t"]["ex"]; lang: "en" | "ko" }) {
  const pairTok = isEth(o.tokenIn) ? o.tokenOut : o.tokenIn;
  const dec = pairTok.toLowerCase() === x.address.toLowerCase() ? x.decimals : 18;
  const p = o.minRate !== "0" ? priceOf(o, dec) : null;
  const buy = isEth(o.tokenIn);
  const left = Number(o.remaining) / 10 ** (buy ? 18 : dec);
  return (
    <tr>
      <td>
        <a href={`#/trade/${pairTok}`}>{tok(pairTok)}/ETH</a>
      </td>
      <td className={buy ? "is-bid" : "is-ask"}>
        {buy ? s.buy : s.sell} · {o.slices ? s.dcaProgress(o.done, o.slices) : s.modes.limit}
      </td>
      <td className="num">{p ? fmtP(p.price) : s.atMarket}</td>
      <td className="num">
        {fmtQ(left)} {buy ? "ETH" : tok(o.tokenIn)}
        {o.slices ? <small> · {s.nextIn(countdown(o.nextAt, lang))}</small> : <small> · {s.expiresIn(countdown(o.expiry, lang))}</small>}
      </td>
      <td className="num">
        <button type="button" className="btn btn--quiet poolsTable__go" onClick={onCancel}>
          {s.cancel}
        </button>
      </td>
    </tr>
  );
}
