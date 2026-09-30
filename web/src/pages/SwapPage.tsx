import { useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress, type Address } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import {
  balanceOf,
  bestQuote,
  ETH,
  fmtAmount,
  listPools,
  parseAmount,
  poolPrice,
  readToken,
  swap,
  tokenList,
  WETH,
  loadStats,
  statsFor,
  statValue,
  type Pool,
  type Quote,
  type SwapStats,
  type Token,
} from "../lib/swap";
import { dateKst } from "../i18n";
import { aggQuote, aggSwap, loadRoutes, routableTokens, type AggQuote } from "../lib/aggregator";
import { dexLabel, loadMarket } from "../lib/market";
import { fmtTiny } from "../lib/tiny";
import { TokenPicker } from "../components/TokenPicker";
import { LiquidityPanel, pct, won } from "./LiquidityPanel";
import { BridgePanel } from "./BridgePanel";

const SLIPPAGES = [50, 100, 300];
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** Rates keep six significant digits, and tiny ones read 0.0₉2153 instead of a run of zeros. */
const fmtRate = (v: number) => (v < 0.0001 ? fmtTiny(v) : v.toLocaleString("en-US", { maximumSignificantDigits: 6 }));
type AnyQuote = (Quote & { via?: "home" }) | AggQuote;
const isQuoteToken = (a: Address, tkrw?: Address) => same(a, tkrw) || same(a, WETH) || same(a, ETH);

export function SwapPage({ query }: { query: URLSearchParams }) {
  const { deployment, account, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.sw;
  const q0 = query.get("tab");
  const [tab, setTab] = useState<"swap" | "pool" | "bridge">(q0 === "pool" || q0 === "bridge" ? q0 : "swap");
  const [preset, setPreset] = useState<{ a?: Address; b?: Address; nonce: number }>({ nonce: 0 });
  // A link to another tab (#/swap?tab=bridge from the menu or the docs) switches it even while this page is open.
  useEffect(() => setTab(q0 === "pool" || q0 === "bridge" ? q0 : "swap"), [q0]);
  const { data: stats } = useChain(loadStats, []);
  const factory = deployment?.swapFactory;
  const router = deployment?.swapRouter;
  const tkrw = deployment?.tkrw;

  const { data: pools, error } = useChain(async () => (factory ? listPools(factory) : []), [factory]);
  const { data: bases } = useChain(async () => (tkrw ? Promise.all([readToken(tkrw), readToken(WETH)]) : []), [tkrw]);
  const agg = deployment?.aggregator;
  const { data: routes } = useChain(async () => (agg ? loadRoutes() : []), [agg]);
  const { data: market } = useChain(async () => (agg ? loadMarket() : null), [agg]);
  // 장터 스왑's own tokens first, then everything else the aggregator can reach, deepest first.
  const tokens = useMemo(() => {
    const home = tokenList(pools ?? [], bases ?? []);
    if (!routes?.length || !market) return home;
    const seen = new Set(home.map((x) => x.address.toLowerCase()));
    const depth = routableTokens(routes);
    const more = market.tokens
      .filter((m) => !m.suspicious && depth.has(m.address.toLowerCase()) && !seen.has(m.address.toLowerCase()))
      .sort((x, y) => (depth.get(y.address.toLowerCase()) ?? 0) - (depth.get(x.address.toLowerCase()) ?? 0))
      .map((m) => ({ address: m.address, symbol: m.symbol, name: m.name, decimals: m.decimals }));
    return [...home, ...more];
  }, [pools, bases, routes, market]);

  const qIn = query.get("in");
  const qOut = query.get("out");
  const [tokenIn, setTokenIn] = useState<Address | undefined>(undefined);
  const [tokenOut, setTokenOut] = useState<Address | undefined>(undefined);
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState(100);
  const [quote, setQuote] = useState<AnyQuote | null>(null);
  const [quoting, setQuoting] = useState(false);

  // Defaults: whatever the link asked for, else tKRW → the first pool's other token.
  useEffect(() => {
    if (!tkrw || !pools) return;
    const other = pools.map((p) => (same(p.token0.address, tkrw) ? p.token1 : same(p.token1.address, tkrw) ? p.token0 : null)).find(Boolean);
    setTokenIn((cur) => cur ?? (qIn && isAddress(qIn) ? qIn : tkrw));
    setTokenOut((cur) => cur ?? (qOut && isAddress(qOut) ? qOut : other?.address));
  }, [tkrw, pools, qIn, qOut]);

  const tIn = tokens.find((x) => same(x.address, tokenIn));
  const tOut = tokens.find((x) => same(x.address, tokenOut));
  // A token linked from outside the list (e.g. a new 청약 token) is loaded on demand.
  const { data: extra } = useChain(
    async () => {
      const miss = [tokenIn, tokenOut].filter((a): a is Address => !!a && !tokens.some((x) => same(x.address, a)));
      return Promise.all(miss.map((a) => readToken(a).catch(() => null)));
    },
    [tokenIn, tokenOut, tokens.length],
  );
  const allTokens = useMemo(() => [...tokens, ...((extra ?? []).filter(Boolean) as Token[])], [tokens, extra]);
  const tin = tIn ?? allTokens.find((x) => same(x.address, tokenIn));
  const tout = tOut ?? allTokens.find((x) => same(x.address, tokenOut));

  const { data: balIn } = useChain(async () => (account && tin ? balanceOf(tin.address, account) : 0n), [account, tin?.address, tick]);
  const { data: balOut } = useChain(async () => (account && tout ? balanceOf(tout.address, account) : 0n), [account, tout?.address, tick]);

  const amt = tin ? parseAmount(amount, tin) : 0n;
  useEffect(() => {
    if (!router || !pools || !tin || !tout || amt === 0n || !tkrw) {
      setQuote(null);
      return;
    }
    let live = true;
    setQuoting(true);
    const timer = setTimeout(() => {
      // Jangteo Swap's own router and the aggregator both quote; the better fill wins.
      Promise.all([
        bestQuote(router, pools, [tkrw, WETH], tin.address, tout.address, amt).catch(() => null),
        agg && routes?.length ? aggQuote(agg, routes, tin.address, tout.address, amt).catch(() => null) : Promise.resolve(null),
      ])
        .then(([h, a]) => live && setQuote(a && (!h || a.amountOut > h.amountOut) ? a : h))
        .catch(() => live && setQuote(null))
        .finally(() => live && setQuoting(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [router, pools, tin, tout, amt, tkrw, tick, agg, routes]);

  if (deployment && (!factory || !router)) return <main className="page"><p className="empty">{s.notDeployed}</p></main>;

  const symOf = (a: Address) => (same(a, WETH) && (same(tin?.address, ETH) || same(tout?.address, ETH)) ? "ETH" : allTokens.find((x) => same(x.address, a))?.symbol ?? market?.tokens.find((x) => same(x.address, a))?.symbol ?? "?");
  const short = (balIn ?? 0n) < amt;
  const rate = quote && tin && tout ? Number(formatUnits(quote.amountOut, tout.decimals)) / Number(formatUnits(amt, tin.decimals)) : 0;
  const minOut = quote ? (quote.amountOut * BigInt(10_000 - slip)) / 10_000n : 0n;
  const noRoute = !quoting && amt > 0n && !quote && !!tin && !!tout && !same(tin.address, tout.address);
  const label = !account ? s.connect : amt === 0n ? s.enter : short && tin ? s.tooMuch(tin.symbol) : noRoute ? s.noRoute : s.swap;

  const pick = (which: "in" | "out") => (v: string) => {
    const a = v as Address;
    if (which === "in") {
      if (same(a, tokenOut)) setTokenOut(tokenIn);
      setTokenIn(a);
    } else {
      if (same(a, tokenIn)) setTokenIn(tokenOut);
      setTokenOut(a);
    }
  };

  return (
    <main className="page swap">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">스왑</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
      </header>

      <div className="tabs swap__tabs" role="tablist">
        {(deployment?.bridge ? (["swap", "pool", "bridge"] as const) : (["swap", "pool"] as const)).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {k === "swap" ? s.tabSwap : k === "pool" ? s.tabPool : s.tabBridge}
          </button>
        ))}
      </div>

      <div className="swap__body">
        <div className="swap__main">
        {tab === "pool" && router && pools && (
          <LiquidityPanel router={router} pools={pools} tokens={allTokens} stats={stats} preset={preset} slip={slip} TokenSelect={TokenSelect} />
        )}
        {tab === "pool" && <Slippage slip={slip} setSlip={setSlip} label={s.slippage} />}
        {tab === "bridge" && deployment?.bridge && <BridgePanel bridge={deployment.bridge} door={deployment.withdraw} fast={deployment.fastExit} />}
        {tab === "swap" && (
        <form
          className="swapcard"
          onSubmit={(e) => {
            e.preventDefault();
            if (!quote || !tin || !tout || !router) return;
            const q = quote;
            void run(s.swapping, s.swapped, (w) => (q.via === "agg" ? aggSwap(w, agg!, q, slip) : swap(w, router, tin.address, tout.address, q, slip))).then(
              (ok) => ok && setAmount(""),
            );
          }}
        >
          <div className="swapleg">
            <div className="swapleg__head">
              <span>{s.from}</span>
              {account && tin && (
                <button type="button" className="swapleg__bal" onClick={() => setAmount(fmtAmount(balIn ?? 0n, tin, 18).replace(/,/g, ""))}>
                  {s.balance(fmtAmount(balIn ?? 0n, tin))} · {s.max}
                </button>
              )}
            </div>
            <div className="swapleg__row">
              <input
                className="swapleg__amount"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                aria-label={s.from}
                aria-invalid={short && amt > 0n}
              />
              <TokenSelect tokens={allTokens} value={tin?.address} onChange={pick("in")} label={s.pick} />
            </div>
          </div>

          <button
            type="button"
            className="swapflip"
            aria-label={s.flip}
            onClick={() => {
              setTokenIn(tokenOut);
              setTokenOut(tokenIn);
              if (quote && tout) setAmount(fmtAmount(quote.amountOut, tout, 18).replace(/,/g, ""));
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M5 2v11M5 13l-3-3M5 13l3-3M11 14V3M11 3 8 6M11 3l3 3" />
            </svg>
          </button>

          <div className="swapleg">
            <div className="swapleg__head">
              <span>{s.to}</span>
              {account && tout && <span className="swapleg__bal">{s.balance(fmtAmount(balOut ?? 0n, tout))}</span>}
            </div>
            <div className="swapleg__row">
              {(() => {
                const shown = quote && tout ? fmtAmount(quote.amountOut, tout) : "0";
                // Long figures step the type down instead of being cut off.
                const size = shown.length > 11 ? "is-xlong" : shown.length > 8 ? "is-long" : "";
                return (
                  <output className={`swapleg__amount ${size} ${quoting ? "is-quoting" : ""}`} aria-live="polite">
                    {shown}
                  </output>
                );
              })()}
              <TokenSelect tokens={allTokens} value={tout?.address} onChange={pick("out")} label={s.pick} />
            </div>
          </div>

          {quote && tin && tout && (
            <dl className="swapinfo">
              <div>
                <dt>{s.rate}</dt>
                <dd>
                  {/* Quote in won (or ETH) like Korean exchanges do: 1 HANJI = 150 tKRW, not the other way round. */}
                  {isQuoteToken(tin.address, tkrw)
                    ? s.rateVal(tout.symbol, tin.symbol, fmtRate(1 / rate))
                    : s.rateVal(tin.symbol, tout.symbol, fmtRate(rate))}
                </dd>
              </div>
              <div>
                <dt>{s.minOut}</dt>
                <dd>
                  {fmtAmount(minOut, tout)} {tout.symbol}
                </dd>
              </div>
              <div>
                <dt>{s.impact}</dt>
                <dd className={quote.impactBps > 300 ? "is-warn" : ""}>{quote.impactBps < 1 ? "< 0.01%" : `${(quote.impactBps / 100).toFixed(2)}%`}</dd>
              </div>
              <div>
                <dt>{s.route}</dt>
                <dd>
                  {quote.path.map(symOf).join(" → ")}
                  {quote.via === "agg" && (
                    <small className="swapinfo__via"> {s.via([...new Set(quote.dexes)].map((d) => dexLabel(d, lang)).join(" + "))}</small>
                  )}
                </dd>
              </div>
              {quote.via === "agg" ? (
                <div>
                  <dt>{s.aggFee}</dt>
                  <dd>{quote.fee === 0n ? s.aggFeeFree : s.aggFeeVal(`${fmtAmount(quote.fee, tin)} ${tin.symbol}`)}</dd>
                </div>
              ) : (
                <div>
                  <dt>{s.lpFee}</dt>
                  <dd>{s.lpFeeVal}</dd>
                </div>
              )}
            </dl>
          )}
          {quote && quote.impactBps > 300 && <p className="form__note form__note--warn">{s.highImpact}</p>}
          {quote?.via === "agg" && <p className="form__note">{s.dexPoolFee}</p>}

          <Slippage slip={slip} setSlip={setSlip} label={s.slippage} />

          <button className="btn btn--ink btn--wide swapcard__go" disabled={!account || !quote || short || quoting}>
            {quoting && amt > 0n ? s.quoting : label}
          </button>
        </form>
        )}
        </div>

        <section className="pools" aria-labelledby="pools-h">
          {stats && (
            <dl className="swaptotals">
              <div>
                <dt>{s.totalsTvl}</dt>
                <dd>{won(stats.totals.tvl)}</dd>
              </div>
              <div>
                <dt>{s.totalsVol}</dt>
                <dd>{won(stats.totals.volume24h)}</dd>
              </div>
              <div>
                <dt>{s.totalsFees}</dt>
                <dd>{won(stats.totals.lpFees7d)}</dd>
              </div>
            </dl>
          )}
          <FeeSplit s={s} />
          {agg && <p className="form__note">{s.aggNote}</p>}
          <h2 id="pools-h">{s.poolsH}</h2>
          {error && <p className="empty">{s.loadError(error)}</p>}
          {pools && pools.length === 0 && <p className="empty">{s.noPools}</p>}
          {pools && pools.length > 0 && (
            <div className="scrollx">
            <table className="poolsTable">
              <thead>
                <tr>
                  <th scope="col">{s.pair}</th>
                  <th scope="col" className="num">{s.price}</th>
                  <th scope="col" className="num">{s.tvl}</th>
                  <th scope="col" className="num">{s.vol24}</th>
                  <th scope="col" className="num" title={s.aprNote}>{s.apr}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <PoolRow
                    key={p.pair}
                    p={p}
                    tkrw={tkrw}
                    stats={stats}
                    onTrade={(a, b) => (setTab("swap"), setTokenIn(a), setTokenOut(b), setAmount(""))}
                    onAdd={(a, b) => (setTab("pool"), setPreset((x) => ({ a, b, nonce: x.nonce + 1 })))}
                    s={s}
                  />
                ))}
              </tbody>
            </table>
            </div>
          )}
          {stats && (
            <p className="form__note">
              {s.aprNote} {s.updated(dateKst(stats.updatedAt, lang))}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

/** Pools are quoted against tKRW (or WETH) when they have one, the way Korean exchanges quote in won. */
function PoolRow({
  p,
  tkrw,
  stats,
  onTrade,
  onAdd,
  s,
}: {
  p: Pool;
  tkrw?: Address;
  stats: SwapStats | null | undefined;
  onTrade: (a: Address, b: Address) => void;
  onAdd: (a: Address, b: Address) => void;
  s: { trade: string; add: string };
}) {
  const quoteIsT0 = same(p.token0.address, tkrw) || (!same(p.token1.address, tkrw) && same(p.token0.address, WETH));
  const [base, quote] = quoteIsT0 ? [p.token1, p.token0] : [p.token0, p.token1];
  const price = poolPrice(p, base.address);
  const st = statsFor(stats, p.pair);
  return (
    <tr>
      <th scope="row">
        <span className="poolsTable__pair">
          {base.symbol}
          <small>/{quote.symbol}</small>
        </span>
      </th>
      <td className="num">
        {fmtRate(price)} <small>{quote.symbol}</small>
      </td>
      <td className="num">{st?.tvl != null ? statValue(st, st.tvl) : "—"}</td>
      <td className="num">{st?.volume24h != null ? statValue(st, st.volume24h) : "—"}</td>
      <td className="num is-apr">{st?.apr != null ? pct(st.apr) : "—"}</td>
      <td className="num">
        <span className="poolsTable__acts">
          <button className="btn btn--line poolsTable__go" onClick={() => onTrade(quote.address, base.address)}>
            {s.trade}
          </button>
          <button className="btn btn--quiet poolsTable__go" onClick={() => onAdd(base.address, quote.address)}>
            {s.add}
          </button>
        </span>
      </td>
    </tr>
  );
}

/** The 0.3% swap fee, drawn to scale: 0.25% to liquidity providers, 0.05% to Jangteo. */
function FeeSplit({ s }: { s: { feeH: string; feeLp: string; feeLpVal: string; feeDev: string; feeDevVal: string; feeNote: string } }) {
  return (
    <figure className="feesplit">
      <figcaption>{s.feeH}</figcaption>
      <div className="feesplit__bar" aria-hidden>
        <i className="feesplit__lp" />
        <i className="feesplit__dev" />
      </div>
      <dl className="feesplit__legend">
        <div>
          <dt>
            <i className="feesplit__lp" aria-hidden /> {s.feeLp}
          </dt>
          <dd>{s.feeLpVal}</dd>
        </div>
        <div>
          <dt>
            <i className="feesplit__dev" aria-hidden /> {s.feeDev}
          </dt>
          <dd>{s.feeDevVal}</dd>
        </div>
      </dl>
      <p className="form__note">{s.feeNote}</p>
    </figure>
  );
}

function Slippage({ slip, setSlip, label }: { slip: number; setSlip: (v: number) => void; label: string }) {
  return (
    <fieldset className="segmented segmented--slip">
      <legend>{label}</legend>
      {SLIPPAGES.map((v) => (
        <label key={v} className={slip === v ? "is-on" : ""}>
          <input type="radio" name="slip" checked={slip === v} onChange={() => setSlip(v)} />
          {v / 100}%
        </label>
      ))}
    </fieldset>
  );
}

const TokenSelect = TokenPicker;
