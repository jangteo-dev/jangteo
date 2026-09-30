import { useLang } from "../i18n";

/** Each throw: how many of the four sticks land flat side up, and its odds out of 16 (as the contract draws them). */
const THROWS: { v: string; flat: number; marked?: boolean; odds: number; moves: string }[] = [
  { v: "1", flat: 1, odds: 3, moves: "+1" },
  { v: "2", flat: 2, odds: 6, moves: "+2" },
  { v: "3", flat: 3, odds: 4, moves: "+3" },
  { v: "4", flat: 4, odds: 1, moves: "+4" },
  { v: "5", flat: 0, odds: 1, moves: "+5" },
  { v: "-1", flat: 1, marked: true, odds: 1, moves: "−1" },
];

/** One stick seen from above: flat face (pale, cross-hatched) or round back (wood). */
function Stick({ flat, mark }: { flat: boolean; mark?: boolean }) {
  return (
    <svg viewBox="0 0 14 56" width="12" height="48" aria-hidden className={`ystick ${flat ? "is-flat" : "is-round"}`}>
      <rect x="1" y="1" width="12" height="54" rx="6" />
      {flat && (
        <>
          <path d="M4 14l6 6M10 14l-6 6M4 36l6 6M10 36l-6 6" />
          {mark && <circle cx="7" cy="28" r="2.2" className="ystick__mark" />}
        </>
      )}
    </svg>
  );
}

/** How the four yut sticks fall: every result drawn as the sticks that make it, with its odds. */
export function YutThrows() {
  const { t } = useLang();
  const s = t.yut;
  return (
    <section className="ythrows" aria-labelledby="ythrows-h">
      <h2 id="ythrows-h">{s.throwsH}</h2>
      <p className="form__note">{s.throwsNote}</p>
      <ul>
        {THROWS.map((x) => (
          <li key={x.v} className={x.v === "4" || x.v === "5" ? "is-again" : x.v === "-1" ? "is-back" : ""}>
            <span className="ythrows__sticks">
              {[0, 1, 2, 3].map((i) => (
                <Stick key={i} flat={i < x.flat} mark={x.marked && i === 0} />
              ))}
            </span>
            <b>{s.names[x.v]}</b>
            <span className="ythrows__move">{s.movesN(x.moves)}</span>
            <span className="ythrows__odds">{s.oddsN(x.odds)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
