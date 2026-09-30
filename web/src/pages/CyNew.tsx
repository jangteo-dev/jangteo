import { useState } from "react";
import { formatUnits, isAddress, parseUnits, type Address } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { cheongyak, money, tokenInfo, WETH, type Profile } from "../lib/cheongyak";
import { fmtTokens } from "./CyList";
import { ProfileFields, profileValid } from "./CyPage";

const num = (v: string) => v.replace(/[^\d.]/g, "");

export function CyNew() {
  const { deployment, account, run } = useApp();
  const { t } = useLang();
  const s = t.cy;
  const [token, setToken] = useState("");
  const [tName, setTName] = useState("Hanok");
  const [tSym, setTSym] = useState("HANOK");
  const [supply, setSupply] = useState("10000000");
  const [quoteKind, setQuoteKind] = useState<"tkrw" | "weth">("tkrw");
  const [name, setName] = useState("");
  const [total, setTotal] = useState("1000000");
  const [price, setPrice] = useState("100");
  const [startIn, setStartIn] = useState(10);
  const [hours, setHours] = useState(24);
  const [equal, setEqual] = useState(50);
  const [min, setMin] = useState("10000");
  const [max, setMax] = useState("1000000");
  const [softCap, setSoftCap] = useState("");
  const [tge, setTge] = useState(100);
  const [cliff, setCliff] = useState(30);
  const [vestDays, setVestDays] = useState(90);
  const [liq, setLiq] = useState(20);
  const [lock, setLock] = useState(180);
  const [profile, setProfile] = useState<Profile>({});

  const valid = isAddress(token);
  const { data: info } = useChain(async () => (valid ? tokenInfo(token as Address, account ?? undefined) : null), [token, account]);
  const addr = deployment?.cheongyakV2;
  const quote = quoteKind === "weth" ? WETH : deployment?.tkrw;
  const q = { quote: quote ?? WETH, quoteSymbol: quoteKind === "weth" ? "WETH" : "tKRW" };
  const m = (v: bigint) => money(q, deployment?.tkrw, v);

  const safe = (v: string) => {
    try {
      return v ? parseUnits(v, 18) : 0n;
    } catch {
      return 0n;
    }
  };
  const totalRaw = safe(total);
  const priceRaw = safe(price);
  const cap = (totalRaw * priceRaw) / 10n ** 18n;
  const liqTokens = (totalRaw * BigInt(liq * 100)) / 10_000n;
  const needed = totalRaw + liqTokens;
  const softRaw = safe(softCap);
  const vesting = tge < 100;
  const ready =
    !!addr &&
    !!quote &&
    valid &&
    !!info &&
    name.trim() !== "" &&
    totalRaw > 0n &&
    priceRaw > 0n &&
    safe(min) > 0n &&
    safe(max) >= safe(min) &&
    softRaw <= cap &&
    info.balance >= needed &&
    profileValid(profile) &&
    (!vesting || cliff + vestDays > 0);

  if (deployment && !addr) return <main className="page"><p className="empty">{s.notDeployed}</p></main>;

  return (
    <main className="page create">
      <a className="back" href="#/cheongyak">{s.back}</a>
      <h1>{s.newH1}</h1>
      <p className="lede create__lede">{s.newLede}</p>

      <div className="create__body">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            let made: number | null = null;
            void run(s.opening, s.opened, async (w) => {
              const { rc } = await cheongyak.create(w, addr!, {
                token: token as Address,
                quote: quote!,
                name: name.trim(),
                total,
                price,
                startInMin: startIn,
                hours,
                equalPct: equal,
                min,
                max,
                softCap,
                tgePct: tge,
                cliffDays: cliff,
                vestingDays: vestDays,
                liqPct: liq,
                lockDays: lock,
                profile,
              });
              // The Created event's first topic is the new offering's id: open it straight away.
              const log = rc.logs.find((l) => l.address.toLowerCase() === addr!.toLowerCase() && l.topics.length === 4);
              made = log?.topics[1] ? Number(BigInt(log.topics[1])) : null;
            }).then((ok) => ok && (location.hash = made !== null ? `#/cheongyak/${made}` : "#/cheongyak"));
          }}
        >
          <h2>{s.tokenH}</h2>
          <label>
            <span>{s.tokenAddr}</span>
            <input value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
          </label>
          {info && <p className="form__note">{s.balance(Number(formatUnits(info.balance, 18)).toLocaleString("en-US"), info.symbol)}</p>}

          <h2>{s.offeringH}</h2>
          <label>
            <span>{s.oName}</span>
            <input value={name} maxLength={31} onChange={(e) => setName(e.target.value)} placeholder={s.oNamePh} />
          </label>
          <fieldset className="segmented">
            <legend>{s.quoteH}</legend>
            {(["tkrw", "weth"] as const).map((k) => (
              <label key={k} className={quoteKind === k ? "is-on" : ""}>
                <input type="radio" name="quote" checked={quoteKind === k} onChange={() => setQuoteKind(k)} />
                {k === "tkrw" ? s.quoteTkrw : s.quoteWeth}
              </label>
            ))}
          </fieldset>
          <label>
            <span>{s.oTotal}</span>
            <input inputMode="numeric" value={total} onChange={(e) => setTotal(e.target.value.replace(/[^\d]/g, ""))} />
          </label>
          <label>
            <span>{s.oPrice(q.quoteSymbol)}</span>
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(num(e.target.value))} />
          </label>
          <label>
            <span>{s.oStart(startIn)}</span>
            <input type="range" min={1} max={1440} value={startIn} onChange={(e) => setStartIn(Number(e.target.value))} />
          </label>
          <label>
            <span>{s.oHours(hours)}</span>
            <input type="range" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </label>
          <label>
            <span>{s.oEqual(equal)}</span>
            <input type="range" min={0} max={100} step={5} value={equal} onChange={(e) => setEqual(Number(e.target.value))} />
          </label>
          <div className="form__pair">
            <label>
              <span>{s.oMin}</span>
              <input inputMode="decimal" value={min} onChange={(e) => setMin(num(e.target.value))} />
            </label>
            <label>
              <span>{s.oMax}</span>
              <input inputMode="decimal" value={max} onChange={(e) => setMax(num(e.target.value))} />
            </label>
          </div>
          <label>
            <span>{s.oSoftCap(q.quoteSymbol)}</span>
            <input inputMode="decimal" value={softCap} onChange={(e) => setSoftCap(num(e.target.value))} aria-invalid={softRaw > cap} />
          </label>
          <p className="form__note">{s.oSoftCapNote(m(cap))}</p>

          <h2>{s.unlockH}</h2>
          <label>
            <span>{s.oTge(tge)}</span>
            <input type="range" min={0} max={100} step={5} value={tge} onChange={(e) => setTge(Number(e.target.value))} />
          </label>
          {vesting && (
            <>
              <label>
                <span>{s.oCliff(cliff)}</span>
                <input type="range" min={0} max={365} value={cliff} onChange={(e) => setCliff(Number(e.target.value))} />
              </label>
              <label>
                <span>{s.oVesting(vestDays)}</span>
                <input type="range" min={0} max={730} step={5} value={vestDays} onChange={(e) => setVestDays(Number(e.target.value))} />
              </label>
            </>
          )}
          <p className="form__note">
            {vesting ? s.unlockVal(tge, cliff, vestDays) : s.unlockAll}
          </p>

          <h2>{s.liqH}</h2>
          <label>
            <span>{s.oLiq(liq)}</span>
            <input type="range" min={0} max={50} step={5} value={liq} onChange={(e) => setLiq(Number(e.target.value))} />
          </label>
          {liq > 0 && (
            <>
              <label>
                <span>{s.oLock(lock)}</span>
                <input type="range" min={30} max={730} step={10} value={lock} onChange={(e) => setLock(Number(e.target.value))} />
              </label>
              <p className="form__note">{s.oLiqNote(fmtTokens(liqTokens), info?.symbol ?? "")}</p>
            </>
          )}

          <h2>{s.profileFormH}</h2>
          <ProfileFields p={profile} set={setProfile} s={s} />

          <p className="form__note">{s.oNote(2)}</p>
          {info && info.balance < needed && <p className="form__note form__note--warn">{s.needTokens(fmtTokens(needed), info.symbol)}</p>}
          <button className="btn btn--ink btn--wide" disabled={!account || !ready}>
            {account ? s.open : t.wallet.connect}
          </button>
        </form>

        <aside className="panel">
          <p>{s.orMint}</p>
          <form
            className="betform"
            onSubmit={(e) => {
              e.preventDefault();
              void run(s.minting, s.minted, async (w) => {
                const a = await cheongyak.mintToken(w, deployment!.tokenFactory!, tName, tSym, supply);
                setToken(a);
              });
            }}
          >
            <label>
              <span>{s.tName}</span>
              <input value={tName} maxLength={40} onChange={(e) => setTName(e.target.value)} />
            </label>
            <label>
              <span>{s.tSymbol}</span>
              <input value={tSym} maxLength={12} onChange={(e) => setTSym(e.target.value.toUpperCase())} />
            </label>
            <label>
              <span>{s.tSupply}</span>
              <input inputMode="numeric" value={supply} onChange={(e) => setSupply(e.target.value.replace(/[^\d]/g, ""))} />
            </label>
            <button className="btn btn--line btn--wide" disabled={!account || !deployment?.tokenFactory}>
              {s.mint}
            </button>
          </form>
        </aside>
      </div>
    </main>
  );
}
