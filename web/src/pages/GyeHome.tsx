import { useApp, useChain } from "../app";
import { Bojagi, type Seat } from "../components/Bojagi";
import { countdown, every, useLang } from "../i18n";
import { listCircles, readCircle, won, MODE_KO, type Circle } from "../lib/gye";
import { seatsOf } from "../lib/seats";

// A twelve-seat circle in its fifth round, shown until a live circle is big enough to carry the hero.
const STORY: Seat[] = [
  { state: "paid", tookPot: true },
  { state: "paid" },
  { state: "paid", tookPot: true },
  { state: "waiting" },
  { state: "paid" },
  { state: "paid", tookPot: true },
  { state: "paid" },
  { state: "waiting" },
  { state: "paid", tookPot: true },
  { state: "paid" },
  { state: "paid" },
  { state: "waiting" },
];

export function GyeHome() {
  const { deployment } = useApp();
  const { t } = useLang();
  const g = t.gye;
  const { data: circles, error } = useChain(
    async () => (deployment ? Promise.all((await listCircles(deployment)).slice(0, 40).map(readCircle)) : []),
    [deployment],
  );
  const hero = circles?.filter((c) => c.phase === "Active" && c.size >= 8).sort((a, b) => b.size - a.size)[0] ?? null;

  return (
    <main>
      <section className="hero">
        <div className="hero__copy">
          <h1>
            {g.h1a}
            <br />
            {g.h1b}
          </h1>
          <p className="lede">{g.lede}</p>
          <div className="actions">
            <a className="btn btn--ink" href="#/gye/new">
              {g.start}
            </a>
            <a className="btn btn--line" href="#open">
              {g.seeOpen}
            </a>
          </div>
        </div>
        <figure className="hero__cloth">
          {hero ? (
            <Bojagi seed={hero.address} size={hero.size} seats={seatsOf(hero, t)} animate title={t.bojagi.live(hero.name)} />
          ) : (
            <Bojagi seed="seongsu" size={12} seats={STORY} animate title={t.bojagi.example12} />
          )}
          <figcaption>
            {hero ? g.captionLive(hero.name, hero.round, hero.size) : g.captionStory} {g.captionKey}
          </figcaption>
        </figure>
      </section>

      <section className="rounds" aria-labelledby="rounds-h">
        <h2 id="rounds-h">{g.roundsH}</h2>
        <ol className="steps">
          {g.steps.map((s) => (
            <li key={s.h}>
              <h3>{s.h}</h3>
              <p>{s.p}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="open" className="open" aria-labelledby="open-h">
        <div className="section-head">
          <h2 id="open-h">{g.circlesH}</h2>
          <a href="#/gye/new">{g.startOne}</a>
        </div>
        {deployment === null && <p className="empty">{g.notDeployed}</p>}
        {error && <p className="empty">{g.readError(error)}</p>}
        {circles && circles.length === 0 && (
          <p className="empty">
            {g.noneYetA} <a href="#/gye/new">{g.noneYetLink}</a> {g.noneYetB}
          </p>
        )}
        {circles && circles.length > 0 && (
          <ul className="rows">
            {circles.map((c) => (
              <CircleRow key={c.address} c={c} />
            ))}
          </ul>
        )}
      </section>

      <section className="why" aria-labelledby="why-h">
        <h2 id="why-h">{g.whyH}</h2>
        <div className="why__grid">
          {g.why.map((w) => (
            <p key={w.h}>
              <strong>{w.h}</strong> {w.p}
            </p>
          ))}
        </div>
      </section>
    </main>
  );
}

function CircleRow({ c }: { c: Circle }) {
  const { t, lang } = useLang();
  const g = t.gye;
  const status =
    c.phase === "Filling"
      ? g.rowFilling(c.members.length, c.size, countdown(c.fillDeadline, lang))
      : c.phase === "Active"
        ? g.rowActive(c.round, c.size, countdown(c.deadline, lang))
        : c.phase === "Completed"
          ? g.rowDone
          : g.rowCancelled;
  return (
    <li>
      <a className="row" href={`#/gye/c/${c.address}`}>
        <Bojagi seed={c.address} size={c.size} seats={seatsOf(c, t)} width={40} height={30} className="row__cloth" />
        <span className="row__name">{c.name || g.untitled}</span>
        <span className="row__terms">{g.terms(won(c.contribution), every(c.roundDuration, lang))}</span>
        <span className="row__mode">
          <span lang="ko">{MODE_KO[c.mode]}</span> {t.modes[c.mode].title}
        </span>
        <span className={`row__status row__status--${c.phase.toLowerCase()}`}>{status}</span>
      </a>
    </li>
  );
}
