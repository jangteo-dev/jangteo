import { useMemo, useState } from "react";
import { useLang } from "../i18n";
import { faqEn, faqKo, type FaqItem } from "../i18n/faq";

/** Questions people ask before they trust a new market, grouped, searchable, in both languages. */
export function Faq() {
  const { lang } = useLang();
  const f = lang === "ko" ? faqKo : faqEn;
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (i: FaqItem) => !needle || `${i.q} ${i.a.join(" ")}`.toLowerCase().includes(needle);
    return f.groups.map((g) => ({ ...g, items: g.items.filter(hit) })).filter((g) => g.items.length);
  }, [f, q]);

  return (
    <main className="page faq">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">자주 묻는 질문</p>
        <h1>{f.h1}</h1>
        <p className="lede">{f.lede}</p>
      </header>
      <input className="faq__search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={f.search} aria-label={f.search} />
      {groups.length === 0 && <p className="empty">{f.none}</p>}
      {groups.map((g) => (
        <section key={g.h} className="faq__group" aria-label={g.h}>
          <h2>{g.h}</h2>
          {g.items.map((i) => (
            <details key={i.q} className="faq__item" open={!!q.trim()}>
              <summary>{i.q}</summary>
              {i.a.map((p, k) => (
                <p key={k}>{p}</p>
              ))}
              {i.table && (
                <table className="faq__table">
                  <tbody>
                    {i.table.map(([a, b]) => (
                      <tr key={a}>
                        <th scope="row">{a}</th>
                        <td>{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </details>
          ))}
        </section>
      ))}
    </main>
  );
}
