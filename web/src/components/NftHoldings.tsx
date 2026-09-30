import type { Address } from "viem";
import { useApp, useChain } from "../app";
import { useLang } from "../i18n";
import { loadCollection, loadIndex, tokenName, type CollectionDoc, type Token } from "../lib/insa";
import { Eth, Frame } from "./InsaBits";

/** Every NFT the wallet holds in a collection Insadong follows, valued at that collection's floor. */
export function NftHoldings({ account }: { account: Address }) {
  const { tick } = useApp();
  const { t } = useLang();
  const s = t.pf;
  const { data } = useChain(async () => {
    const idx = await loadIndex();
    if (!idx) return null;
    const docs = (await Promise.all(idx.collections.filter((c) => c.supply > 0).map((c) => loadCollection(c.address)))).filter((d): d is CollectionDoc => !!d);
    const me = account.toLowerCase();
    return { ethKrw: idx.ethKrw, rows: docs.flatMap((d) => d.tokens.filter((x) => x.owner.toLowerCase() === me).map((x) => ({ d, x }))) };
  }, [account, tick]);
  if (!data) return null;
  const floorWei = data.rows.reduce((a, { d }) => a + BigInt(d.collection.floor ?? 0), 0n);
  return (
    <section className="nfthold" aria-labelledby="nft-h">
      <div className="nfthold__top">
        <h2 id="nft-h">
          {s.nftH} <span>{data.rows.length}</span>
        </h2>
        {floorWei > 0n && (
          <p>
            {s.nftValue} <Eth wei={floorWei} ethKrw={data.ethKrw} />
          </p>
        )}
      </div>
      {data.rows.length === 0 ? (
        <p className="empty">{s.nftNone}</p>
      ) : (
        <ul className="itemgrid itemgrid--small">
          {data.rows.map(({ d, x }: { d: CollectionDoc; x: Token }) => (
            <li key={`${d.collection.address}-${x.id}`}>
              <a className="itemcard" href={`#/insa/c/${d.collection.address}/${x.id}`}>
                <Frame src={x.image} alt="" />
                <span className="itemcard__name">{tokenName(x.name, d.collection.name, x.id)}</span>
                {x.listing ? (
                  <small className="itemcard__none">
                    {s.nftListed} · <Eth wei={x.listing.price} />
                  </small>
                ) : (
                  <small className="itemcard__none">{d.collection.name}</small>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="form__note">{s.nftNote}</p>
    </section>
  );
}
