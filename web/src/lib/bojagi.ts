/**
 * Jogakbo layout: a rectangle split recursively into as many patches as a circle has seats,
 * seeded by the circle address so every circle has its own cloth. Real jogakbo are pieced
 * from uneven scraps, so splits stay deliberately off-centre.
 */
export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
  seat: number;
}

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 10_000) / 10_000;
  };
}

export function layout(n: number, seed: string, w = 100, h = 100): Patch[] {
  const rand = rng(seed || "gye");
  const out: Omit<Patch, "seat">[] = [];
  const split = (x: number, y: number, pw: number, ph: number, k: number) => {
    if (k <= 1) {
      out.push({ x, y, w: pw, h: ph });
      return;
    }
    const a = Math.max(1, Math.round(k * (0.34 + rand() * 0.32)));
    const b = k - a;
    const t = a / k;
    const wide = pw / ph > 1.15 ? true : pw / ph < 0.87 ? false : rand() > 0.5;
    if (wide) {
      split(x, y, pw * t, ph, a);
      split(x + pw * t, y, pw * (1 - t), ph, b);
    } else {
      split(x, y, pw, ph * t, a);
      split(x, y + ph * t, pw, ph * (1 - t), b);
    }
  };
  split(0, 0, w, h, Math.max(1, n));
  // Seat order follows reading order, like the order members sat down at the table.
  return out
    .map((p) => ({ ...p, cy: p.y + p.h / 2, cx: p.x + p.w / 2 }))
    .sort((p, q) => (Math.abs(p.cy - q.cy) > 8 ? p.cy - q.cy : p.cx - q.cx))
    .map(({ x, y, w: pw, h: ph }, seat) => ({ x, y, w: pw, h: ph, seat }));
}

/** Obangsaek-derived fabric tones; seats cycle through them. */
export const FABRIC = ["#2F4A9A", "#B3243A", "#D9A021", "#3E7F6B", "#F4F5F0", "#5B3C88", "#6F8A2A", "#1F6E8C"];
