import { useEffect, useState } from "react";
import { type Address } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import {
  addLiquidity,
  balanceOf,
  ETH,
  findPool,
  fmtAmount,
  mintPreview,
  pairedAmount,
  parseAmount,
  readPositions,
  removeLiquidity,
  statsFor,
  statValue,
  WETH,
  type Pool,
  type Position,
  type SwapStats,
  type Token,
} from "../lib/swap";

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const plain = (v: bigint, t: Token) => fmtAmount(v, t, 18).replace(/,/g, "");
export const pct = (x: number) => `${(x * 100).toLocaleString("en-US", { maximumFractionDigits: x < 0.001 ? 4 : 2 })}%`;
export const won = (v: number) => `₩${Math.round(v).toLocaleString("en-US")}`;

export function LiquidityPanel(props: {
  router: Address;
  pools: Pool[];
  tokens: Token[];
  stats: SwapStats | null | undefined;
  preset: { a?: Address; b?: Address; nonce: number };
  slip: number;
  TokenSelect: (p: { tokens: Token[]; value?: Address; onChange: (v: string) => void; label: string }) => React.ReactNode;
}) {
  const { router, pools, tokens, stats, preset, slip, TokenSelect } = props;
  const { account, tick } = useApp();
  const { t } = useLang();
  const s = t.sw;
  const { data: positions } = useChain(async () => (account ? readPositions(pools, account) : []), [account, pools, tick]);

  return (
    <div className="liq">
      <section className="liq__positions" aria-labelledby="pos-h">
        <h2 id="pos-h">{s.positionsH}</h2>
        {account && positions && positions.length === 0 && <p className="empty">{s.noPositions}</p>}
        {!account && <p className="empty">{s.connectLp}</p>}
        <ul className="positions">
          {positions?.map((p) => (
            <PositionCard key={p.pool.pair} pos={p} router={router} stats={stats} slip={slip} />
          ))}
        </ul>
      </section>
      <AddForm router={router} pools={pools} tokens={tokens} stats={stats} preset={preset} slip={slip} TokenSelect={TokenSelect} />
    </div>
  );
}

function AddForm({
  router,
  pools,
  tokens,
  stats,
  preset,
  slip,
  TokenSelect,
}: {
  router: Address;
  pools: Pool[];
  tokens: Token[];
  stats: SwapStats | null | undefined;
  preset: { a?: Address; b?: Address; nonce: number };
  slip: number;
  TokenSelect: (p: { tokens: Token[]; value?: Address; onChange: (v: string) => void; label: string }) => React.ReactNode;
}) {
  const { account, run, tick } = useApp();
  const { t } = useLang();
  const s = t.sw;
  const [a, setA] = useState<Address | undefined>(preset.a);
  const [b, setB] = useState<Address | undefined>(preset.b);
  const [amtA, setAmtA] = useState("");
  const [amtB, setAmtB] = useState("");
  const [lead, setLead] = useState<"a" | "b">("a");

  // Without a preset, start from the first pool so the form is never empty.
  useEffect(() => {
    if (preset.a || a || !pools[0]) return;
    setA(pools[0].token1.address);
    setB(pools[0].token0.address);
  }, [pools, preset.a, a]);

  useEffect(() => {
    if (preset.a) setA(preset.a);
    if (preset.b) setB(preset.b);
    setAmtA("");
    setAmtB("");
  }, [preset.nonce, preset.a, preset.b]);

  const ta = tokens.find((x) => same(x.address, a));
  const tb = tokens.find((x) => same(x.address, b));
  const pool = a && b ? findPool(pools, a, b) : undefined;
  const isNew = !!ta && !!tb && !pool;
  const sameToken = !!a && !!b && (same(a, b) || (same(a, ETH) && same(b, WETH)) || (same(a, WETH) && same(b, ETH)));

  // In an existing pool the second amount follows the first at the pool's price.
  useEffect(() => {
    if (!pool || !ta || !tb) return;
    if (lead === "a") {
      const x = parseAmount(amtA, ta);
      setAmtB(x ? plain(pairedAmount(pool, ta.address, x), tb) : "");
    } else {
      const y = parseAmount(amtB, tb);
      setAmtA(y ? plain(pairedAmount(pool, tb.address, y), ta) : "");
    }
  }, [amtA, amtB, lead, pool, ta, tb]);

  const { data: bals } = useChain(async () => (account && ta && tb ? Promise.all([balanceOf(ta.address, account), balanceOf(tb.address, account)]) : [0n, 0n]), [account, a, b, tick]);
  const xa = ta ? parseAmount(amtA, ta) : 0n;
  const xb = tb ? parseAmount(amtB, tb) : 0n;
  const preview = ta && tb && xa && xb ? mintPreview(pool, ta.address, xa, xb) : null;
  const shortA = !!bals && xa > bals[0];
  const shortB = !!bals && xb > bals[1];
  const st = pool ? statsFor(stats, pool.pair) : undefined;
  const ready = !!account && !!ta && !!tb && xa > 0n && xb > 0n && !shortA && !shortB && !sameToken && !!preview && preview.lp > 0n;
  const label = !account
    ? s.connectLp
    : sameToken
      ? s.same
      : xa === 0n || xb === 0n
        ? s.enter
        : shortA && ta
          ? s.tooMuch(ta.symbol)
          : shortB && tb
            ? s.tooMuch(tb.symbol)
            : s.addBtn;

  return (
    <form
      className="swapcard liq__add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ta || !tb) return;
        void run(s.adding, s.added, (w) => addLiquidity(w, router, ta.address, tb.address, xa, xb, slip, isNew)).then((ok) => ok && (setAmtA(""), setAmtB("")));
      }}
    >
      <h2>{s.addH}</h2>
      <p className="form__note">{s.addLede}</p>
      {([
        ["a", ta, amtA, setAmtA, setA, bals?.[0]],
        ["b", tb, amtB, setAmtB, setB, bals?.[1]],
      ] as const).map(([k, tok, val, setVal, setTok, bal]) => (
        <div className="swapleg" key={k}>
          <div className="swapleg__head">
            <span>{k === "a" ? "A" : "B"}</span>
            {account && tok && (
              <button type="button" className="swapleg__bal" onClick={() => (setLead(k), setVal(plain(bal ?? 0n, tok)))}>
                {s.balance(fmtAmount(bal ?? 0n, tok))} · {s.max}
              </button>
            )}
          </div>
          <div className="swapleg__row">
            <input
              className="swapleg__amount"
              inputMode="decimal"
              placeholder="0"
              value={val}
              onChange={(e) => (setLead(k), setVal(e.target.value.replace(/[^\d.]/g, "")))}
              aria-label={`${s.addH} ${k.toUpperCase()}`}
              aria-invalid={k === "a" ? shortA : shortB}
            />
            <TokenSelect tokens={tokens} value={tok?.address} onChange={(v) => (setTok(v as Address), setVal(""))} label={s.pick} />
          </div>
        </div>
      ))}

      {isNew && <p className="form__note form__note--warn">{s.newPool}</p>}
      {isNew && ta && tb && xa > 0n && xb > 0n && (
        <p className="form__note">{s.startPrice(ta.symbol, tb.symbol, (Number(amtB) / Number(amtA)).toLocaleString("en-US", { maximumSignificantDigits: 6 }))}</p>
      )}

      {preview && (
        <dl className="swapinfo">
          <div>
            <dt>{s.youGet}</dt>
            <dd>{s.lpTokens(fmtAmount(preview.lp, { decimals: 18 }))}</dd>
          </div>
          <div>
            <dt>{s.poolShare}</dt>
            <dd>{pct(preview.share)}</dd>
          </div>
          {st?.apr != null && (
            <div>
              <dt>{s.poolApr}</dt>
              <dd className="is-apr">{pct(st.apr)}</dd>
            </div>
          )}
        </dl>
      )}

      <button className="btn btn--ink btn--wide swapcard__go" disabled={!ready}>
        {label}
      </button>
    </form>
  );
}

function PositionCard({ pos, router, stats, slip }: { pos: Position; router: Address; stats: SwapStats | null | undefined; slip: number }) {
  const { run } = useApp();
  const { t } = useLang();
  const s = t.sw;
  const [open, setOpen] = useState(false);
  const [part, setPart] = useState(100);
  const [asEth, setAsEth] = useState(true);
  const p = pos.pool;
  const st = statsFor(stats, p.pair);
  const value = st?.tvl != null ? st.tvl * pos.share : null;
  const shown = value !== null && st ? statValue(st, value) : null;
  const lp = (pos.lp * BigInt(part)) / 100n;
  const out0 = p.totalSupply ? (lp * p.reserve0) / p.totalSupply : 0n;
  const out1 = p.totalSupply ? (lp * p.reserve1) / p.totalSupply : 0n;
  const hasWeth = same(p.token0.address, WETH) || same(p.token1.address, WETH);
  const sym = (tk: Token) => (hasWeth && asEth && same(tk.address, WETH) ? "ETH" : tk.symbol);

  return (
    <li className="position-card">
      <div className="position-card__head">
        <span className="poolsTable__pair">
          {p.token0.symbol}
          <small>/{p.token1.symbol}</small>
        </span>
        <span className="position-card__share">{s.share(pct(pos.share))}</span>
      </div>
      <p className="position-card__amounts">
        {fmtAmount(pos.amount0, p.token0)} {p.token0.symbol} · {fmtAmount(pos.amount1, p.token1)} {p.token1.symbol}
      </p>
      <p className="position-card__meta">
        {shown && (
          <span>
            {s.value} {shown}
          </span>
        )}
        {st?.apr != null && <span className="is-apr">APR {pct(st.apr)}</span>}
      </p>
      {!open ? (
        <button className="btn btn--line" onClick={() => setOpen(true)}>
          {s.remove}
        </button>
      ) : (
        <form
          className="position-card__remove"
          onSubmit={(e) => {
            e.preventDefault();
            void run(s.removing, s.removed, (w) => removeLiquidity(w, router, pos, lp, slip, asEth)).then((ok) => ok && setOpen(false));
          }}
        >
          <label>
            <span>{s.removePct(part)}</span>
            <input type="range" min={1} max={100} value={part} onChange={(e) => setPart(Number(e.target.value))} />
          </label>
          <div className="chips">
            {[25, 50, 75, 100].map((v) => (
              <button type="button" key={v} className={`chip ${part === v ? "is-on" : ""}`} onClick={() => setPart(v)}>
                {v}%
              </button>
            ))}
          </div>
          <p className="form__note">
            {s.receive}: {fmtAmount(out0, p.token0)} {sym(p.token0)} + {fmtAmount(out1, p.token1)} {sym(p.token1)}
          </p>
          {hasWeth && (
            <label className="check">
              <input type="checkbox" checked={asEth} onChange={(e) => setAsEth(e.target.checked)} />
              <span>{s.asEth}</span>
            </label>
          )}
          <button className="btn btn--ink btn--wide" disabled={lp === 0n}>
            {s.removeBtn}
          </button>
        </form>
      )}
    </li>
  );
}
