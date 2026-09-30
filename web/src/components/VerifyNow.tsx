import { formatEther, parseAbi } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { client } from "../lib/chain";
import { actions } from "../lib/gye";

const FEE = 10n ** 15n; // the test attester's 0.001 ETH
const GAS = 5n * 10n ** 14n;
const gateAbi = parseAbi(["function isEligible(address) view returns (bool)"]);

/**
 * Dojang test verification in place: why it's needed, and the one transaction that does it.
 * Shown wherever an unverified wallet hits a verified-only feature.
 */
export function VerifyNow({ reason }: { reason?: string }) {
  const { account, deployment, run, tick } = useApp();
  const { t } = useLang();
  const s = t.vf;
  const { data: bal } = useChain(async () => (account ? client.getBalance({ address: account }) : null), [account, tick]);
  // Read the gate itself: the published points file can be minutes behind a fresh verification.
  const { data: eligible } = useChain(
    async () => (account && deployment?.gate ? client.readContract({ address: deployment.gate, abi: gateAbi, functionName: "isEligible", args: [account] }) : null),
    [account, deployment?.gate, tick],
  );
  if (!account || eligible !== false) return null;
  const short = bal !== undefined && bal !== null && bal < FEE + GAS;
  return (
    <div className="verifynow">
      {reason && <p className="verifynow__why">{reason}</p>}
      <p className="form__note">{s.how}</p>
      {short && (
        <p className="form__note form__note--warn">
          {s.needEth}{" "}
          <a href="https://faucet.giwa.io/" target="_blank" rel="noreferrer">
            {s.faucet}
          </a>{" "}
          ·{" "}
          <a href="https://faucet.lambda256.io/giwa-sepolia" target="_blank" rel="noreferrer">
            Lambda256
          </a>{" "}
          · <a href="#/swap?tab=bridge">{s.orBridge}</a> ({Number(formatEther(bal!)).toFixed(4)} ETH)
        </p>
      )}
      <button type="button" className="btn btn--ink btn--wide" disabled={short} onClick={() => void run(s.busy, s.done, (w) => actions.verifyTestnet(w))}>
        {s.btn}
      </button>
    </div>
  );
}
