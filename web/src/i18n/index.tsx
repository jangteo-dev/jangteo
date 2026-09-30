import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { STRINGS, type Dict } from "./strings";

export type Lang = "en" | "ko";

const KEY = "jangteo.lang";

/** ?lang= in the URL wins (for shared links), then the saved choice, then the browser language. */
function initialLang(): Lang {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "ko" || q === "en") return q;
    const saved = localStorage.getItem(KEY);
    if (saved === "ko" || saved === "en") return saved;
  } catch {
    // storage can be blocked; fall through to the browser language
  }
  return navigator.language?.toLowerCase().startsWith("ko") ? "ko" : "en";
}

interface LangState {
  lang: Lang;
  t: Dict;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<LangState | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<Lang>(initialLang);

  const setLang = useCallback((l: Lang) => {
    set(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      // not fatal: the choice just won't persist
    }
  }, []);

  useEffect(() => {
    const t = STRINGS[lang];
    document.documentElement.lang = lang;
    document.title = t.meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", t.meta.description);
  }, [lang]);

  return <Ctx.Provider value={{ lang, t: STRINGS[lang], setLang }}>{children}</Ctx.Provider>;
}

export function useLang() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLang outside LangProvider");
  return v;
}

// ───────────────────────────── formatting ─────────────────────────────

/** "2d 3h" / "2일 3시간" until `to` (unix seconds). */
export function countdown(to: number, lang: Lang, now = Date.now() / 1000) {
  const s = Math.max(0, Math.round(to - now));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (lang === "ko") {
    if (d) return `${d}일 ${h}시간`;
    if (h) return `${h}시간 ${m}분`;
    return `${m}분 ${sec}초`;
  }
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}

function unit(s: number): { n: number; u: "day" | "hour" | "min" | "sec" } {
  if (s % 86400 === 0) return { n: s / 86400, u: "day" };
  if (s % 3600 === 0) return { n: s / 3600, u: "hour" };
  if (s % 60 === 0) return { n: s / 60, u: "min" };
  return { n: s, u: "sec" };
}

const KO_UNIT = { day: "일", hour: "시간", min: "분", sec: "초" };

/** "1 day", "7 days", "10 min" / "1일", "7일", "10분". */
export function durationLabel(s: number, lang: Lang) {
  const { n, u } = unit(s);
  if (lang === "ko") return `${n}${KO_UNIT[u]}`;
  if (u === "min") return `${n} min`;
  if (u === "sec") return `${n}s`;
  return `${n} ${u}${n === 1 ? "" : "s"}`;
}

/** "every day", "every 7 days" / "매일", "7일마다". */
export function every(s: number, lang: Lang) {
  const { n, u } = unit(s);
  if (lang === "ko") {
    if (n === 1 && u === "day") return "매일";
    if (n === 1 && u === "hour") return "매시간";
    return `${n}${KO_UNIT[u]}마다`;
  }
  if (n === 1 && (u === "day" || u === "hour")) return `every ${u}`;
  return `every ${durationLabel(s, "en")}`;
}

/** A moment in Korea time: "23 Oct 2026, 12:53 KST" / "2026년 10월 23일 오후 12:53 (KST)". */
export function dateKst(t: number, lang: Lang) {
  const s = new Date(t * 1000).toLocaleString(lang === "ko" ? "ko-KR" : "en-GB", {
    dateStyle: lang === "ko" ? "long" : "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  });
  return lang === "ko" ? `${s} (KST)` : `${s} KST`;
}
