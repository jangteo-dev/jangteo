/**
 * Upbit's live KRW prices of ETH and USDT, cached for a minute, so every won amount on Telegram
 * can carry its ETH and dollar equivalents. Reads are synchronous from the cache; `refreshFx`
 * keeps it warm.
 */
let ethKrw = 0;
let usdKrw = 0;
let at = 0;

export async function refreshFx() {
  if (Date.now() - at < 60_000 && ethKrw) return;
  try {
    const res = await fetch("https://api.upbit.com/v1/ticker?markets=KRW-ETH,KRW-USDT", { signal: AbortSignal.timeout(8000) });
    const j = (await res.json()) as { market: string; trade_price: number }[];
    ethKrw = j.find((x) => x.market === "KRW-ETH")?.trade_price ?? ethKrw;
    usdKrw = j.find((x) => x.market === "KRW-USDT")?.trade_price ?? usdKrw;
    at = Date.now();
  } catch {
    /* keep the last good rates */
  }
}

export const fx = () => ({ ethKrw, usdKrw });

/** "₩12,000 (≈0.0033 ETH · $8.70)", or just the won amount before the first rate arrives. */
export function krwPlus(won: number): string {
  const base = `₩${Math.round(won).toLocaleString("en-US")}`;
  if (!ethKrw || !usdKrw || won === 0) return base;
  const eth = won / ethKrw;
  const usd = won / usdKrw;
  const e = eth.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  const u = usd >= 0.01 ? usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : usd.toLocaleString("en-US", { maximumSignificantDigits: 2 });
  return `${base} (≈${e} ETH · $${u})`;
}
