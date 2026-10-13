import { useState } from "react";
import { useApp, useChain } from "../app";
import { countdown, useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { fmtPctSigned, fmtUsd, fmtWon, loadBoard, nextOpen, stockName, tone, type Board, type StockRow, type TapeRow } from "../lib/stocks";
import { shortAddr } from "../lib/chain";

export function marketState(rows: StockRow[], region: 0 | 1, s: Dict["sk"], lang: "en" | "ko") {
  const list = rows.filter((r) => r.region === region);
  if (list.some((r) => r.tradable)) return { open: true, text: s.open };
  if (list.some((r) => r.open)) return { open: false, text: s.stale };
  return { open: false, text: `${s.closed} · ${s.opensIn(countdown(nextOpen(region), lang))}` };
}

export function Mono({ r }: { r: Pick<StockRow, "ticker" | "region"> }) {
  return (
    <span className={`skmono skmono--${r.region === 0 ? "kr" : "us"}`} aria-hidden>
      {r.ticker.replace(/^j/, "").slice(0, 2)}
    </span>
  );
}

export function StockBoard() {
  const { deployment } = useApp();
  const { t, lang } = useLang();
  const s = t.sk;
  const { data, error } = useChain(() => loadBoard(), []);
  const [tab, setTab] = useState<0 | 1 | null>(null);

  if (deployment && !deployment.stocks) return <main className="page"><p className="empty">{s.notDeployed}</p></main>;
  if (error && !data) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;

  const kr = data ? marketState(data.markets, 0, s, lang) : null;
  const us = data ? marketState(data.markets, 1, s, lang) : null;
  // Open on whichever market is trading; Korea first otherwise.
  const region: 0 | 1 = tab ?? (us?.open && !kr?.open ? 1 : 0);
  const rows = (data?.markets ?? []).filter((r) => r.region === region);
  const state = region === 0 ? kr : us;

  return (
    <main className="page listings sk">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">주식</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
        <div className="skcta">
          <span className="prop__badge">{s.simulated}</span>
          <a className="btn btn--line" href="#/stocks/pool">{s.poolCta}</a>
        </div>
      </header>

      <div className="sktabs" role="tablist">
        {([0, 1] as const).map((r) => {
          const st = r === 0 ? kr : us;
          return (
            <button key={r} role="tab" aria-selected={region === r} onClick={() => setTab(r)}>
              <b>{r === 0 ? s.korea : s.us}</b>
              {st && <small className={st.open ? "skdot skdot--on" : "skdot"}>{st.open ? s.open : s.closed}</small>}
            </button>
          );
        })}
      </div>
      <p className="form__note">
        {region === 0 ? s.koreaHours : s.usHours}
        {state && !state.open && ` · ${state.text}`}
      </p>

      {!data && <p className="empty">{s.loading}</p>}
      {data && (
        <table className="sktable">
          <thead>
            <tr>
              <th scope="col">{s.colStock}</th>
              <th scope="col" className="num">{s.colPrice}</th>
              <th scope="col" className="num">{s.colChange}</th>
              <th scope="col" className="num sktable__vol">{s.colVol}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sym} onClick={() => (location.hash = `#/stocks/${r.sym}`)}>
                <td>
                  <a className="skname" href={`#/stocks/${r.sym}`}>
                    <Mono r={r} />
                    <span>
                      <b>{stockName(r, lang)}</b>
                      <small>
                        {r.sym} · {r.ticker}
                        {!r.tradable && <i className="skclosed">{r.open ? s.stale : s.closed}</i>}
                      </small>
                    </span>
                  </a>
                </td>
                <td className="num">
                  <b>{fmtWon(r.price)}</b>
                  {r.region === 1 && r.local > 0 && <small>{fmtUsd(r.local)}</small>}
                </td>
                <td className={`num ${tone(r.changePct)}`}>{fmtPctSigned(r.changePct)}</td>
                <td className="num sktable__vol">{fmtWon(r.vol24)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && <VaultStrip b={data} s={s} />}
      {data && <Tape rows={data.tape} s={s} lang={lang} names={data.markets} />}
    </main>
  );
}

function VaultStrip({ b, s }: { b: Board; s: Dict["sk"] }) {
  return (
    <a className="skvault" href="#/stocks/pool">
      <span>
        <small>{s.nav}</small>
        <b>{fmtWon(b.vault.nav)}</b>
      </span>
      <span>
        <small>{s.lpPrice}</small>
        <b>{fmtWon(b.vault.lpPrice, 4)}</b>
      </span>
      <span>
        <small>{s.apr}</small>
        <b>{b.vault.apr.toFixed(2)}%</b>
      </span>
      <span>
        <small>{s.util}</small>
        <b>{(b.vault.utilisation * 100).toFixed(1)}%</b>
      </span>
    </a>
  );
}

export function Tape({ rows, s, lang, names }: { rows: TapeRow[]; s: Dict["sk"]; lang: "en" | "ko"; names?: StockRow[] }) {
  const nameOf = (sym?: string) => {
    const r = names?.find((x) => x.sym === sym);
    return r ? stockName(r, lang) : sym;
  };
  return (
    <section className="sktape" aria-labelledby="sk-tape">
      <h2 id="sk-tape">{s.tapeH}</h2>
      {rows.length === 0 && <p className="empty">{s.tapeEmpty}</p>}
      <ul>
        {rows.map((r) => (
          <li key={r.tx + r.side + r.who}>
            <span className={r.side === "buy" ? "is-up" : "is-down"}>{r.side === "buy" ? s.sideBuy : s.sideSell}</span>
            {names && <span>{nameOf(r.sym)}</span>}
            <span className="num">{fmtWon(r.krw)}</span>
            <span className="num">{fmtWon(r.price)}</span>
            <span className="sktape__who">{shortAddr(r.who as `0x${string}`)}</span>
            <time>{new Date(r.t * 1000).toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" })}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
