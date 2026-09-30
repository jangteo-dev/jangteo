import { useState } from "react";
import { formatEther, isAddress, parseEther, type Address } from "viem";
import { useApp, useChain } from "../app";
import { dateKst, useLang } from "../i18n";
import { explorer } from "../lib/chain";
import {
  balances,
  bridgeTerms,
  claimWithdrawal,
  deposit,
  fastExit,
  fastTerms,
  loadWithdrawalFile,
  proveWithdrawal,
  waitArrival,
  withdraw,
  withdrawalStatus,
  type Withdrawal,
} from "../lib/bridge";

const fmt = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 5 });

/** Both directions: deposits from Ethereum (L1 front door) and withdrawals back (GIWA front door). */
export function BridgePanel({ bridge, door, fast }: { bridge: Address; door?: Address; fast?: Address }) {
  const { t } = useLang();
  const [dir, setDir] = useState<"in" | "out">("in");
  return (
    <div className="bridge">
      {door && (
        <fieldset className="segmented bridge__dir" aria-label={t.sw.brH}>
          {(["in", "out"] as const).map((d) => (
            <label key={d} className={dir === d ? "is-on" : ""}>
              <input type="radio" name="brdir" checked={dir === d} onChange={() => setDir(d)} />
              {d === "in" ? t.sw.brDirIn : t.sw.brDirOut}
            </label>
          ))}
        </fieldset>
      )}
      {dir === "in" || !door ? <DepositForm bridge={bridge} /> : <WithdrawForm door={door} fast={fast} />}
    </div>
  );
}

function DepositForm({ bridge }: { bridge: Address }) {
  const { account, run, tick } = useApp();
  const { t } = useLang();
  const s = t.sw;
  const { data: terms } = useChain(async () => bridgeTerms(bridge), [bridge]);
  const { data: bal } = useChain(async () => (account ? balances(account) : null), [account, tick]);
  const [amount, setAmount] = useState("");
  const [other, setOther] = useState(false);
  const [to, setTo] = useState("");
  const [track, setTrack] = useState<{ stage: "l1" | "l2" | "done"; sec: number } | null>(null);

  const amt = (() => {
    try {
      return amount ? parseEther(amount) : 0n;
    } catch {
      return 0n;
    }
  })();
  const feeBps = BigInt(terms?.feeBps ?? 50);
  const fee = (amt * feeBps) / 10_000n;
  const received = amt - fee;
  const recipient = (other ? to : account) as Address | undefined;
  const short = !!bal && amt > bal.onL1;
  const tooSmall = !!terms && amt > 0n && amt < terms.minDeposit;
  const ready = !!account && amt > 0n && !short && !tooSmall && !!recipient && isAddress(recipient);

  return (
    <>
      <form
        className="swapcard"
        onSubmit={(e) => {
          e.preventDefault();
          if (!recipient) return;
          void run(s.brSending, s.brSent, async (w) => {
            const before = (await balances(recipient)).onGiwa;
            await deposit(w, bridge, recipient, amt);
            setTrack({ stage: "l2", sec: 0 });
            setAmount("");
            // Tracked in the background; the toast has already said it is on its way.
            void waitArrival(recipient, before, received, (sec) => setTrack({ stage: "l2", sec }))
              .then((sec) => setTrack({ stage: "done", sec }))
              .catch(() => setTrack(null));
          });
        }}
      >
        <h2>{s.brH}</h2>
        <p className="form__note">{s.brLede}</p>
        <div className="swapleg">
          <div className="swapleg__head">
            <span>{s.brFrom}</span>
            {bal && (
              <button type="button" className="swapleg__bal" onClick={() => setAmount(formatEther(bal.onL1 > 10n ** 15n ? bal.onL1 - 10n ** 15n : 0n))}>
                {s.balance(`${fmt(bal.onL1)} ETH`)} · {s.max}
              </button>
            )}
          </div>
          <div className="swapleg__row">
            <input className="swapleg__amount" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} aria-invalid={short || tooSmall} aria-label={s.brFrom} />
            <span className="tokensel tokensel--static">ETH</span>
          </div>
        </div>
        <div className="bridge__arrow" aria-hidden>
          <svg viewBox="0 0 16 16">
            <path d="M8 2v11M8 13l-4-4M8 13l4-4" />
          </svg>
        </div>
        <div className="swapleg">
          <div className="swapleg__head">
            <span>{s.brTo}</span>
            {bal && <span className="swapleg__bal">{s.balance(`${fmt(bal.onGiwa)} ETH`)}</span>}
          </div>
          <div className="swapleg__row">
            <output className="swapleg__amount">{amt > 0n ? fmt(received) : "0"}</output>
            <span className="tokensel tokensel--static">ETH</span>
          </div>
        </div>

        <fieldset className="segmented">
          <legend>{s.brRecipient}</legend>
          {[false, true].map((o) => (
            <label key={String(o)} className={other === o ? "is-on" : ""}>
              <input type="radio" name="brto" checked={other === o} onChange={() => setOther(o)} />
              {o ? s.brOther : s.brSelf}
            </label>
          ))}
        </fieldset>
        {other && <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" spellCheck={false} aria-invalid={!!to && !isAddress(to)} aria-label={s.brRecipient} />}

        {amt > 0n && (
          <dl className="swapinfo">
            <div>
              <dt>{s.brFee}</dt>
              <dd>{s.brFeeVal(fmt(fee))}</dd>
            </div>
            <div>
              <dt>{s.brArrives}</dt>
              <dd>{fmt(received)} ETH</dd>
            </div>
            <div>
              <dt>{s.brTime}</dt>
              <dd>{s.brTimeVal}</dd>
            </div>
          </dl>
        )}
        {tooSmall && terms && <p className="form__note form__note--warn">{s.brMin(formatEther(terms.minDeposit))}</p>}
        <button className="btn btn--ink btn--wide swapcard__go" disabled={!ready}>
          {!account ? s.brConnect : short ? s.brNoFunds : amt === 0n ? s.enter : s.brBtn}
        </button>

        {track && (
          <ol className="bridge__track">
            <li className="is-done">{s.brStepL1}</li>
            <li className={track.stage === "done" ? "is-done" : "is-live"}>
              {track.stage === "done" ? s.brStepDone(track.sec) : `${s.brStepL2} · ${s.brWaiting(track.sec)}`}
            </li>
          </ol>
        )}
        <p className="form__note">
          {s.brWithdrawNote}{" "}
          <a href={`https://sepolia.etherscan.io/address/${bridge}`} target="_blank" rel="noreferrer">
            {s.brContract}
          </a>
        </p>
      </form>
    </>
  );
}

function WithdrawForm({ door, fast }: { door: Address; fast?: Address }) {
  const { account, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.sw;
  const { data: terms } = useChain(async () => bridgeTerms(door, "giwa"), [door]);
  const { data: bal } = useChain(async () => (account ? balances(account) : null), [account, tick]);
  const { data: file } = useChain(loadWithdrawalFile, [tick]);
  const all = file?.withdrawals;
  const [speed, setSpeed] = useState<"fast" | "std">(fast ? "fast" : "std");
  const { data: ft } = useChain(async () => (fast ? fastTerms(fast) : null), [fast]);
  const isFast = speed === "fast" && !!fast && !!ft;
  const [amount, setAmount] = useState("");
  const [other, setOther] = useState(false);
  const [to, setTo] = useState("");

  const amt = (() => {
    try {
      return amount ? parseEther(amount) : 0n;
    } catch {
      return 0n;
    }
  })();
  const fee = isFast ? (amt * BigInt(ft.feeBps)) / 10_000n + ft.flatFee : (amt * BigInt(terms?.feeBps ?? 50)) / 10_000n;
  const received = amt > fee ? amt - fee : 0n;
  const recipient = (other ? to : account) as Address | undefined;
  const short = !!bal && amt > bal.onGiwa;
  const min = isFast ? ft.minExit : terms?.minDeposit;
  const tooSmall = min !== undefined && amt > 0n && amt < min;
  const tooBig = isFast && amt > ft.maxExit;
  // More than the float can cover right now: it still arrives, in 7 days, with the fee refunded.
  const overFloat = isFast && !!file && received > file.fastLiquidity;
  const ready = !!account && amt > 0n && !short && !tooSmall && !tooBig && !!recipient && isAddress(recipient);
  const mine = (all ?? []).filter((w) => !!account && (w.from.toLowerCase() === account.toLowerCase() || w.to.toLowerCase() === account.toLowerCase()));

  return (
    <>
      <form
        className="swapcard"
        onSubmit={(e) => {
          e.preventDefault();
          if (!recipient) return;
          void run(s.wdSending, isFast ? s.fxSent : s.wdSent, (w) => (isFast ? fastExit(w, fast!, recipient, amt) : withdraw(w, door, recipient, amt))).then((ok) => ok && setAmount(""));
        }}
      >
        <h2>{s.wdH}</h2>
        <p className="form__note">{isFast ? s.fxLede : s.wdLede}</p>
        {fast && (
          <fieldset className="segmented">
            <legend>{s.fxSpeed}</legend>
            {(["fast", "std"] as const).map((k) => (
              <label key={k} className={speed === k ? "is-on" : ""}>
                <input type="radio" name="wdspeed" checked={speed === k} onChange={() => setSpeed(k)} />
                {k === "fast" ? s.fxFast : s.fxStd}
              </label>
            ))}
          </fieldset>
        )}
        <div className="swapleg">
          <div className="swapleg__head">
            <span>{s.wdFrom}</span>
            {bal && (
              <button type="button" className="swapleg__bal" onClick={() => setAmount(formatEther(bal.onGiwa > 10n ** 15n ? bal.onGiwa - 10n ** 15n : 0n))}>
                {s.balance(`${fmt(bal.onGiwa)} ETH`)} · {s.max}
              </button>
            )}
          </div>
          <div className="swapleg__row">
            <input className="swapleg__amount" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} aria-invalid={short || tooSmall} aria-label={s.wdFrom} />
            <span className="tokensel tokensel--static">ETH</span>
          </div>
        </div>
        <div className="bridge__arrow" aria-hidden>
          <svg viewBox="0 0 16 16">
            <path d="M8 2v11M8 13l-4-4M8 13l4-4" />
          </svg>
        </div>
        <div className="swapleg">
          <div className="swapleg__head">
            <span>{s.wdTo}</span>
            {bal && <span className="swapleg__bal">{s.balance(`${fmt(bal.onL1)} ETH`)}</span>}
          </div>
          <div className="swapleg__row">
            <output className="swapleg__amount">{amt > 0n ? fmt(received) : "0"}</output>
            <span className="tokensel tokensel--static">ETH</span>
          </div>
        </div>

        <fieldset className="segmented">
          <legend>{s.wdRecipient}</legend>
          {[false, true].map((o) => (
            <label key={String(o)} className={other === o ? "is-on" : ""}>
              <input type="radio" name="wdto" checked={other === o} onChange={() => setOther(o)} />
              {o ? s.brOther : s.brSelf}
            </label>
          ))}
        </fieldset>
        {other && <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" spellCheck={false} aria-invalid={!!to && !isAddress(to)} aria-label={s.wdRecipient} />}

        {amt > 0n && (
          <dl className="swapinfo">
            <div>
              <dt>{s.brFee}</dt>
              <dd>{isFast ? s.fxFeeVal(fmt(fee)) : s.brFeeVal(fmt(fee))}</dd>
            </div>
            <div>
              <dt>{s.wdArrives}</dt>
              <dd>{fmt(received)} ETH</dd>
            </div>
            <div>
              <dt>{s.wdTime}</dt>
              <dd>{isFast && !overFloat ? s.fxTimeVal : s.wdTimeVal}</dd>
            </div>
            {isFast && file && (
              <div>
                <dt>{s.fxFloat}</dt>
                <dd>{fmt(file.fastLiquidity)} ETH</dd>
              </div>
            )}
          </dl>
        )}
        {tooSmall && min !== undefined && <p className="form__note form__note--warn">{s.brMin(formatEther(min))}</p>}
        {tooBig && ft && <p className="form__note form__note--warn">{s.fxMax(formatEther(ft.maxExit))}</p>}
        {overFloat && !tooBig && <p className="form__note form__note--warn">{s.fxOverFloat}</p>}
        <button className="btn btn--ink btn--wide swapcard__go" disabled={!ready}>
          {!account ? s.brConnect : short ? s.wdNoFunds : amt === 0n ? s.enter : isFast ? s.fxBtn : s.wdBtn}
        </button>
        <p className="form__note">
          {s.wdSteps}{" "}
          <a href={`${explorer}/address/${door}`} target="_blank" rel="noreferrer">
            {s.wdContract}
          </a>
        </p>
      </form>

      {account && (
        <section className="withdrawals" aria-labelledby="wd-h">
          <h3 id="wd-h">{s.wdMine}</h3>
          {mine.length === 0 && <p className="empty">{s.wdNone}</p>}
          <ul>
            {mine.map((w) => (
              <WithdrawalRow key={w.l2Tx} w={w} lang={lang} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function WithdrawalRow({ w, lang }: { w: Withdrawal; lang: "en" | "ko" }) {
  const { account, run, tick } = useApp();
  const { t } = useLang();
  const s = t.sw;
  // The keeper's file can be minutes old: the portal's own answer decides which button shows.
  const { data: live } = useChain(async () => (w.status === "finalized" ? w.status : withdrawalStatus(w.l2Tx).catch(() => w.status)), [w.l2Tx, tick]);
  const status = live ?? w.status;
  const mineToAct = !!account && !w.relayed;
  const provedByMe = !!account && !!w.prover && w.prover.toLowerCase() === account.toLowerCase();
  return (
    <li className={`withdrawal is-${status}`}>
      <div className="withdrawal__head">
        <strong>{fmt(BigInt(w.amount))} ETH</strong>
        <span className="withdrawal__status">{w.kind === "fast" ? (w.fillTx ? s.fxDone : s.fxWaiting) : s.wdStatus[status]}</span>
      </div>
      <p className="withdrawal__meta">
        {dateKst(w.startedAt, lang)}
        {w.nextAt && status !== "finalized" && status !== "ready-to-prove" && status !== "ready-to-finalize" ? ` · ${s.wdOpens(dateKst(w.nextAt, lang))}` : ""}
        {" · "}
        <a href={`${explorer}/tx/${w.l2Tx}`} target="_blank" rel="noreferrer">
          GIWA tx
        </a>
        {w.proveTx && (
          <>
            {" · "}
            <a href={`https://sepolia.etherscan.io/tx/${w.proveTx}`} target="_blank" rel="noreferrer">
              prove tx
            </a>
          </>
        )}
        {w.fillTx && (
          <>
            {" · "}
            <a href={`https://sepolia.etherscan.io/tx/${w.fillTx}`} target="_blank" rel="noreferrer">
              payout tx
            </a>
          </>
        )}
        {w.finalizeTx && (
          <>
            {" · "}
            <a href={`https://sepolia.etherscan.io/tx/${w.finalizeTx}`} target="_blank" rel="noreferrer">
              claim tx
            </a>
          </>
        )}
      </p>
      {w.kind === "fast" ? (
        <p className="form__note">{w.fillTx ? s.fxPaid(dateKst(w.filledAt ?? w.startedAt, lang)) : status === "finalized" ? s.fxSettled : s.fxPending}</p>
      ) : (
        status !== "finalized" && <p className="form__note">{w.relayed ? s.wdRelayed : s.wdSelf}</p>
      )}
      {w.kind !== "fast" && status === "ready-to-prove" && mineToAct && (
        <button className="btn btn--line" onClick={() => void run(s.wdProving, s.wdProved, (x) => proveWithdrawal(x, w.l2Tx))}>
          {s.wdProve}
        </button>
      )}
      {w.kind !== "fast" && status === "ready-to-finalize" && (mineToAct || provedByMe) && (
        <button className="btn btn--ink" onClick={() => void run(s.wdClaiming, s.wdClaimed, (x) => claimWithdrawal(x, w.l2Tx))}>
          {s.wdClaim}
        </button>
      )}
    </li>
  );
}
