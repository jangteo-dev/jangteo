import { useEffect, useRef, useState } from "react";
import { parseAbiItem } from "viem";
import { useApp } from "../app";
import { Sticks, Tray, YutBoard, type BoardPiece } from "../components/YutBoard";
import { countdown, useLang } from "../i18n";
import { client, shortAddr } from "../lib/chain";
import { won } from "../lib/gye";
import { advance, finishReason, HOME, OFF, readGame, winnings, yut, type YutGameState } from "../lib/yut";

const THROWN = parseAbiItem("event Thrown(uint256 indexed id, uint8 indexed player, int8 value, uint16 throwNo)");

/** Games move every second or two, so this page polls faster than the rest of the app. */
function useGame(addr: string | undefined, id: number) {
  const [g, setG] = useState<YutGameState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (!addr) return;
    let live = true;
    const load = () =>
      readGame(addr as `0x${string}`, id)
        .then((x) => live && (setG(x), setErr(null)))
        .catch((e) => live && setErr(String(e?.shortMessage ?? e)));
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [addr, id, bump]);
  return { g, err, refresh: () => setBump((b) => b + 1) };
}

export function YutPage({ id }: { id: number }) {
  const { deployment, account, run } = useApp();
  const { t, lang } = useLang();
  const s = t.yut;
  const addr = deployment?.yut;
  const { g, err, refresh } = useGame(addr, id);
  // The contract records why a game ended; guessing from the clock is wrong once the deadline has passed.
  const [ended, setEnded] = useState<number | null>(null);
  useEffect(() => {
    if (!addr || g?.status !== "Done") return;
    let live = true;
    void finishReason(addr, id, g.lastBlock).then((r) => live && setEnded(r));
    return () => {
      live = false;
    };
  }, [addr, id, g?.status, g?.lastBlock]);
  const [slot, setSlot] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const [rolling, setRolling] = useState(false);
  const [now, setNow] = useState(Date.now() / 1000);
  const [prize, setPrize] = useState(0n);
  const seen = useRef(-1);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  // The newest throw drives the sticks; a new one plays the single tumble animation.
  const totalThrows = g ? g.throws[0] + g.throws[1] : 0;
  useEffect(() => {
    if (!g || !addr || totalThrows === seen.current) return;
    const first = seen.current === -1;
    seen.current = totalThrows;
    if (totalThrows === 0) return;
    void client
      .getLogs({ address: addr, event: THROWN, args: { id: BigInt(id) }, fromBlock: BigInt(Math.max(0, g.lastBlock - 400)), toBlock: BigInt(g.lastBlock + 9_000) })
      .then((logs) => {
        const v = logs.at(-1)?.args.value;
        if (v === undefined) return;
        if (first) return setLast(Number(v));
        setRolling(true);
        setTimeout(() => (setLast(Number(v)), setRolling(false)), 900);
      })
      .catch(() => {});
  }, [totalThrows, g, addr, id]);

  useEffect(() => {
    if (!addr || !account || g?.status !== "Done") return;
    void winnings(addr, account).then(setPrize).catch(() => {});
  }, [addr, account, g?.status, g]);

  useEffect(() => {
    if (g && slot >= g.pending.length) setSlot(0);
  }, [g, slot]);

  if (err && !g) return <main className="page"><p className="empty">{s.loadError(err)}</p></main>;
  if (!g || !addr || !deployment) return <main className="page"><p className="empty">{s.loading}</p></main>;

  const meIdx = account ? g.players.findIndex((p) => p.toLowerCase() === account.toLowerCase()) : -1;
  const me = meIdx === 0 || meIdx === 1 ? (meIdx as 0 | 1) : null;
  const myTurn = me !== null && g.status === "Playing" && g.turn === me;
  const value = g.pending[slot];
  const pieces: BoardPiece[] = g.pos.map((pos, i) => ({ player: (i < 4 ? 0 : 1) as 0 | 1, piece: i % 4, pos }));
  const own = me === null ? [] : pieces.filter((p) => p.player === me);
  const movable = new Set<number>(
    myTurn && g.phase === "moving" && value !== undefined
      ? own.filter((p) => p.pos !== HOME && (value > 0 || p.pos !== OFF)).map((p) => p.piece)
      : [],
  );
  const firstWaiting = own.find((p) => p.pos === OFF)?.piece;
  const target =
    hover !== null && me !== null && value !== undefined ? advance(g.pos[me * 4 + hover], g.route[me * 4 + hover], value) : null;
  const canPass = myTurn && g.phase === "moving" && value === -1 && movable.size === 0;
  const timedOut = g.status === "Playing" && now > g.deadline;

  const doMove = (piece: number) =>
    void run(s.moving, s.moved, (w) => yut.move(w, addr, id, slot, piece)).then(() => (setHover(null), refresh()));

  const side = (p: 0 | 1) => {
    const ps = pieces.filter((x) => x.player === p);
    return {
      waiting: ps.filter((x) => x.pos === OFF).length,
      home: ps.filter((x) => x.pos === HOME).length,
    };
  };

  const house = deployment.yutHouse?.toLowerCase();
  const who = (p: 0 | 1) =>
    me === p
      ? s.you
      : g.players[p] === "0x0000000000000000000000000000000000000000"
        ? "—"
        : g.players[p].toLowerCase() === house
          ? s.house
          : shortAddr(g.players[p]);
  const reason = g.status === "Done" ? endReason(g, s, ended) : "";
  const winnerName = g.winner.toLowerCase() === house ? s.house : shortAddr(g.winner);

  return (
    <main className="page yutgame">
      <a className="back" href="#/yut">{s.back}</a>

      <div className="yutgame__body">
        <section className="yutgame__board">
          <div className="yutgame__players">
            {([0, 1] as const).map((p) => {
              const sd = side(p);
              const active = g.status === "Playing" && g.turn === p;
              return (
                <div key={p} className={`seatcard seatcard--p${p} ${active ? "is-active" : ""}`}>
                  <p className="seatcard__who">
                    <i className={`dotp dotp--p${p}`} aria-hidden /> {who(p)}
                  </p>
                  <div className="seatcard__trays">
                    <span>{s.waitingPieces}</span>
                    <Tray
                      count={sd.waiting}
                      player={p}
                      movable={me === p && firstWaiting !== undefined && movable.has(firstWaiting)}
                      onPick={() => firstWaiting !== undefined && doMove(firstWaiting)}
                    />
                    <span>{s.homePieces}</span>
                    <Tray count={sd.home} player={p} pieces={4} />
                  </div>
                </div>
              );
            })}
          </div>
          <YutBoard pieces={pieces} me={me} movable={movable} target={target} onPick={doMove} onHover={setHover} label={s.boardAria} />
        </section>

        <aside className="panel yutgame__panel">
          <p className="yutgame__stake">{s.stakeOf(won(g.stake))}</p>

          {g.status === "Open" && (
            <>
              <p>{s.seatOpen}</p>
              {me === 0 && (
                <button className="btn btn--line btn--wide" onClick={() => void run(s.cancelling, s.cancelled, (w) => yut.cancel(w, addr, id)).then(refresh)}>
                  {s.cancelTable}
                </button>
              )}
              {me === null && account && (
                <button className="btn btn--ink btn--wide" onClick={() => void run(s.joining, s.joined, (w) => yut.join(w, addr, deployment.tkrw, g)).then(refresh)}>
                  {s.join(won(g.stake))}
                </button>
              )}
            </>
          )}

          {g.status === "Playing" && (
            <>
              <p className={`yutgame__turn ${myTurn ? "is-mine" : ""}`}>
                {g.turn > 1 ? s.deciding : myTurn ? s.yourTurn : me === null ? s.turnOf(who(g.turn as 0 | 1)) : s.theirTurn} · {s.timeLeft(countdown(g.deadline, lang))}
              </p>
              <div className="yutgame__throw">
                <Sticks value={rolling ? null : last} rolling={rolling} />
                {last !== null && !rolling && (
                  <p className="yutgame__name">
                    {s.names[String(last)]}
                  </p>
                )}
              </div>

              {myTurn && g.phase === "throwing" && (
                <button
                  className="btn btn--ink btn--wide"
                  onClick={() => void run(s.throwing, s.thrown, (w) => yut.throwSticks(w, addr, g, me!)).then(refresh)}
                >
                  {g.pending.length > 0 || g.extra > 0 ? s.throwAgain : s.throwIt}
                </button>
              )}

              {g.pending.length > 0 && (
                <div className="pending">
                  <p>{s.pending}</p>
                  <div className="pending__chips" role="radiogroup">
                    {g.pending.map((v, i) => (
                      <button
                        key={i}
                        role="radio"
                        aria-checked={i === slot}
                        className={`chip ${i === slot ? "is-on" : ""}`}
                        disabled={!myTurn || g.phase !== "moving"}
                        onClick={() => setSlot(i)}
                      >
                        {s.names[String(v)]}
                      </button>
                    ))}
                  </div>
                  {myTurn && g.phase === "moving" && <p className="form__note">{movable.size ? s.pickPiece : s.pickThrow}</p>}
                </div>
              )}

              {canPass && (
                <button className="btn btn--line btn--wide" onClick={() => void run(s.passing, s.passed, (w) => yut.pass(w, addr, id, slot)).then(refresh)}>
                  {s.pass}
                </button>
              )}

              {me !== null && !myTurn && timedOut && (
                <button className="btn btn--gold btn--wide" onClick={() => void run(s.claiming, s.claimed, (w) => yut.claimTimeout(w, addr, id)).then(refresh)}>
                  {s.claimWin}
                </button>
              )}
              {me !== null && (
                <button className="btn btn--quiet btn--wide" onClick={() => void run(s.resigning, s.resigned, (w) => yut.resign(w, addr, id)).then(refresh)}>
                  {s.resign}
                </button>
              )}
            </>
          )}

          {g.status === "Done" && (
            <div className="yutgame__end">
              <p className="yutgame__result">
                {me === null
                  ? `${s.wonBy(winnerName)} (${reason})`
                  : g.winner.toLowerCase() === account?.toLowerCase()
                    ? `${s.youWon(won((g.stake * 2n * BigInt(10_000 - g.feeBps)) / 10_000n))} (${reason})`
                    : `${s.youLost} (${reason})`}
              </p>
              {prize > 0n && (
                <button className="btn btn--gold btn--wide" onClick={() => void run(s.collecting, s.collected, (w) => yut.claim(w, addr)).then(() => setPrize(0n))}>
                  {s.collect(won(prize))}
                </button>
              )}
            </div>
          )}

          <details className="rules">
            <summary>{s.rulesH}</summary>
            <ul>
              {s.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </details>
        </aside>
      </div>
    </main>
  );
}

function endReason(g: YutGameState, s: { endedHome: string; endedTime: string; endedResign: string }, code: number | null) {
  if (code !== null) return code === 0 ? s.endedHome : code === 1 ? s.endedTime : s.endedResign;
  const winnerIdx = g.players[0].toLowerCase() === g.winner.toLowerCase() ? 0 : 1;
  const home = g.pos.slice(winnerIdx * 4, winnerIdx * 4 + 4).every((p) => p === HOME);
  if (home) return s.endedHome;
  return Date.now() / 1000 > g.deadline ? s.endedTime : s.endedResign;
}
