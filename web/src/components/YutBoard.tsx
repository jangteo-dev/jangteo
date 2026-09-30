import { CORNERS, HOME, OFF, STATION } from "../lib/yut";

export interface BoardPiece {
  player: 0 | 1;
  piece: number;
  pos: number;
}

interface Props {
  pieces: BoardPiece[];
  me: 0 | 1 | null;
  /** Own pieces that can take the selected throw. */
  movable?: Set<number>;
  target?: number | null;
  onPick?: (piece: number) => void;
  onHover?: (piece: number | null) => void;
  label: string;
}

const LINES: [number, number][] = [
  [0, 5],
  [5, 10],
  [10, 15],
  [15, 0],
  [5, 15],
  [10, 0],
];

/**
 * The 윷판 as ink on hanji: the square, both diagonals, 29 stations. Corners and the centre
 * (방) are larger, as on a hand-drawn board. Pieces stack by station and show a count.
 */
export function YutBoard({ pieces, me, movable, target, onPick, onHover, label }: Props) {
  const byStation = new Map<number, BoardPiece[]>();
  for (const p of pieces) {
    if (p.pos === OFF || p.pos === HOME) continue;
    const list = byStation.get(p.pos) ?? [];
    list.push(p);
    byStation.set(p.pos, list);
  }

  return (
    <svg className="yutboard" viewBox="0 0 100 100" role="img" aria-label={label}>
      <rect x="1" y="1" width="98" height="98" rx="1.5" className="yutboard__paper" />
      {LINES.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={STATION[a][0]} y1={STATION[a][1]} x2={STATION[b][0]} y2={STATION[b][1]} className="yutboard__ink" />
      ))}
      {Object.entries(STATION).map(([k, [x, y]]) => {
        const n = Number(k);
        const big = CORNERS.has(n);
        return (
          <g key={k} className={`station ${target === n ? "station--target" : ""}`}>
            <circle cx={x} cy={y} r={big ? 4.2 : 2.6} className="station__dot" />
            {big && <circle cx={x} cy={y} r={2.3} className="station__inner" />}
          </g>
        );
      })}
      {target === HOME && (
        <text x={STATION[0][0]} y={STATION[0][1] + 7.5} className="yutboard__home" textAnchor="middle">
          ★
        </text>
      )}
      {[...byStation.entries()].map(([pos, list]) => {
        const [x, y] = STATION[pos];
        const top = list[0];
        const mine = me !== null && top.player === me;
        const can = mine && movable?.has(top.piece);
        return (
          <g
            key={pos}
            className={`mal mal--p${top.player} ${can ? "mal--can" : ""}`}
            onClick={can && onPick ? () => onPick(top.piece) : undefined}
            onMouseEnter={can && onHover ? () => onHover(top.piece) : undefined}
            onMouseLeave={can && onHover ? () => onHover(null) : undefined}
            role={can ? "button" : undefined}
            tabIndex={can ? 0 : undefined}
            onKeyDown={can && onPick ? (e) => (e.key === "Enter" || e.key === " ") && onPick(top.piece) : undefined}
          >
            <circle cx={x} cy={y} r={4.6} className="mal__body" />
            <circle cx={x} cy={y} r={2.2} className="mal__eye" />
            {list.length > 1 && (
              <text x={x + 4.2} y={y - 3.4} className="mal__count">
                {list.length}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A tray of pieces waiting to enter or already home, as small tokens. */
export function Tray({ count, player, movable, onPick, pieces }: { count: number; player: 0 | 1; movable?: boolean; onPick?: () => void; pieces?: number }) {
  return (
    <div className={`tray ${movable ? "tray--can" : ""}`} onClick={movable ? onPick : undefined} role={movable ? "button" : undefined} tabIndex={movable ? 0 : undefined}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={`tray__mal tray__mal--p${player}`} aria-hidden />
      ))}
      {pieces !== undefined && count === 0 && <span className="tray__none">—</span>}
    </div>
  );
}

/**
 * Four 윷가락. Each is flat (배, marked with three strokes) or round (등, plain wood). 도‥걸 show
 * that many flat faces, 윷 all four, 모 none. 빽도 is 도 on the one marked stick.
 */
export function Sticks({ value, rolling }: { value: number | null; rolling: boolean }) {
  // Stick 0 is the marked one: flat alone it reads 빽도, so plain 도 shows a different stick flat.
  const flatSet =
    value === null || value === 5 ? [] : value === -1 ? [0] : value === 1 ? [2] : value === 4 ? [0, 1, 2, 3] : Array.from({ length: value }, (_, i) => i + 1);
  return (
    <div className={`sticks ${rolling ? "sticks--roll" : ""}`} aria-hidden>
      {[0, 1, 2, 3].map((i) => {
        const flat = flatSet.includes(i);
        const marked = i === 0;
        return (
          <span key={i} className={`stick ${flat ? "stick--flat" : "stick--round"}`} style={{ ["--i" as string]: i }}>
            {flat && <i className="stick__marks" />}
            {marked && <b className="stick__mark">{value === -1 ? "✕" : ""}</b>}
          </span>
        );
      })}
    </div>
  );
}
