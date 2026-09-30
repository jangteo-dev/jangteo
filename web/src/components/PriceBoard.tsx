import { useEffect, useRef, useState } from "react";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { krw, loadMarket, type MarketToken } from "../lib/market";
import { TokenMark } from "./PumpVisuals";

/**
 * 전광판: the price board of a Korean exchange floor, for GIWA. The busiest tokens right now, won
 * prices, red when up and blue when down, and a brief flash on the figure that just changed.
 */
export function PriceBoard() {
  const { tick } = useApp();
  const { t, lang } = useLang();
  const s = t.hub;
  const { data: m } = useChain(loadMarket, [tick]);
  const prev = useRef(new Map<string, number>());
  const [flash, setFlash] = useState<Record<string, "up" | "down">>({});

  const rows: MarketToken[] = (m?.tokens ?? [])
    .filter((x) => !x.anchor && !x.suspicious && x.priceKrw !== null && x.liquidityKrw >= 100_000)
    .sort((a, b) => b.volume24hKrw - a.volume24hKrw || b.liquidityKrw - a.liquidityKrw)
    .slice(0, 6);

  useEffect(() => {
    const next: Record<string, "up" | "down"> = {};
    for (const r of rows) {
      const p = prev.current.get(r.address);
      if (p !== undefined && r.priceKrw !== null && r.priceKrw !== p) next[r.address] = r.priceKrw > p ? "up" : "down";
      if (r.priceKrw !== null) prev.current.set(r.address, r.priceKrw);
    }
    if (Object.keys(next).length) {
      setFlash(next);
      const id = setTimeout(() => setFlash({}), 900);
      return () => clearTimeout(id);
    }
  }, [m?.updatedAt]);

  return (
    <aside className="pboard" aria-label={s.boardH}>
      <header className="pboard__head">
        <span className="pboard__title">{s.boardH}</span>
        {m && (
          <span className={`pboard__live ${m.live ? "is-live" : ""}`}>
            {s.boardBlock(m.block.toLocaleString("en-US"))}
          </span>
        )}
      </header>
      <ol className="pboard__rows">
        {rows.length === 0 && <li className="pboard__empty">{s.boardLoading}</li>}
        {rows.map((r) => {
          const up = (r.change24h ?? 0) > 0;
          const down = (r.change24h ?? 0) < 0;
          return (
            <li key={r.address}>
              <a href={`#/trade/${r.address}`} className={flash[r.address] ? `is-flash-${flash[r.address]}` : ""}>
                <TokenMark l={{ token: r.address, symbol: r.symbol, meta: { image: r.icon ?? undefined } }} size={22} />
                <b>{r.symbol}</b>
                <span className="pboard__px">{krw(r.priceKrw, lang)}</span>
                <span className={`pboard__chg ${up ? "is-up" : down ? "is-down" : ""}`}>
                  {r.change24h === null ? "—" : `${up ? "▲" : down ? "▼" : ""} ${Math.abs(r.change24h * 100).toFixed(2)}%`}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
      <a className="pboard__foot" href="#/market">
        {s.boardAll(m ? m.totals.tokens.toLocaleString("en-US") : "…")}
      </a>
    </aside>
  );
}
