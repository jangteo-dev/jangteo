import { useChain } from "../app";
import { useLang } from "../i18n";
import { fmtPctSigned, fmtWon, loadBoard, stockName, tone } from "../lib/stocks";

/** The hub's stocks card: a small 전광판 of the market that's open (Korea first). */
export function StockHubBoard() {
  const { t, lang } = useLang();
  const { data } = useChain(() => loadBoard().catch(() => null), []);
  if (!data) return <p className="empty">{t.sk.loading}</p>;
  const usOpen = data.markets.some((m) => m.region === 1 && m.tradable);
  const krOpen = data.markets.some((m) => m.region === 0 && m.tradable);
  const region = usOpen && !krOpen ? 1 : 0;
  const rows = data.markets.filter((m) => m.region === region).slice(0, 5);
  return (
    <div className="minibook skmini">
      <p className="minibook__name">{region === 0 ? t.sk.korea : t.sk.us}</p>
      <ul>
        {rows.map((m) => (
          <li key={m.sym}>
            <span>{stockName(m, lang)}</span>
            <span>{fmtWon(m.price)}</span>
            <span className={tone(m.changePct)}>{fmtPctSigned(m.changePct)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
