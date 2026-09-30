import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, isAddress, parseAbi, type Address } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { client } from "../lib/chain";
import { krw, loadMarket, type MarketFile, type MarketToken } from "../lib/market";
import { ETH, readToken, type Token } from "../lib/swap";
import { fmtTiny } from "../lib/tiny";
import { TokenMark } from "./PumpVisuals";

/** Below this much liquidity a price is too easy to move to trust (same line as the Market page). */
const THIN_KRW = 100_000;
const BASES = ["ETH", "tKRW", "USDC", "WETH"];
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// market.json is shared by every picker on the page: one fetch, refreshed at most every 30 s.
let marketCache: { at: number; p: Promise<MarketFile | null> } | null = null;
const market = () => {
  if (!marketCache || Date.now() - marketCache.at > 30_000) marketCache = { at: Date.now(), p: loadMarket() };
  return marketCache.p;
};

function Icon({ t, meta, size }: { t: Token; meta?: MarketToken; size: number }) {
  return <TokenMark l={{ token: same(t.address, ETH) ? "0x4200000000000000000000000000000000000006" : t.address, symbol: t.symbol, meta: { image: meta?.icon ?? undefined } }} size={size} />;
}

/**
 * The token field of a swap or liquidity form: a button showing the chosen token, opening a
 * searchable list with icons, the wallet's balances, each token's liquidity, and a warning on thin
 * or unlisted tokens. A pasted address that is not in the list can be imported.
 */
export function TokenPicker({ tokens, value, onChange, label }: { tokens: Token[]; value?: Address; onChange: (v: string) => void; label: string }) {
  const { account, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.sw;
  const dlg = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data: m } = useChain(market, []);
  const meta = useMemo(() => new Map((m?.tokens ?? []).map((x) => [x.address.toLowerCase(), x])), [m]);
  const cur = tokens.find((x) => same(x.address, value));

  // Balances only while the list is open: one multicall for everything shown.
  const { data: bal } = useChain(
    async () => {
      if (!open || !account) return new Map<string, bigint>();
      const erc = tokens.filter((x) => !same(x.address, ETH));
      const [eth, res] = await Promise.all([
        client.getBalance({ address: account }),
        client.multicall({ contracts: erc.map((x) => ({ address: x.address, abi: erc20, functionName: "balanceOf", args: [account] }) as const), allowFailure: true }),
      ]);
      const out = new Map<string, bigint>([[ETH.toLowerCase(), eth]]);
      erc.forEach((x, i) => res[i].status === "success" && out.set(x.address.toLowerCase(), res[i].result as bigint));
      return out;
    },
    [open, account, tokens.length, tick],
  );

  const query = q.trim().toLowerCase();
  const pasted = isAddress(query) && !tokens.some((x) => same(x.address, query)) ? (query as Address) : null;
  const { data: imported } = useChain(async () => (pasted ? readToken(pasted).catch(() => null) : null), [pasted]);

  const rows = useMemo(() => {
    const hit = (x: Token) => !query || x.symbol.toLowerCase().includes(query) || x.name.toLowerCase().includes(query) || same(x.address, query);
    const held = (x: Token) => (bal?.get(x.address.toLowerCase()) ?? 0n) > 0n;
    return tokens
      .filter(hit)
      .map((x, i) => ({ x, i }))
      .sort((a, b) => Number(held(b.x)) - Number(held(a.x)) || a.i - b.i)
      .map(({ x }) => x)
      .slice(0, 200);
  }, [tokens, query, bal]);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const choose = (a: string) => {
    onChange(a);
    setOpen(false);
    setQ("");
  };
  const bases = BASES.map((sym) => tokens.find((x) => x.symbol === sym)).filter((x): x is Token => !!x);
  const fmtBal = (x: Token) => {
    const v = bal?.get(x.address.toLowerCase());
    if (!v) return null;
    const n = Number(formatUnits(v, x.decimals));
    return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 3 }) : fmtTiny(n);
  };

  return (
    <>
      <button type="button" className="tokenbtn" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={label}>
        {cur ? (
          <>
            <Icon t={cur} meta={meta.get(cur.address.toLowerCase())} size={24} />
            <span className="tokenbtn__sym">{cur.symbol}</span>
          </>
        ) : (
          <span className="tokenbtn__sym tokenbtn__sym--empty">{label}</span>
        )}
        <svg viewBox="0 0 12 12" aria-hidden className="tokenbtn__chev">
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>

      <dialog ref={dlg} className="tokenpick" onClose={() => setOpen(false)} onClick={(e) => e.target === dlg.current && setOpen(false)}>
        {open && (
          <div className="tokenpick__box">
            <header className="tokenpick__head">
              <h2>{s.tpTitle}</h2>
              <button type="button" className="tokenpick__x" onClick={() => setOpen(false)} aria-label={s.tpClose}>
                ×
              </button>
            </header>
            <input className="tokenpick__search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={s.tpSearch} spellCheck={false} aria-label={s.tpSearch} />
            {bases.length > 0 && (
              <div className="tokenpick__bases">
                {bases.map((x) => (
                  <button type="button" key={x.address} className={same(x.address, value) ? "is-on" : ""} onClick={() => choose(x.address)}>
                    <Icon t={x} meta={meta.get(x.address.toLowerCase())} size={20} />
                    {x.symbol}
                  </button>
                ))}
              </div>
            )}
            <ul className="tokenpick__list" role="listbox" aria-label={s.tpTitle}>
              {pasted && imported && (
                <li>
                  <button type="button" className="tokenpick__row is-import" onClick={() => choose(imported.address)}>
                    <Icon t={imported} size={32} />
                    <span className="tokenpick__id">
                      <b>{imported.symbol}</b>
                      <small>{imported.name}</small>
                    </span>
                    <span className="tokenpick__side">
                      <em className="tokenpick__warn">{s.tpUnlisted}</em>
                      <small>{s.tpImport}</small>
                    </span>
                  </button>
                </li>
              )}
              {rows.map((x) => {
                const mt = meta.get(x.address.toLowerCase());
                const b = fmtBal(x);
                const thin = !!mt && !mt.anchor && mt.liquidityKrw < THIN_KRW;
                return (
                  <li key={x.address}>
                    <button type="button" role="option" aria-selected={same(x.address, value)} className={`tokenpick__row ${same(x.address, value) ? "is-on" : ""}`} onClick={() => choose(x.address)}>
                      <Icon t={x} meta={mt} size={32} />
                      <span className="tokenpick__id">
                        <b>
                          {x.symbol}
                          {thin && <em className="tokenpick__warn">{s.tpThin}</em>}
                        </b>
                        <small>{x.name}</small>
                      </span>
                      <span className="tokenpick__side">
                        {b && <b>{b}</b>}
                        {mt && mt.liquidityKrw > 0 && <small>{s.tpLiq(krw(mt.liquidityKrw, lang))}</small>}
                      </span>
                    </button>
                  </li>
                );
              })}
              {rows.length === 0 && !imported && <li className="tokenpick__none">{s.tpNone}</li>}
            </ul>
          </div>
        )}
      </dialog>
    </>
  );
}
