import { useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { useApp, useChain } from "../app";
import { Eth, Frame, Seal, since } from "../components/InsaBits";
import { OfferForm } from "../components/InsaForms";
import { countdown, dateKst, useLang } from "../i18n";
import { explorer, shortAddr } from "../lib/chain";
import {
  acceptOffer,
  cancelOffer,
  fmtEthStr,
  isPublic,
  isTba,
  loadAllowlist,
  loadCollection,
  mint,
  phaseState,
  proofFor,
  readMintState,
  tokenName,
  type CollectionDoc,
  type Token,
} from "../lib/insa";
import { phaseLabel } from "../lib/insaUi";

type Tab = "items" | "activity" | "offers";
type Sort = "price" | "id" | "recent";

export function InsaCollection({ address }: { address: Address }) {
  const { tick, account, deployment } = useApp();
  const { t } = useLang();
  const s = t.ins;
  const { data: doc, error } = useChain(() => loadCollection(address), [address, tick]);
  const [tab, setTab] = useState<Tab>("items");
  const [offering, setOffering] = useState(false);

  if (error) return <main className="page"><p className="empty">{error}</p></main>;
  if (doc === undefined) return <main className="page page--loading" aria-busy="true"><p className="empty">{s.loading}</p></main>;
  // A collection launched a moment ago appears once the indexer has read it (about a minute); the page retries on its own.
  if (doc === null) return <main className="page"><p className="empty">{s.settingUp}</p></main>;
  const c = doc.collection;
  const mine = account ? doc.tokens.filter((x) => x.owner.toLowerCase() === account.toLowerCase()).length : 0;

  return (
    <main className="page insa">
      <a className="back" href="#/insa">
        {t.nav.insa}
      </a>
      <header className="colhead">
        <Frame src={c.image} alt={c.name} className="frame--cover" />
        <div className="colhead__body">
          <h1>
            {c.name} {c.verified && <Seal title={s.verifiedNote} />}
          </h1>
          <p className="colhead__meta">
            {c.symbol}
            {c.creator && (
              <>
                {" · "}
                <a href={`${explorer}/address/${c.creator}`} target="_blank" rel="noreferrer">
                  {s.by(shortAddr(c.creator))}
                </a>
              </>
            )}
            {" · "}
            {c.verified ? s.verified : s.external}
            {c.revealed !== null && ` · ${c.revealed ? s.revealed : s.notRevealed}`}
          </p>
          {/* Our own collection speaks the reader's language; creators' text is shown as written. */}
          {c.address.toLowerCase() === deployment?.tal?.toLowerCase() ? (
            <p className="colhead__about">
              {s.talLede} {s.talPerks}
            </p>
          ) : (
            c.about.description && <p className="colhead__about">{c.about.description}</p>
          )}
          <p className="colhead__links">
            {(["site", "x", "discord", "telegram"] as const).map((k) =>
              c.about.links[k] ? (
                <a key={k} href={c.about.links[k]} target="_blank" rel="noreferrer nofollow">
                  {k === "site" ? s.site : k === "x" ? "X" : k === "discord" ? "Discord" : "Telegram"}
                </a>
              ) : null,
            )}
            <a href={`${explorer}/address/${c.address}`} target="_blank" rel="noreferrer">
              {shortAddr(c.address)}
            </a>
          </p>
        </div>
      </header>

      <dl className="colstats">
        <div>
          <dt>{s.floor}</dt>
          <dd>{c.floor ? `${fmtEthStr(c.floor)} ETH` : "—"}</dd>
        </div>
        <div>
          <dt>{s.topOffer}</dt>
          <dd>{c.topOffer ? `${fmtEthStr(c.topOffer)} ETH` : "—"}</dd>
        </div>
        <div>
          <dt>{s.volume}</dt>
          <dd>{fmtEthStr(c.volume, 3)} ETH</dd>
        </div>
        <div>
          <dt>{s.owners}</dt>
          <dd>{c.owners}</dd>
        </div>
        <div>
          <dt>{s.supply}</dt>
          <dd>
            {c.supply.toLocaleString("en-US")}
            {c.maxSupply ? ` / ${c.maxSupply.toLocaleString("en-US")}` : ""}
          </dd>
        </div>
        {c.royaltyBps !== null && (
          <div>
            <dt>{s.royalty}</dt>
            <dd>{c.royaltyBps / 100}%</dd>
          </div>
        )}
      </dl>

      {c.drop && c.phases && c.phases.length > 0 && <MintPanel doc={doc} />}

      <div className="colbar">
        <div className="tabs" role="tablist">
          {(["items", "activity", "offers"] as Tab[]).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {k === "items" ? s.tabItems : k === "activity" ? s.tabActivity : `${s.tabOffers}${doc.offers.length ? ` ${doc.offers.length}` : ""}`}
            </button>
          ))}
        </div>
        <button className="btn btn--line" onClick={() => setOffering((o) => !o)} aria-expanded={offering}>
          {s.makeCollectionOffer}
        </button>
      </div>
      {offering && (
        <div className="insapop">
          <OfferForm collection={c.address} tokenId={null} onDone={() => setOffering(false)} />
        </div>
      )}

      {tab === "items" && <Items doc={doc} mineCount={mine} />}
      {tab === "activity" && <Activity doc={doc} />}
      {tab === "offers" && <Offers doc={doc} />}
    </main>
  );
}

function MintPanel({ doc }: { doc: CollectionDoc }) {
  const { account, tick, run } = useApp();
  const { t, lang } = useLang();
  const s = t.ins;
  const c = doc.collection;
  const { data: live } = useChain(() => readMintState(c.address, account ?? null), [c.address, account, tick]);
  const { data: lists } = useChain(
    () => Promise.all((live?.phases ?? c.phases ?? []).map((p, i) => (isPublic(p) ? Promise.resolve(null) : loadAllowlist(c.about.lists[String(i)], p.root)))),
    [c.address, live?.phases.map((p) => p.root).join()],
  );
  const phases = live?.phases ?? c.phases ?? [];
  const total = live?.total ?? c.supply;
  const max = live?.max ?? c.maxSupply ?? 0;
  const soldOut = max > 0 && total >= max;
  const liveIdx = phases.findIndex((p) => phaseState(p) === "live");
  const [pick, setPick] = useState<number | null>(null);
  const sel = pick ?? (liveIdx >= 0 ? liveIdx : Math.max(0, phases.findIndex((p) => phaseState(p) === "upcoming")));
  const [qty, setQty] = useState(1);
  const p = phases[sel];
  if (!p) return null;
  const st = phaseState(p);
  const minted = live?.minted[sel] ?? 0;
  const cap = p.perWallet ? Math.max(0, p.perWallet - minted) : 20;
  const left = Math.max(0, max - total);
  const maxQty = Math.max(0, Math.min(cap, left, 20));
  const q = Math.min(Math.max(1, qty), Math.max(1, maxQty));
  const list = lists?.[sel] ?? null;
  const proof: Hex[] | null = isPublic(p) ? [] : account ? proofFor(list, account, p.root) : null;
  const price = BigInt(p.price);
  const cost = price * BigInt(q);
  const allEnded = phases.every((x) => phaseState(x) === "ended");
  const pct = max ? Math.min(100, (total / max) * 100) : 0;

  return (
    <section className="mintpanel" aria-labelledby="mint-h">
      <div className="mintpanel__top">
        <h2 id="mint-h">{s.mintH}</h2>
        <p>{soldOut ? s.soldOut : s.minted(total, max)}</p>
      </div>
      <div className="mintbar" aria-hidden>
        <i style={{ width: `${Math.max(0.8, pct)}%` }} />
      </div>
      <ol className="phasecards" role="tablist">
        {phases.map((x, i) => {
          const xs = phaseState(x);
          return (
            <li key={i}>
              <button role="tab" aria-selected={i === sel} className={`is-${xs}`} onClick={() => (setPick(i), setQty(1))}>
                <b>{phaseLabel(s, c.about.phaseNames[String(i)], i)}</b>
                <span>{BigInt(x.price) === 0n ? s.free : `${fmtEthStr(x.price)} ETH`}</span>
                <small>{isPublic(x) ? s.publicPhase : s.listPhase} · {x.perWallet ? s.perWallet(x.perWallet) : s.noCap}</small>
                <small className="phasecards__state">
                  {isTba(x) ? s.tba : xs === "upcoming" ? s.opensIn(countdown(x.start, lang)) : xs === "live" ? (x.end ? s.endsIn(countdown(x.end, lang)) : s.live) : s.ended}
                </small>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mintpanel__act">
        <p className="mintpanel__when">
          {isTba(p) ? s.tbaNote : `${dateKst(p.start, lang)}${p.end ? ` – ${dateKst(p.end, lang)}` : ""}`}
        </p>
        {!isPublic(p) && (
          <p className={`mintpanel__elig ${proof ? "is-yes" : account ? "is-no" : ""}`}>
            {!account ? s.connectToCheck : lists && !list ? s.listUnreadable : proof ? s.eligible : s.notEligible}
          </p>
        )}
        {account && p.perWallet > 0 && <p className="form__note">{s.youMinted(minted, p.perWallet)}</p>}
        {soldOut || allEnded ? (
          <p className="empty">{soldOut ? s.soldOut : s.mintClosed}</p>
        ) : (
          <div className="mintpanel__row">
            <div className="stepper" aria-label={s.quantity}>
              <button type="button" onClick={() => setQty(Math.max(1, q - 1))} disabled={q <= 1} aria-label="−">
                −
              </button>
              <output>{q}</output>
              <button type="button" onClick={() => setQty(Math.min(maxQty, q + 1))} disabled={q >= maxQty} aria-label="+">
                +
              </button>
            </div>
            <button
              className="btn btn--ink mintpanel__go"
              disabled={!account || st !== "live" || !proof || maxQty === 0}
              onClick={() => void run(s.minting, s.mintedToast, (w) => mint(w, c.address, sel, q, proof ?? [], price))}
            >
              {!account ? t.wallet.connectFirst : isTba(p) ? s.tba : st === "upcoming" ? s.opensIn(countdown(p.start, lang)) : s.mintBtn(q, cost === 0n ? s.free : `${fmtEthStr(cost)} ETH`)}
            </button>
          </div>
        )}
        {c.revealed === false && <p className="form__note">{s.revealNote}</p>}
      </div>
    </section>
  );
}

function Items({ doc, mineCount }: { doc: CollectionDoc; mineCount: number }) {
  const { account } = useApp();
  const { t } = useLang();
  const s = t.ins;
  const [listed, setListed] = useState(false);
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState<Sort>("price");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const traits = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const tk of doc.tokens) for (const a of tk.attributes) m.set(a.trait_type, (m.get(a.trait_type) ?? new Map()).set(a.value, (m.get(a.trait_type)?.get(a.value) ?? 0) + 1));
    return [...m.entries()].filter(([k]) => k !== "Status");
  }, [doc.tokens]);
  const rows = doc.tokens
    .filter((x) => !listed || x.listing)
    .filter((x) => !mine || (account && x.owner.toLowerCase() === account.toLowerCase()))
    .filter((x) => Object.entries(filters).every(([k, v]) => !v || x.attributes.some((a) => a.trait_type === k && a.value === v)))
    .sort((a, b) => {
      if (sort === "price") {
        if (a.listing && b.listing) return BigInt(a.listing.price) < BigInt(b.listing.price) ? -1 : 1;
        if (a.listing || b.listing) return a.listing ? -1 : 1;
      }
      if (sort === "recent" && (a.listing || b.listing)) return (b.listing?.expiry ?? 0) - (a.listing?.expiry ?? 0);
      return Number(BigInt(a.id) - BigInt(b.id));
    });

  if (doc.tokens.length === 0) return <p className="empty">{s.noneMinted}</p>;
  return (
    <>
      <div className="itembar">
        <label className="check">
          <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} /> {s.listedOnly}
        </label>
        {account && mineCount > 0 && (
          <label className="check">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {s.mine} ({mineCount})
          </label>
        )}
        {traits.map(([k, vals]) => (
          <select key={k} value={filters[k] ?? ""} onChange={(e) => setFilters({ ...filters, [k]: e.target.value })} aria-label={k}>
            <option value="">{s.allOf(k)}</option>
            {[...vals.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([v, n]) => (
                <option key={v} value={v}>
                  {v} ({n})
                </option>
              ))}
          </select>
        ))}
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="price">{s.sortPrice}</option>
          <option value="recent">{s.sortRecent}</option>
          <option value="id">{s.sortId}</option>
        </select>
        <span className="itembar__count">{s.showing(rows.length, doc.tokens.length)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{s.noItems}</p>
      ) : (
        <ul className="itemgrid">
          {rows.slice(0, 300).map((x) => (
            <ItemCard key={x.id} x={x} doc={doc} />
          ))}
        </ul>
      )}
    </>
  );
}

function ItemCard({ x, doc }: { x: Token; doc: CollectionDoc }) {
  const { account } = useApp();
  const { t } = useLang();
  const s = t.ins;
  const own = account && x.owner.toLowerCase() === account.toLowerCase();
  return (
    <li>
      <a className={`itemcard ${own ? "is-mine" : ""}`} href={`#/insa/c/${doc.collection.address}/${x.id}`}>
        <Frame src={x.image} alt={x.name ?? `#${x.id}`} />
        <span className="itemcard__name">{tokenName(x.name, doc.collection.name, x.id)}</span>
        {x.listing ? <Eth wei={x.listing.price} ethKrw={doc.ethKrw} /> : <small className="itemcard__none">{s.notListed}</small>}
      </a>
    </li>
  );
}

export function Activity({ doc, id }: { doc: CollectionDoc; id?: string }) {
  const { t, lang } = useLang();
  const s = t.ins;
  const rows = doc.activity.filter((a) => !id || a.id === id);
  if (rows.length === 0) return <p className="empty">{s.noActivity}</p>;
  const label = { mint: s.evMint, sale: s.evSale, list: s.evList, offer: s.evOffer, transfer: s.evTransfer };
  return (
    <div className="scrollx">
      <table className="acttable">
        <thead>
          <tr>
            <th scope="col">{s.event}</th>
            {!id && <th scope="col">{s.item}</th>}
            <th scope="col" className="num">{s.price}</th>
            <th scope="col">{s.from}</th>
            <th scope="col">{s.to}</th>
            <th scope="col" className="num">{s.when}</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((a, i) => (
            <tr key={`${a.tx}-${i}`}>
              <td>
                <span className={`evtag evtag--${a.kind}`}>{label[a.kind]}</span>
              </td>
              {!id && <td>{a.id ? <a href={`#/insa/c/${doc.collection.address}/${a.id}`}>#{a.id}</a> : s.offerAny}</td>}
              <td className="num">{a.price ? `${fmtEthStr(a.price)} ETH` : "—"}</td>
              <td>{a.from ? shortAddr(a.from) : "—"}</td>
              <td>{a.to ? shortAddr(a.to) : "—"}</td>
              <td className="num">
                <a href={`${explorer}/tx/${a.tx}`} target="_blank" rel="noreferrer">
                  {s.ago(since(a.at, lang))}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Offers({ doc, id }: { doc: CollectionDoc; id?: string }) {
  const { account, deployment, run } = useApp();
  const { t, lang } = useLang();
  const s = t.ins;
  const market = deployment?.insaMarket;
  const now = Date.now() / 1000;
  const mineIds = account ? doc.tokens.filter((x) => x.owner.toLowerCase() === account.toLowerCase()).map((x) => x.id) : [];
  const [sellWith, setSellWith] = useState<Record<number, string>>({});
  const rows = doc.offers
    .filter((o) => o.expiry > now && (!id || o.tokenId === id || o.tokenId === "any"))
    .sort((a, b) => (BigInt(b.price) > BigInt(a.price) ? 1 : -1));
  if (rows.length === 0) return <p className="empty">{s.noOffers}</p>;
  return (
    <ul className="offerlist">
      {rows.map((o) => {
        const isBuyer = account && o.buyer.toLowerCase() === account.toLowerCase();
        const canSell = o.tokenId === "any" ? (id ? mineIds.includes(id) : mineIds.length > 0) : mineIds.includes(o.tokenId);
        const tokenToSell = id ?? (o.tokenId === "any" ? (sellWith[o.id] ?? mineIds[0]) : o.tokenId);
        return (
          <li key={o.id}>
            <Eth wei={o.price} ethKrw={doc.ethKrw} />
            <span className="offerlist__for">{o.tokenId === "any" ? s.offerAny : s.offerFor(o.tokenId)}</span>
            <small>
              {shortAddr(o.buyer)} · {s.expires(countdown(o.expiry, lang))}
            </small>
            {market && isBuyer && (
              <button className="btn btn--quiet" onClick={() => void run(s.cancelling, s.cancelled, (w) => cancelOffer(w, market, o.id))}>
                {s.cancel}
              </button>
            )}
            {market && !isBuyer && canSell && (
              <span className="offerlist__sell">
                {!id && o.tokenId === "any" && mineIds.length > 1 && (
                  <select value={tokenToSell} onChange={(e) => setSellWith({ ...sellWith, [o.id]: e.target.value })} aria-label={s.item}>
                    {mineIds.map((m) => (
                      <option key={m} value={m}>
                        #{m}
                      </option>
                    ))}
                  </select>
                )}
                <button className="btn btn--ink" onClick={() => void run(s.accepting, s.accepted, (w) => acceptOffer(w, market, doc.collection.address, o.id, BigInt(tokenToSell)))}>
                  {id || o.tokenId !== "any" ? s.accept : `${s.acceptWith} #${tokenToSell}`}
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
