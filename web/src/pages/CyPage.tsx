import { useState } from "react";
import { parseUnits } from "viem";
import { useApp, useChain } from "../app";
import { dateKst, useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { explorer } from "../lib/chain";
import {
  cheongyak,
  estimate,
  hardCap,
  isVesting,
  money,
  readAllocation,
  readOffering,
  stage,
  vestedAt,
  type Offering,
  type Profile,
} from "../lib/cheongyak";
import { cyAddrs, fmtComp, fmtTokens, offeringStatus, VerifiedMark } from "./CyList";

const DAY = 86_400;

export function CyPage({ v, id }: { v: 1 | 2; id: number }) {
  const { deployment, account, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.cy;
  const addrs = cyAddrs(deployment);
  const { data: o, error } = useChain(async () => (addrs ? readOffering(addrs, { v, id }) : null), [addrs?.v1, addrs?.v2, v, id]);
  const { data: a } = useChain(async () => (o && account ? readAllocation(o, account) : null), [o, account, tick]);
  const [amount, setAmount] = useState("");
  const [editing, setEditing] = useState(false);

  if (error) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;
  if (!o || !deployment) return <main className="page"><p className="empty">{s.loading}</p></main>;

  const m = (x: bigint) => money(o, deployment.tkrw, x);
  const now = Date.now() / 1000;
  const st = stage(o);
  const amt = amount ? parseUnits(amount, 18) : 0n;
  const current = a?.deposit ?? 0n;
  const est = amt > 0n ? estimate(o, current + amt, current === 0n) : null;
  const isIssuer = account?.toLowerCase() === o.issuer.toLowerCase();
  const settled = o.status === "Settled";
  const softPct = o.softCap > 0n ? Number((o.totalDeposit * 10_000n) / o.softCap) / 100 : 0;
  const lockEnd = o.settledAt + o.lpLock;
  const vesting = isVesting(o);

  return (
    <main className="page listing">
      <a className="back" href="#/cheongyak">{s.back}</a>
      <header className="listing__head">
        <h1 className="listing__sym">{o.symbol}</h1>
        <p className="listing__q">
          {o.name} {o.verified && <VerifiedMark t={t} />}
          {o.v === 1 && <span className="tag">{s.earlier}</span>}
        </p>
        <p className="circle__status">{offeringStatus(o, t, lang)}</p>
      </header>

      <div className="listing__body">
        <section className="listing__main">
          <div className="compbig">
            <span className="compbig__label">{s.comp}</span>
            {o.subscribers ? (
              <span className="compbig__value">{fmtComp(o.competition)} : 1</span>
            ) : (
              <span className="compbig__empty">{s.subscribers(0)}</span>
            )}
          </div>

          {o.softCap > 0n && o.status !== "Cancelled" && (
            <div className="softcap">
              <div className="meter__nums">
                <span>{s.softCapProgress(Math.min(softPct, 999))}</span>
                <span>
                  {m(o.totalDeposit)} / {m(o.softCap)}
                </span>
              </div>
              <div className={`meter__bar ${o.status === "Failed" ? "is-failed" : ""}`}>
                <i style={{ width: `${Math.min(100, softPct)}%` }} />
              </div>
            </div>
          )}

          <dl className="figures">
            <div><dt>{s.price}</dt><dd>{m(o.price)}</dd></div>
            <div><dt>{s.offered}</dt><dd>{fmtTokens(o.totalTokens)}</dd></div>
            <div><dt>{s.hardCap}</dt><dd>{m(hardCap(o))}</dd></div>
            <div><dt>{s.softCap}</dt><dd>{o.softCap ? m(o.softCap) : s.softCapNone}</dd></div>
            <div><dt>{s.equal}</dt><dd>{s.equalVal(o.equalBps / 100)}</dd></div>
            <div><dt>{s.subs}</dt><dd>{o.subscribers.toLocaleString("en-US")}</dd></div>
            <div><dt>{s.deposits}</dt><dd>{m(o.totalDeposit)}</dd></div>
            <div><dt>{s.limits}</dt><dd className="dd--sm">{s.limitsVal(m(o.minDeposit), m(o.maxDeposit))}</dd></div>
          </dl>

          <dl className="terms">
            <div>
              <dt>{s.unlock}</dt>
              <dd>{vesting ? s.unlockVal(o.tgeBps / 100, Math.round(o.cliff / DAY), Math.round(o.vesting / DAY)) : s.unlockAll}</dd>
            </div>
            <div>
              <dt>{s.liquidity}</dt>
              <dd>{o.liqBps ? s.liqVal(o.liqBps / 100, Math.round(o.lpLock / DAY)) : s.liqNone}</dd>
            </div>
            <div>
              <dt>{s.window}</dt>
              <dd>{s.windowVal(dateKst(o.startAt, lang), dateKst(o.endAt, lang))}</dd>
            </div>
            <div>
              <dt>{s.fee}</dt>
              <dd>{s.feeVal(o.feeBps / 100)}</dd>
            </div>
          </dl>

          {vesting && <UnlockCurve o={o} now={now} s={s} lang={lang} />}

          {settled && o.liqBps > 0 && (
            <div className="pool">
              {o.lpAmount > 0n ? (
                <>
                  <p className="pool__head">{s.poolOpened}</p>
                  <p>
                    {fmtTokens(o.liqTokens)} {o.symbol} + {m(o.liqQuote)} ·{" "}
                    {o.lpWithdrawn ? s.lpReleased : s.lpLocked(dateKst(lockEnd, lang))}
                  </p>
                  <p className="pool__links">
                    <a href={`#/swap?in=${o.quote}&out=${o.token}`}>{t.sw.tradeOnSwap}</a>
                    <a href={`${explorer}/address/${o.pair}`} target="_blank" rel="noreferrer">{s.viewPool}</a>
                  </p>
                </>
              ) : (
                <p>{s.poolSkipped}</p>
              )}
            </div>
          )}

          {(Object.keys(o.profile).length > 0 || editing) && (
            <section className="profile" aria-labelledby="about-h">
              <h2 id="about-h">{s.profileH}</h2>
              {editing ? (
                <ProfileForm
                  initial={o.profile}
                  s={s}
                  onSave={(p) => void run(s.savingProfile, s.savedProfile, (w) => cheongyak.setProfile(w, o, p)).then((ok) => ok && setEditing(false))}
                />
              ) : (
                <ProfileView p={o.profile} s={s} />
              )}
            </section>
          )}

          <section className="rules" aria-labelledby="how-h">
            <h2 id="how-h">{s.howH}</h2>
            <ol className="docs__steps">
              {[...s.how, ...(o.v === 2 ? s.howMore : [])].map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ol>
          </section>
        </section>

        <aside className="panel">
          {isIssuer && <p className="seat">{s.youIssued}</p>}
          {isIssuer && st === "upcoming" && o.status === "Scheduled" && (
            <button className="btn btn--line btn--wide" onClick={() => void run(s.withdrawing, s.withdrawn, (w) => cheongyak.cancel(w, o))}>
              {s.withdraw}
            </button>
          )}
          {isIssuer && o.v === 2 && o.status === "Scheduled" && now < o.endAt && !editing && (
            <button className="btn btn--quiet btn--wide" onClick={() => setEditing(true)}>
              {s.editProfile}
            </button>
          )}
          {isIssuer && o.lpAmount > 0n && !o.lpWithdrawn && now >= lockEnd && (
            <button className="btn btn--line btn--wide" onClick={() => void run(s.withdrawingLp, s.withdrawnLp, (w) => cheongyak.withdrawLp(w, o))}>
              {s.withdrawLp}
            </button>
          )}

          {st === "open" && (
            <form
              className="betform"
              onSubmit={(e) => {
                e.preventDefault();
                void run(s.subscribing, s.subscribed, (w) => cheongyak.subscribe(w, o, amount)).then((ok) => ok && setAmount(""));
              }}
            >
              <label>
                <span>{s.depositLabel(m(o.minDeposit), m(o.maxDeposit))}</span>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="100000" />
              </label>
              {est && (
                <p className="betform__est">
                  {s.estimate(fmtTokens(est.tokens), o.symbol, m(est.cost), m(current + amt - est.cost))} {s.estimateNote}
                </p>
              )}
              <button className="btn btn--ink btn--wide" disabled={!account || amt === 0n}>
                {account ? s.subscribe : s.connect}
              </button>
            </form>
          )}

          {a && a.deposit > 0n && !settled && o.status !== "Failed" && <p className="seat">{s.yourDeposit(m(a.deposit))}</p>}

          {o.status === "Failed" && a && a.deposit > 0n && (
            <div className="position">
              {a.claimableRefund > 0n ? (
                <>
                  <p>{s.failedRefund(m(a.deposit))}</p>
                  <button className="btn btn--gold btn--wide" onClick={() => void run(s.collecting, s.collected, (w) => cheongyak.claim(w, o))}>
                    {s.collectRefund(m(a.claimableRefund))}
                  </button>
                </>
              ) : (
                <p>{s.allDone}</p>
              )}
            </div>
          )}

          {settled && a && a.deposit > 0n && (
            <div className="position">
              <p>{s.yourResult(fmtTokens(a.tokens), o.symbol, m(a.cost), m(a.deposit - a.cost))}</p>
              {vesting && a.tokens > 0n && (
                <p className="form__note">{s.unlockedSoFar(fmtTokens(vestedAt(o, a.tokens, now)), fmtTokens(a.tokens), o.symbol)}</p>
              )}
              {a.claimableTokens > 0n || a.claimableRefund > 0n ? (
                <button className="btn btn--gold btn--wide" onClick={() => void run(s.collecting, s.collected, (w) => cheongyak.claim(w, o))}>
                  {claimLabel(s, a.claimableTokens, a.claimableRefund, o.symbol, m)}
                </button>
              ) : (
                <p>{a.released >= a.tokens && (a.refunded || a.deposit === a.cost) ? s.allDone : s.nothingYet}</p>
              )}
            </div>
          )}

          {st === "closed" && (o.status === "Scheduled" || o.status === "Settling") && account && (
            <button className="btn btn--line btn--wide" onClick={() => void run(s.running, s.ran, (w) => cheongyak.settle(w, o))}>
              {s.runAllocation}
            </button>
          )}
          {settled && !o.issuerPaid && account && (
            <button className="btn btn--quiet btn--wide" onClick={() => void run(s.payingIssuer, s.paidIssuer, (w) => cheongyak.payIssuer(w, o))}>
              {s.payIssuer}
            </button>
          )}

          <p className="form__note">
            <a href={`${explorer}/address/${o.token}`} target="_blank" rel="noreferrer">{o.symbol}</a>{" "}
            <a href={`${explorer}/address/${o.addr}`} target="_blank" rel="noreferrer">{s.contract}</a>
          </p>
        </aside>
      </div>
    </main>
  );
}

function claimLabel(s: Dict["cy"], tokens: bigint, refund: bigint, sym: string, m: (x: bigint) => string) {
  if (tokens > 0n && refund > 0n) return s.collectBoth(fmtTokens(tokens), sym, m(refund));
  if (tokens > 0n) return s.collectUnlocked(fmtTokens(tokens), sym);
  return s.collectRefund(m(refund));
}

/**
 * The unlock schedule as a step-and-ramp line: the TGE share at allocation, flat through the
 * cliff, then linear to 100%. Before allocation it is drawn from the window's close.
 */
function UnlockCurve({ o, now, s, lang }: { o: Offering; now: number; s: Dict["cy"]; lang: "en" | "ko" }) {
  const t0 = o.settledAt || o.endAt;
  const cliffEnd = t0 + o.cliff;
  const end = cliffEnd + o.vesting;
  const span = Math.max(end - t0, 1);
  const W = 320;
  const H = 96;
  const x = (t: number) => ((t - t0) / span) * W;
  const y = (pct: number) => H - (pct / 100) * H;
  const tge = o.tgeBps / 100;
  const line = `M0 ${H} L0 ${y(tge)} L${x(cliffEnd)} ${y(tge)} L${W} ${y(100)}`;
  const started = o.status === "Settled";
  const nowX = started ? Math.min(W, Math.max(0, x(now))) : null;
  const nowPct = started ? Number(vestedAt(o, 10_000n, now)) / 100 : 0;
  return (
    <figure className="unlock">
      <figcaption>{s.scheduleH}</figcaption>
      <svg viewBox={`-4 -6 ${W + 8} ${H + 12}`} role="img" aria-label={s.unlock} preserveAspectRatio="none">
        <line x1="0" x2={W} y1={H} y2={H} className="unlock__base" />
        <path d={`${line} L${W} ${H} Z`} className="unlock__area" />
        <path d={line} className="unlock__line" vectorEffect="non-scaling-stroke" />
        {nowX !== null && (
          <>
            <line x1={nowX} x2={nowX} y1={0} y2={H} className="unlock__now" vectorEffect="non-scaling-stroke" />
            <circle cx={nowX} cy={y(nowPct)} r="3.5" className="unlock__dot" />
          </>
        )}
      </svg>
      <ol className="unlock__marks">
        <li>
          <b>{tge}%</b> {s.schedAt}
          <small>{started ? dateKst(t0, lang) : ""}</small>
        </li>
        {o.cliff > 0 && (
          <li>
            <b>{tge}%</b> {s.schedCliff}
            <small>{started ? dateKst(cliffEnd, lang) : `+${Math.round(o.cliff / DAY)}d`}</small>
          </li>
        )}
        <li>
          <b>100%</b> {s.schedFull}
          <small>{started ? dateKst(end, lang) : `+${Math.round((o.cliff + o.vesting) / DAY)}d`}</small>
        </li>
      </ol>
    </figure>
  );
}

function ProfileView({ p, s }: { p: Profile; s: Dict["cy"] }) {
  const links = (["site", "x", "telegram", "discord"] as const).filter((k) => p[k]);
  return (
    <>
      {p.about && <p className="profile__about">{p.about}</p>}
      {links.length > 0 && (
        <ul className="profile__links">
          {links.map((k) => (
            <li key={k}>
              <a href={p[k]} target="_blank" rel="noreferrer nofollow ugc">
                {s[k]}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ProfileFields({ p, set, s }: { p: Profile; set: (p: Profile) => void; s: Dict["cy"] }) {
  return (
    <>
      <label>
        <span>{s.pAbout}</span>
        <textarea rows={4} maxLength={1200} value={p.about ?? ""} placeholder={s.pAboutPh} onChange={(e) => set({ ...p, about: e.target.value })} />
      </label>
      {(["site", "x", "telegram", "discord"] as const).map((k) => (
        <label key={k}>
          <span>{s[k]}</span>
          <input
            value={p[k] ?? ""}
            maxLength={200}
            placeholder="https://"
            spellCheck={false}
            onChange={(e) => set({ ...p, [k]: e.target.value.trim() })}
            aria-invalid={!!p[k] && !/^https:\/\//i.test(p[k]!)}
          />
        </label>
      ))}
      <p className="form__note">{s.linkNote}</p>
    </>
  );
}

export const profileValid = (p: Profile) => (["site", "x", "telegram", "discord"] as const).every((k) => !p[k] || /^https:\/\/\S+$/i.test(p[k]!));

function ProfileForm({ initial, s, onSave }: { initial: Profile; s: Dict["cy"]; onSave: (p: Profile) => void }) {
  const [p, setP] = useState<Profile>(initial);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(p);
      }}
    >
      <ProfileFields p={p} set={setP} s={s} />
      <button className="btn btn--ink" disabled={!profileValid(p)}>
        {s.saveProfile}
      </button>
    </form>
  );
}
