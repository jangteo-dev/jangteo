import { useState } from "react";
import { parseEther, type Address } from "viem";
import { useApp } from "../app";
import { useLang } from "../i18n";
import { ANY, makeOffer } from "../lib/insa";

const DAYS = [1, 7, 30];

/** Escrow ETH for one item (`tokenId`) or for any item of the collection. */
export function OfferForm({ collection, tokenId, onDone }: { collection: Address; tokenId: bigint | null; onDone?: () => void }) {
  const { account, deployment, run } = useApp();
  const { t } = useLang();
  const s = t.ins;
  const [price, setPrice] = useState("");
  const [days, setDays] = useState(7);
  const market = deployment?.insaMarket;
  let wei = 0n;
  try {
    wei = price ? parseEther(price) : 0n;
  } catch {
    wei = 0n;
  }
  return (
    <form
      className="form insaform"
      onSubmit={(e) => {
        e.preventDefault();
        if (!market || wei === 0n) return;
        void run(s.offering, s.offered, (w) => makeOffer(w, market, collection, tokenId ?? ANY, wei, days)).then((ok) => ok && (setPrice(""), onDone?.()));
      }}
    >
      <label className="field">
        <span>{s.offerPrice}</span>
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.01" />
      </label>
      <fieldset className="chips">
        <legend>{s.duration}</legend>
        {DAYS.map((d) => (
          <button type="button" key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
            {s.days(d)}
          </button>
        ))}
      </fieldset>
      <button className="btn btn--ink btn--wide" disabled={!account || wei === 0n}>
        {account ? s.placeOffer : t.wallet.connectFirst}
      </button>
      <p className="form__note">{s.offerNote}</p>
    </form>
  );
}
