import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PumpTrade } from "../lib/pump";
import { fmtTiny } from "../lib/tiny";

export { fmtTiny };

const FRAMES = [
  { key: "1m", sec: 60 },
  { key: "5m", sec: 300 },
  { key: "15m", sec: 900 },
  { key: "1h", sec: 3600 },
  { key: "4h", sec: 14_400 },
  { key: "1D", sec: 86_400 },
] as const;
type Frame = (typeof FRAMES)[number]["key"];
type Mode = "price" | "mcap";

/** The chart's axis speaks Korea time: lightweight-charts draws UTC, so every point is shifted +9h. */
const KST = 9 * 3600;
/** Prices here run around 1e-9 ETH; the series works on a scaled value so no float step rounds them away. */
const SCALE = 1e9;

interface Candle extends CandlestickData<Time> {
  volume: number;
  buyVol: number;
}

/** Buckets trades into candles. Each candle opens where the last one closed, as on any exchange. */
function toCandles(trades: PumpTrade[], frame: number, value: (t: PumpTrade) => number): Candle[] {
  const out: Candle[] = [];
  let prevClose: number | null = null;
  for (const t of trades) {
    const v = value(t);
    const bucket = (Math.floor((t.at + KST) / frame) * frame) as UTCTimestamp;
    const eth = Number(t.eth) / 1e18;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, v);
      last.low = Math.min(last.low, v);
      last.close = v;
      last.volume += eth;
      if (t.isBuy) last.buyVol += eth;
    } else {
      const open: number = prevClose ?? v;
      out.push({ time: bucket, open, high: Math.max(open, v), low: Math.min(open, v), close: v, volume: eth, buyVol: t.isBuy ? eth : 0 });
    }
    prevClose = v;
  }
  return out;
}

/** Canvas colours can't use color-mix(); turn a #rrggbb token into rgba at `a`. */
function alpha(hex: string, a: number) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface TvLabels {
  price: string;
  mcap: string;
  volume: string;
  graduated: string;
  empty: string;
}

export function TvChart({ trades, symbol, circulating, labels }: { trades: PumpTrade[]; symbol: string; circulating: number; labels: TvLabels }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vol = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [frame, setFrame] = useState<Frame>("1m");
  const [mode, setMode] = useState<Mode>("price");
  const [hover, setHover] = useState<Candle | null>(null);

  const sec = FRAMES.find((f) => f.key === frame)!.sec;
  const data = useMemo(
    () => toCandles(trades, sec, (t) => (mode === "price" ? t.price * SCALE : t.price * circulating)),
    [trades, sec, mode, circulating],
  );
  // Below zero is only the chart's margin: prices never go there, so those ticks stay blank.
  const show = (v: number) => (v < 0 ? "" : mode === "price" ? fmtTiny(v / SCALE) : fmtTiny(v, 3));

  // Build the chart once; theme it from the page's own colour tokens.
  useEffect(() => {
    if (!box.current) return;
    const ink = cssVar("--ink-2", "#4a5163");
    const seam = cssVar("--seam", "rgba(29,34,48,.14)");
    const up = cssVar("--hong", "#b3243a");
    const down = cssVar("--jjok", "#2f4a9a");
    const c = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: ink,
        fontFamily: "'Gowun Dodum', system-ui, sans-serif",
        fontSize: 12,
        attributionLogo: false,
      },
      grid: { vertLines: { color: seam }, horzLines: { color: seam } },
      rightPriceScale: { borderColor: seam, scaleMargins: { top: 0.12, bottom: 0.26 } },
      timeScale: { borderColor: seam, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 12 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (v: number) => v.toString() },
    });
    // Korean convention: rising candles are red, falling ones blue.
    const cs = c.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
      priceLineColor: up,
      priceFormat: { type: "custom", minMove: 1e-9, formatter: (v: number) => v.toString() },
    });
    const vs = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.current = c;
    candles.current = cs;
    vol.current = vs;
    markers.current = createSeriesMarkers(cs, []);
    c.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(cs) as CandlestickData<Time> | undefined;
      setHover(d ? ({ ...d, volume: 0, buyVol: 0 } as Candle) : null);
    });
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  // Formatters depend on the mode; data on trades, frame and mode.
  useEffect(() => {
    const cs = candles.current;
    const vs = vol.current;
    if (!cs || !vs || !chart.current) return;
    cs.applyOptions({ priceFormat: { type: "custom", minMove: 1e-6, formatter: show } });
    chart.current.applyOptions({ localization: { priceFormatter: show } });
    const up = cssVar("--hong", "#b3243a");
    const down = cssVar("--jjok", "#2f4a9a");
    cs.setData(data);
    vs.setData(
      data.map((d) => ({
        time: d.time,
        value: d.volume,
        color: alpha(d.buyVol >= d.volume / 2 ? up : down, 0.4),
      })),
    );
    const g = trades.findIndex((t) => t.venue === "pool");
    const gTime = g > 0 ? ((Math.floor((trades[g].at + KST) / sec) * sec) as UTCTimestamp) : null;
    markers.current?.setMarkers(
      gTime ? [{ time: gTime, position: "aboveBar", color: cssVar("--nok", "#3e7f6b"), shape: "arrowDown", text: labels.graduated }] : [],
    );
    chart.current.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mode, labels.graduated]);

  const last = data[data.length - 1];
  const shown = hover ?? last;
  const change = shown ? ((shown.close - shown.open) / shown.open) * 100 : 0;

  return (
    <div className="tv">
      <div className="tv__bar">
        <div className="tv__frames" role="tablist">
          {FRAMES.map((f) => (
            <button key={f.key} role="tab" aria-selected={frame === f.key} onClick={() => setFrame(f.key)}>
              {f.key}
            </button>
          ))}
        </div>
        <div className="tv__modes" role="tablist">
          {(["price", "mcap"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
              {m === "price" ? labels.price : labels.mcap}
            </button>
          ))}
        </div>
      </div>
      <div className="tv__legend" aria-live="off">
        <b>{symbol}/ETH</b>
        {shown && (
          <>
            <span>O {show(shown.open)}</span>
            <span>H {show(shown.high)}</span>
            <span>L {show(shown.low)}</span>
            <span>C {show(shown.close)}</span>
            <span className={change >= 0 ? "is-bid" : "is-ask"}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(2)}%
            </span>
          </>
        )}
      </div>
      <div className="tv__canvas">
        {/* The chart library owns this node's children; React must never render inside it. */}
        <div className="tv__host" ref={box} />
        {data.length === 0 && <p className="tv__empty">{labels.empty}</p>}
      </div>
    </div>
  );
}
