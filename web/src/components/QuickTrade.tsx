import { useEffect, useState } from "react";
import { formatEther, formatUnits, parseEther, parseUnits, type WalletClient } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { aggQuote, aggSwap, loadRoutes, type AggQuote } from "../lib/aggregator";
import { dexLabel, krw, type MarketToken } from "../lib/market";
import { pumpTx, quoteBuy, quoteSell } from "../lib/pump";
import { ETH, balanceOf } from "../lib/swap";
import { fmtTiny } from "../lib/tiny";
import { TokenMark } from "./PumpVisuals";

type Side = "buy" | "sell";
const fmtQ = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v >= 1 ? v.toFixed(4) : fmtTiny(v, 4));
const plain = (v: number) => v.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 8, maximumFractionDigits: 30 });

interface Quote {
  out: bigint;
  impactBps: number | null;
  via: string;
  run: (w: WalletClient) => Promise<unknown>;
}

/**
 * A small buy/sell ticket that slides in over the Market page: from the side on a desktop, from
 * the bottom on a phone. Tokens still on a 뻥튀기 curve trade on their curve; everything else goes
 * through the aggregator's best route across every DEX on GIWA.
 */
export function QuickTrade({ token, side: side0, onClose }: { token: MarketToken; side: Side; onClose: () => void }) {
  const { account, deployment, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.ex;
  const [side, setSide] = useState<Side>(side0);
  const [amount, setAmount] = useState("");
  const [q, setQ] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const { data: routes } = useChain(loadRoutes, []);
  const agg = deployment?.aggregator;
  // The curve a coin trades on is the 뻥튀기 contract it launched on (v2, or v1 for older coins).
  const pump = (token.venues?.find((v) => v.kind === "curve")?.pool as `0x${string}` | undefined) ?? deployment?.pump;
  const onCurve = !!token.curve && !!pump;
  const dec = token.decimals;
  const { data: bal } = useChain(async () => (account ? { eth: await balanceOf(ETH, account), tok: await balanceOf(token.address, account) } : null), [account, token.address, tick]);

  useEffect(() => setSide(side0), [side0, token.address]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const amt = (() => {
    try {
      return amount ? (side === "buy" ? parseEther(amount) : parseUnits(amount, dec)) : 0n;
    } catch {
      return 0n;
    }
  })();

  useEffect(() => {
    if (amt === 0n) {
      setQ(null);
      return;
    }
    let live = true;
    setQuoting(true);
    const tm = setTimeout(async () => {
      try {
        let r: Quote | null = null;
        if (onCurve) {
          if (side === "buy") {
            const b = await quoteBuy(pump!, token.address, amt);
            r = { out: b.out, impactBps: null, via: "Ppeongtwigi", run: (w) => pumpTx.buy(w, pump!, token.address, amt, b.out, 100) };
          } else {
            const out = await quoteSell(pump!, token.address, amt);
            r = { out, impactBps: null, via: "Ppeongtwigi", run: (w) => pumpTx.sell(w, pump!, token.address, amt, out, 100) };
          }
        } else if (agg && routes) {
          const a: AggQuote | null = await aggQuote(agg, routes, side === "buy" ? ETH : token.address, side === "buy" ? token.address : ETH, amt);
          if (a) r = { out: a.amountOut, impactBps: a.impactBps, via: [...new Set(a.dexes)].map((d) => dexLabel(d, lang)).join(" + "), run: (w) => aggSwap(w, agg, a, 100) };
        }
        if (live) setQ(r);
      } catch {
        if (live) setQ(null);
      } finally {
        if (live) setQuoting(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [amt, side, onCurve, agg, routes, token.address, tick]);

  const ethBal = bal ? Number(formatEther(bal.eth)) : 0;
  const tokBal = bal ? Number(formatUnits(bal.tok, dec)) : 0;
  const short = !!bal && (side === "buy" ? amt > bal.eth : amt > bal.tok);
  const outN = q ? Number(side === "buy" ? formatUnits(q.out, dec) : formatEther(q.out)) : 0;
  const full = onCurve ? `#/ppeongtwigi/${token.address}` : `#/trade/${token.address}`;

  return (
    <div className="qt__backdrop" onClick={onClose}>
      <aside className={`qt is-${side}`} role="dialog" aria-label={`${token.symbol} ${side === "buy" ? s.buy : s.sell}`} onClick={(e) => e.stopPropagation()}>
        <span className="qt__grip" aria-hidden />
        <header className="qt__head">
          <TokenMark l={{ token: token.address, symbol: token.symbol, meta: { image: token.icon ?? undefined } }} size={40} />
          <div className="qt__id">
            <b>{token.symbol}</b>
            <small>{token.name}</small>
          </div>
          <div className="qt__px">
            <b>{krw(token.priceKrw, lang)}</b>
            <small className={(token.change24h ?? 0) >= 0 ? "is-bid" : "is-ask"}>
              {token.change24h === null ? "" : `${token.change24h >= 0 ? "+" : ""}${(token.change24h * 100).toFixed(2)}%`}
            </small>
          </div>
          <button type="button" className="qt__x" onClick={onClose} aria-label={t.sw.tpClose}>
            ×
          </button>
        </header>

        <div className="ticket__side" role="tablist">
          {(["buy", "sell"] as const).map((sd) => (
            <button key={sd} role="tab" aria-selected={side === sd} className={`is-${sd}`} onClick={() => (setSide(sd), setAmount(""))}>
              {sd === "buy" ? s.buy : s.sell}
            </button>
          ))}
        </div>

        <form
          className="ticket"
          onSubmit={(e) => {
            e.preventDefault();
            if (!q) return;
            const go = q.run;
            void run(s.sending, s.sent, (w) => go(w)).then((ok) => ok && setAmount(""));
          }}
        >
          <label className="ticket__field">
            <span>{side === "buy" ? s.spend : s.amount}</span>
            <input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0" />
            <em>{side === "buy" ? "ETH" : token.symbol}</em>
          </label>
          {account && bal && (
            <div className="ticket__pcts">
              <small>{s.avail(side === "buy" ? `${fmtQ(ethBal)} ETH` : `${fmtQ(tokBal)} ${token.symbol}`)}</small>
              {[25, 50, 100].map((p) => (
                <button type="button" key={p} onClick={() => setAmount(plain(side === "buy" ? Math.max(0, ((ethBal - 0.001) * p) / 100) : (tokBal * p) / 100))}>
                  {p === 100 ? "Max" : `${p}%`}
                </button>
              ))}
            </div>
          )}
          {side === "buy" && (
            <div className="qt__presets">
              {["0.001", "0.01", "0.05", "0.1"].map((v) => (
                <button type="button" key={v} className={amount === v ? "is-on" : ""} onClick={() => setAmount(v)}>
                  {v} ETH
                </button>
              ))}
            </div>
          )}

          <dl className="swapinfo">
            <div>
              <dt>{s.receive}</dt>
              <dd>{q ? (side === "buy" ? `${fmtQ(outN)} ${token.symbol}` : `${fmtQ(outN)} ETH`) : "—"}</dd>
            </div>
            {q?.impactBps !== null && q?.impactBps !== undefined && (
              <div>
                <dt>{s.impact}</dt>
                <dd className={q.impactBps > 300 ? "is-warn" : ""}>{q.impactBps < 1 ? "< 0.01%" : `${(q.impactBps / 100).toFixed(2)}%`}</dd>
              </div>
            )}
            {q && (
              <div>
                <dt>{s.route}</dt>
                <dd>{onCurve ? `${q.via} · ${token.curve!.progress.toFixed(1)}%` : q.via}</dd>
              </div>
            )}
          </dl>

          <button className={`btn btn--wide ticket__go is-${side}`} disabled={!account || amt === 0n || !q || quoting || short}>
            {!account
              ? s.connect
              : short
                ? t.sw.tooMuch(side === "buy" ? "ETH" : token.symbol)
                : quoting && amt > 0n
                  ? s.quoting
                  : amt > 0n && !q
                    ? s.noRoute
                    : side === "buy"
                      ? s.buyBtn(token.symbol)
                      : s.sellBtn(token.symbol)}
          </button>
        </form>
        <a className="qt__full" href={full} onClick={onClose}>
          {s.fullView}
        </a>
      </aside>
    </div>
  );
}

