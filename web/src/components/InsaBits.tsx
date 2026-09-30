import { useEffect, useMemo, useState } from "react";
import { krw } from "../lib/market";
import { fmtEthStr, safeImg } from "../lib/insa";
import { render, traitsOf } from "../lib/talArt";
import { countdown, useLang } from "../i18n";

/** An artwork hung in a thin gallery frame. A missing picture keeps the frame, empty. */
export function Frame({ src, alt, className = "" }: { src: string | null | undefined; alt: string; className?: string }) {
  const url = safeImg(src);
  const [broken, setBroken] = useState(false);
  return (
    <span className={`frame ${className}`}>
      {url && !broken ? <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => setBroken(true)} /> : <span className="frame__empty" aria-hidden />}
    </span>
  );
}

/** A red seal stamped on collections launched on Insadong by a verified creator. */
export function Seal({ title }: { title: string }) {
  return (
    <svg className="nakgwan" viewBox="0 0 20 20" width="18" height="18" role="img" aria-label={title}>
      <title>{title}</title>
      <rect x="1" y="1" width="18" height="18" rx="3" fill="var(--hong)" />
      <path d="M5.5 6h9M5.5 10h9M5.5 14h9M8 6v8M12 6v8" stroke="var(--paper-hi)" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** "0.012 ETH" with its won value underneath. */
export function Eth({ wei, ethKrw, dp = 4 }: { wei: string | bigint | null; ethKrw?: number; dp?: number }) {
  const { lang } = useLang();
  if (wei === null) return <span className="eth eth--none">—</span>;
  const n = Number(BigInt(wei)) / 1e18;
  return (
    <span className="eth">
      <b>{fmtEthStr(wei, dp)} ETH</b>
      {ethKrw ? <small>{krw(n * ethKrw, lang)}</small> : null}
    </span>
  );
}

export const since = (at: number, lang: "en" | "ko") => countdown(2 * (Date.now() / 1000) - at, lang);

const svgUri = (s: string) => `data:image/svg+xml;base64,${btoa(s)}`;

/** Tal masks drawn in the browser from the same tables as the contract, one after another. */
export function TalReel() {
  const frames = useMemo(() => {
    const seed = BigInt(Math.floor(Math.random() * 2 ** 48));
    return Array.from({ length: 10 }, (_, i) => svgUri(render(traitsOf(seed, BigInt(i + 1)))));
  }, []);
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((x) => (x + 1) % frames.length), 2600);
    return () => clearInterval(t);
  }, [frames.length]);
  return (
    <span className="frame frame--hero talreel" aria-hidden>
      {frames.map((f, k) => (
        <img key={k} src={f} alt="" className={k === i ? "is-on" : ""} />
      ))}
    </span>
  );
}
