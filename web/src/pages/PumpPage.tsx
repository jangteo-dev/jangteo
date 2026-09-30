import { useEffect, useState } from "react";
import { formatEther, parseEther, type Address } from "viem";
import { useApp, useChain } from "../app";
import { PopGauge, TokenMark } from "../components/PumpVisuals";
import { TvChart, fmtTiny } from "../components/TvChart";
import { useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { client, explorer, shortAddr } from "../lib/chain";
import {
  fmtEth,
  fmtTokens,
  pumpTx,
  quoteBuy,
  quoteSell,
  readCurve,
  readHolders,
  readLaunch,
  readTrades,
  tokenBalance,
  type PumpLaunch,
  creatorEarned,
  pumpOf,
} from "../lib/pump";
import { ago } from "./PumpList";

const DEAD = "0x000000000000000000000000000000000000dead";
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const SLIPS = [100, 300, 1000];

export function PumpPage({ token }: { token: Address }) {
  const { deployment, account, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.pm;
  // New coins live on v2; coins launched before 2026-09-26 keep trading on v1.
  const { data: pump } = useChain(async () => (deployment ? pumpOf(deployment, token) : null), [deployment, token]);
  const { data: l, error } = useChain(async () => (pump ? readLaunch(pump, token) : null), [pump, token, tick]);
  const { data: curve } = useChain(async () => (pump ? readCurve(pump) : null), [pump]);
  const { data: trades } = useChain(async () => (pump && l ? readTrades(pump, l) : []), [pump, l?.token, l?.trades]);
  const { data: holders } = useChain(async () => (l ? readHolders(l) : []), [l?.token, l?.trades]);

  if (error) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;
  if (!l || !pump || !curve) return <main className="page"><p className="empty">{s.loading}</p></main>;

  const tag = (a: string) =>
    same(a, pump) ? s.curveTag : same(a, l.pair) ? s.poolTag : same(a, DEAD) ? s.burnTag : same(a, l.creator) ? s.creatorTag : null;

  return (
    <main className="page pumptoken">
      <a className="back" href="#/ppeongtwigi">{s.back}</a>

      <header className="pumptoken__head">
        <TokenMark l={l} size={96} />
        <div>
          <h1>
            {l.name} <span className="pumptoken__sym">{l.symbol}</span>
          </h1>
          <p className="pumptoken__by">
            {s.by(same(l.creator, account ?? undefined) ? s.you : shortAddr(l.creator))} · {s.age(ago(l.createdAt, lang))}
          </p>
        </div>
      </header>

      <div className="pumptoken__body">
        <section className="pumptoken__main">
          <dl className="pumpfigs">
            <div>
              <dt>{s.mcap}</dt>
              <dd>{fmtEth(l.marketCap, 2)} ETH</dd>
            </div>
            <div>
              <dt>{s.price}</dt>
              <dd>{fmtTiny(l.price)} ETH</dd>
            </div>
            <div>
              <dt>{s.raised}</dt>
              <dd>{l.graduated ? s.graduatedTag : s.raisedVal(fmtEth(l.realEth, 3))}</dd>
            </div>
            <div>
              <dt>{s.volume}</dt>
              <dd>{fmtEth(l.volume + (trades ?? []).filter((x) => x.venue === "pool").reduce((a, x) => a + x.eth, 0n), 3)} ETH</dd>
            </div>
            <div>
              <dt title={s.creatorEarnedNote}>{s.creatorEarned}</dt>
              <dd>{fmtEth(creatorEarned(l), 4)} ETH</dd>
            </div>
          </dl>

          {!l.graduated && (
            <div className="gradmeter">
              <span className="gradbar gradbar--big" aria-hidden>
                <i style={{ width: `${Math.max(1, l.progress * 100)}%` }} />
              </span>
              <p>
                {s.progress} {(l.progress * 100).toFixed(2)}%
              </p>
            </div>
          )}

          <PopGauge progress={l.progress} raised={Number(l.realEth) / 1e18} threshold={Number(curve.threshold) / 1e18} graduated={l.graduated} label={s.gauge} size={280} />

          {l.graduated && <Graduated l={l} pump={pump} s={s} />}

          <section aria-labelledby="chart-h" className="pumpblock">
            <h2 id="chart-h">{s.chartH}</h2>
            <TvChart
              trades={trades ?? []}
              symbol={l.symbol}
              circulating={l.price > 0 ? l.marketCap / l.price : 1e9}
              labels={{ price: s.price, mcap: s.mcap, volume: s.volume, graduated: s.graduatedTag, empty: s.chartEmpty }}
            />
          </section>

          {l.meta.about && <p className="profile__about">{l.meta.about}</p>}
          {(l.meta.site || l.meta.x || l.meta.telegram) && (
            <ul className="profile__links">
              {(["site", "x", "telegram"] as const)
                .filter((k) => l.meta[k])
                .map((k) => (
                  <li key={k}>
                    <a href={l.meta[k]} target="_blank" rel="noreferrer nofollow ugc">
                      {s[k]}
                    </a>
                  </li>
                ))}
            </ul>
          )}

          <div className="pumptoken__lists">
            <section aria-labelledby="trades-h" className="pumpblock">
              <h2 id="trades-h">{s.tradesH}</h2>
              <div className="scrollx">
              <table className="tradesTable">
                <tbody>
                  {(trades ?? [])
                    .slice(-30)
                    .reverse()
                    .map((x) => (
                      <tr key={x.hash + x.trader + x.venue}>
                        <td className={x.isBuy ? "is-bid" : "is-ask"}>
                          {x.isBuy ? s.buy : s.sell}
                          {x.venue === "pool" && <span className="tag">{s.poolTag}</span>}
                        </td>
                        <td>{same(x.trader, account ?? undefined) ? s.you : shortAddr(x.trader)}</td>
                        <td className="num">{fmtEth(x.eth, 4)} ETH</td>
                        <td className="num">{fmtTokens(x.tokens)}</td>
                        <td className="num">
                          <a href={`${explorer}/tx/${x.hash}`} target="_blank" rel="noreferrer">
                            {s.age(ago(x.at, lang))}
                          </a>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              </div>
            </section>
            <section aria-labelledby="holders-h" className="pumpblock">
              <h2 id="holders-h">{s.holdersH}</h2>
              <ol className="holders">
                {(holders ?? []).slice(0, 12).map((h) => (
                  <li key={h.address}>
                    <span>
                      {same(h.address, account ?? undefined) ? s.you : shortAddr(h.address)}
                      {tag(h.address) && <span className="tag">{tag(h.address)}</span>}
                    </span>
                    <span className="num">{(h.share * 100).toFixed(2)}%</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </section>

        <aside className="pumptoken__side">
          {!l.graduated ? <TradeBox l={l} pump={pump} s={s} /> : <a className="btn btn--ink btn--wide" href={`#/swap?in=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&out=${l.token}`}>{s.tradeOnSwap}</a>}
          <CreatorFees l={l} pump={pump} s={s} />
          <div className="outside">
            <h2>{s.outsideH}</h2>
            <p>{s.outsideBody}</p>
            <p className="form__note">
              <a href={`${explorer}/address/${l.token}`} target="_blank" rel="noreferrer">{s.contract}</a>{" "}
              {deployment?.pumpRouter && (
                <a href={`${explorer}/address/${same(pump, deployment.pumpV1) ? (deployment.pumpRouterV1 ?? deployment.pumpRouter) : deployment.pumpRouter}`} target="_blank" rel="noreferrer">{s.router}</a>
              )}
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Graduated({ l, pump, s }: { l: PumpLaunch; pump: Address; s: Dict["pm"] }) {
  const { data } = useChain(async () => {
    const head = await client.getBlock();
    const gradBlock = head.number - BigInt(Math.max(0, Number(head.timestamp) - l.graduatedAt));
    const logs = await client.getLogs({
      address: pump,
      event: {
        type: "event",
        name: "Graduated",
        inputs: [
          { type: "address", name: "token", indexed: true },
          { type: "address", name: "pair" },
          { type: "uint256", name: "ethLiquidity" },
          { type: "uint256", name: "tokenLiquidity" },
          { type: "uint256", name: "burned" },
          { type: "uint256", name: "fee" },
          { type: "uint256", name: "lp" },
        ],
      },
      args: { token: l.token },
      // Graduation happened at a known moment (1-second blocks): look in a small window around it.
      fromBlock: gradBlock - 300n,
      toBlock: gradBlock + 300n,
    });
    return logs[0]?.args;
  }, [l.token]);
  return (
    <div className="gradpanel">
      <p className="gradpanel__stamp">{s.graduatedTag}</p>
      <div>
        <h2>{s.gradH}</h2>
        {data && <p>{s.gradBody(fmtEth(data.ethLiquidity!, 3), fmtTokens(data.tokenLiquidity!), fmtTokens(data.burned!))}</p>}
        <p className="pool__links">
          <a href={`#/swap?in=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&out=${l.token}`}>{s.tradeOnSwap}</a>
          <a href={`${explorer}/address/${l.pair}`} target="_blank" rel="noreferrer">{s.viewPool}</a>
        </p>
      </div>
    </div>
  );
}

function TradeBox({ l, pump, s }: { l: PumpLaunch; pump: Address; s: Dict["pm"] }) {
  const { account, run, tick } = useApp();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState(300);
  const [q, setQ] = useState<{ out: bigint; refund: bigint } | null>(null);
  const { data: bal } = useChain(
    async () => (account ? Promise.all([client.getBalance({ address: account }), tokenBalance(l.token, account)]) : [0n, 0n]),
    [account, l.token, tick],
  );
  const amt = (() => {
    try {
      return amount ? parseEther(amount) : 0n;
    } catch {
      return 0n;
    }
  })();

  useEffect(() => {
    if (amt === 0n) return setQ(null);
    let live = true;
    const timer = setTimeout(() => {
      (side === "buy" ? quoteBuy(pump, l.token, amt) : quoteSell(pump, l.token, amt).then((out) => ({ out, refund: 0n, used: amt })))
        .then((r) => live && setQ({ out: r.out, refund: r.refund }))
        .catch(() => live && setQ(null));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [amt, side, pump, l.token, l.trades]);

  const have = side === "buy" ? (bal?.[0] ?? 0n) : (bal?.[1] ?? 0n);
  const short = amt > have;
  const label = !account ? s.connect : amt === 0n ? s.enter : short ? s.tooMuch : side === "buy" ? s.buyBtn(l.symbol) : s.sellBtn(l.symbol);
  const presets = side === "buy" ? ["0.01", "0.05", "0.1", "0.5"] : ["25", "50", "75", "100"];

  return (
    <form
      className="tradebox"
      onSubmit={(e) => {
        e.preventDefault();
        if (!q) return;
        void run(side === "buy" ? s.buying : s.selling, side === "buy" ? s.bought : s.sold, (w) =>
          side === "buy" ? pumpTx.buy(w, pump, l.token, amt, q.out, slip) : pumpTx.sell(w, pump, l.token, amt, q.out, slip),
        ).then((ok) => ok && setAmount(""));
      }}
    >
      <div className="tradebox__sides" role="tablist">
        {(["buy", "sell"] as const).map((k) => (
          <button
            type="button"
            key={k}
            role="tab"
            aria-selected={side === k}
            className={k === "buy" ? "is-bid" : "is-ask"}
            onClick={() => (setSide(k), setAmount(""))}
          >
            {k === "buy" ? s.buy : s.sell}
          </button>
        ))}
      </div>
      <label className="tradebox__amount">
        <span>
          {side === "buy" ? s.payEth : s.sellAmount(l.symbol)}
          {account && <em>{s.balance(side === "buy" ? fmtEth(have, 4) : fmtTokens(have))}</em>}
        </span>
        <input inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} aria-invalid={short && amt > 0n} />
      </label>
      <div className="chips">
        {presets.map((p) => (
          <button
            type="button"
            key={p}
            className="chip"
            onClick={() => setAmount(side === "buy" ? p : formatEther((have * BigInt(p)) / 100n))}
          >
            {side === "buy" ? `${p} ETH` : `${p}%`}
          </button>
        ))}
      </div>
      {q && (
        <dl className="swapinfo">
          <div>
            <dt>{s.youGet}</dt>
            <dd>{side === "buy" ? `${fmtTokens(q.out)} ${l.symbol}` : `${fmtEth(q.out, 6)} ETH`}</dd>
          </div>
        </dl>
      )}
      {q && q.refund > 0n && <p className="form__note">{s.refundNote(fmtEth(q.refund, 4))}</p>}
      <fieldset className="segmented segmented--slip">
        <legend>{s.slippage}</legend>
        {SLIPS.map((v) => (
          <label key={v} className={slip === v ? "is-on" : ""}>
            <input type="radio" name="pslip" checked={slip === v} onChange={() => setSlip(v)} />
            {v / 100}%
          </label>
        ))}
      </fieldset>
      <button className={`btn btn--wide ${side === "buy" ? "btn--bid" : "btn--ask"}`} disabled={!account || !q || short || amt === 0n}>
        {label}
      </button>
      <p className="form__note">{s.feeNote}</p>
    </form>
  );
}

function CreatorFees({ l, pump, s }: { l: PumpLaunch; pump: Address; s: Dict["pm"] }) {
  const { account, run } = useApp();
  if (!same(account ?? undefined, l.creator) || l.creatorFees === 0n) return null;
  return (
    <div className="position">
      <p>{s.creatorFees(fmtEth(l.creatorFees, 6))}</p>
      <button className="btn btn--gold btn--wide" onClick={() => void run(s.claiming, s.claimed, (w) => pumpTx.claimCreatorFees(w, pump, l.token))}>
        {s.claim}
      </button>
    </div>
  );
}
