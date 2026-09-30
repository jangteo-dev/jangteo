import { useEffect, useMemo, useRef, useState } from "react";
import { FABRIC, layout } from "../lib/bojagi";
import type { PumpLaunch, PumpTrade } from "../lib/pump";

/** A token's face: its own image if it has one, otherwise a jogakbo cut from its address. */
export function TokenMark({ l, size = 48 }: { l: Pick<PumpLaunch, "token" | "symbol" | "meta">; size?: number }) {
  const [broken, setBroken] = useState(false);
  const patches = useMemo(() => layout(5, l.token.toLowerCase(), 100, 100), [l.token]);
  // Pick five fabrics in an order the address decides, so neighbours rarely look alike.
  const offset = parseInt(l.token.slice(2, 4), 16) % FABRIC.length;
  if (l.meta.image && !broken) {
    return <img className="tokenmark" src={l.meta.image} alt="" width={size} height={size} onError={() => setBroken(true)} loading="lazy" />;
  }
  return (
    <svg className="tokenmark" width={size} height={size} viewBox="-2 -2 104 104" aria-hidden>
      {patches.map((p, i) => (
        <rect key={i} x={p.x + 1} y={p.y + 1} width={Math.max(0, p.w - 2)} height={Math.max(0, p.h - 2)} fill={FABRIC[(offset + i * 3) % FABRIC.length]} />
      ))}
    </svg>
  );
}

/**
 * The one curve every launch rides. Drawn at the container's real pixel width (never scaled), so
 * on a phone the labels and token faces stay full size: a filled price curve from 0 to the 4.2 ETH
 * graduation line, each live token sitting on it with its face and symbol, graduated ones parked
 * past the line where their pool on Jangteo Swap begins.
 */
export function InkCurve({
  launches,
  threshold,
  virtualEth,
  label,
  gradLabel,
  focus,
  height = 260,
}: {
  launches: (Pick<PumpLaunch, "token" | "symbol" | "realEth" | "graduated"> & Partial<Pick<PumpLaunch, "meta">>)[];
  threshold: number;
  virtualEth: number;
  label: string;
  gradLabel: string;
  focus?: string;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    ro.observe(el);
    setW(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, []);
  const narrow = W > 0 && W < 560;
  const H = narrow ? 220 : height;
  const pad = { l: 6, r: narrow ? 64 : 110, t: 34, b: 30 };
  const px = (r: number) => pad.l + (r / threshold) * (W - pad.l - pad.r);
  const p0 = (virtualEth / (virtualEth + threshold)) ** 2;
  const py = (r: number) => {
    const p = ((virtualEth + r) / (virtualEth + threshold)) ** 2; // share of the graduation price
    return H - pad.b - ((p - p0) / (1 - p0)) * (H - pad.t - pad.b);
  };
  const N = 80;
  let d = "";
  for (let i = 0; i <= N; i++) {
    const r = (threshold * i) / N;
    d += `${i ? "L" : "M"}${px(r).toFixed(1)},${py(r).toFixed(1)}`;
  }
  const gx = px(threshold);
  const gy = py(threshold);
  const base = H - pad.b;
  const live = launches
    .filter((l) => !l.graduated)
    .map((l) => ({ l, r: Math.min(threshold, Number(l.realEth) / 1e18) }))
    .sort((a, b) => a.r - b.r);
  // Faces that would overlap are nudged apart along the curve (a few pixels, never past the line),
  // and a crowded neighbour's label is raised a row so no two labels collide.
  const gap = narrow ? 44 : 58;
  let lastX = -1e9;
  let row = 0;
  const placed = live.map(({ l, r }) => {
    let x = Math.max(px(r), pad.l + 14);
    if (x - lastX < gap) {
      x = Math.min(lastX + gap, px(threshold) - 14);
      row = (row + 1) % 2;
    } else row = 0;
    lastX = x;
    // Keep the face on the curve at its (possibly nudged) x.
    const rAt = ((x - pad.l) / (W - pad.l - pad.r)) * threshold;
    return { l, x, y: py(Math.max(0, rAt)), below: false, row };
  });
  const grads = launches.filter((l) => l.graduated);
  const fmt = (v: number) => (v >= 1 ? v.toFixed(1) : v.toFixed(2));

  return (
    <div className="inkcurve" ref={box} style={{ height: H }} role="img" aria-label={label}>
      {W > 0 && (
        <>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
            <defs>
              <linearGradient id="inkwash" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--hong)" stopOpacity="0.28" />
                <stop offset="1" stopColor="var(--hong)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <g key={f}>
                <line x1={px(threshold * f)} x2={px(threshold * f)} y1={pad.t - 6} y2={base} className="inkcurve__grid" />
                <text x={px(threshold * f)} y={base + 18} textAnchor="middle" className="inkcurve__tick">
                  {fmt(threshold * f)}
                </text>
              </g>
            ))}
            <line x1={pad.l} x2={W - 4} y1={base} y2={base} className="inkcurve__ground" />
            <path d={`${d} L${gx.toFixed(1)},${base} L${pad.l},${base} Z`} fill="url(#inkwash)" />
            <path d={d} className="inkcurve__line" />
            <line x1={gx} x2={gx} y1={gy - 16} y2={base} className="inkcurve__gradline" />
            <line x1={gx} x2={W - 6} y1={gy} y2={gy} className="inkcurve__pool" />
            <text x={pad.l} y={base + 18} className="inkcurve__tick">
              0 ETH
            </text>
            <text x={gx} y={base + 18} textAnchor="middle" className="inkcurve__gradtick">
              {fmt(threshold)} ETH
            </text>
            <text x={gx - 6} y={gy - 22} textAnchor="end" className="inkcurve__label">
              {gradLabel}
            </text>
          </svg>
          {placed.map(({ l, x, y, below, row }) => (
            <a
              key={l.token}
              href={`#/ppeongtwigi/${l.token}`}
              className={`inkseal ${below ? "is-below" : ""} ${focus && focus.toLowerCase() === l.token.toLowerCase() ? "is-focus" : ""}`}
              style={{ left: x, top: y - row * 22 }}
              title={l.symbol}
            >
              <TokenMark l={{ token: l.token, symbol: l.symbol, meta: l.meta ?? {} }} size={narrow ? 22 : 26} />
              <span>{l.symbol}</span>
            </a>
          ))}
          {grads.length > 0 && (
            <div className="inkcurve__shelf" style={{ left: gx + 10, top: gy + 10 }}>
              {grads.slice(0, narrow ? 3 : 6).map((l) => (
                <a key={l.token} href={`#/ppeongtwigi/${l.token}`} title={l.symbol} className="inkseal is-grad">
                  <TokenMark l={{ token: l.token, symbol: l.symbol, meta: l.meta ?? {} }} size={20} />
                  {!narrow && <span>{l.symbol}</span>}
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 뻥튀기 pressure gauge: the machine's dial filling as a launch's curve collects ETH. The needle
 * sweeps from empty to the red zone; at 4.2 ETH the lid pops (뻥!) and the token graduates.
 */
export function PopGauge({
  progress,
  raised,
  threshold,
  graduated,
  label,
  size = 260,
  caption,
}: {
  progress: number; // 0..1
  raised: number; // ETH in the curve
  threshold: number;
  graduated: boolean;
  label: string;
  size?: number;
  caption?: string;
}) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(graduated ? 1 : Math.min(1, Math.max(0, progress))));
    return () => cancelAnimationFrame(id);
  }, [progress, graduated]);
  const R = 100;
  const cx = 120;
  const cy = 118;
  const at = (f: number, r = R) => {
    const a = Math.PI * (1 - f);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const;
  };
  const arc = (f0: number, f1: number, r = R) => {
    const [x0, y0] = at(f0, r);
    const [x1, y1] = at(f1, r);
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
  };
  const gid = `popg${Math.round(progress * 1e6)}${graduated ? "g" : ""}`;
  const pct = graduated ? 100 : progress * 100;
  return (
    <figure className={`popgauge ${graduated ? "is-popped" : ""}`} style={{ width: size }} role="img" aria-label={`${label} ${pct.toFixed(1)}%`}>
      <svg viewBox="0 0 240 150" width={size} height={(size * 150) / 240} aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--hwang)" />
            <stop offset="0.7" stopColor="#e0662f" />
            <stop offset="1" stopColor="var(--hong)" />
          </linearGradient>
        </defs>
        <path d={arc(0, 1)} className="popgauge__track" />
        <path d={arc(0.9, 1)} className="popgauge__red" />
        {Array.from({ length: 21 }, (_, i) => {
          const f = i / 20;
          const [x0, y0] = at(f, R - 16);
          const [x1, y1] = at(f, R - (i % 5 === 0 ? 26 : 21));
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={`popgauge__tick ${i % 5 === 0 ? "is-major" : ""}`} />;
        })}
        {shown > 0.002 && <path d={arc(0, Math.max(0.004, shown))} stroke={graduated ? "var(--nok)" : `url(#${gid})`} className="popgauge__fill" />}
        <g className="popgauge__needle" style={{ transform: `rotate(${-90 + 180 * shown}deg)`, transformOrigin: `${cx}px ${cy}px` }}>
          <line x1={cx} y1={cy} x2={cx} y2={cy - R + 30} />
        </g>
        <circle cx={cx} cy={cy} r="7" className="popgauge__hub" />
        <text x={at(0, R)[0] + 2} y={cy + 20} className="popgauge__end">
          0
        </text>
        <text x={at(1, R)[0] - 2} y={cy + 20} textAnchor="end" className="popgauge__end is-hot">
          {threshold} ETH
        </text>
      </svg>
      <figcaption>
        <b>{graduated ? "뻥!" : `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`}</b>
        <span>{caption ?? `${raised < 1 ? raised.toFixed(3) : raised.toFixed(2)} / ${threshold} ETH`}</span>
      </figcaption>
    </figure>
  );
}

/** Price after every trade, as an ink line over its own wash. */
export function PriceChart({ trades, label }: { trades: PumpTrade[]; label: string }) {
  const W = 1000;
  const H = 280;
  const pad = { l: 8, r: 8, t: 16, b: 16 };
  if (trades.length === 0) return null;
  // Trades are spaced evenly, not by time: early launches trade in bursts, and one quiet hour
  // would otherwise flatten everything else into a wall.
  const pts = trades.map((t, i) => ({ t: i, p: t.price }));
  if (pts.length === 1) pts.unshift({ t: -1, p: pts[0].p });
  const t0 = pts[0].t;
  const t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const lo = Math.min(...pts.map((x) => x.p));
  const hi = Math.max(...pts.map((x) => x.p));
  const span = hi - lo || hi * 0.1 || 1;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (p: number) => H - pad.b - ((p - lo + span * 0.08) / (span * 1.16)) * (H - pad.t - pad.b);
  let d = `M${x(pts[0].t).toFixed(1)},${y(pts[0].p).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` L${x(pts[i].t).toFixed(1)},${y(pts[i].p).toFixed(1)}`;
  const area = `${d} V${H - pad.b} H${x(pts[0].t).toFixed(1)} Z`;
  // Where the curve handed over to the pool.
  const gi = trades.findIndex((tr) => tr.venue === "pool");
  const gx = gi > 0 ? (x(gi - 1) + x(gi)) / 2 : null;
  return (
    <svg className="pricechart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
      <path d={area} className="pricechart__wash" />
      <path d={d} className="pricechart__line" vectorEffect="non-scaling-stroke" />
      {gx !== null && <line x1={gx} x2={gx} y1={pad.t} y2={H - pad.b} className="pricechart__grad" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
