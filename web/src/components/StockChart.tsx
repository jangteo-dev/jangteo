import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Ohlc, StockHistory, TapeRow } from "../lib/stocks";

type Frame = "m1" | "m5" | "h1" | "d1";
const FRAMES: Frame[] = ["m1", "m5", "h1", "d1"];
const SEC: Record<Frame, number> = { m1: 60, m5: 300, h1: 3600, d1: 86_400 };
/** lightweight-charts draws UTC; every point is shifted +9 h so the axis reads Korea time. */
const KST = 9 * 3600;

const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));

function cssVar(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Each candle opens where the previous one closed, as on any exchange chart. */
function chain(rows: Ohlc[], shift: number): CandlestickData<Time>[] {
  const out: CandlestickData<Time>[] = [];
  let prev: number | null = null;
  for (const r of rows) {
    const open: number = prev ?? r.open;
    out.push({ time: (r.time + shift) as UTCTimestamp, open, high: Math.max(r.high, open), low: Math.min(r.low, open), close: r.close });
    prev = r.close;
  }
  return out;
}

export function StockChart({
  history,
  livePrice,
  tape,
  title,
  labels,
}: {
  history: StockHistory | undefined;
  livePrice: number;
  tape: TapeRow[];
  title: string;
  labels: { frames: Record<Frame, string>; empty: string; buy: string; sell: string; dailyNote: string };
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const fitted = useRef<string>("");
  const [frame, setFrame] = useState<Frame>("m5");
  const [hover, setHover] = useState<CandlestickData<Time> | null>(null);

  const data = useMemo(() => {
    if (!history) return [];
    // Daily bars are dated at 00:00 UTC by the exchange's day: no KST shift, or the day label slips.
    const rows = chain(history[frame], frame === "d1" ? 0 : KST);
    // The live price nudges the last candle so the chart never lags the ticket.
    const last = rows[rows.length - 1];
    if (last && livePrice > 0 && frame !== "d1") {
      last.close = livePrice;
      last.high = Math.max(last.high, livePrice);
      last.low = Math.min(last.low, livePrice);
    }
    return rows;
  }, [history, frame, livePrice]);

  useEffect(() => {
    if (!box.current) return;
    const ink = cssVar("--ink-2", "#4a5163");
    const seam = cssVar("--seam", "rgba(29,34,48,.14)");
    const up = cssVar("--hong", "#b3243a");
    const down = cssVar("--jjok", "#2f4a9a");
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: ink, fontFamily: "'Gowun Dodum', system-ui, sans-serif", fontSize: 12, attributionLogo: false },
      grid: { vertLines: { color: seam }, horzLines: { color: seam } },
      rightPriceScale: { borderColor: seam, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: seam, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 10 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: fmt },
    });
    // Korean convention: rising red, falling blue.
    const s = c.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
      priceFormat: { type: "custom", minMove: 0.01, formatter: fmt },
    });
    chartRef.current = c;
    series.current = s;
    markers.current = createSeriesMarkers(s, []);
    c.subscribeCrosshairMove((p) => setHover((p.seriesData.get(s) as CandlestickData<Time> | undefined) ?? null));
    return () => {
      c.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    const c = chartRef.current;
    if (!s || !c) return;
    s.setData(data);
    c.applyOptions({ timeScale: { timeVisible: frame !== "d1" } });
    const size = SEC[frame];
    const shift = frame === "d1" ? 0 : KST;
    const first = data[0] ? Number(data[0].time) : Infinity;
    // Jangteo trades on the chart: ▲ buys under the bar, ▼ sells above it (latest 40).
    const ms = tape
      .slice(0, 40)
      .map((t) => ({ time: (Math.floor((t.t + shift) / size) * size) as UTCTimestamp, buy: t.side === "buy" }))
      .filter((m) => Number(m.time) >= first)
      .sort((a, b) => Number(a.time) - Number(b.time))
      .map((m) => ({
        time: m.time,
        position: m.buy ? ("belowBar" as const) : ("aboveBar" as const),
        shape: m.buy ? ("arrowUp" as const) : ("arrowDown" as const),
        color: m.buy ? cssVar("--hong", "#b3243a") : cssVar("--jjok", "#2f4a9a"),
        text: "",
      }));
    markers.current?.setMarkers(ms);
    // Fit once per frame; later refreshes keep wherever the reader scrolled to.
    if (fitted.current !== frame && data.length) {
      c.timeScale().fitContent();
      fitted.current = frame;
    }
  }, [data, tape, frame]);

  const last = data[data.length - 1];
  const shown = hover ?? last;
  const pct = shown ? ((shown.close - shown.open) / shown.open) * 100 : 0;

  return (
    <div className="tv">
      <div className="tv__bar">
        <div className="tv__frames" role="tablist">
          {FRAMES.map((f) => (
            <button key={f} role="tab" aria-selected={frame === f} onClick={() => setFrame(f)}>
              {labels.frames[f]}
            </button>
          ))}
        </div>
      </div>
      <div className="tv__legend" aria-live="off">
        <b>{title}</b>
        {shown && (
          <>
            <span>O {fmt(shown.open)}</span>
            <span>H {fmt(shown.high)}</span>
            <span>L {fmt(shown.low)}</span>
            <span>C {fmt(shown.close)}</span>
            <span className={pct >= 0 ? "is-bid" : "is-ask"}>
              {pct >= 0 ? "+" : ""}
              {pct.toFixed(2)}%
            </span>
          </>
        )}
      </div>
      <div className="tv__canvas">
        {/* The chart library owns this node's children; React must never render inside it. */}
        <div className="tv__host" ref={box} />
        {data.length === 0 && <p className="tv__empty">{labels.empty}</p>}
      </div>
      {frame === "d1" && <p className="form__note">{labels.dailyNote}</p>}
    </div>
  );
}
