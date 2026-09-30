import { useMemo, useState } from "react";
import { parseEther, type Address } from "viem";
import { useApp, useChain } from "../app";
import { Eth, Frame, Seal } from "../components/InsaBits";
import { OfferForm } from "../components/InsaForms";
import { countdown, useLang } from "../i18n";
import { explorer, shortAddr } from "../lib/chain";
import { buy, fmtEthStr, insaFees, list, loadCollection, pctOf, tokenName, unlist } from "../lib/insa";
import { Activity, Offers } from "./InsaCollection";

const DAYS = [1, 7, 30];

export function InsaItem({ address, id }: { address: Address; id: string }) {
  const { tick, account, deployment, run } = useApp();
  const { t, lang } = useLang();
  const s = t.ins;
  const { data: doc } = useChain(() => loadCollection(address), [address, tick]);
  const { data: fees } = useChain(() => insaFees(undefined, deployment?.insaMarket), [deployment]);
  const [price, setPrice] = useState("");
  const [days, setDays] = useState(7);
  const [offering, setOffering] = useState(false);
  const market = deployment?.insaMarket;
  const tok = doc?.tokens.find((x) => x.id === id);
  const rarity = useMemo(() => {
    const n = doc?.tokens.length ?? 0;
    const m = new Map<string, number>();
    for (const x of doc?.tokens ?? []) for (const a of x.attributes) m.set(`${a.trait_type}\u0000${a.value}`, (m.get(`${a.trait_type}\u0000${a.value}`) ?? 0) + 1);
    return (k: string, v: string) => (n ? ((m.get(`${k}\u0000${v}`) ?? 0) / n) * 100 : 0);
  }, [doc]);

  if (doc === undefined) return <main className="page page--loading" aria-busy="true"><p className="empty">{s.loading}</p></main>;
  if (!doc || !tok) return <main className="page"><a className="back" href={`#/insa/c/${address}`}> {s.back}</a><p className="empty">{s.notFound}</p></main>;
  const c = doc.collection;
  const own = !!account && tok.owner.toLowerCase() === account.toLowerCase();
  let wei = 0n;
  try {
    wei = price ? parseEther(price) : 0n;
  } catch {
    wei = 0n;
  }
  const roy = (c.royaltyBps ?? 0) / 100;
  const saleBps = fees?.saleBps ?? 0;
  const net = wei ? (Number(wei) / 1e18) * (1 - roy / 100 - saleBps / 10_000) : 0;

  return (
    <main className="page insa itempage">
      <a className="back" href={`#/insa/c/${c.address}`}>
        {c.name}
      </a>
      <div className="itempage__grid">
        <Frame src={tok.image} alt={tok.name ?? `#${tok.id}`} className="frame--big" />
        <div className="itempage__side">
          <p className="itempage__col">
            <a href={`#/insa/c/${c.address}`}>{c.name}</a> {c.verified && <Seal title={s.verifiedNote} />}
          </p>
          <h1>{tokenName(tok.name, c.name, tok.id)}</h1>
          <p className="itempage__owner">
            {s.owner}{" "}
            <a href={`${explorer}/address/${tok.owner}`} target="_blank" rel="noreferrer">
              {own ? s.you : shortAddr(tok.owner)}
            </a>
          </p>

          <section className="pricebox" aria-label={s.price}>
            {tok.listing ? (
              <>
                <p className="pricebox__label">
                  {s.listedFor} · {s.expires(countdown(tok.listing.expiry, lang))}
                </p>
                <Eth wei={tok.listing.price} ethKrw={doc.ethKrw} />
                {market &&
                  (own ? (
                    <button className="btn btn--line btn--wide" onClick={() => void run(s.unlisting, s.unlisted, (w) => unlist(w, market, c.address, BigInt(tok.id)))}>
                      {s.unlist}
                    </button>
                  ) : (
                    <button className="btn btn--ink btn--wide" disabled={!account} onClick={() => void run(s.buying, s.bought, (w) => buy(w, market, c.address, BigInt(tok.id)))}>
                      {account ? `${s.buy} · ${fmtEthStr(tok.listing.price)} ETH` : t.wallet.connectFirst}
                    </button>
                  ))}
              </>
            ) : (
              <p className="pricebox__label">{s.notListed}</p>
            )}
            {own && market && (
              <form
                className="form insaform"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (wei > 0n) void run(s.listing, s.listed, (w) => list(w, market, c.address, BigInt(tok.id), wei, days)).then((ok) => ok && setPrice(""));
                }}
              >
                <label className="field">
                  <span>{s.listPrice}</span>
                  <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder={tok.listing ? fmtEthStr(tok.listing.price) : "0.01"} />
                </label>
                <fieldset className="chips">
                  <legend>{s.duration}</legend>
                  {DAYS.map((d) => (
                    <button type="button" key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
                      {s.days(d)}
                    </button>
                  ))}
                </fieldset>
                {wei > 0n && <p className="form__note">{s.youGet(net.toLocaleString("en-US", { maximumFractionDigits: 6 }), `${roy}%`, pctOf(fees?.saleBps))}</p>}
                <button className="btn btn--ink btn--wide" disabled={wei === 0n}>
                  {s.list}
                </button>
                <p className="form__note">{s.approveNote}</p>
              </form>
            )}
            {!own && (
              <>
                <button className="btn btn--line btn--wide" onClick={() => setOffering((o) => !o)} aria-expanded={offering}>
                  {s.makeOffer}
                </button>
                {offering && <OfferForm collection={c.address} tokenId={BigInt(tok.id)} onDone={() => setOffering(false)} />}
              </>
            )}
          </section>

          {tok.attributes.length > 0 && (
            <section aria-labelledby="traits-h">
              <h2 id="traits-h">{s.traits}</h2>
              <ul className="traits">
                {tok.attributes.map((a) => (
                  <li key={a.trait_type}>
                    <small>{a.trait_type}</small>
                    <b>{a.value}</b>
                    {a.trait_type !== "Status" && <small>{s.rarity(`${rarity(a.trait_type, a.value).toFixed(1)}%`)}</small>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      <section aria-labelledby="offers-h">
        <h2 id="offers-h">{s.offersForThis}</h2>
        <Offers doc={doc} id={tok.id} />
      </section>
      <section aria-labelledby="hist-h">
        <h2 id="hist-h">{s.history}</h2>
        <Activity doc={doc} id={tok.id} />
      </section>
    </main>
  );
}
