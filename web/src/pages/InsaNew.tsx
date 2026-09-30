import { useEffect, useState } from "react";
import { isAddress, parseEther, zeroHash, type Address } from "viem";
import { useApp, useChain } from "../app";
import { ImageDrop } from "../components/ImageDrop";
import { useLang } from "../i18n";
import { readIdentity } from "../lib/gye";
import { createDrop, insaFees, pctOf, SITE, storeJson } from "../lib/insa";
import { merkleRoot } from "../lib/merkle";

interface PhaseDraft {
  name: string;
  start: string; // datetime-local, read as Korea time
  end: string;
  price: string;
  perWallet: string;
  list: string;
}

/** "2026-10-01T20:00" in Korea time → unix seconds. */
const kstToUnix = (v: string) => {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5]) / 1000) : 0;
};
const kstInput = (unix: number) => new Date((unix + 9 * 3600) * 1000).toISOString().slice(0, 16);
const parseList = (txt: string) => txt.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export function InsaNew() {
  const { account, deployment, run } = useApp();
  const { t } = useLang();
  const s = t.ins;
  const factory = deployment?.insaFactory;
  const { data: fees } = useChain(() => insaFees(deployment?.insaFactory, deployment?.insaMarket), [deployment]);
  const { data: id } = useChain(async () => (deployment && account ? readIdentity(deployment, account) : null), [deployment, account]);
  const soon = Math.ceil(Date.now() / 1000 / 3600) * 3600 + 3600;
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState("1000");
  const [royalty, setRoyalty] = useState("5");
  const [about, setAbout] = useState("");
  const [cover, setCover] = useState<string | undefined>();
  const [site, setSite] = useState("");
  const [x, setX] = useState("");
  const [mode, setMode] = useState<"many" | "edition" | "folder">("many");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [art, setArt] = useState<string | undefined>();
  const [folder, setFolder] = useState("");
  const [phases, setPhases] = useState<PhaseDraft[]>([{ name: "Public", start: kstInput(soon), end: "", price: "0.001", perWallet: "5", list: "" }]);
  const [err, setErr] = useState<string | null>(null);

  if (deployment && !factory) return <main className="page"><p className="empty">{s.notDeployed}</p></main>;
  const upd = (i: number, p: Partial<PhaseDraft>) => setPhases(phases.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const badAddr = phases.flatMap((p) => parseList(p.list)).find((a) => !isAddress(a));

  async function submit() {
    setErr(null);
    const n = mode === "many" ? files.length : Number(supply);
    if (mode === "many" && (files.length === 0 || files.length > 200 || files.some((f) => !/^image\/(png|jpeg|webp|gif)$/.test(f.type) || f.size > 5 * 1024 * 1024))) return setErr(s.errFiles);
    if (!name.trim() || !symbol.trim()) return setErr(s.errName);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) return setErr(s.errSupply);
    if (mode === "edition" ? !art : mode === "folder" ? !/^(ipfs|https):\/\/.+\/$/.test(folder.trim()) : false) return setErr(s.errArt);
    if (phases.some((p) => !kstToUnix(p.start))) return setErr(s.errPhase);
    if (badAddr) return setErr(s.badAddress(badAddr));
    if (!factory) return;
    await run(s.creating, s.createdToast, async (w) => {
      const lists: Record<string, string> = {};
      const onchain = [];
      for (const [i, p] of phases.entries()) {
        const addrs = parseList(p.list) as Address[];
        if (addrs.length) lists[String(i)] = await storeJson({ kind: "allowlist", addresses: addrs });
        onchain.push({
          start: BigInt(kstToUnix(p.start)),
          end: BigInt(p.end ? kstToUnix(p.end) : 0),
          price: parseEther(p.price || "0"),
          perWallet: Math.max(0, Math.floor(Number(p.perWallet) || 0)),
          root: addrs.length ? merkleRoot(addrs) : zeroHash,
        });
      }
      let firstImage: string | undefined;
      let baseURI: string;
      if (mode === "many") {
        // Every artwork goes up first (kept on Jangteo's server), then one manifest lists them in token order.
        const urls: string[] = [];
        for (const [i, f] of files.entries()) {
          setProgress(s.uploading(i + 1, files.length));
          urls.push(await uploadArtwork(f));
        }
        setProgress(null);
        firstImage = urls[0];
        const manifest = await storeJson({ kind: "manifest", name: name.trim(), description: about.trim(), images: urls });
        baseURI = `${SITE}/nft/${manifest.match(/[0-9a-f]{64}/)![0]}/`;
      } else {
        baseURI = mode === "edition" ? SITE + (await storeJson({ kind: "token", name: name.trim(), description: about.trim(), image: art })) : folder.trim();
      }
      const contractURI =
        SITE +
        (await storeJson({
          kind: "collection",
          description: about.trim(),
          image: cover ?? art ?? firstImage,
          links: { site: site.trim() || undefined, x: x.trim() || undefined },
          lists,
          phaseNames: Object.fromEntries(phases.map((p, i) => [String(i), p.name.trim()])),
        }));
      const drop = await createDrop(w, factory, {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        maxSupply: n,
        royaltyBps: Math.round(Math.min(10, Math.max(0, Number(royalty) || 0)) * 100),
        baseURI,
        contractURI,
        phases: onchain,
      });
      if (drop) location.hash = `#/insa/c/${drop}`;
    });
  }

  return (
    <main className="page insa insanew">
      <a className="back" href="#/insa">
        {t.nav.insa}
      </a>
      <header>
        <h1>{s.newH1}</h1>
        <p className="lede">{s.newLede}</p>
        <p className="form__note">{s.gateNote}</p>
      </header>
      <form
        className="form insanew__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset>
          <legend>{s.secBasics}</legend>
          <div className="grid2">
            <label className="field">
              <span>{s.name}</span>
              <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>{s.symbol}</span>
              <input value={symbol} maxLength={16} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, ""))} />
            </label>
            <label className="field">
              <span>{s.maxSupply}</span>
              <input inputMode="numeric" value={supply} disabled={mode === "many"} onChange={(e) => setSupply(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label className="field">
              <span>{s.royaltyPct}</span>
              <input inputMode="decimal" value={royalty} onChange={(e) => setRoyalty(e.target.value.replace(/[^\d.]/g, ""))} />
            </label>
          </div>
          <label className="field">
            <span>{s.description}</span>
            <textarea rows={4} maxLength={2000} value={about} onChange={(e) => setAbout(e.target.value)} />
          </label>
          <ImageDrop value={cover} onChange={setCover} label={s.cover} />
          <div className="grid2">
            <label className="field">
              <span>
                {s.links} · {s.site}
              </span>
              <input value={site} placeholder="https://" onChange={(e) => setSite(e.target.value)} />
            </label>
            <label className="field">
              <span>X</span>
              <input value={x} placeholder="https://x.com/…" onChange={(e) => setX(e.target.value)} />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>{s.secArt}</legend>
          <div className="modepick" role="radiogroup">
            {(["many", "edition", "folder"] as const).map((m) => (
              <label key={m} className={mode === m ? "is-on" : ""}>
                <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
                <b>{m === "many" ? s.artMany : m === "edition" ? s.artEdition : s.artFolder}</b>
                <small>{m === "many" ? s.artManyNote : m === "edition" ? s.artEditionNote : s.artFolderNote}</small>
              </label>
            ))}
          </div>
          {mode === "many" ? (
            <div className="manypick">
              <label className="btn btn--line">
                {s.pickFiles}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  hidden
                  onChange={(e) => {
                    const fs = [...(e.target.files ?? [])].slice(0, 200);
                    setFiles(fs);
                    setSupply(String(fs.length));
                  }}
                />
              </label>
              {files.length > 0 && <p className="form__note">{s.filesPicked(files.length)}</p>}
              {files.length > 0 && (
                <ul className="manypick__grid">
                  {files.slice(0, 24).map((f, i) => (
                    <li key={i}>
                      <Thumb file={f} />
                      <small>#{i + 1}</small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : mode === "edition" ? (
            <ImageDrop value={art} onChange={setArt} label={s.tokenImage} />
          ) : (
            <label className="field">
              <span>{s.baseUri}</span>
              <input value={folder} placeholder="ipfs://bafy…/" onChange={(e) => setFolder(e.target.value)} />
            </label>
          )}
        </fieldset>

        <fieldset>
          <legend>{s.secPhases}</legend>
          <p className="form__note">{s.phasesNote}</p>
          {phases.map((p, i) => {
            const n = parseList(p.list).length;
            return (
              <div className="phasedraft" key={i}>
                <div className="phasedraft__head">
                  <b>{s.phaseN(i + 1)}</b>
                  {phases.length > 1 && (
                    <button type="button" className="btn btn--quiet" onClick={() => setPhases(phases.filter((_, k) => k !== i))}>
                      {s.removePhase}
                    </button>
                  )}
                </div>
                <div className="grid3">
                  <label className="field">
                    <span>{s.phaseName}</span>
                    <input value={p.name} maxLength={32} onChange={(e) => upd(i, { name: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>{s.start}</span>
                    <input type="datetime-local" value={p.start} onChange={(e) => upd(i, { start: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>{s.end}</span>
                    <input type="datetime-local" value={p.end} onChange={(e) => upd(i, { end: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>{s.pricePer}</span>
                    <input inputMode="decimal" value={p.price} onChange={(e) => upd(i, { price: e.target.value.replace(/[^\d.]/g, "") })} />
                  </label>
                  <label className="field">
                    <span>{s.walletCap}</span>
                    <input inputMode="numeric" value={p.perWallet} onChange={(e) => upd(i, { perWallet: e.target.value.replace(/\D/g, "") })} />
                  </label>
                </div>
                <label className="field">
                  <span>
                    {s.allowlist}
                    {n > 0 && ` · ${s.addresses(n)}`}
                  </span>
                  <textarea rows={3} value={p.list} placeholder="0x…" onChange={(e) => upd(i, { list: e.target.value })} />
                  <small>{s.allowlistNote}</small>
                </label>
              </div>
            );
          })}
          {phases.length < 5 && (
            <button
              type="button"
              className="btn btn--line"
              onClick={() => setPhases([{ name: "Allowlist", start: kstInput(soon), end: "", price: "0", perWallet: "1", list: "" }, ...phases.map((p) => p)].slice(0, 5))}
            >
              {s.addPhase}
            </button>
          )}
        </fieldset>

        <p className="form__note">{s.feesNote(pctOf(fees?.mintBps), pctOf(fees?.saleBps))}</p>
        {progress && <p className="form__note" aria-live="polite">{progress}</p>}
        {err && <p className="form__error">{err}</p>}
        {account && id && !id.eligible && <p className="form__error">{s.needVerified}</p>}
        <button className="btn btn--ink btn--wide" disabled={!account || (!!id && !id.eligible)}>
          {account ? s.create : t.wallet.connectFirst}
        </button>
      </form>
    </main>
  );
}

/** A local preview of a picked file (never uploaded until the launch). */
function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img src={url} alt="" /> : null;
}

/** One collection artwork: resized to fit 1024 px and kept on Jangteo's server. */
async function uploadArtwork(f: File): Promise<string> {
  const body = new FormData();
  body.append("image", f);
  body.append("kind", "nft");
  for (let i = 0; ; i++) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/upload-image.php`, { method: "POST", body });
    const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (res.ok && j.url) return j.url;
    if (i >= 2 || res.status < 500) throw new Error(j.error || `Upload failed (${res.status})`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
