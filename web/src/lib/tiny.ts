/** Number formatting for prices that live many zeros after the decimal point. */

const SUB = "₀₁₂₃₄₅₆₇₈₉";
const sub = (n: number) => String(n).replace(/\d/g, (d) => SUB[Number(d)]);

/**
 * Tiny numbers the way crypto traders read them: 0.000000002157 → 0.0₈2157 (eight zeros, then
 * the digits that matter). Numbers of normal size keep ordinary decimals.
 */
export function fmtTiny(v: number, digits = 4): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1000) return sign + a.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return sign + a.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const zeros = Math.floor(-Math.log10(a));
  if (zeros < 4) return sign + a.toFixed(zeros + digits).replace(/0+$/, "").replace(/\.$/, "");
  const sig = Math.round(a * 10 ** (zeros + digits)).toString().slice(0, digits).replace(/0+$/, "") || "0";
  return `${sign}0.0${sub(zeros)}${sig}`;
}

