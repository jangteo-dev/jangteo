import { useState } from "react";
import { formatEther } from "viem";
import { useApp, useChain } from "../app";
import { countdown, useLang } from "../i18n";
import { fmtWon, loadBoard, readWallet, stockName, stocks } from "../lib/stocks";
import { Mono } from "./StockBoard";

const wonInput = (v: string) => v.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "").slice(0, 13);

/** JSLP value over time as a small line, no library: the history is short and only needs a shape. */
function Spark({ points }: { points: { t: number; price: number }[] }) {
  if (points.length < 2) return null;
  const w = 600;
  const h = 140;
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.price);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (y1 - y0 < 1e-9) [y0, y1] = [y0 * 0.999, y1 * 1.001];
  const d = points.map((p, i) => `${i ? "L" : "M"}${(((p.t - x0) / (x1 - x0 || 1)) * w).toFixed(1)},${(h - ((p.price - y0) / (y1 - y0)) * (h - 12) - 6).toFixed(1)}`).join(" ");
  return (
    <svg className="skspark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="JSLP">
      <path d={`${d} L${w},${h} L0,${h} Z`} className="skspark__fill" />
      <path d={d} className="skspark__line" />
    </svg>
  );
}

export function StockPool() {
  const { deployment, account, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.sk;
  const ex = deployment?.stocks;
  const tkrw = deployment?.tkrw;
  const { data: b, error } = useChain(() => loadBoard(), []);
  const { data: w } = useChain(async () => (ex && tkrw && account && b ? readWallet(ex, tkrw, b.markets, account) : null), [ex, account, b?.updatedAt, tick]);
  const [krw, setKrw] = useState("100000");

  if (deployment && !ex) return <main className="page"><p className="empty">{s.notDeployed}</p></main>;
  if (error && !b) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;
  if (!b || !ex || !tkrw) return <main className="page"><p className="empty">{s.loading}</p></main>;

  const v = b.vault;
  const lp = w?.lp ?? 0n;
  const lpNum = Number(formatEther(lp));
  const lpValue = lpNum * v.lpPrice;
  const locked = w ? w.lockedUntil > Date.now() / 1000 : false;
  const depOk = Number(krw || 0) >= 1000 && (w ? w.krw >= BigInt(krw || 0) * 10n ** 18n : true);
  const cash = v.cash || 1;

  return (
    <main className="page listing sk">
      <a className="back" href="#/stocks">{s.back}</a>
      <header className="listings__head">
        <p className="listings__ko" lang="ko">주식 금고</p>
        <h1>{s.poolH}</h1>
        <p className="lede">{s.poolLede}</p>
      </header>

      <div className="listing__body">
        <section className="listing__main">
          <dl className="propfacts">
            <div>
              <dt>{s.nav}</dt>
              <dd>{fmtWon(v.nav)}</dd>
            </div>
            <div>
              <dt>{s.lpPrice}</dt>
              <dd>{fmtWon(v.lpPrice, 4)}</dd>
            </div>
            <div>
              <dt>{s.apr}</dt>
              <dd>{v.apr.toFixed(2)}%</dd>
            </div>
            <div>
              <dt>{s.fees7}</dt>
              <dd>{fmtWon(v.fees7d)}</dd>
            </div>
            <div>
              <dt>{s.util}</dt>
              <dd>
                {fmtWon(v.liability)}
                <small>{s.utilOf((v.utilisation * 100).toFixed(1))}</small>
              </dd>
            </div>
          </dl>

          <section className="settle">
            <h2>{s.historyH}</h2>
            <Spark points={v.history} />
          </section>

          <section aria-labelledby="sk-exp">
            <h2 id="sk-exp">{s.exposureH}</h2>
            <p className="form__note">{s.exposureNote}</p>
            <ul className="skexp">
              {b.markets.map((m) => {
                const pct = (m.exposure / cash) * 100;
                return (
                  <li key={m.sym}>
                    <a href={`#/stocks/${m.sym}`}>
                      <Mono r={m} />
                      <span>{stockName(m, lang)}</span>
                    </a>
                    <span className="skexp__bar" role="img" aria-label={`${pct.toFixed(1)}%`}>
                      <i style={{ width: `${Math.min(100, (pct / 25) * 100)}%` }} />
                    </span>
                    <span className="num">{pct.toFixed(1)}%</span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="rules" aria-labelledby="sk-risk">
            <h2 id="sk-risk">{s.riskH}</h2>
            <ul className="docs__steps">
              {s.risk.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </section>
        </section>

        <aside className="panel">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (depOk) void run(s.depositing, s.deposited, (wl) => stocks.deposit(wl, ex, tkrw, krw));
            }}
          >
            <h2>{s.depositH}</h2>
            <label>
              <span>{s.amountWon}</span>
              <input inputMode="numeric" value={krw} onChange={(e) => setKrw(wonInput(e.target.value))} aria-invalid={!depOk} />
            </label>
            <p className="form__note">{s.depositNote}</p>
            <button className="btn btn--ink btn--wide" disabled={!account || !depOk}>
              {account ? s.depositBtn : s.connect}
            </button>
          </form>

          {account && (
            <div className="position">
              <h2>{s.yourLp}</h2>
              <p>
                <b>{lpNum.toLocaleString("en-US", { maximumFractionDigits: 4 })} JSLP</b> · {s.yourLpValue(fmtWon(lpValue))}
              </p>
              {lp > 0n && (
                <>
                  <p className="form__note">{s.withdrawNote}</p>
                  {locked && <p className="form__note form__note--warn">{s.lockedTill(countdown(w!.lockedUntil, lang))}</p>}
                  <button
                    className="btn btn--line btn--wide"
                    disabled={locked}
                    onClick={() => void run(s.withdrawing, s.withdrawn, (wl) => stocks.withdraw(wl, ex, lp))}
                  >
                    {s.withdrawBtn(fmtWon(lpValue * 0.997))}
                  </button>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
