import { useState } from "react";
import { parseUnits, type Address } from "viem";
import { useApp, useChain } from "../app";
import { Bojagi } from "../components/Bojagi";
import { countdown, durationLabel, useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { explorer, shortAddr } from "../lib/chain";
import { actions, MODE_KO, paidRound, readCircle, readRecord, won, type Circle, type Member } from "../lib/gye";
import { seatsOf } from "../lib/seats";

export function CirclePage({ address }: { address: Address }) {
  const { account, deployment } = useApp();
  const { t, lang } = useLang();
  const s = t.circle;
  const { data: c, error } = useChain(() => readCircle(address), [address]);
  if (error) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;
  if (!c) return <main className="page"><p className="empty">{s.loading}</p></main>;

  const me = account ? c.members.find((m) => m.address.toLowerCase() === account.toLowerCase()) : undefined;
  const pot = c.contribution * BigInt(c.size);
  const collectedPct = c.phase === "Active" ? Number((c.roundCollected * 100n) / pot) : 0;
  const name = c.name || t.gye.untitled;

  return (
    <main className="page circle">
      <a className="back" href="#/gye">{s.back}</a>
      <header className="circle__head">
        <h1>{name}</h1>
        <p className="circle__status">{statusLine(c, t, lang)}</p>
      </header>

      <div className="circle__body">
        <figure className="circle__cloth">
          <Bojagi seed={c.address} size={c.size} seats={seatsOf(c, t, account)} animate title={s.seating(name)} />
          <figcaption className="legend">
            <span><i className="sw sw--paid" /> {s.legendPaid}</span>
            <span><i className="sw sw--waiting" /> {s.legendWaiting}</span>
            <span><i className="sw sw--knot" /> {s.legendKnot}</span>
            <span><i className="sw sw--open" /> {s.legendOpen}</span>
          </figcaption>
        </figure>

        <aside className="panel">
          <YourSeat c={c} me={me} />
          {c.phase === "Active" && (
            <div className="meter" aria-label={s.potAria}>
              <div className="meter__nums">
                <span>{s.potLabel}</span>
                <span>{s.potOf(won(c.roundCollected), won(pot))}</span>
              </div>
              <div className="meter__bar"><i style={{ width: `${collectedPct}%` }} /></div>
            </div>
          )}
          {c.phase === "Active" && c.mode === "Auction" && <Auction c={c} me={me} />}
          {deployment && me && <Credit me={me} c={c} />}
        </aside>
      </div>

      <section className="terms" aria-labelledby="terms-h">
        <h2 id="terms-h">{s.termsH}</h2>
        <dl>
          <div><dt>{s.tEach}</dt><dd>{won(c.contribution)}</dd></div>
          <div><dt>{s.tMembers}</dt><dd>{c.size}</dd></div>
          <div><dt>{s.tLength}</dt><dd>{durationLabel(c.roundDuration, lang)}</dd></div>
          <div><dt>{s.tPot}</dt><dd>{won(pot)}</dd></div>
          <div>
            <dt>{s.tWho}</dt>
            <dd><span lang="ko">{MODE_KO[c.mode]}</span> {t.modes[c.mode].body}</dd>
          </div>
          {c.mode === "Auction" && <div><dt>{s.tDiscount}</dt><dd>{s.tDiscountVal(c.maxDiscountBps / 100)}</dd></div>}
          {c.feeBps > 0 && <div><dt>{s.tFee}</dt><dd>{s.tFeeVal(c.feeBps / 100)}</dd></div>}
          <div><dt>{s.tCollateral}</dt><dd>{s.tCollateralVal}</dd></div>
        </dl>
      </section>

      <section className="members" aria-labelledby="members-h">
        <h2 id="members-h">{s.membersH}</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">{s.colMember}</th>
              <th scope="col">{s.colRound}</th>
              <th scope="col">{s.colPot}</th>
              <th scope="col" className="num">{s.colHeld}</th>
              <th scope="col" className="num">{s.colOwes}</th>
            </tr>
          </thead>
          <tbody>
            {c.members.map((m) => (
              <tr key={m.address} className={m.address.toLowerCase() === account?.toLowerCase() ? "is-you" : undefined}>
                <td>
                  <a href={`${explorer}/address/${m.address}`} target="_blank" rel="noreferrer">{shortAddr(m.address)}</a>
                  {m.address.toLowerCase() === account?.toLowerCase() && <span className="you">{s.you}</span>}
                  {m.address === c.creator && <span className="tag">{s.startedIt}</span>}
                </td>
                <td>{c.phase !== "Active" ? "" : m.defaulted ? s.defaulted : paidRound(m, c.round) ? s.paid : s.waiting}</td>
                <td>{m.received ? s.roundN(m.receivedRound) : ""}</td>
                <td className="num">{m.escrow ? won(m.escrow) : ""}</td>
                <td className="num">{m.debt ? won(m.debt) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function statusLine(c: Circle, t: Dict, lang: "en" | "ko") {
  const s = t.circle;
  switch (c.phase) {
    case "Filling":
      return s.stFilling(c.size - c.members.length, countdown(c.fillDeadline, lang));
    case "Active":
      return Date.now() / 1000 >= c.deadline ? s.stSettling(c.round, c.size) : s.stActive(c.round, c.size, countdown(c.deadline, lang));
    case "Completed":
      return s.stDone;
    default:
      return s.stCancelled;
  }
}

function YourSeat({ c, me }: { c: Circle; me?: Member }) {
  const { account, run } = useApp();
  const { t } = useLang();
  const s = t.circle;
  if (!account) return <div className="seat"><p>{s.connectToJoin}</p></div>;

  if (!me) {
    if (c.phase !== "Filling") return <div className="seat"><p>{s.notIn}</p></div>;
    return (
      <div className="seat">
        <p>{s.joinWhy}</p>
        <button className="btn btn--ink btn--wide" onClick={() => void run(s.joining, s.joined, (w) => actions.join(w, c))}>
          {s.join(won(c.contribution))}
        </button>
      </div>
    );
  }

  const paid = paidRound(me, c.round);
  return (
    <div className="seat">
      {me.claimable > 0n && (
        <button className="btn btn--gold btn--wide" onClick={() => void run(s.collecting, s.collected, (w) => actions.claim(w, c))}>
          {s.collect(won(me.claimable))}
        </button>
      )}
      {c.phase === "Filling" && (
        <>
          <p>{s.seated(c.size)}</p>
          <button className="btn btn--line btn--wide" onClick={() => void run(s.leaving, s.left, (w) => actions.leave(w, c))}>
            {s.leave(won(c.contribution))}
          </button>
        </>
      )}
      {c.phase === "Active" &&
        (paid ? (
          <p>
            {s.paidRound(c.round)}
            {me.received ? ` ${s.tookIn(me.receivedRound)}` : ""}
          </p>
        ) : (
          <>
            <p>{s.roundOpen(c.round)}</p>
            <button className="btn btn--ink btn--wide" onClick={() => void run(s.paying(c.round), s.payed(c.round), (w) => actions.contribute(w, c))}>
              {s.pay(won(c.contribution), c.round)}
            </button>
          </>
        ))}
      {me.debt > 0n && (
        <button className="btn btn--line btn--wide" onClick={() => void run(s.repaying, s.repaid, (w) => actions.repay(w, c, me.debt))}>
          {s.repay(won(me.debt))}
        </button>
      )}
      {c.phase === "Active" && Date.now() / 1000 >= c.deadline && (
        <button className="btn btn--line btn--wide" onClick={() => void run(s.closing, s.closed, (w) => actions.settle(w, c))}>
          {s.close(c.round)}
        </button>
      )}
      {c.phase === "Filling" && Date.now() / 1000 > c.fillDeadline && (
        <button className="btn btn--line btn--wide" onClick={() => void run(s.cancelling, s.cancelled, (w) => actions.cancel(w, c))}>
          {s.cancel}
        </button>
      )}
    </div>
  );
}

function Auction({ c, me }: { c: Circle; me?: Member }) {
  const { run } = useApp();
  const { t } = useLang();
  const s = t.circle;
  const [amount, setAmount] = useState("");
  const pot = c.contribution * BigInt(c.size);
  const cap = (pot * BigInt(c.maxDiscountBps)) / 10_000n;
  const canBid = me && !me.received && !me.defaulted && paidRound(me, c.round);
  const yours = !!me && c.bestBidder.toLowerCase() === me.address.toLowerCase();
  return (
    <div className="auction">
      <p>{c.bestBid > 0n ? s.bestBid(won(c.bestBid), yours) : s.noBid}</p>
      {canBid && (
        <form
          className="auction__form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(s.bidding, s.bidPlaced, (w) => actions.bid(w, c, parseUnits(amount || "0", 18)));
          }}
        >
          <label htmlFor="bid">{s.bidLabel(won(cap))}</label>
          <div className="auction__row">
            <input id="bid" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} placeholder="50000" />
            <button className="btn btn--ink" disabled={!amount}>{s.bid}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function Credit({ me, c }: { me: Member; c: Circle }) {
  const { deployment } = useApp();
  const { t } = useLang();
  const s = t.circle;
  const { data: rec } = useChain(() => readRecord(deployment!, me.address), [me.address]);
  if (!rec) return null;
  const remaining = BigInt(c.size - (me.received ? me.receivedRound : c.round)) * c.contribution;
  return (
    <p className="credit">
      {s.creditA(me.holdbackBps / 100)}
      {remaining > 0n ? s.creditNow(won((remaining * BigInt(me.holdbackBps)) / 10_000n)) : ""}.{" "}
      {rec.completed === 0 ? s.creditFirst : s.creditDone(rec.completed)}
    </p>
  );
}
