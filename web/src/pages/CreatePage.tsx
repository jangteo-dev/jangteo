import { useState } from "react";
import { useApp } from "../app";
import { Bojagi, type Seat } from "../components/Bojagi";
import { useLang } from "../i18n";
import { actions, MODE_KO, MODES, won, type Mode, circleFromTx } from "../lib/gye";

const ROUND_SECONDS = [600, 3600, 86400, 604800, 2592000];

export function CreatePage() {
  const { account, deployment, run } = useApp();
  const { t } = useLang();
  const s = t.create;
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("100000");
  const [size, setSize] = useState(8);
  const [mode, setMode] = useState<Mode>("Ordered");
  const [round, setRound] = useState(86400);
  const [discount, setDiscount] = useState(20);
  const [fillDays, setFillDays] = useState(3);

  const seats: Seat[] = Array.from({ length: size }, (_, i) => (i === 0 ? { state: "paid", you: true } : { state: "open" }));
  const pot = BigInt(amount || "0") * BigInt(size) * 10n ** 18n;
  const valid = !!deployment && name.trim().length > 0 && Number(amount) > 0 && size >= 2 && size <= 50;

  return (
    <main className="page create">
      <a className="back" href="#/gye">{t.circle.back}</a>
      <h1>{s.h1}</h1>
      <div className="create__body">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            let made: `0x${string}` | null = null;
            void run(s.creating, s.created, async (w) => {
              const hash = await actions.create(w, deployment!, { name: name.trim(), contributionWon: amount, size, mode, roundSeconds: round, maxDiscountPct: discount, fillDays });
              made = await circleFromTx(hash, deployment!.factory);
            }).then((ok) => ok && (location.hash = made ? `#/gye/c/${made}` : "#/gye"));
          }}
        >
          <label>
            <span>{s.name}</span>
            <input value={name} maxLength={31} onChange={(e) => setName(e.target.value)} placeholder={s.namePh} required />
          </label>
          <label>
            <span>{s.amount}</span>
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} />
          </label>
          <label>
            <span>{s.members(size)}</span>
            <input type="range" min={2} max={20} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </label>
          <label>
            <span>{s.length}</span>
            <select value={round} onChange={(e) => setRound(Number(e.target.value))}>
              {ROUND_SECONDS.map((sec, i) => (
                <option key={sec} value={sec}>{s.rounds[i]}</option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>{s.who}</legend>
            <div className="modes">
              {MODES.map((m) => (
                <label key={m} className={`mode ${mode === m ? "is-on" : ""}`}>
                  <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                  <span className="mode__ko" lang="ko">{MODE_KO[m]}</span>
                  <span className="mode__title">{t.modes[m].title}</span>
                  <span className="mode__body">{t.modes[m].body}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {mode === "Auction" && (
            <label>
              <span>{s.discount(discount)}</span>
              <input type="range" min={5} max={50} step={5} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />
            </label>
          )}
          <label>
            <span>{s.fill(fillDays)}</span>
            <input type="range" min={1} max={30} value={fillDays} onChange={(e) => setFillDays(Number(e.target.value))} />
          </label>
          <p className="form__note">{s.note(won(BigInt(amount || "0") * 10n ** 18n))}</p>
          <button className="btn btn--ink btn--wide" disabled={!valid || !account}>
            {account ? s.submit : s.connect}
          </button>
        </form>
        <figure className="create__preview">
          <Bojagi seed={name || "preview"} size={size} seats={seats} title={s.preview} />
          <figcaption>{s.caption(size, won(pot))}</figcaption>
        </figure>
      </div>
    </main>
  );
}
