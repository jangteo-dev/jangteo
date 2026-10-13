import { useState } from "react";
import { formatEther, parseEther, type Address } from "viem";
import { useApp, useChain } from "../app";
import { StockChart } from "../components/StockChart";
import { VerifyNow } from "../components/VerifyNow";
import { countdown, useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import {
  fmtPctSigned,
  fmtShares,
  fmtUsd,
  fmtWon,
  loadBoard,
  loadHistory,
  nextOpen,
  readWallet,
  stockName,
  stocks,
  tone,
  type Board,
  type StockRow,
} from "../lib/stocks";
import { Mono, Tape } from "./StockBoard";

type Positions = { wallets: Record<string, Record<string, { shares: number; cost: number }>> };

/** Whole won only for amounts; shares may be fractional (up to 6 places). */
const wonInput = (v: string) => v.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "").slice(0, 13);
const shareInput = (v: string) => {
  const x = v.replace(/[^\d.]/g, "");
  const [a, b] = x.split(".");
  return b === undefined ? a.slice(0, 9) : `${a.slice(0, 9)}.${b.slice(0, 6)}`;
};

export function StockPage({ sym }: { sym: string }) {
  const { deployment, account, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.sk;
  const ex = deployment?.stocks;
  const { data: board, error } = useChain(() => loadBoard(), []);
  const { data: history } = useChain(() => loadHistory(sym), [sym]);
  const r = board?.markets.find((m) => m.sym === sym);
  const { data: wallet } = useChain(
    async () => (ex && deployment?.tkrw && account && board ? readWallet(ex, deployment.tkrw, board.markets, account) : null),
    [ex, account, board?.updatedAt, tick],
  );
  const { data: pos } = useChain(async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}stocks/wallets.json`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Positions) : null;
  }, [tick]);

  if (error && !board) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;
  if (!board || !r || !ex || !deployment?.tkrw) return <main className="page"><p className="empty">{s.loading}</p></main>;

  const held = wallet?.holdings[sym] ?? 0n;
  const heldNum = Number(formatEther(held));
  const mine = account ? pos?.wallets[account.toLowerCase()]?.[sym] : undefined;
  const value = heldNum * r.price;
  const avg = mine && mine.shares > 0 ? mine.cost / mine.shares : 0;
  // Cost basis covers only shares bought here; tokens received from elsewhere have none.
  const costKnown = mine && Math.abs(mine.shares - heldNum) / Math.max(heldNum, 1e-9) < 0.001;
  const pnl = costKnown ? value - mine!.cost : 0;

  return (
    <main className="page listing sk">
      <a className="back" href="#/stocks">{s.back}</a>
      <header className="skhead">
        <Mono r={r} />
        <div>
          <p className="prop__badges">
            <span className="prop__badge">{r.region === 0 ? s.korea : s.us}</span>
            <span className="prop__badge">{s.simulated}</span>
          </p>
          <h1 className="listing__sym">{stockName(r, lang)}</h1>
          <p className="listing__q">
            {r.sym} · {r.ticker}
          </p>
        </div>
        <div className="skhead__px">
          <b>{fmtWon(r.price)}</b>
          <span className={tone(r.changePct)}>{fmtPctSigned(r.changePct)}</span>
          {r.region === 1 && r.local > 0 && <small>{fmtUsd(r.local)} · ₩{board.fx.toFixed(1)}/$</small>}
          <small className={r.tradable ? "skdot skdot--on" : "skdot"}>
            {r.tradable ? s.open : r.open ? s.stale : `${s.closed} · ${s.opensIn(countdown(nextOpen(r.region), lang))}`}
          </small>
        </div>
      </header>

      <div className="listing__body">
        <section className="listing__main">
          <StockChart
            history={history}
            livePrice={r.price}
            tape={history?.tape ?? []}
            title={`${r.ticker} / ₩`}
            labels={{ frames: s.frames, empty: s.chartEmpty, buy: s.sideBuy, sell: s.sideSell, dailyNote: s.dailyNote }}
          />
          <Tape rows={history?.tape ?? []} s={s} lang={lang} />
          <section className="rules" aria-labelledby="sk-about">
            <h2 id="sk-about">{s.aboutH}</h2>
            <ol className="docs__steps">
              {s.about.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ol>
          </section>
        </section>

        <aside className="panel">
          <Ticket r={r} board={board} ex={ex} tkrw={deployment.tkrw} held={held} s={s} lang={lang} />
          {account && (
            <div className="position">
              <h2>{s.posH}</h2>
              {held === 0n ? (
                <p>{s.posNone}</p>
              ) : (
                <dl className="propfacts propfacts--small">
                  <div>
                    <dt>{s.posShares}</dt>
                    <dd>{fmtShares(heldNum)}</dd>
                  </div>
                  <div>
                    <dt>{s.posValue}</dt>
                    <dd>{fmtWon(value)}</dd>
                  </div>
                  {costKnown && (
                    <>
                      <div>
                        <dt>{s.posCost}</dt>
                        <dd>{fmtWon(avg)}</dd>
                      </div>
                      <div>
                        <dt>{s.posPnl}</dt>
                        <dd className={tone(pnl)}>
                          {pnl >= 0 ? "+" : "−"}
                          {fmtWon(Math.abs(pnl))}
                          <small>{fmtPctSigned(mine!.cost ? (pnl / mine!.cost) * 100 : 0)}</small>
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function Ticket({ r, board, ex, tkrw, held, s, lang }: { r: StockRow; board: Board; ex: Address; tkrw: Address; held: bigint; s: Dict["sk"]; lang: "en" | "ko" }) {
  const { account, run } = useApp();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [krw, setKrw] = useState("100000");
  const [qty, setQty] = useState("");
  const fee = board.tradeBps / 10_000;
  const krwN = Number(krw || 0);
  let sharesWei = 0n;
  try {
    sharesWei = qty ? parseEther(qty) : 0n;
  } catch {
    sharesWei = 0n;
  }
  const sharesN = Number(formatEther(sharesWei));
  const estShares = r.price ? (krwN * (1 - fee)) / r.price : 0;
  const estKrw = sharesN * r.price * (1 - fee);
  const buyOk = krwN >= 1000 && krwN <= r.buyRoom && !r.buyPaused;
  const sellOk = sharesWei > 0n && sharesWei <= held;
  const closedText = r.open ? s.staleNote : s.closedNote(countdown(nextOpen(r.region), lang));

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!r.tradable) return;
        if (side === "buy" && buyOk) void run(s.buying, s.bought, (w) => stocks.buy(w, ex, tkrw, r.sym, krw, board.tradeBps));
        if (side === "sell" && sellOk) void run(s.selling, s.sold, (w) => stocks.sell(w, ex, r.sym, sharesWei, board.tradeBps)).then((ok) => ok && setQty(""));
      }}
    >
      <fieldset className="segmented segmented--book">
        {(["buy", "sell"] as const).map((k) => (
          <label key={k} className={`${side === k ? "is-on" : ""} ${k === "buy" ? "is-bid" : "is-ask"}`}>
            <input type="radio" name="skside" checked={side === k} onChange={() => setSide(k)} />
            {k === "buy" ? s.ticketBuy : s.ticketSell}
          </label>
        ))}
      </fieldset>
      {side === "buy" ? (
        <label>
          <span>{s.amountWon}</span>
          <input inputMode="numeric" value={krw} onChange={(e) => setKrw(wonInput(e.target.value))} aria-invalid={!buyOk} />
        </label>
      ) : (
        <div className="sklabel">
          <label htmlFor="sk-qty">{s.amountShares}</label>
          <button type="button" className="linkbtn" onClick={() => setQty(formatEther(held))} disabled={held === 0n}>
            {s.max}
          </button>
          <input id="sk-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(shareInput(e.target.value))} aria-invalid={qty !== "" && !sellOk} />
        </div>
      )}
      <p className="form__note">
        {side === "buy" ? s.youGet(`${fmtShares(estShares)} ${r.ticker}`) : s.youGet(fmtWon(estKrw))} · {s.fee((board.tradeBps / 100).toFixed(1))}
      </p>
      {side === "buy" && r.tradable && <p className="form__note">{s.roomNote(fmtWon(r.buyRoom))}</p>}
      {!r.tradable && <p className="form__note form__note--warn">{closedText}</p>}
      {side === "buy" && <VerifyNow reason={s.needVerify} />}
      <button
        className={`btn btn--wide ${side === "buy" ? "btn--hong" : "btn--jjok"}`}
        disabled={!account || !r.tradable || (side === "buy" ? !buyOk : !sellOk)}
      >
        {!account ? s.connect : side === "buy" ? s.buyBtn(fmtWon(krwN)) : s.sellBtn(`${fmtShares(sharesN)} ${r.ticker}`)}
      </button>
    </form>
  );
}
