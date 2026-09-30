import { useMemo } from "react";
import { formatEther, type Address } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { client } from "../lib/chain";
import { holdings, krw, loadMarket, tradeLink, type MarketToken } from "../lib/market";
import { fmtTiny } from "../lib/tiny";
import { TokenMark } from "./PumpVisuals";

const ALLOC = ["var(--jjok)", "var(--hong)", "var(--nok)", "var(--hwang)", "#7c5cbf", "#c2410c", "var(--ink-3)"];
const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
const tone = (v: number | null) => (v === null || Math.abs(v) < 1e-9 ? "" : v > 0 ? "is-bid" : "is-ask");
const amount = (n: number) => (n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 4 }) : fmtTiny(n));

interface Row {
  t: MarketToken | null; // null = native ETH
  symbol: string;
  name: string;
  amount: number;
  priceKrw: number;
  valueKrw: number;
  change24h: number | null;
  pnlKrw: number | null;
}

/**
 * Everything the connected wallet holds on GIWA, valued in won at the indexer's prices: total,
 * 24-hour change, allocation, and per-token profit and loss from its own trades (money received
 * from sells plus what it still holds, minus what the buys cost).
 */
export function Portfolio({ account }: { account: Address }) {
  const { tick } = useApp();
  const { t, lang } = useLang();
  const s = t.pf;
  const { data: m } = useChain(loadMarket, [tick]);
  const { data: held } = useChain(async () => (m ? holdings(account, m.tokens) : null), [account, m?.updatedAt, tick]);
  const { data: eth } = useChain(async () => client.getBalance({ address: account }), [account, tick]);

  const rows = useMemo<Row[]>(() => {
    if (!m || !held || eth === undefined) return [];
    const flows = m.flows[account.toLowerCase()] ?? {};
    const out: Row[] = [];
    const ethN = Number(formatEther(eth));
    if (ethN > 0) out.push({ t: null, symbol: "ETH", name: "Ether", amount: ethN, priceKrw: m.ethKrw, valueKrw: ethN * m.ethKrw, change24h: null, pnlKrw: null });
    for (const h of held) {
      const price = h.token.priceKrw ?? 0;
      const value = h.amount * price;
      const f = flows[h.token.address.toLowerCase()];
      out.push({
        t: h.token,
        symbol: h.token.symbol,
        name: h.token.name,
        amount: h.amount,
        priceKrw: price,
        valueKrw: value,
        change24h: h.token.change24h,
        pnlKrw: f && f.spentKrw > 0 ? f.receivedKrw + value - f.spentKrw : null,
      });
    }
    return out.sort((a, b) => b.valueKrw - a.valueKrw);
  }, [m, held, eth, account]);

  if (!m || !held || eth === undefined) return <p className="empty">{s.loading}</p>;
  const total = rows.reduce((a, r) => a + r.valueKrw, 0);
  // Yesterday's value of today's holdings, token by token: the portfolio's 24h move.
  const before = rows.reduce((a, r) => a + (r.change24h !== null ? r.valueKrw / (1 + r.change24h) : r.valueKrw), 0);
  const change = before > 0 ? (total - before) / before : null;
  const pnl = rows.reduce((a, r) => a + (r.pnlKrw ?? 0), 0);
  const hasPnl = rows.some((r) => r.pnlKrw !== null);
  const top = rows.filter((r) => r.valueKrw > 0).slice(0, 6);
  const rest = total - top.reduce((a, r) => a + r.valueKrw, 0);

  return (
    <section className="pf" aria-labelledby="pf-h">
      <h2 id="pf-h" className="visually-hidden">{s.h}</h2>
      <dl className="pf__totals">
        <div>
          <dt>{s.total}</dt>
          <dd className="pf__big">{krw(total, lang)}</dd>
          <dd className="pf__sub">≈ {amount(total / m.ethKrw)} ETH</dd>
        </div>
        <div>
          <dt>{s.change}</dt>
          <dd className={tone(change)}>{pct(change)}</dd>
        </div>
        <div>
          <dt>{s.pnl}</dt>
          <dd className={hasPnl ? tone(pnl) : ""}>{hasPnl ? `${pnl >= 0 ? "+" : "−"}${krw(Math.abs(pnl), lang)}` : "—"}</dd>
        </div>
        <div>
          <dt>{s.tokens}</dt>
          <dd>{rows.length}</dd>
        </div>
      </dl>

      {total > 0 && (
        <div className="pf__alloc">
          <div className="pf__bar" role="img" aria-label={s.alloc}>
            {top.map((r, i) => (
              <i key={r.symbol + i} style={{ flexGrow: r.valueKrw, background: ALLOC[i] }} />
            ))}
            {rest > total * 0.001 && <i style={{ flexGrow: rest, background: ALLOC[6] }} />}
          </div>
          <ul className="pf__legend">
            {top.map((r, i) => (
              <li key={r.symbol + i}>
                <i style={{ background: ALLOC[i] }} aria-hidden /> {r.symbol} <span>{((r.valueKrw / total) * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="empty">{s.empty}</p>
      ) : (
        <div className="scrollx">
          <table className="pfTable">
            <thead>
              <tr>
                <th scope="col">{s.token}</th>
                <th scope="col" className="num">{s.balance}</th>
                <th scope="col" className="num">{s.price}</th>
                <th scope="col" className="num">{s.value}</th>
                <th scope="col" className="num">{s.d24}</th>
                <th scope="col" className="num" title={s.pnlNote}>{s.pnlCol}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const link = r.t ? tradeLink(r.t) : null;
                return (
                  <tr key={r.t?.address ?? "eth"}>
                    <th scope="row">
                      <span className="pfTable__tok">
                        <TokenMark l={{ token: r.t?.address ?? "0x4200000000000000000000000000000000000006", symbol: r.symbol, meta: { image: r.t?.icon ?? undefined } }} size={28} />
                        <span>
                          <b>{r.symbol}</b>
                          <small>{r.name}</small>
                        </span>
                      </span>
                    </th>
                    <td className="num">{amount(r.amount)}</td>
                    <td className="num">{r.priceKrw ? krw(r.priceKrw, lang) : "—"}</td>
                    <td className="num">{krw(r.valueKrw, lang)}</td>
                    <td className={`num ${tone(r.change24h)}`}>{pct(r.change24h)}</td>
                    <td className={`num ${r.pnlKrw !== null ? tone(r.pnlKrw) : ""}`}>{r.pnlKrw === null ? "—" : `${r.pnlKrw >= 0 ? "+" : "−"}${krw(Math.abs(r.pnlKrw), lang)}`}</td>
                    <td className="num">
                      <span className="poolsTable__acts">
                        {link && (
                          <a className="btn btn--line poolsTable__go" href={link}>
                            {s.trade}
                          </a>
                        )}
                        {r.t && (
                          <a className="btn btn--quiet poolsTable__go" href={`#/market/${r.t.address}`}>
                            {s.chart}
                          </a>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="form__note">{s.note}</p>
    </section>
  );
}
