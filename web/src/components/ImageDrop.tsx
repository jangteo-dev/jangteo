import { useRef, useState } from "react";
import { useLang } from "../i18n";

/**
 * Token image picker: drop or choose a file and it is squared, compressed and stored (IPFS through
 * Pinata, or Jangteo's own server when Pinata is unavailable) by /api/upload-image.php; the https
 * URL it returns becomes the token's image. A link can still be pasted instead.
 */
export function ImageDrop({ value, onChange, label }: { value?: string; onChange: (url: string | undefined) => void; label?: string }) {
  const { t } = useLang();
  const s = t.pm;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState(false);

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return setErr(s.imgType);
    if (f.size > 5 * 1024 * 1024) return setErr(s.imgSize);
    setBusy(true);
    try {
      const body = new FormData();
      body.append("image", f);
      const res = await fetch(`${import.meta.env.BASE_URL}api/upload-image.php`, { method: "POST", body });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error || `HTTP ${res.status}`);
      onChange(j.url);
    } catch (e) {
      setErr(s.imgFailed((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="imgdrop">
      <span className="imgdrop__label">{label ?? s.imageUp}</span>
      <div
        className={`imgdrop__zone ${over ? "is-over" : ""} ${value ? "has-image" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => !busy && input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload(e.dataTransfer.files[0]);
        }}
        aria-label={s.imageUp}
      >
        {value ? <img src={value} alt="" /> : <span className="imgdrop__plus" aria-hidden>+</span>}
        <span className="imgdrop__text">
          <b>{busy ? s.imgUploading : value ? s.imgChange : s.imgChoose}</b>
          <small>{s.imgHint}</small>
        </span>
        {value && !busy && (
          <button type="button" className="imgdrop__rm" onClick={(e) => (e.stopPropagation(), onChange(undefined))} aria-label={s.imgRemove}>
            ×
          </button>
        )}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void upload(e.target.files?.[0] ?? undefined)} />
      </div>
      {err && <p className="form__note form__note--warn">{err}</p>}
      <button type="button" className="imgdrop__paste" onClick={() => setPaste((p) => !p)}>
        {s.imgPaste}
      </button>
      {paste && <input value={value ?? ""} onChange={(e) => onChange(e.target.value.trim() || undefined)} placeholder="https://" spellCheck={false} aria-label={s.image} />}
    </div>
  );
}
