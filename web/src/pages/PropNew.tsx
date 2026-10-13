import { useState } from "react";
import { useApp } from "../app";
import { ImageDrop } from "../components/ImageDrop";
import { VerifyNow } from "../components/VerifyNow";
import { useLang } from "../i18n";
import { won } from "../lib/gye";
import { digits, feeOf, property, PROP_KINDS, toWei, yieldPct, type PropKind, type PropMeta } from "../lib/property";
import { fmtPct } from "./PropList";

const MAX_SHARES = 1_000_000_000_000n;
const SALE_BPS = 200; // the registry's current sale fee; the contract stores it per property

export function PropNew() {
  const { deployment, account, run } = useApp();
  const { t } = useLang();
  const s = t.pr;
  const addr = deployment?.property;
  const [name, setName] = useState("");
  const [loc, setLoc] = useState("");
  const [kind, setKind] = useState<PropKind>("apartment");
  const [area, setArea] = useState("");
  const [desc, setDesc] = useState("");
  const [images, setImages] = useState<(string | undefined)[]>([undefined, undefined, undefined]);
  const [total, setTotal] = useState("1000");
  const [price, setPrice] = useState("10000");
  const [min, setMin] = useState("500");
  const [days, setDays] = useState("7");
  const [rent, setRent] = useState("50000");
  const [months, setMonths] = useState("3");

  const totalN = total ? BigInt(total) : 0n;
  const minN = min ? BigInt(min) : 0n;
  const priceW = price ? toWei(price) : 0n;
  const rentW = rent ? toWei(rent) : 0n;
  const monthsN = rentW === 0n ? 0n : months ? BigInt(months) : 0n;
  const daysN = days ? Number(days) : 0;
  const minRaise = minN * priceW;
  const meta: PropMeta = {
    name: name.trim(),
    location: loc.trim(),
    kind,
    areaM2: area ? Number(area) : undefined,
    description: desc.trim() || undefined,
    images: images.filter((x): x is string => !!x),
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta)).length;

  const err = !meta.name
    ? s.errName
    : totalN < 1n || totalN > MAX_SHARES
      ? s.errShares
      : minN < 1n || minN > totalN
        ? s.errMin
        : priceW === 0n
          ? s.errPrice
          : daysN < 1 || daysN > 30
            ? s.errDays
            : rentW > 0n && (monthsN < 3n || monthsN > 24n)
              ? s.errReserve
              : monthsN * rentW > minRaise - feeOf(minRaise, SALE_BPS)
                ? s.errReserveBig
                : metaBytes > 4096
                  ? s.errMeta
                  : null;
  const value = totalN * priceW;
  const youGet = value - feeOf(value, SALE_BPS) - monthsN * rentW;

  if (!addr) return <main className="page"><p className="empty">{deployment === undefined ? s.loading : s.notDeployed}</p></main>;

  return (
    <main className="page create prop">
      <a className="back" href="#/property">{s.back}</a>
      <header className="listings__head">
        <p className="listings__ko" lang="ko">부동산 등록</p>
        <h1>{s.newH}</h1>
        <p className="lede">{s.newLede}</p>
      </header>
      <VerifyNow reason={s.needVerify} />
      <form
        className="form form--wide"
        onSubmit={(e) => {
          e.preventDefault();
          if (err) return;
          void run(s.creating, s.created, async (w) => {
            await property.create(
              w,
              addr,
              { totalShares: totalN, minShares: minN, price: priceW, duration: BigInt(daysN * 86_400), rentPerPeriod: rentW, reserveMonths: monthsN },
              meta,
            );
          }).then((ok) => ok && (window.location.hash = "#/property"));
        }}
      >
        <label>
          <span>{s.fName}</span>
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} required />
        </label>
        <label>
          <span>{s.fLocation}</span>
          <input value={loc} onChange={(e) => setLoc(e.target.value.slice(0, 120))} />
        </label>
        <fieldset className="segmented">
          <legend>{s.fKind}</legend>
          {PROP_KINDS.map((k) => (
            <label key={k} className={kind === k ? "is-on" : ""}>
              <input type="radio" name="propkind" checked={kind === k} onChange={() => setKind(k)} />
              {s.kinds[k]}
            </label>
          ))}
        </fieldset>
        <label>
          <span>{s.fArea}</span>
          <input inputMode="numeric" value={area} onChange={(e) => setArea(digits(e.target.value).slice(0, 7))} />
        </label>
        <label>
          <span>{s.fDesc}</span>
          <textarea rows={5} value={desc} onChange={(e) => setDesc(e.target.value.slice(0, 1500))} />
        </label>
        <ImageDrop label={s.fImage} value={images[0]} onChange={(u) => setImages((xs) => [u, xs[1], xs[2]])} />
        <div className="propnew__more">
          <span>{s.fImages}</span>
          {[1, 2].map((i) => (
            <ImageDrop key={i} label=" " value={images[i]} onChange={(u) => setImages((xs) => xs.map((x, k) => (k === i ? u : x)))} />
          ))}
        </div>
        <div className="form__row">
          <label>
            <span>{s.fShares}</span>
            <input inputMode="numeric" value={total} onChange={(e) => setTotal(digits(e.target.value))} />
          </label>
          <label>
            <span>{s.fPrice}</span>
            <input inputMode="numeric" value={price} onChange={(e) => setPrice(digits(e.target.value))} />
          </label>
        </div>
        <div className="form__row">
          <label>
            <span>{s.fMin}</span>
            <input inputMode="numeric" value={min} onChange={(e) => setMin(digits(e.target.value))} />
          </label>
          <label>
            <span>{s.fDays}</span>
            <input inputMode="numeric" value={days} onChange={(e) => setDays(digits(e.target.value).slice(0, 2))} />
          </label>
        </div>
        <div className="form__row">
          <label>
            <span>{s.fRent}</span>
            <input inputMode="numeric" value={rent} onChange={(e) => setRent(digits(e.target.value))} />
          </label>
          <label>
            <span>{s.fReserve}</span>
            <input inputMode="numeric" value={rentW === 0n ? "0" : months} disabled={rentW === 0n} onChange={(e) => setMonths(digits(e.target.value).slice(0, 2))} />
          </label>
        </div>
        {value > 0n && (
          <p className="form__note">
            {s.sumValue(won(value))}
            {rentW > 0n && ` · ${s.sumYield(fmtPct(yieldPct({ rentPerPeriod: rentW, price: priceW, totalShares: totalN })))}`}
            {youGet > 0n && ` · ${s.sumYouGet(won(youGet))}`}
          </p>
        )}
        {err && <p className="form__note form__note--warn">{err}</p>}
        <button className="btn btn--ink btn--wide" disabled={!account || !!err}>
          {account ? s.createBtn : s.connect}
        </button>
      </form>
    </main>
  );
}
