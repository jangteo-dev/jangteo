import { useLang } from "../i18n";
import { yesShare } from "../lib/sangjang";

/** YES in jjok indigo from the left, NO in hong crimson from the right, split at the pool share. */
export function Odds({ yesPool, noPool, size = "md" }: { yesPool: bigint; noPool: bigint; size?: "sm" | "md" | "lg" }) {
  const { t } = useLang();
  const y = yesShare({ yesPool, noPool });
  const empty = yesPool + noPool === 0n;
  const pct = Math.round(y * 100);
  return (
    <div className={`odds odds--${size} ${empty ? "odds--empty" : ""}`} role="img" aria-label={empty ? t.odds.emptyAria : t.odds.aria(pct)}>
      <div className="odds__bar">
        <i className="odds__yes" style={{ width: `${y * 100}%` }} />
        <i className="odds__no" style={{ width: `${(1 - y) * 100}%` }} />
      </div>
      {size !== "sm" && empty && <p className="odds__empty">{t.odds.empty}</p>}
      {size !== "sm" && !empty && (
        <div className="odds__labels">
          <span>{t.odds.yes(`${pct}%`)}</span>
          <span>{t.odds.no(`${100 - pct}%`)}</span>
        </div>
      )}
    </div>
  );
}
