import { useEffect, useState } from "react";
import { useApp } from "../app";
import { useLang } from "../i18n";
import { shortAddr } from "../lib/chain";
import { savedRef } from "../lib/invite";

const phone = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** This page inside MetaMask's in-app browser, carrying a friend's invite along. */
function walletAppLink() {
  const ref = savedRef();
  const q = new URLSearchParams(location.search);
  if (ref && !q.has("ref")) q.set("ref", ref);
  const qs = q.toString();
  return `https://metamask.app.link/dapp/${location.host}${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`;
}

type NavItem = { href: string; label: string; ko: string; desc?: string; active: boolean };

/** Hand-drawn glyphs for the phone tab bar: a market awning, a swap, a popping grain, a seal, a patchwork. */
function Glyph({ name }: { name: "market" | "swap" | "pump" | "insa" | "points" | "more" }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      {name === "market" && (
        <>
          <path {...p} d="M3 9.5h18M4 9.5l1.6-4.5h12.8L20 9.5" />
          <path {...p} d="M3 9.5c0 1.5 1.3 2.5 3 2.5s3-1 3-2.5c0 1.5 1.3 2.5 3 2.5s3-1 3-2.5c0 1.5 1.3 2.5 3 2.5s3-1 3-2.5" />
          <path {...p} d="M5 12.5V20h14v-7.5M10 20v-4.5h4V20" />
        </>
      )}
      {name === "swap" && <path {...p} d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5" />}
      {name === "pump" && (
        <>
          <circle {...p} cx="12" cy="13" r="4.2" />
          <path {...p} d="M12 3.5v2.5M5.3 6.3l1.8 1.8M18.7 6.3l-1.8 1.8M3.5 13h2.3M18.2 13h2.3" />
        </>
      )}
      {name === "insa" && (
        <>
          <rect {...p} x="3.5" y="4.5" width="17" height="15" rx="1.5" />
          <rect {...p} x="6.5" y="7.5" width="11" height="9" rx="0.5" />
          <path {...p} d="M6.5 16.5l3.5-4 2.5 2.5 1.8-2 3.2 3.5" />
        </>
      )}
      {name === "points" && (
        <>
          <rect {...p} x="5" y="5" width="14" height="14" rx="2.5" />
          <path {...p} d="M9 9.5h6M12 9.5v5.5M9.5 15h5" />
        </>
      )}
      {name === "more" && (
        <>
          <rect {...p} x="4" y="4" width="7" height="7" rx="1" />
          <rect {...p} x="13" y="4" width="7" height="4" rx="1" />
          <rect {...p} x="13" y="10" width="7" height="10" rx="1" />
          <rect {...p} x="4" y="13" width="7" height="7" rx="1" />
        </>
      )}
    </svg>
  );
}

export function Header({ route }: { route: string }) {
  const { account, wallets, connectWith, disconnect } = useApp();
  const { t, lang, setLang } = useLang();
  const n = t.nav;
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<null | "stalls" | "wallet" | "sheet">(null);
  const at = (p: string) => route === p || route.startsWith(`${p}/`) || route.startsWith(`${p}?`);
  const main: NavItem[] = [
    { href: "#/market", label: n.market, ko: "마켓", active: at("/market") || at("/trade") },
    { href: "#/swap", label: n.swap, ko: "스왑", active: at("/swap") },
    { href: "#/ppeongtwigi", label: n.pump, ko: "뻥튀기", active: at("/ppeongtwigi") },
    { href: "#/insa", label: n.insa, ko: "인사동", active: at("/insa") },
    { href: "#/points", label: n.points, ko: "포인트", active: at("/points") },
  ];
  const stalls: NavItem[] = [
    { href: "#/cheongyak", label: n.offerings, ko: "청약", desc: n.dOfferings, active: at("/cheongyak") },
    { href: "#/gye", label: n.circles, ko: "계모임", desc: n.dCircles, active: at("/gye") },
    { href: "#/listings", label: n.listings, ko: "상장 예측", desc: n.dListings, active: at("/listings") },
    { href: "#/jangoe", label: n.premarket, ko: "장외", desc: n.dPremarket, active: at("/jangoe") },
    { href: "#/yut", label: n.yut, ko: "윷놀이", desc: n.dYut, active: at("/yut") },
    { href: "#/stats", label: t.st.h1, ko: "통계", desc: t.st.desc, active: route === "/stats" },
    { href: "#/me", label: n.record, ko: "내 자산", desc: n.dPortfolio, active: route === "/me" },
    { href: "#/faq", label: t.footer.faq, ko: "자주 묻는 질문", desc: n.dFaq, active: route === "/faq" },
  ];
  const stallActive = stalls.some((x) => x.active);
  const walletName = (w: (typeof wallets)[number]) => (w.info.uuid === "legacy" ? t.wallet.browser : w.info.name);
  const close = () => setMenu(null);

  useEffect(() => {
    close();
  }, [route]);
  useEffect(() => {
    if (!menu) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [menu]);

  const StallList = ({ items }: { items: NavItem[] }) => (
    <ul className="nlist">
      {items.map((x) => (
        <li key={x.href}>
          <a href={x.href} aria-current={x.active ? "page" : undefined} onClick={close}>
            <b>{x.label}</b>
            {x.desc && <small>{x.desc}</small>}
          </a>
        </li>
      ))}
    </ul>
  );

  const connect =
    wallets.length === 0 ? (
      phone ? (
        // In KakaoTalk, Telegram or a phone browser there is no wallet: open the same page inside one.
        <a className="btn" href={walletAppLink()}>
          {t.wallet.openApp}
        </a>
      ) : (
        <a className="btn btn--quiet" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
          {t.wallet.install}
        </a>
      )
    ) : wallets.length === 1 ? (
      <button className="btn" onClick={() => void connectWith(wallets[0])}>
        {t.wallet.connect}
      </button>
    ) : (
      <div className="picker">
        <button className="btn" onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
          {t.wallet.connect}
        </button>
        {picking && (
          <ul className="picker__list">
            {wallets.map((w) => (
              <li key={w.info.uuid}>
                <button onClick={() => (setPicking(false), void connectWith(w))}>
                  {w.info.icon && <img src={w.info.icon} alt="" width={20} height={20} />}
                  {walletName(w)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );

  return (
    <>
      <header className="hdr">
        <a className="mark" href="#/" aria-label={n.home}>
          <img className="mark__icon" src="/brand/jangteo-mark.svg" alt="" width={34} height={34} />
          <span className="mark__ko" lang="ko">
            장터
          </span>
          {lang === "en" && <span className="mark__en">Jangteo</span>}
        </a>
        <nav className="hdr__nav" aria-label={n.mainNav}>
          {main.map((x) => (
            <a key={x.href} href={x.href} aria-current={x.active ? "page" : undefined}>
              {x.label}
            </a>
          ))}
          <div className="hdr__more">
            <button type="button" className={stallActive ? "is-active" : ""} aria-expanded={menu === "stalls"} onClick={() => setMenu(menu === "stalls" ? null : "stalls")}>
              {n.stalls}
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            {menu === "stalls" && (
              <>
                <div className="hdr__scrim" onClick={close} />
                <div className="hdr__panel">
                  <StallList items={stalls} />
                </div>
              </>
            )}
          </div>
        </nav>
        <div className="hdr__end">
          <button className="lang" onClick={() => setLang(lang === "en" ? "ko" : "en")} aria-label={n.switchLabel} lang={lang === "en" ? "ko" : "en"}>
            {n.switchTo}
          </button>
          {account ? (
            <div className="hdr__acct">
              <button className="btn btn--quiet" aria-expanded={menu === "wallet"} onClick={() => setMenu(menu === "wallet" ? null : "wallet")}>
                <span className="dot" aria-hidden /> {shortAddr(account)}
              </button>
              {menu === "wallet" && (
                <>
                  <div className="hdr__scrim" onClick={close} />
                  <ul className="picker__list">
                    <li>
                      <a href="#/me" onClick={close}>
                        {n.record}
                      </a>
                    </li>
                    <li>
                      <button onClick={() => (close(), disconnect())}>{t.wallet.disconnect}</button>
                    </li>
                  </ul>
                </>
              )}
            </div>
          ) : (
            connect
          )}
        </div>
      </header>

      <nav className="tabbar" aria-label={n.mainNav}>
        {(
          [
            ["market", main[0]],
            ["swap", main[1]],
            ["pump", main[2]],
            ["insa", main[3]],
          ] as const
        ).map(([g, x]) => (
          <a key={x.href} href={x.href} aria-current={x.active ? "page" : undefined}>
            <Glyph name={g} />
            <span>{x.label}</span>
          </a>
        ))}
        <button type="button" aria-expanded={menu === "sheet"} className={stallActive || main[4].active ? "is-active" : ""} onClick={() => setMenu(menu === "sheet" ? null : "sheet")}>
          <Glyph name="more" />
          <span>{n.more}</span>
        </button>
      </nav>
      {menu === "sheet" && (
        <div className="sheet__backdrop" onClick={close}>
          <div className="sheet" role="dialog" aria-label={n.stalls} onClick={(e) => e.stopPropagation()}>
            <span className="sheet__grip" aria-hidden />
            <StallList items={[{ ...main[4], desc: n.dPoints }, ...stalls]} />
          </div>
        </div>
      )}
    </>
  );
}

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <p key={t.id} className={`toast toast--${t.kind}`}>
          {t.kind === "busy" && <span className="spinner" aria-hidden />}
          {t.text}
        </p>
      ))}
    </div>
  );
}

export function Footer() {
  const { deployment } = useApp();
  const { t } = useLang();
  return (
    <footer className="foot">
      <p>{t.footer.runsOn}</p>
      {deployment && (
        <p>
          <a href="#/docs">{t.footer.docs}</a>
          <a href="#/faq">{t.footer.faq}</a>
          <a href="https://x.com/jangteo_org" target="_blank" rel="noreferrer">X @jangteo_org</a>
          <a href="https://github.com/jangteo-dev/jangteo" target="_blank" rel="noreferrer">GitHub</a>
        </p>
      )}
    </footer>
  );
}
