import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useApp, useChain } from "../app";
import { Odds } from "../components/Odds";
import { countdown, dateKst, useLang } from "../i18n";
import { explorer } from "../lib/chain";
import { won } from "../lib/gye";
import { multiple, readMarket, readPosition, sangjang, UPBIT_NOTICES } from "../lib/sangjang";
import { outcomeLine } from "./Listings";

export function ListingPage({ id }: { id: number }) {
  const { deployment, account, run } = useApp();
  const { t, lang } = useLang();
  const s = t.market;
  const addr = deployment?.sangjang;
  const { data, error } = useChain(async () => (addr ? readMarket(addr, id) : null), [addr, id]);
  const { data: pos } = useChain(async () => (addr && account ? readPosition(addr, id, account) : null), [addr, id, account]);
  const [side, setSide] = useState<boolean>(true);
  const [amount, setAmount] = useState("");

  if (error) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;
  if (!data || !addr || !deployment) return <main className="page"><p className="empty">{s.loading}</p></main>;
  const { market: m, window, feeBps, bond } = data;
  const now = Date.now() / 1000;
  const bettable = m.status === "Open" && m.closesAt > now;
  const amt = amount ? parseUnits(amount, 18) : 0n;
  const mult = multiple(m, side, feeBps, amt);
  const room = pos ? m.cap - pos.staked : m.cap;
  const estReturn = amt > 0n && mult ? BigInt(Math.floor(Number(formatUnits(amt, 18)) * mult)) * 10n ** 18n : 0n;

  return (
    <main className="page listing">
      <a className="back" href="#/listings">{s.back}</a>
      <header className="listing__head">
        <h1 className="listing__sym">{m.symbol}</h1>
        <p className="listing__q">{s.question(m.symbol, dateKst(m.closesAt, lang))}</p>
        <p className="circle__status">{outcomeLine(m, t, lang)}</p>
      </header>

      <div className="listing__body">
        <section className="listing__main">
          <Odds yesPool={m.yesPool} noPool={m.noPool} size="lg" />
          <dl className="figures">
            <div><dt>{s.onYes}</dt><dd>{won(m.yesPool)}</dd></div>
            <div><dt>{s.onNo}</dt><dd>{won(m.noPool)}</dd></div>
            <div><dt>{s.cap}</dt><dd>{won(m.cap)}</dd></div>
            <div><dt>{s.fee}</dt><dd>{feeBps / 100}%</dd></div>
          </dl>

          <section className="rules" aria-labelledby="rules-h">
            <h2 id="rules-h">{s.rulesH}</h2>
            <p>{s.rules1(m.symbol)}</p>
            <p>
              {s.rules2a}{" "}
              <a href={UPBIT_NOTICES} target="_blank" rel="noreferrer">{s.rules2link}</a>
              {s.rules2b(Math.round(window / 60), won(bond))}
            </p>
          </section>
        </section>

        <aside className="panel">
          {bettable && (
            <form
              className="betform"
              onSubmit={(e) => {
                e.preventDefault();
                void run(s.betting(won(amt), side), s.betPlaced(side), (w) => sangjang.bet(w, addr, deployment.tkrw, id, side, amount)).then(
                  (ok) => ok && setAmount(""),
                );
              }}
            >
              <div className="sides" role="radiogroup" aria-label={s.sideAria}>
                <button type="button" role="radio" aria-checked={side} className={`side side--yes ${side ? "is-on" : ""}`} onClick={() => setSide(true)}>
                  {s.yesSide}
                </button>
                <button type="button" role="radio" aria-checked={!side} className={`side side--no ${!side ? "is-on" : ""}`} onClick={() => setSide(false)}>
                  {s.noSide}
                </button>
              </div>
              <label>
                <span>{s.amount(won(room))}</span>
                <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} placeholder="100000" />
              </label>
              <p className="betform__est">{estReturn > 0n ? s.est(side, won(amt), won(estReturn)) : s.estNone}</p>
              <button className="btn btn--ink btn--wide" disabled={!account || amt === 0n || amt > room}>
                {account ? s.bet(side) : s.connect}
              </button>
            </form>
          )}
          {!bettable && m.status === "Open" && <p className="seat">{s.closed}</p>}

          {pos && pos.bets.length > 0 && (
            <div className="position">
              <h2>{s.yourBets}</h2>
              <p>{[pos.yesStake > 0n && s.onYesAmt(won(pos.yesStake)), pos.noStake > 0n && s.onNoAmt(won(pos.noStake))].filter(Boolean).join(", ")}</p>
              {pos.claimable > 0n && (
                <button className="btn btn--gold btn--wide" onClick={() => void run(t.circle.collecting, t.circle.collected, (w) => sangjang.claim(w, addr, id))}>
                  {t.circle.collect(won(pos.claimable))}
                </button>
              )}
              {pos.claimed && <p>{t.circle.collected}</p>}
            </div>
          )}

          {m.status === "Proposed" && (
            <div className="resolution">
              <p>{s.proposed(m.yes, dateKst(m.announcedAt, lang), countdown(m.proposedAt + window, lang))}</p>
              {now < m.proposedAt + window ? (
                account && (
                  <button className="btn btn--line btn--wide" onClick={() => void run(s.disputing, s.disputed, (w) => sangjang.dispute(w, addr, deployment.tkrw, id, bond))}>
                    {s.dispute(won(bond))}
                  </button>
                )
              ) : (
                <button className="btn btn--line btn--wide" onClick={() => void run(s.finalizing, s.finalized, (w) => sangjang.finalize(w, addr, id))}>
                  {s.finalize}
                </button>
              )}
            </div>
          )}
          {m.status === "Resolved" && m.yes && <p className="resolution">{s.noticeAt(dateKst(m.announcedAt, lang))}</p>}
          <p className="form__note">
            <a href={`${explorer}/address/${addr}`} target="_blank" rel="noreferrer">{s.contract}</a>
          </p>
        </aside>
      </div>
    </main>
  );
}
