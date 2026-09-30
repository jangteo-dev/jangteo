import { useState } from "react";
import { useApp, useChain } from "../app";
import { Odds } from "../components/Odds";
import { countdown, useLang, type Lang } from "../i18n";
import type { Dict } from "../i18n/strings";
import { won } from "../lib/gye";
import { listMarkets, type Market } from "../lib/sangjang";

export function Listings() {
  const { deployment } = useApp();
  const { t } = useLang();
  const s = t.listings;
  const [tab, setTab] = useState<"open" | "settled">("open");
  const { data, error } = useChain(async () => (deployment?.sangjang ? listMarkets(deployment.sangjang) : []), [deployment]);
  const now = Date.now() / 1000;
  const open = data?.filter((m) => m.status === "Open" && m.closesAt > now) ?? [];
  const settled = data?.filter((m) => !(m.status === "Open" && m.closesAt > now)) ?? [];
  const rows = tab === "open" ? [...open].sort((a, b) => Number(b.yesPool + b.noPool - (a.yesPool + a.noPool))) : settled;

  return (
    <main className="page listings">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">상장</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
      </header>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "open"} onClick={() => setTab("open")}>
          {s.tabOpen} <span className="tabs__n">{open.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "settled"} onClick={() => setTab("settled")}>
          {s.tabSettled} <span className="tabs__n">{settled.length}</span>
        </button>
      </div>

      {deployment && !deployment.sangjang && <p className="empty">{s.notDeployed}</p>}
      {error && <p className="empty">{s.readError(error)}</p>}
      {data && rows.length === 0 && <p className="empty">{tab === "open" ? s.noneOpen : s.noneSettled}</p>}
      <ul className="rows">
        {rows.map((m) => (
          <MarketRow key={m.id} m={m} />
        ))}
      </ul>
    </main>
  );
}

export function outcomeLine(m: Market, t: Dict, lang: Lang) {
  const s = t.listings;
  switch (m.status) {
    case "Open":
      return m.closesAt > Date.now() / 1000 ? s.stOpen(countdown(m.closesAt, lang)) : s.stPastDeadline;
    case "Proposed":
      return s.stProposed(m.yes);
    case "Disputed":
      return s.stDisputed;
    case "Resolved":
      return s.stResolved(m.yes);
    case "Voided":
      return s.stVoided;
    default:
      return "";
  }
}

function MarketRow({ m }: { m: Market }) {
  const { t, lang } = useLang();
  const pool = m.yesPool + m.noPool;
  return (
    <li>
      <a className="mrow" href={`#/listings/${m.id}`}>
        <span className="mrow__sym">{m.symbol}</span>
        <span className="mrow__odds">
          <Odds yesPool={m.yesPool} noPool={m.noPool} />
        </span>
        <span className="mrow__pool">{pool ? t.listings.inPool(won(pool)) : t.listings.noBets}</span>
        <span className={`mrow__status mrow__status--${m.status.toLowerCase()}`}>{outcomeLine(m, t, lang)}</span>
      </a>
    </li>
  );
}
