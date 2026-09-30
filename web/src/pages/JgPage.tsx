import { useState } from "react";
import { parseUnits, type Address } from "viem";
import { useApp, useChain } from "../app";
import { dateKst, useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { explorer, shortAddr } from "../lib/chain";
import { won } from "../lib/gye";
import {
  book,
  collateralOf,
  fmtUnits,
  jangoe,
  readMarket,
  readMyTrades,
  readOffers,
  sellerRecord,
  tokensFor,
  valueOf,
  type JgMarket,
  type JgOffer,
  type Side,
} from "../lib/jangoe";
import { kindLabel, marketStatus } from "./JgList";

const safeUnits = (v: string) => {
  try {
    return v ? parseUnits(v, 18) : 0n;
  } catch {
    return 0n;
  }
};
const dec = (v: string) => v.replace(/[^\d.]/g, "");

export function JgPage({ id }: { id: number }) {
  const { deployment, account, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.jg;
  const addr = deployment?.jangoe;
  const { data: m, error } = useChain(async () => (addr ? readMarket(addr, id) : null), [addr, id]);
  const { data: offers } = useChain(async () => (addr ? readOffers(addr, id) : []), [addr, id, tick]);
  const { data: mine } = useChain(async () => (addr && account ? readMyTrades(addr, account, id) : []), [addr, id, account, tick]);
  const makers = [...new Set((offers ?? []).filter((o) => o.active && o.side === "Sell").map((o) => o.maker))];
  const { data: records } = useChain(
    async () => (addr ? Object.fromEntries(await Promise.all(makers.map(async (a) => [a.toLowerCase(), await sellerRecord(addr, a)] as const))) : {}),
    [addr, makers.join()],
  );

  if (error) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;
  if (!m || !addr) return <main className="page"><p className="empty">{s.loading}</p></main>;

  const { bids, asks, bestBid, bestAsk } = book(offers ?? []);
  const open = m.status === "Open";
  const now = Date.now() / 1000;
  const me = account?.toLowerCase();
  const myOffers = (offers ?? []).filter((o) => o.active && o.maker.toLowerCase() === me);
  const trades = mine ?? [];
  const toDeliver = trades.filter((x) => x.status === "Open" && x.seller.toLowerCase() === me && m.status === "Settling" && now <= m.deliverBy);
  const toClaim = trades.filter((x) => x.status === "Open" && x.buyer.toLowerCase() === me && m.status === "Settling" && now > m.deliverBy);
  const toRefund = trades.filter((x) => x.status === "Open" && m.status === "Voided");
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;

  return (
    <main className="page listing jg">
      <a className="back" href="#/jangoe">{s.back}</a>
      <header className="listing__head">
        <h1 className="listing__sym">{m.name}</h1>
        <p className="listing__q">
          {kindLabel(m, t)}
          {m.meta.kind === "cheongyak" && m.meta.offering !== undefined && (
            <>
              {" · "}
              <a href={`#/cheongyak/${m.meta.offering}`}>{s.offering}</a>
            </>
          )}
        </p>
        <p className="circle__status">{marketStatus(m, t, lang)}</p>
      </header>

      <div className="listing__body">
        <section className="listing__main">
          <div className="jgquote">
            <div>
              <span>{s.bid}</span>
              <b className="is-bid">{bestBid ? won(bestBid) : s.noQuote}</b>
            </div>
            <div>
              <span>{s.ask}</span>
              <b className="is-ask">{bestAsk ? won(bestAsk) : s.noQuote}</b>
            </div>
            <div>
              <span>{s.volume}</span>
              <b>{won(m.volume)}</b>
              <small>{s.tradesN(m.trades)}</small>
            </div>
          </div>
          {m.meta.about && <p className="profile__about">{m.meta.about}</p>}

          <div className="orderbook" aria-live="polite">
            <BookSide title={s.asks} side="Sell" rows={asks} m={m} addr={addr} records={records ?? {}} s={s} open={open} me={me} />
            {spread !== null && <p className="orderbook__spread">{won(spread < 0n ? -spread : spread)}</p>}
            <BookSide title={s.bids} side="Buy" rows={bids} m={m} addr={addr} records={records ?? {}} s={s} open={open} me={me} />
          </div>

          <section className="settle">
            <h2>{s.settleH}</h2>
            <p>
              {m.status === "Settling"
                ? s.settleVal(fmtUnits(m.tokensPerUnit), m.tokenSymbol, dateKst(m.deliverBy, lang))
                : m.status === "Voided"
                  ? s.voided
                  : s.settlePending}
            </p>
          </section>

          <section className="rules" aria-labelledby="jg-how">
            <h2 id="jg-how">{s.howH}</h2>
            <ol className="docs__steps">
              {s.how.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ol>
          </section>
        </section>

        <aside className="panel">
          {open ? <PostForm m={m} addr={addr} s={s} /> : <p>{s.closedTrading}</p>}

          {myOffers.length > 0 && (
            <div className="position">
              <h2>{s.myOffers}</h2>
              <ul className="myoffers">
                {myOffers.map((o) => (
                  <li key={o.id}>
                    <span className={o.side === "Buy" ? "is-bid" : "is-ask"}>{o.side === "Buy" ? s.sideBuy : s.sideSell}</span>
                    <span>
                      {fmtUnits(o.left)} × {won(o.price)}
                    </span>
                    <button className="btn btn--quiet" onClick={() => void run(s.cancelling, s.cancelled, (w) => jangoe.cancel(w, addr, o.id))}>
                      {s.cancel}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {trades.length > 0 && (
            <div className="position">
              <h2>{s.myTrades}</h2>
              <table className="jgtrades">
                <thead>
                  <tr>
                    <th scope="col">{s.role}</th>
                    <th scope="col" className="num">{s.units}</th>
                    <th scope="col" className="num">{s.paid}</th>
                    <th scope="col">{s.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((x) => (
                    <tr key={x.id}>
                      <td>{x.buyer.toLowerCase() === me ? s.roleBuyer : s.roleSeller}</td>
                      <td className="num">{fmtUnits(x.units)}</td>
                      <td className="num">{won(x.paid)}</td>
                      <td>{s.st[x.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {toDeliver.length > 0 && (
                <button
                  className="btn btn--gold btn--wide"
                  onClick={() => void run(s.delivering2, s.deliveredOk, (w) => jangoe.deliver(w, addr, m, toDeliver))}
                >
                  {s.deliverAll(toDeliver.length, fmtUnits(toDeliver.reduce((a, x) => a + tokensFor(m, x.units), 0n)), m.tokenSymbol)}
                </button>
              )}
              {toClaim.length > 0 && (
                <button className="btn btn--gold btn--wide" onClick={() => void run(s.claiming, s.claimed, (w) => jangoe.claimDefault(w, addr, toClaim))}>
                  {s.claimDefault(toClaim.length)}
                </button>
              )}
              {toRefund.length > 0 && (
                <button className="btn btn--line btn--wide" onClick={() => void run(s.refunding, s.refunded, (w) => jangoe.refund(w, addr, toRefund))}>
                  {s.refundAll(toRefund.length)}
                </button>
              )}
            </div>
          )}

          <p className="form__note">
            <a href={`${explorer}/address/${addr}`} target="_blank" rel="noreferrer">{s.contract}</a>
          </p>
        </aside>
      </div>
    </main>
  );
}

type Records = Record<string, { delivered: number; defaulted: number }>;

function BookSide(props: {
  title: string;
  side: Side;
  rows: JgOffer[];
  m: JgMarket;
  addr: Address;
  records: Records;
  s: Dict["jg"];
  open: boolean;
  me: string | undefined;
}) {
  const { title, side, rows, m, addr, records, s, open, me } = props;
  const [taking, setTaking] = useState<number | null>(null);
  // Asks read top-down from the highest, so the best price sits next to the spread.
  const shown = side === "Sell" ? [...rows].slice(0, 12).reverse() : rows.slice(0, 12);
  const max = rows.reduce((a, o) => (o.left > a ? o.left : a), 1n);
  return (
    <div className={`bookside bookside--${side === "Buy" ? "bid" : "ask"}`}>
      <p className="bookside__title">{title}</p>
      {shown.length === 0 && <p className="empty">{s.emptySide}</p>}
      <ul>
        {shown.map((o) => {
          const rec = records[o.maker.toLowerCase()];
          const mineRow = o.maker.toLowerCase() === me;
          return (
            <li key={o.id}>
              <div className="bookrow">
                <i className="bookrow__depth" style={{ width: `${Number((o.left * 100n) / max)}%` }} aria-hidden />
                <span className="bookrow__price">{won(o.price)}</span>
                <span className="bookrow__units">{fmtUnits(o.left)}</span>
                <span className="bookrow__maker">
                  {shortAddr(o.maker)}
                  {side === "Sell" && rec && <small>{s.record(rec.delivered, rec.defaulted)}</small>}
                </span>
                {mineRow ? (
                  <span className="bookrow__yours">{s.yours}</span>
                ) : (
                  open &&
                  me && (
                    <button className="btn btn--line bookrow__take" onClick={() => setTaking(taking === o.id ? null : o.id)} aria-expanded={taking === o.id}>
                      {s.take}
                    </button>
                  )
                )}
              </div>
              {taking === o.id && <TakeForm o={o} m={m} addr={addr} s={s} onDone={() => setTaking(null)} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TakeForm({ o, m, addr, s, onDone }: { o: JgOffer; m: JgMarket; addr: Address; s: Dict["jg"]; onDone: () => void }) {
  const { run } = useApp();
  const [units, setUnits] = useState(fmtUnits(o.left).replace(/,/g, ""));
  const u = safeUnits(units);
  const valid = u > 0n && u <= o.left;
  const v = valueOf(u, o.price);
  return (
    <form
      className="takeform"
      onSubmit={(e) => {
        e.preventDefault();
        void run(s.taking, s.taken, (w) => jangoe.fill(w, addr, m, o, u)).then((ok) => ok && onDone());
      }}
    >
      <input inputMode="decimal" value={units} onChange={(e) => setUnits(dec(e.target.value))} aria-label={s.units} aria-invalid={!valid} />
      <button className="btn btn--ink" disabled={!valid}>
        {o.side === "Sell" ? s.takeBuy(fmtUnits(u), won(v)) : s.takeSell(fmtUnits(u), won(collateralOf(m, v)))}
      </button>
    </form>
  );
}

function PostForm({ m, addr, s }: { m: JgMarket; addr: Address; s: Dict["jg"] }) {
  const { account, run } = useApp();
  const [side, setSide] = useState<Side>("Buy");
  const [units, setUnits] = useState("100");
  const [price, setPrice] = useState("");
  const u = safeUnits(units);
  const p = safeUnits(price);
  const v = valueOf(u, p);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(s.posting, s.posted, (w) => jangoe.post(w, addr, m, side, units, price)).then((ok) => ok && setPrice(""));
      }}
    >
      <h2>{s.postH}</h2>
      <fieldset className="segmented segmented--book">
        {(["Buy", "Sell"] as const).map((k) => (
          <label key={k} className={`${side === k ? "is-on" : ""} ${k === "Buy" ? "is-bid" : "is-ask"}`}>
            <input type="radio" name="jgside" checked={side === k} onChange={() => setSide(k)} />
            {k === "Buy" ? s.sideBuy : s.sideSell}
          </label>
        ))}
      </fieldset>
      <label>
        <span>{s.postUnits}</span>
        <input inputMode="decimal" value={units} onChange={(e) => setUnits(dec(e.target.value))} />
      </label>
      <label>
        <span>{s.postPrice("tKRW")}</span>
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(dec(e.target.value))} placeholder="1000" />
      </label>
      {v > 0n && <p className="form__note">{side === "Buy" ? s.lockBuy(won(v)) : s.lockSell(won(collateralOf(m, v)), m.collateralBps / 100)}</p>}
      <button className="btn btn--ink btn--wide" disabled={!account || v === 0n}>
        {account ? s.post : s.connect}
      </button>
    </form>
  );
}
