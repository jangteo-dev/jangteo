import { useMemo } from "react";
import { FABRIC, layout } from "../lib/bojagi";
import { useLang } from "../i18n";

export type SeatState = "open" | "waiting" | "paid" | "defaulted";

export interface Seat {
  state: SeatState;
  tookPot?: boolean;
  you?: boolean;
  label?: string;
}

interface Props {
  seed: string;
  seats: Seat[];
  size: number;
  width?: number;
  height?: number;
  animate?: boolean;
  className?: string;
  title?: string;
}

const GAP = 1.1;

/**
 * A circle drawn as a jogakbo: one patch per seat. Paid patches are sewn in (solid with a
 * running stitch), unpaid ones are basted (faint, dashed), and a gold knot marks whoever
 * has taken the pot.
 */
export function Bojagi({ seed, seats, size, width = 120, height = 90, animate = false, className, title }: Props) {
  const { t } = useLang();
  const patches = useMemo(() => layout(size, seed, width, height), [size, seed, width, height]);
  return (
    <svg
      className={`bojagi ${animate ? "bojagi--sew" : ""} ${className ?? ""}`}
      viewBox={`-1 -1 ${width + 2} ${height + 2}`}
      role="img"
      aria-label={title ?? t.bojagi.circle(size)}
    >
      <defs>
        {/* ramie weave: two fine thread directions so flat colour reads as cloth */}
        <pattern id="weave" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(8)">
          <path d="M0 0.4H1.6M0 1.2H1.6" className="weave__weft" />
          <path d="M0.4 0V1.6M1.2 0V1.6" className="weave__warp" />
        </pattern>
      </defs>
      <rect x={-1} y={-1} width={width + 2} height={height + 2} rx={1.4} className="bojagi__ground" />
      {patches.map((p) => {
        const seat = seats[p.seat] ?? { state: "open" as const };
        const color = FABRIC[p.seat % FABRIC.length];
        const x = p.x + GAP / 2;
        const y = p.y + GAP / 2;
        const w = Math.max(0, p.w - GAP);
        const h = Math.max(0, p.h - GAP);
        const inset = Math.min(1.3, w / 6, h / 6);
        const knot = Math.min(2.4, w / 6, h / 6);
        const light = color === "#F4F5F0" || color === "#D9A021";
        return (
          <g key={p.seat} className={`patch patch--${seat.state}`} style={{ ["--i" as string]: p.seat }}>
            <title>{seat.label ?? (seat.state === "open" ? t.bojagi.open : t.bojagi.seat(p.seat + 1))}</title>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={0.5}
              fill={seat.state === "open" ? "none" : color}
              stroke={seat.state === "waiting" ? color : undefined}
              className="patch__cloth"
            />
            {seat.state !== "open" && <rect x={x} y={y} width={w} height={h} rx={0.5} fill="url(#weave)" className="patch__weave" />}
            {seat.state === "paid" && (
              <rect
                x={x + inset}
                y={y + inset}
                width={Math.max(0, w - inset * 2)}
                height={Math.max(0, h - inset * 2)}
                rx={0.3}
                className={`patch__stitch ${light ? "patch__stitch--dark" : ""}`}
                pathLength={100}
              />
            )}
            {seat.state === "defaulted" && (
              <g className="patch__fray">
                <line x1={x + inset} y1={y + inset} x2={x + w - inset} y2={y + h - inset} />
                <line x1={x + w - inset} y1={y + inset} x2={x + inset} y2={y + h - inset} />
              </g>
            )}
            {seat.tookPot && (
              <g className="patch__knot">
                <circle cx={x + w - knot - inset * 0.6} cy={y + knot + inset * 0.6} r={knot} />
                <circle cx={x + w - knot - inset * 0.6} cy={y + knot + inset * 0.6} r={knot * 0.42} className="patch__knot-core" />
              </g>
            )}
            {seat.you && <rect x={x - 0.35} y={y - 0.35} width={w + 0.7} height={h + 0.7} rx={0.8} className="patch__you" />}
          </g>
        );
      })}
    </svg>
  );
}
