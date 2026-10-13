import { useState } from "react";
import type { Address } from "viem";
import { useApp, useChain } from "../app";
import { VerifyNow } from "../components/VerifyNow";
import { dateKst, useLang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { explorer, shortAddr } from "../lib/chain";
import { won } from "../lib/gye";
import {
  digits,
  feeOf,
  localized,
  property,
  readListings,
  readPosition,
  readProperty,
  redeemValue,
  rentPerShare,
  toWei,
  yieldPct,
  type PropListing,
  type Property,
} from "../lib/property";
import { fmtN, fmtPct, PropBadges, propStatus } from "./PropList";

const big = (v: string) => (v ? BigInt(v) : 0n);

export function PropPage({ id }: { id: number }) {
  const { deployment, account, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.pr;
  const addr = deployment?.property;
  const tkrw = deployment?.tkrw;
  const { data: p, error } = useChain(async () => (addr ? readProperty(addr, id) : null), [addr, id, tick]);
  const { data: pos } = useChain(async () => (addr && p ? readPosition(addr, p, account) : null), [addr, p?.id, p?.status, account, tick]);
  const { data: listings } = useChain(async () => (addr ? readListings(addr, id) : []), [addr, id, tick]);
  const [img, setImg] = useState(0);

  if (error) return <main className="page"><p className="empty">{s.loadError(error)}</p></main>;
  if (!p || !addr || !tkrw) return <main className="page"><p className="empty">{s.loading}</p></main>;

  const l = localized(p.meta, lang);
  const now = Date.now() / 1000;
  const me = account?.toLowerCase();
  const isIssuer = me === p.issuer.toLowerCase();
  const saleOpen = p.status === "Funding" && now < p.endAt && p.sold < p.totalShares;
  const canClose = p.status === "Funding" && !saleOpen;
  const open = (listings ?? []).filter((x) => x.shares > 0n);
  const mineListed = open.filter((x) => x.seller.toLowerCase() === me);
  const pct = Number((p.sold * 10_000n) / p.totalShares) / 100;
  const reserveMonths = p.rentPerPeriod === 0n ? 0 : Number(p.reserve / p.rentPerPeriod);
  const shares = pos?.shares ?? 0n;

  return (
    <main className="page listing prop">
      <a className="back" href="#/property">{s.back}</a>
      <header className="listing__head">
        <PropBadges p={p} s={s} />
        <h1 className="listing__sym">{l.name}</h1>
        <p className="listing__q">
          {s.kinds[p.meta.kind]}
          {l.location && ` · ${l.location}`}
        </p>
        <p className="circle__status">{propStatus(p, t, lang)}</p>
      </header>

      <div className="listing__body">
        <section className="listing__main">
          {p.meta.images.length > 0 && (
            <figure className="propgal">
              <img src={p.meta.images[Math.min(img, p.meta.images.length - 1)]} alt={l.name} />
              {p.meta.images.length > 1 && (
                <div className="propgal__thumbs">
                  {p.meta.images.map((src, i) => (
                    <button key={src + i} className={i === img ? "is-on" : ""} onClick={() => setImg(i)} aria-label={`${i + 1}`}>
                      <img src={src} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </figure>
          )}
          {!p.verified && <p className="form__note form__note--warn">{s.unverifiedNote}</p>}

          <dl className="propfacts">
            <div>
              <dt>{s.price}</dt>
              <dd>{won(p.price)}</dd>
            </div>
            <div>
              <dt>{s.shares}</dt>
              <dd>{fmtN(p.totalShares)}</dd>
            </div>
            <div>
              <dt>{s.value}</dt>
              <dd>{won(p.price * p.totalShares)}</dd>
            </div>
            <div>
              <dt>{s.rentMonth}</dt>
              <dd>
                {p.rentPerPeriod === 0n ? s.noRent : won(p.rentPerPeriod)}
                {p.rentPerPeriod > 0n && <small>{s.perShareMonth(won(rentPerShare(p)))}</small>}
              </dd>
            </div>
            <div>
              <dt>{s.yield}</dt>
              <dd>{p.rentPerPeriod === 0n ? "—" : `${fmtPct(yieldPct(p))}%`}</dd>
            </div>
            {p.meta.areaM2 && (
              <div>
                <dt>{s.area}</dt>
                <dd>{s.areaM2(p.meta.areaM2.toLocaleString("en-US"))}</dd>
              </div>
            )}
            <div>
              <dt>{s.issuer}</dt>
              <dd>
                <a href={`${explorer}/address/${p.issuer}`} target="_blank" rel="noreferrer">{shortAddr(p.issuer)}</a>
              </dd>
            </div>
          </dl>

          {p.status === "Funding" && (
            <div className="propsale">
              <span className="propbar propbar--big" role="img" aria-label={s.soldOf(fmtN(p.sold), fmtN(p.totalShares))}>
                <i style={{ width: `${pct}%` }} />
                <i className="propbar__cap" style={{ left: `${Number((p.minShares * 10_000n) / p.totalShares) / 100}%` }} />
              </span>
              <p>
                <b>{s.soldOf(fmtN(p.sold), fmtN(p.totalShares))}</b> · {s.softCap(fmtN(p.minShares))}
              </p>
            </div>
          )}

          {l.description && <p className="profile__about">{l.description}</p>}

          {p.rentPerPeriod > 0n && (
            <section className="settle">
              <h2>{s.rentH}</h2>
              {p.status === "Funding" ? (
                <p>{s.rentStarts}</p>
              ) : (
                <dl className="propfacts propfacts--small">
                  <div>
                    <dt>{s.rentPaid}</dt>
                    <dd>{won(p.rentPaid)}</dd>
                  </div>
                  {p.status === "Active" && (
                    <div>
                      <dt>{s.reserve}</dt>
                      <dd>
                        {won(p.reserve)}
                        <small>{s.reserveMonths(reserveMonths)}</small>
                      </dd>
                    </div>
                  )}
                </dl>
              )}
              {p.status === "Active" && pos && (
                <p className={pos.arrears > 0n ? "form__note form__note--warn" : "form__note"}>
                  {pos.arrears > 0n ? s.late(won(pos.arrears)) : s.onTime} {s.nextRent(dateKst(pos.nextPeriodAt, lang))}
                </p>
              )}
            </section>
          )}

          {p.status === "Sold" && (
            <section className="settle">
              <h2>{s.redeemH}</h2>
              <dl className="propfacts propfacts--small">
                <div>
                  <dt>{s.salePrice}</dt>
                  <dd>{won(p.salePrice)}</dd>
                </div>
                <div>
                  <dt>{s.pool}</dt>
                  <dd>{won(p.pool)}</dd>
                </div>
              </dl>
            </section>
          )}

          {(p.status === "Active" || open.length > 0) && (
            <section className="propmarket" aria-labelledby="pr-market">
              <h2 id="pr-market">{s.marketH}</h2>
              {open.length === 0 && <p className="empty">{s.marketEmpty}</p>}
              <ul>
                {[...open].sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.id - b.id)).map((x) => (
                  <ListingRow key={x.id} x={x} p={p} addr={addr} tkrw={tkrw} s={s} me={me} />
                ))}
              </ul>
            </section>
          )}

          <p className="form__note">{s.fees(p.saleBps / 100, p.tradeBps / 100, p.exitBps / 100)}</p>

          <section className="rules" aria-labelledby="pr-how2">
            <h2 id="pr-how2">{s.howH}</h2>
            <ol className="docs__steps">
              {s.how.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ol>
          </section>
        </section>

        <aside className="panel">
          {saleOpen && <BuyForm p={p} addr={addr} tkrw={tkrw} s={s} />}
          {saleOpen && <VerifyNow />}

          {canClose && (
            <div className="position">
              <h2>{s.closeH}</h2>
              <p className="form__note">{s.closeNote}</p>
              <button className="btn btn--gold btn--wide" disabled={!account} onClick={() => void run(s.closing, s.closed, (w) => property.finalize(w, addr, p.id))}>
                {account ? s.closeBtn : s.connect}
              </button>
            </div>
          )}

          {account && (
            <div className="position">
              <h2>{s.myH}</h2>
              <p>{shares > 0n ? s.myShares(fmtN(shares), fmtPct(Number((shares * 1_000_000n) / p.totalShares) / 10_000)) : s.myNone}</p>
              {p.status === "Failed" && shares > 0n && (
                <button className="btn btn--gold btn--wide" onClick={() => void run(s.refunding, s.refunded, (w) => property.refund(w, addr, p.id))}>
                  {s.refundBtn(won(shares * p.price))}
                </button>
              )}
              {(pos?.claimable ?? 0n) > 0n && (
                <>
                  <p>
                    {s.myRent}: <b>{won(pos!.claimable)}</b>
                  </p>
                  <button className="btn btn--gold btn--wide" onClick={() => void run(s.claiming, s.claimed, (w) => property.claimRent(w, addr, p.id))}>
                    {s.claimBtn}
                  </button>
                </>
              )}
              {p.status === "Sold" && shares > 0n && (
                <button className="btn btn--gold btn--wide" onClick={() => void run(s.redeeming, s.redeemed, (w) => property.redeem(w, addr, p.id, shares))}>
                  {s.redeemBtn(fmtN(shares), won(redeemValue(p, shares)))}
                </button>
              )}
              {p.status === "Sold" && mineListed.length > 0 && <p className="form__note">{s.listedBack}</p>}
            </div>
          )}

          {p.status === "Active" && shares > 0n && <ListForm p={p} addr={addr} s={s} max={shares} />}

          {isIssuer && p.status === "Funding" && (
            <div className="position">
              <h2>{s.issuerH}</h2>
              <button className="btn btn--line btn--wide" onClick={() => void run(s.cancelling, s.cancelled, (w) => property.cancel(w, addr, p.id))}>
                {s.cancelBtn}
              </button>
            </div>
          )}
          {isIssuer && p.status === "Active" && <IssuerForms p={p} addr={addr} tkrw={tkrw} s={s} />}

          <p className="form__note">
            <a href={`${explorer}/address/${addr}`} target="_blank" rel="noreferrer">JangteoProperty</a>
            {" · "}
            <a href={`${explorer}/token/${p.share}`} target="_blank" rel="noreferrer">JPROP{p.id}</a>
          </p>
        </aside>
      </div>
    </main>
  );
}

function BuyForm({ p, addr, tkrw, s }: { p: Property; addr: Address; tkrw: Address; s: Dict["pr"] }) {
  const { account, run } = useApp();
  const left = p.totalShares - p.sold;
  const [n, setN] = useState("10");
  const shares = big(n);
  const valid = shares > 0n && shares <= left;
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void run(s.buying, s.bought, (w) => property.buy(w, addr, tkrw, p, shares));
      }}
    >
      <h2>{s.buyH}</h2>
      <label>
        <span>
          {s.buyShares} <small>{s.buyLeft(fmtN(left))}</small>
        </span>
        <input inputMode="numeric" value={n} onChange={(e) => setN(digits(e.target.value))} aria-invalid={!valid} />
      </label>
      <p className="form__note">{s.buyNote}</p>
      <button className="btn btn--ink btn--wide" disabled={!account || !valid}>
        {account ? s.buyBtn(fmtN(shares), won(shares * p.price)) : s.connect}
      </button>
    </form>
  );
}

function ListingRow({ x, p, addr, tkrw, s, me }: { x: PropListing; p: Property; addr: Address; tkrw: Address; s: Dict["pr"]; me: string | undefined }) {
  const { run } = useApp();
  const [taking, setTaking] = useState(false);
  const [n, setN] = useState(x.shares.toString());
  const shares = big(n);
  const valid = shares > 0n && shares <= x.shares;
  const mine = x.seller.toLowerCase() === me;
  return (
    <li className="proplist">
      <div className="proplist__row">
        <span className="proplist__price">{s.perShare(won(x.price))}</span>
        <span>{fmtN(x.shares)}</span>
        <span className="proplist__seller">{shortAddr(x.seller)}</span>
        {mine ? (
          <button className="btn btn--quiet" onClick={() => void run(s.cancellingListing, s.cancelledListing, (w) => property.cancelListing(w, addr, x.id))}>
            {s.cancelListing}
          </button>
        ) : (
          p.status === "Active" &&
          me && (
            <button className="btn btn--line" onClick={() => setTaking((v) => !v)} aria-expanded={taking}>
              {s.take}
            </button>
          )
        )}
      </div>
      {taking && !mine && (
        <form
          className="takeform"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void run(s.taking, s.taken, (w) => property.buyListing(w, addr, tkrw, x, shares)).then((ok) => ok && setTaking(false));
          }}
        >
          <input inputMode="numeric" value={n} onChange={(e) => setN(digits(e.target.value))} aria-label={s.buyShares} aria-invalid={!valid} />
          <button className="btn btn--ink" disabled={!valid}>
            {s.takeBtn(fmtN(shares), won(shares * x.price))}
          </button>
        </form>
      )}
    </li>
  );
}

function ListForm({ p, addr, s, max }: { p: Property; addr: Address; s: Dict["pr"]; max: bigint }) {
  const { run } = useApp();
  const [n, setN] = useState("");
  const [price, setPrice] = useState("");
  const shares = big(n);
  const wei = price ? toWei(price) : 0n;
  const valid = shares > 0n && shares <= max && wei > 0n;
  return (
    <form
      className="form position"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void run(s.listing, s.listed, (w) => property.list(w, addr, p.id, shares, wei)).then((ok) => ok && (setN(""), setPrice("")));
      }}
    >
      <h2>{s.listH}</h2>
      <label>
        <span>{s.listShares}</span>
        <input inputMode="numeric" value={n} onChange={(e) => setN(digits(e.target.value))} placeholder={max.toString()} />
      </label>
      <label>
        <span>{s.listPrice}</span>
        <input inputMode="numeric" value={price} onChange={(e) => setPrice(digits(e.target.value))} placeholder={(p.price / 10n ** 18n).toString()} />
      </label>
      {valid && <p className="form__note">{won(shares * wei - feeOf(shares * wei, p.tradeBps))}</p>}
      <p className="form__note">{s.listNote}</p>
      <button className="btn btn--ink btn--wide" disabled={!valid}>
        {s.listBtn}
      </button>
    </form>
  );
}

function IssuerForms({ p, addr, tkrw, s }: { p: Property; addr: Address; tkrw: Address; s: Dict["pr"] }) {
  const { run } = useApp();
  const [fund, setFund] = useState("");
  const [sale, setSale] = useState("");
  const [sure, setSure] = useState(false);
  const fundWei = fund ? toWei(fund) : 0n;
  const saleWei = sale ? toWei(sale) : 0n;
  return (
    <div className="position">
      <h2>{s.issuerH}</h2>
      {p.rentPerPeriod > 0n && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (fundWei > 0n) void run(s.funding, s.funded, (w) => property.fundReserve(w, addr, tkrw, p.id, fundWei)).then((ok) => ok && setFund(""));
          }}
        >
          <h3>{s.fundH}</h3>
          <p className="form__note">{s.fundNote}</p>
          <label>
            <span>{s.fundAmount}</span>
            <input inputMode="numeric" value={fund} onChange={(e) => setFund(digits(e.target.value))} placeholder={(p.rentPerPeriod / 10n ** 18n).toString()} />
          </label>
          <button className="btn btn--line btn--wide" disabled={fundWei === 0n}>
            {s.fundBtn}
          </button>
        </form>
      )}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (saleWei > 0n && sure) void run(s.selling, s.soldOk, (w) => property.sell(w, addr, tkrw, p.id, saleWei));
        }}
      >
        <h3>{s.sellH}</h3>
        <p className="form__note">{s.sellNote}</p>
        <label>
          <span>{s.sellAmount}</span>
          <input inputMode="numeric" value={sale} onChange={(e) => (setSale(digits(e.target.value)), setSure(false))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} disabled={saleWei === 0n} />
          <span>{saleWei > 0n ? won(saleWei) : "—"}</span>
        </label>
        <button className="btn btn--gold btn--wide" disabled={saleWei === 0n || !sure}>
          {s.sellBtn}
        </button>
      </form>
    </div>
  );
}
