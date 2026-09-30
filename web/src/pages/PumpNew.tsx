import { useState } from "react";
import { ImageDrop } from "../components/ImageDrop";
import { formatEther, parseEther, zeroAddress, type Address } from "viem";
import { useApp, useChain } from "../app";
import { TokenMark } from "../components/PumpVisuals";
import { useLang } from "../i18n";
import { readIdentity } from "../lib/gye";
import { VerifyNow } from "../components/VerifyNow";
import { fmtTokens, pumpTx, readCurve, type PumpMeta } from "../lib/pump";

const https = (v?: string) => !v || /^https:\/\/\S+$/i.test(v);

export function PumpNew() {
  const { deployment, account, run } = useApp();
  const { t } = useLang();
  const s = t.pm;
  const pump = deployment?.pump;
  const { data: curve } = useChain(async () => (pump ? readCurve(pump) : null), [pump]);
  const { data: id } = useChain(async () => (deployment && account ? readIdentity(deployment, account) : null), [deployment, account]);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [meta, setMeta] = useState<PumpMeta>({});
  const [dev, setDev] = useState("");

  if (deployment && !pump) return <main className="page"><p className="empty">{s.notDeployed}</p></main>;

  const devWei = (() => {
    try {
      return dev ? parseEther(dev) : 0n;
    } catch {
      return 0n;
    }
  })();
  // The first buy's tokens at the opening price: y − k / (x + net), with nothing sold yet.
  const devTokens =
    curve && devWei > 0n
      ? curve.virtualTokens - (curve.virtualEth * curve.virtualTokens) / (curve.virtualEth + (devWei * 99n) / 100n)
      : 0n;
  const overCap = !!curve && devWei > curve.maxCreatorBuy;
  const linksOk = https(meta.image) && https(meta.site) && https(meta.x) && https(meta.telegram);
  const ready = !!account && !!id?.eligible && name.trim().length > 0 && symbol.trim().length >= 2 && linksOk && !overCap;
  const set = (k: keyof PumpMeta) => (e: { target: { value: string } }) => setMeta({ ...meta, [k]: e.target.value.trim() });
  const preview = { token: (account ?? zeroAddress) as Address, symbol: symbol || "?", meta };

  return (
    <main className="page create pumpnew">
      <a className="back" href="#/ppeongtwigi">{s.back}</a>
      <h1>{s.newH1}</h1>
      <p className="lede create__lede">{s.newLede}</p>

      <div className="create__body">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            let token: Address | null = null;
            void run(s.launching, s.launched, async (w) => {
              token = await pumpTx.create(w, pump!, name, symbol, meta, dev);
            }).then((ok) => ok && token && (location.hash = `#/ppeongtwigi/${token}`));
          }}
        >
          {account && id && !id.eligible && (
            <VerifyNow reason={s.notVerified} />
          )}
          <div className="form__pair">
            <label>
              <span>{s.name}</span>
              <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder={s.namePh} />
            </label>
            <label>
              <span>{s.symbol}</span>
              <input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder={s.symbolPh} />
            </label>
          </div>
          <ImageDrop value={meta.image} onChange={(url) => setMeta({ ...meta, image: url })} />
          <p className="form__note">{s.imageNote}</p>
          <label>
            <span>{s.about}</span>
            <textarea rows={3} maxLength={600} value={meta.about ?? ""} onChange={(e) => setMeta({ ...meta, about: e.target.value })} placeholder={s.aboutPh} />
          </label>
          {(["site", "x", "telegram"] as const).map((k) => (
            <label key={k}>
              <span>{s[k]}</span>
              <input value={meta[k] ?? ""} onChange={set(k)} placeholder="https://" spellCheck={false} aria-invalid={!https(meta[k])} />
            </label>
          ))}
          <label>
            <span>{s.devBuy(curve ? formatEther(curve.maxCreatorBuy) : "0.1")}</span>
            <input inputMode="decimal" value={dev} onChange={(e) => setDev(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0" aria-invalid={overCap} />
          </label>
          {devTokens > 0n && <p className="form__note">{s.devBuyNote(fmtTokens(devTokens))}</p>}
          <button className="btn btn--ink btn--wide" disabled={!ready}>
            {account ? s.launchBtn : t.wallet.connect}
          </button>
        </form>

        <aside className="pumpnew__side">
          <p className="pumpnew__label">{s.preview}</p>
          <div className="pumpcard">
            <TokenMark l={preview} size={120} />
            <p className="pumpcard__name">{name || s.namePh}</p>
            <p className="pumpcard__sym">{symbol || s.symbolPh}</p>
            {meta.about && <p className="pumpcard__about">{meta.about}</p>}
            <span className="gradbar" aria-hidden>
              <i style={{ width: `${devWei > 0n && curve ? Math.max(1.5, Number((devWei * 99n * 100n) / 100n / curve.threshold)) : 1.5}%` }} />
            </span>
          </div>
          <section className="rules">
            <h2>{s.termsH}</h2>
            <ul>
              {s.terms.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}
