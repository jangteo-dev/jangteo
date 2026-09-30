import { useState } from "react";
import { formatUnits } from "viem";
import { useApp, useChain } from "../app";
import { countdown, useLang, type Lang } from "../i18n";
import type { Dict } from "../i18n/strings";
import type { Deployment } from "../lib/chain";
import { cyHref, listOfferings, money, stage, type CyAddrs, type Offering, type Stage } from "../lib/cheongyak";

export const fmtTokens = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 });
export const fmtComp = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: x < 10 ? 2 : 0 });

export const cyAddrs = (d: Deployment | null | undefined): CyAddrs | null =>
  d && (d.cheongyakV2 || d.cheongyak) ? { v1: d.cheongyak, v2: d.cheongyakV2, tkrw: d.tkrw } : null;

export function offeringStatus(o: Offering, t: Dict, lang: Lang) {
  const s = t.cy;
  if (o.status === "Cancelled") return s.cancelled;
  if (o.status === "Failed") return s.failed;
  if (o.status === "Settled") return s.allocated;
  const st = stage(o);
  if (st === "upcoming") return s.opensIn(countdown(o.startAt, lang));
  if (st === "open") return s.closesIn(countdown(o.endAt, lang));
  return s.allocating;
}

export function VerifiedMark({ t }: { t: Dict }) {
  return (
    <span className="verified" title={t.cy.verifiedNote}>
      <svg viewBox="0 0 12 12" aria-hidden>
        <path d="M2.5 6.2 5 8.6 9.6 3.6" />
      </svg>
      {t.cy.verified}
    </span>
  );
}

export function CyList() {
  const { deployment } = useApp();
  const { t, lang } = useLang();
  const s = t.cy;
  const addrs = cyAddrs(deployment);
  const { data, error } = useChain(async () => (addrs ? listOfferings(addrs) : []), [addrs?.v1, addrs?.v2]);
  const [tab, setTab] = useState<Stage>("open");
  const by = (st: Stage) => data?.filter((o) => o.status !== "Cancelled" && stage(o) === st) ?? [];
  const rows = by(tab);

  return (
    <main className="page listings">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">청약</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
      </header>
      <div className="tabs tabs--end" role="tablist">
        {(["open", "upcoming", "closed"] as Stage[]).map((st) => (
          <button key={st} role="tab" aria-selected={tab === st} onClick={() => setTab(st)}>
            {st === "open" ? s.tabOpen : st === "upcoming" ? s.tabUpcoming : s.tabClosed} <span className="tabs__n">{by(st).length}</span>
          </button>
        ))}
        {deployment?.cheongyakV2 && (
          <a className="tabs__action" href="#/cheongyak/new">
            {s.listOne}
          </a>
        )}
      </div>
      {deployment && !addrs && <p className="empty">{s.notDeployed}</p>}
      {error && <p className="empty">{s.readError(error)}</p>}
      {data && rows.length === 0 && <p className="empty">{s.none}</p>}
      <ul className="rows">
        {rows.map((o) => (
          <li key={`${o.v}-${o.id}`}>
            <a className="cyrow" href={cyHref(o)}>
              <span className="cyrow__name">
                {o.name}
                <small>{o.symbol}</small>
                {o.verified && <VerifiedMark t={t} />}
                {o.v === 1 && <span className="tag">{s.earlier}</span>}
              </span>
              <span className="cyrow__price">{s.perToken(money(o, deployment?.tkrw, o.price))}</span>
              <span className="cyrow__comp">{o.subscribers ? s.competition(fmtComp(o.competition)) : s.subscribers(0)}</span>
              <span className="cyrow__status">{offeringStatus(o, t, lang)}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
