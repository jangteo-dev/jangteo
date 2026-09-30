import { useState } from "react";
import { formatEther, formatUnits, parseAbi, type Address } from "viem";
import { useApp, useChain } from "../app";
import { Avatar } from "../components/Avatar";
import { NftHoldings } from "../components/NftHoldings";
import { VerifyNow } from "../components/VerifyNow";
import { Portfolio } from "../components/Portfolio";
import { countdown, useLang } from "../i18n";
import { client, confirmed, explorer, shortAddr } from "../lib/chain";
import { actions, readIdentity, readRecord, usd, won } from "../lib/gye";
import { dropAbi, loadIndex } from "../lib/insa";
import { loadMarket } from "../lib/market";
import { cancelOrder, isEth, loadOrders } from "../lib/orders";
import { creatorEarned, fmtEth, listAllLaunches, pumpTx } from "../lib/pump";
import { loadWithdrawals } from "../lib/bridge";
import { listGames } from "../lib/yut";

type Tab = "assets" | "earn" | "open" | "id";
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Everything about the connected wallet: assets, what it earned as a creator, what is still open, and its record. */
export function MePage({ query }: { query?: URLSearchParams }) {
  const { account, deployment, tick } = useApp();
  const { t } = useLang();
  const s = t.dash;
  const asked = query?.get("tab");
  const [tab, setTab] = useState<Tab>(asked === "id" || asked === "earn" || asked === "open" ? asked : "assets");
  if (!account) return <main className="page"><h1>{s.title}</h1><p className="empty">{s.connect}</p></main>;
  return (
    <main className="page me dash">
      <ProfileHead account={account} key={account} onVerify={() => setTab("id")} />
      <div className="tabs" role="tablist">
        {(["assets", "earn", "open", "id"] as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {k === "assets" ? s.tabAssets : k === "earn" ? s.tabEarn : k === "open" ? s.tabOpen : s.tabId}
          </button>
        ))}
      </div>
      {tab === "assets" && (
        <>
          <Portfolio account={account} />
          <NftHoldings account={account} />
        </>
      )}
      {tab === "earn" && <Earnings account={account} tick={tick} />}
      {tab === "open" && <OpenItems account={account} />}
      {tab === "id" && deployment && <Identity />}
    </main>
  );
}

function ProfileHead({ account, onVerify }: { account: Address; onVerify: () => void }) {
  const { deployment, tick } = useApp();
  const { t } = useLang();
  const s = t.dash;
  const [copied, setCopied] = useState(false);
  const { data } = useChain(async () => {
    const [id, pts, tal] = await Promise.all([
      deployment ? readIdentity(deployment, account) : null,
      fetch(`${import.meta.env.BASE_URL}points.json`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      deployment?.tal ? client.readContract({ address: deployment.tal, abi: balAbi, functionName: "balanceOf", args: [account] }).catch(() => 0n) : 0n,
    ]);
    const me = (pts?.entries as { address: string; total: number; rank: number | null }[] | undefined)?.find((e) => same(e.address, account));
    return { id, me, tal };
  }, [account, deployment, tick]);
  return (
    <header className="dash__head">
      <Avatar address={account} size={64} />
      <div className="dash__who">
        <h1>
          {shortAddr(account)}
          <button
            type="button"
            className="btn btn--quiet dash__copy"
            onClick={() => void navigator.clipboard?.writeText(account).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          >
            {copied ? s.copied : s.copy}
          </button>
        </h1>
        <p className="dash__badges">
          {data?.id?.eligible ? (
            <span className="badge badge--ok">{s.verified}</span>
          ) : (
            <button type="button" className="badge badge--action" onClick={onVerify}>
              {s.notVerified} · {s.verifyNow}
            </button>
          )}
          {data && data.tal > 0n && <span className="badge badge--gold">{s.talHolder}</span>}
          <a href={`${explorer}/address/${account}`} target="_blank" rel="noreferrer">
            {s.explorer}
          </a>
        </p>
      </div>
      <dl className="dash__figs">
        <div>
          <dt>{s.points}</dt>
          <dd>
            <a href="#/points">{data?.me ? data.me.total.toLocaleString("en-US") : "0"} P</a>
            <small>{data?.me?.rank ? s.rank(data.me.rank) : s.unranked}</small>
          </dd>
        </div>
        <div>
          <dt>{s.eth}</dt>
          <dd>{data?.id ? Number(formatEther(data.id.eth)).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</dd>
        </div>
      </dl>
    </header>
  );
}

function Earnings({ account, tick }: { account: Address; tick: number }) {
  const { deployment, run } = useApp();
  const { t } = useLang();
  const s = t.dash;
  const pump = deployment?.pump;
  const { data: launches } = useChain(async () => (pump ? (await listAllLaunches(deployment)).filter((l) => same(l.creator, account)) : []), [pump, account, tick]);
  const { data: drops } = useChain(async () => {
    const idx = await loadIndex();
    const mine = (idx?.collections ?? []).filter((c) => c.drop && same(c.creator, account));
    return Promise.all(
      mine.map(async (c) => ({ c, owed: await client.readContract({ address: c.address, abi: dropAbi, functionName: "creatorOwed" }).catch(() => 0n) })),
    );
  }, [account, tick]);
  const earned = (launches ?? []).reduce((a, l) => a + creatorEarned(l), 0n);
  const unclaimed = (launches ?? []).reduce((a, l) => a + l.creatorFees, 0n) + (drops ?? []).reduce((a, d) => a + d.owed, 0n);
  return (
    <section className="dash__earn">
      <p className="form__note">{s.earnPrivate}</p>
      <dl className="colstats">
        <div>
          <dt>{s.earnLifetime}</dt>
          <dd>{fmtEth(earned, 5)} ETH</dd>
        </div>
        <div>
          <dt>{s.earnUnclaimed}</dt>
          <dd>{fmtEth(unclaimed, 5)} ETH</dd>
        </div>
      </dl>

      <h2>{s.launchesH}</h2>
      {launches && launches.length === 0 ? (
        <p className="empty">
          {s.launchesNone} <a href="#/ppeongtwigi/new">{s.launchGo}</a>
        </p>
      ) : (
        <div className="scrollx">
          <table className="acttable">
            <thead>
              <tr>
                <th scope="col">{s.coin}</th>
                <th scope="col">{s.status}</th>
                <th scope="col" className="num">{s.volume}</th>
                <th scope="col" className="num">{s.earned}</th>
                <th scope="col" className="num">{s.unclaimed}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {(launches ?? []).map((l) => (
                <tr key={l.token}>
                  <td>
                    <a href={`#/ppeongtwigi/${l.token}`}>
                      {l.name} <small>{l.symbol}</small>
                    </a>
                  </td>
                  <td>{l.graduated ? s.graduated : s.onCurve(`${(l.progress * 100).toFixed(1)}%`)}</td>
                  <td className="num">{fmtEth(l.volume, 4)} ETH</td>
                  <td className="num">{fmtEth(creatorEarned(l), 5)} ETH</td>
                  <td className="num">{fmtEth(l.creatorFees, 5)} ETH</td>
                  <td className="num">
                    {l.creatorFees > 0n && (
                      <button className="btn btn--gold" onClick={() => void run(s.claiming, s.claimed, (w) => pumpTx.claimCreatorFees(w, l.pump, l.token))}>
                        {s.claim}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>{s.dropsH}</h2>
      {drops && drops.length === 0 ? (
        <p className="empty">
          {s.dropsNone} <a href="#/insa/new">{s.dropGo}</a>
        </p>
      ) : (
        <ul className="offerlist">
          {(drops ?? []).map(({ c, owed }) => (
            <li key={c.address}>
              <a href={`#/insa/c/${c.address}`}>{c.name}</a>
              <small>
                {s.minted} {c.supply}
                {c.maxSupply ? ` / ${c.maxSupply}` : ""}
              </small>
              <span>
                {s.mintIncome}: {fmtEth(owed, 5)} ETH
              </span>
              {owed > 0n && (
                <button
                  className="btn btn--gold"
                  onClick={() =>
                    void run(s.withdrawing, s.withdrawn, async (w) => {
                      const hash = await w.writeContract({ account: w.account!, chain: w.chain, address: c.address, abi: dropAbi, functionName: "withdraw" });
                      return confirmed(hash);
                    })
                  }
                >
                  {s.withdraw}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OpenItems({ account }: { account: Address }) {
  const { deployment, run, tick } = useApp();
  const { t, lang } = useLang();
  const s = t.dash;
  const { data } = useChain(async () => {
    const [ord, wd, market, games] = await Promise.all([
      loadOrders(),
      loadWithdrawals().catch(() => []),
      loadMarket(),
      deployment?.yut ? listGames(deployment.yut, 40).catch(() => []) : [],
    ]);
    const sym = (a: string) => (isEth(a) ? "ETH" : market?.tokens.find((x) => same(x.address, a))?.symbol ?? shortAddr(a));
    const dec = (a: string) => (isEth(a) ? 18 : market?.tokens.find((x) => same(x.address, a))?.decimals ?? 18);
    return {
      orders: ord.open.filter((o) => same(o.owner, account)).map((o) => ({ o, pair: `${sym(o.tokenIn)} → ${sym(o.tokenOut)}`, left: Number(formatUnits(BigInt(o.remaining), dec(o.tokenIn))), inSym: sym(o.tokenIn) })),
      withdrawals: wd.filter((w) => same(w.from, account) && w.status !== "finalized"),
      games: games.filter((g) => g.players.some((p) => same(p, account)) && (g.status === "Open" || g.status === "Playing")),
    };
  }, [account, deployment, tick]);
  if (!data) return <p className="empty">{t.ins.loading}</p>;
  return (
    <section className="dash__open">
      <h2>{s.ordersH}</h2>
      {data.orders.length === 0 ? (
        <p className="empty">{s.ordersNone}</p>
      ) : (
        <ul className="offerlist">
          {data.orders.map(({ o, pair, left, inSym }) => (
            <li key={o.id}>
              <b>{pair}</b>
              <small>{o.slices ? s.dca(o.done, o.slices) : s.limit}</small>
              <span>
                {s.remaining}: {left.toLocaleString("en-US", { maximumFractionDigits: 6 })} {inSym}
              </span>
              {deployment?.orders && (
                <button className="btn btn--quiet" onClick={() => void run(s.cancelling, s.cancelled, (w) => cancelOrder(w, deployment.orders!, o.id))}>
                  {s.cancel}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>{s.withdrawalsH}</h2>
      {data.withdrawals.length === 0 ? (
        <p className="empty">{s.withdrawalsNone}</p>
      ) : (
        <ul className="offerlist">
          {data.withdrawals.map((w) => (
            <li key={w.l2Tx}>
              <b>{Number(formatEther(BigInt(w.amount))).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH</b>
              <small>{w.kind === "fast" ? s.fast : ""}</small>
              <span>
                {s.wStatus[w.status] ?? w.status}
                {w.nextAt && w.nextAt > Date.now() / 1000 ? ` · ${countdown(w.nextAt, lang)}` : ""}
              </span>
              <a className="btn btn--quiet" href="#/swap?tab=bridge">
                {s.open}
              </a>
            </li>
          ))}
        </ul>
      )}

      <h2>{s.gamesH}</h2>
      {data.games.length === 0 ? (
        <p className="empty">{s.gamesNone}</p>
      ) : (
        <ul className="offerlist">
          {data.games.map((g) => (
            <li key={g.id}>
              <b>#{g.id}</b>
              <span>{g.status === "Open" ? s.gameOpen : s.gamePlaying}</span>
              <a className="btn btn--quiet" href={`#/yut/${g.id}`}>
                {s.gameGo}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Dojang status, test won faucet and the savings-circle record (formerly the whole page). */
function Identity() {
  const { account, deployment, run } = useApp();
  const { t } = useLang();
  const s = t.me;
  const { data } = useChain(
    async () => (account && deployment ? { id: await readIdentity(deployment, account), rec: await readRecord(deployment, account) } : null),
    [account, deployment],
  );
  if (!data) return <p className="empty">{s.loading}</p>;
  const { id, rec } = data;
  const nextDrip = id.lastDrip ? id.lastDrip + 86400 : 0;
  const canDrip = Date.now() / 1000 >= nextDrip;
  return (
    <>
      <section className="me__id" aria-labelledby="id-h">
        <h2 id="id-h">{s.idH}</h2>
        {id.upbit ? (
          <p>{s.upbit}</p>
        ) : id.testnet ? (
          <p>{s.testnet}</p>
        ) : (
          <>
            <p>{s.none}</p>
            <VerifyNow />
          </>
        )}
        <p className="me__wallet">
          {s.holds(Number(formatEther(id.eth)).toFixed(4), won(id.won))}{" "}
          {id.eth === 0n && (
            <>
              {s.faucetA}{" "}
              <a href="https://faucet.giwa.io/" target="_blank" rel="noreferrer">
                {s.faucetLink}
              </a>
              .
            </>
          )}
        </p>
        <button className="btn btn--line" disabled={!canDrip} onClick={() => void run(s.dripping, s.dripped, (w) => actions.drip(w, deployment!))}>
          {canDrip ? s.drip : s.nextDrip(Math.ceil((nextDrip - Date.now() / 1000) / 3600))}
        </button>
      </section>
      <section className="me__rec" aria-labelledby="rec-h">
        <h2 id="rec-h">{s.recH}</h2>
        {rec.defaults > 0 && <p className="warn">{s.defaulted}</p>}
        <dl className="figures">
          <div><dt>{s.fClean}</dt><dd>{rec.completed}</dd></div>
          <div><dt>{s.fLate}</dt><dd>{rec.late}</dd></div>
          <div><dt>{s.fDefaults}</dt><dd>{rec.defaults}</dd></div>
          <div><dt>{s.fActive}</dt><dd>{s.fActiveVal(rec.active, rec.maxConcurrent)}</dd></div>
          <div><dt>{s.fProven}</dt><dd>{usd(rec.provenUsd)}</dd></div>
          <div><dt>{s.fCredit}</dt><dd>{usd(rec.availableCredit)}</dd></div>
          <div><dt>{s.fHold}</dt><dd>{rec.holdbackBps / 100}%</dd></div>
        </dl>
        <p className="form__note">{s.easNote}</p>
      </section>
    </>
  );
}
