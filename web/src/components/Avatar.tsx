/** A wallet's patchwork: a 4×4 bojagi of obangsaek colours drawn from its address. */
const COLORS = ["var(--jjok)", "var(--hong)", "var(--hwang)", "var(--nok)", "var(--paper-hi)", "var(--ink)"];

export function Avatar({ address, size = 56 }: { address: string; size?: number }) {
  const hex = address.toLowerCase().replace(/^0x/, "");
  const cells = Array.from({ length: 16 }, (_, i) => COLORS[parseInt(hex[i * 2] + hex[i * 2 + 1], 16) % COLORS.length]);
  return (
    <svg className="avatar" viewBox="0 0 40 40" width={size} height={size} aria-hidden>
      <rect width="40" height="40" rx="9" fill="var(--paper-lo)" />
      {cells.map((c, i) => (
        <rect key={i} x={3 + (i % 4) * 8.6} y={3 + Math.floor(i / 4) * 8.6} width="8" height="8" rx="1.2" fill={c} stroke="var(--seam)" strokeWidth=".4" />
      ))}
    </svg>
  );
}
