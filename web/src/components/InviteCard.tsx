import { useState } from "react";
import { isAddress, zeroAddress, type Address } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { chain, client, confirmed, shortAddr } from "../lib/chain";
import { inviteAbi, inviteLink, savedRef } from "../lib/invite";

/**
 * 친구 초대: my link to share, and — for a wallet that hasn't named one yet — who invited me.
 * Joining is one small transaction; the season engine credits both sides once both are verified.
 */
export function InviteCard({ invite, points, friends }: { invite: Address; points: number; friends: number }) {
  const { account, run, tick } = useApp();
  const { t } = useLang();
  const s = t.pt;
  const [copied, setCopied] = useState(false);
  const [typed, setTyped] = useState("");

  const { data: by } = useChain(
    async () => (account ? await client.readContract({ address: invite, abi: inviteAbi, functionName: "referrerOf", args: [account] }) : null),
    [account, invite, tick],
  );

  if (!account) return null;
  const link = inviteLink(account);
  const suggested = savedRef();
  const target = (isAddress(typed) ? typed : suggested) as Address | null;
  const canJoin = by === zeroAddress && !!target && target.toLowerCase() !== account.toLowerCase();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(s.invCopy, link);
    }
  };
  const join = () =>
    run(s.invJoining, s.invJoined, async (w) => {
      const hash = await w.writeContract({ account: w.account!, chain, address: invite, abi: inviteAbi, functionName: "join", args: [target!] });
      await confirmed(hash);
    });

  return (
    <section className="invite" aria-labelledby="invite-h">
      <h2 id="invite-h">{s.invTitle}</h2>
      <p className="form__note">{s.invLede}</p>
      <div className="invite__link">
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={s.invTitle} />
        <button type="button" className="btn btn--line" onClick={copy}>
          {copied ? s.invCopied : s.invCopy}
        </button>
      </div>
      <div className="invite__nums">
        <div>
          <span>{s.invFriends}</span>
          <b>{friends}</b>
        </div>
        <div>
          <span>{s.invPoints}</span>
          <b>{Math.round(points).toLocaleString("en-US")} P</b>
        </div>
      </div>
      {by && by !== zeroAddress && <p className="form__note">{s.invBy(shortAddr(by))}</p>}
      {by === zeroAddress && (
        <div className="invite__join">
          {suggested && suggested.toLowerCase() !== account.toLowerCase() ? (
            <p className="form__note">{s.invFrom(shortAddr(suggested))}</p>
          ) : (
            <label>
              <span>{s.invPaste}</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
            </label>
          )}
          <button type="button" className="btn btn--ink btn--wide" disabled={!canJoin} onClick={join}>
            {s.invJoin}
          </button>
        </div>
      )}
    </section>
  );
}
