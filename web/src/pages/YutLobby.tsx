import { useState } from "react";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { shortAddr } from "../lib/chain";
import { won } from "../lib/gye";
import { listGames, yut, type YutGameState } from "../lib/yut";
import { YutBoard } from "../components/YutBoard";
import { YutThrows } from "../components/YutThrows";

export function YutLobby() {
  const { deployment, account, run } = useApp();
  const { t } = useLang();
  const s = t.yut;
  const addr = deployment?.yut;
  const [stake, setStake] = useState("10000");
  const { data: games } = useChain(async () => (addr ? listGames(addr) : []), [addr]);

  const open = games?.filter((g) => g.status === "Open" && g.players[0].toLowerCase() !== account?.toLowerCase()) ?? [];
  const mine = account ? (games?.filter((g) => g.players.some((p) => p.toLowerCase() === account.toLowerCase())) ?? []) : [];

  return (
    <main className="page yutlobby">
      <header className="listings__head">
        <p className="listings__ko" lang="ko">윷놀이</p>
        <h1>{s.h1}</h1>
        <p className="lede">{s.lede}</p>
      </header>

      <div className="yutlobby__body">
        <section aria-labelledby="open-h">
          <h2 id="open-h">{s.openH}</h2>
          {deployment && !addr && <p className="empty">{s.notDeployed}</p>}
          {games && open.length === 0 && <p className="empty">{s.none}</p>}
          <ul className="rows">
            {open.map((g) => (
              <li key={g.id}>
                <div className="grow">
                  <a className="grow__main" href={`#/yut/${g.id}`}>
                    <span className="grow__stake">{won(g.stake)}</span>
                    <span className="grow__who">
                      {g.players[0].toLowerCase() === deployment?.yutHouse?.toLowerCase() ? s.house : shortAddr(g.players[0])}
                    </span>
                  </a>
                  <button
                    className="btn btn--ink"
                    disabled={!account}
                    onClick={() =>
                      void run(s.joining, s.joined, (w) => yut.join(w, addr!, deployment!.tkrw, g)).then((ok) => ok && (location.hash = `#/yut/${g.id}`))
                    }
                  >
                    {s.join(won(g.stake))}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <YutThrows />

          {account && (
            <>
              <h2 className="yutlobby__mine">{s.mineH}</h2>
              {games && mine.length === 0 && <p className="empty">{s.noneMine}</p>}
              <ul className="rows">
                {mine.map((g) => (
                  <MyGame key={g.id} g={g} me={account} />
                ))}
              </ul>
            </>
          )}
        </section>

        <aside className="panel">
          <form
            className="betform"
            onSubmit={(e) => {
              e.preventDefault();
              void run(s.opening, s.opened, async (w) => {
                const rc = await yut.create(w, addr!, deployment!.tkrw, stake);
                const log = rc.logs.find((l) => l.address.toLowerCase() === addr!.toLowerCase());
                if (log?.topics[1]) location.hash = `#/yut/${Number(BigInt(log.topics[1]))}`;
              });
            }}
          >
            <h2 className="betform__h">{s.newH}</h2>
            <YutBoard pieces={[]} me={null} label={s.boardAria} />
            <label>
              <span>{s.stake}</span>
              <input inputMode="numeric" value={stake} onChange={(e) => setStake(e.target.value.replace(/[^\d]/g, ""))} />
            </label>
            <button className="btn btn--ink btn--wide" disabled={!account || !addr || !stake}>
              {account ? s.openTable : t.wallet.connect}
            </button>
            <p className="form__note">{s.signNote}</p>
          </form>
        </aside>
      </div>
    </main>
  );
}

function MyGame({ g, me }: { g: YutGameState; me: string }) {
  const { t } = useLang();
  const s = t.yut;
  const opp = g.players.find((p) => p.toLowerCase() !== me.toLowerCase());
  const status =
    g.status === "Open"
      ? s.waiting
      : g.status === "Playing"
        ? s.playing
        : g.status === "Done"
          ? g.winner.toLowerCase() === me.toLowerCase()
            ? s.wonBy(s.you)
            : s.wonBy(s.opponent)
          : s.cancelledTable;
  return (
    <li>
      <a className="grow grow__main" href={`#/yut/${g.id}`}>
        <span className="grow__stake">{won(g.stake)}</span>
        <span className="grow__who">
          {s.vs} {opp && opp !== "0x0000000000000000000000000000000000000000" ? shortAddr(opp) : "—"}
        </span>
        <span className={`grow__status grow__status--${g.status.toLowerCase()}`}>{status}</span>
      </a>
    </li>
  );
}
