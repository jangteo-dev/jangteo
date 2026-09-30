/** Copy of ops/src/nft/talArt.ts (the source of truth), used here to preview masks in the browser.
 *
 * 탈 Tal — Jangteo's own collection of Korean masks, drawn entirely on-chain.
 *
 * This file is the source of truth for the art. `talSol.ts` turns these tables into
 * `contracts/src/insa/TalParts.sol`, and `render()` below assembles an SVG exactly the way the
 * contract does, so previews, tests and the chain always agree.
 *
 * Every part uses CSS classes only; a token's colours live in one <style> block:
 *   b b2 b3   background, its accent, its detail      f fs   mask face and its shade
 *   f1 f2     face gradient stops                     l e    ink lines and eye fill
 *   h         hair (always dark)                      r      red (lips, cheeks, jewels)
 *   w         white                                   g      gold / straw
 *   k k2      headwear and its trim
 */
import { encodeAbiParameters, keccak256 } from "viem";

export interface Trait {
  name: string;
  ko: string;
  weight: number;
}

// ---- tables (order and weights are part of the contract: never reorder after launch) ----------

export const BACKDROPS: (Trait & { svg: string })[] = [
  { name: "Hanji", ko: "한지", weight: 30, svg: `<rect class="b" width="400" height="400"/><path class="b2" opacity=".35" d="M0 332h400v68H0z"/>` },
  {
    name: "Sun and Moon Peaks",
    ko: "일월오봉",
    weight: 16,
    svg:
      `<rect class="b" width="400" height="400"/><circle class="r" cx="332" cy="70" r="30"/><circle class="w" cx="68" cy="70" r="26"/>` +
      `<path class="b2" d="M0 400V300l50-70 45 55 60-110 45 70 45-70 60 110 45-55 50 70v100z"/>` +
      `<path class="b3" opacity=".55" d="M0 400v-40q50-22 100 0t100 0 100 0 100 0v40z"/>`,
  },
  {
    name: "Waves",
    ko: "파도",
    weight: 16,
    svg:
      `<rect class="b" width="400" height="400"/><g fill="none" class="b2s" stroke-width="7" stroke-linecap="round">` +
      `<path d="M-10 318q30-28 60 0t60 0 60 0 60 0 60 0 60 0 60 0"/><path d="M-10 348q30-28 60 0t60 0 60 0 60 0 60 0 60 0 60 0"/>` +
      `<path d="M-10 378q30-28 60 0t60 0 60 0 60 0 60 0 60 0 60 0"/></g>`,
  },
  {
    name: "Clouds",
    ko: "구름",
    weight: 14,
    svg:
      `<rect class="b" width="400" height="400"/><g fill="none" class="b2s" stroke-width="6" stroke-linecap="round">` +
      `<path d="M22 92c0-18 26-18 26 0 0-24 36-24 36 0m-8 0h46"/><path d="M292 60c0-18 26-18 26 0 0-24 36-24 36 0m-8 0h40"/>` +
      `<path d="M300 318c0-18 26-18 26 0 0-24 36-24 36 0m-8 0h40"/><path d="M14 300c0-18 26-18 26 0 0-24 36-24 36 0m-8 0h46"/></g>`,
  },
  {
    name: "Dancheong",
    ko: "단청",
    weight: 14,
    svg:
      `<rect class="b" width="400" height="400"/><circle class="b2" cx="200" cy="200" r="178"/><circle class="b3" cx="200" cy="200" r="160"/>` +
      `<circle class="r" cx="200" cy="200" r="146"/><circle class="b" cx="200" cy="200" r="134"/>` +
      `<circle fill="none" class="b2s" stroke-width="3" stroke-dasharray="4 10" cx="200" cy="200" r="170"/>`,
  },
  {
    name: "Bojagi",
    ko: "보자기",
    weight: 10,
    svg:
      `<rect class="b" width="400" height="400"/><path class="b2" d="M0 0h130v110H0zM270 0h130v70H270zM300 290h100v110H300zM0 300h90v100H0z"/>` +
      `<path class="b3" d="M130 0h60v50h-60zM340 70h60v90h-60zM0 110h50v80H0zM230 350h70v50h-70z"/>` +
      `<path fill="none" class="b3s" stroke-width="2" stroke-dasharray="3 5" d="M130 0v110H0M270 0v70h130M300 400V290h100M90 400V300H0"/>`,
  },
];

export const PALETTES: { name: string; ko: string; weight: number; b: string; b2: string; b3: string }[] = [
  { name: "Jade", ko: "비취", weight: 16, b: "#2f5d50", b2: "#c8a24a", b3: "#e9dfc7" },
  { name: "Indigo", ko: "쪽빛", weight: 16, b: "#1f2a44", b2: "#c8a24a", b3: "#e9dfc7" },
  { name: "Vermilion", ko: "주홍", weight: 12, b: "#a8392c", b2: "#e9c46a", b3: "#1f2a44" },
  { name: "Hanji Cream", ko: "미색", weight: 18, b: "#ebe0c8", b2: "#2f5d50", b3: "#b23a2e" },
  { name: "Ink", ko: "먹", weight: 12, b: "#1c1a19", b2: "#b23a2e", b3: "#c8a24a" },
  { name: "Pine", ko: "솔", weight: 14, b: "#3d5a3a", b2: "#e2c275", b3: "#f0e6d2" },
  { name: "Plum", ko: "매화", weight: 12, b: "#5e2a44", b2: "#e8a0a8", b3: "#f0e6d2" },
];

export const WOODS: { name: string; ko: string; weight: number; f: string; fs: string; f1: string; l: string }[] = [
  { name: "Alder", ko: "오리나무", weight: 35, f: "#d9b48a", fs: "#b88a5e", f1: "#ecd0ac", l: "#2a211b" },
  { name: "White", ko: "백", weight: 20, f: "#efe6d4", fs: "#cdbfa3", f1: "#fbf6ea", l: "#2a211b" },
  { name: "Red Lacquer", ko: "주칠", weight: 18, f: "#b8412f", fs: "#8e2d22", f1: "#d0604b", l: "#231310" },
  { name: "Ink", ko: "먹", weight: 12, f: "#34302c", fs: "#1f1c1a", f1: "#4a443e", l: "#eadcbd" },
  { name: "Celadon", ko: "청자", weight: 10, f: "#8fb3a0", fs: "#6b8f7d", f1: "#b2cfbf", l: "#1d2a24" },
  { name: "Gold", ko: "금", weight: 5, f: "#d6a93c", fs: "#a47a1f", f1: "#f0cf6e", l: "#2a1d08" },
];

const S = `class="s"`; // ink stroke
export const MASKS: (Trait & { svg: string })[] = [
  {
    name: "Yangban",
    ko: "양반",
    weight: 16,
    svg:
      `<path class="fc" d="M130 150c0-50 40-62 70-62s70 12 70 62l2 75c0 15-10 27-22 31q-50-18-100 0c-12-4-22-16-22-31z"/>` +
      `<path class="e" d="M150 256q50-18 100 0l-2 8q-48-17-96 0z"/>` +
      `<path class="fc" d="M152 266q48-17 96 0c2 28-20 50-48 50s-50-22-48-50z"/>` +
      `<path ${S} d="M160 124q40-14 80 0M166 138q34-11 68 0M150 176q16-16 32 0M218 176q16-16 32 0"/>` +
      `<path class="e" d="M150 176q16-16 32 0q-16-8-32 0zM218 176q16-16 32 0q-16-8-32 0z"/>` +
      `<path ${S} d="M200 168c-4 25-14 35-10 44 5 6 15 6 20 0M158 214q10 20 26 26M242 214q-10 20-26 26M176 292q24 10 48 0"/>` +
      `<path class="fs" d="M146 150q10-8 20-2l-4 8zM254 150q-10-8-20-2l4 8z"/>`,
  },
  {
    name: "Gaksi",
    ko: "각시",
    weight: 16,
    svg:
      `<path class="fc" d="M200 85c45 0 62 45 62 100 0 65-26 120-62 120s-62-55-62-120c0-55 17-100 62-100z"/>` +
      `<path class="h" d="M138 172c-2-60 27-94 62-94s64 34 62 94c-12-40-37-58-62-52-25-6-50 12-62 52z"/>` +
      `<path fill="none" stroke="#000" stroke-opacity=".35" stroke-width="3" d="M200 80v40"/>` +
      `<path ${S} d="M160 180q12 7 24 0M216 180q12 7 24 0M162 164q11-6 22-2M216 162q11-4 22 2M200 182l-3 40q3 4 8 1"/>` +
      `<ellipse class="r" cx="200" cy="256" rx="11" ry="5"/><circle class="r" cx="162" cy="230" r="9"/><circle class="r" cx="238" cy="230" r="9"/>` +
      `<circle class="r" cx="200" cy="146" r="6"/>`,
  },
  {
    name: "Bune",
    ko: "부네",
    weight: 14,
    svg:
      `<circle class="h" cx="158" cy="96" r="22"/><circle class="h" cx="242" cy="96" r="22"/>` +
      `<path class="fc" d="M200 92c48 0 70 43 70 98 0 60-30 110-70 110s-70-50-70-110c0-55 22-98 70-98z"/>` +
      `<path class="h" d="M132 180c-2-62 30-92 68-92s70 30 68 92c-13-40-38-55-68-52-30-3-55 12-68 52z"/>` +
      `<ellipse class="r" opacity=".45" cx="160" cy="228" rx="17" ry="10"/><ellipse class="r" opacity=".45" cx="240" cy="228" rx="17" ry="10"/>` +
      `<ellipse class="e" cx="170" cy="192" rx="8" ry="4"/><ellipse class="e" cx="230" cy="192" rx="8" ry="4"/>` +
      `<path ${S} d="M158 186q12-9 24 0M218 186q12-9 24 0M160 172q10-5 20-2M220 170q10-3 20 2M200 196l-2 28q3 3 7 1"/>` +
      `<path class="r" d="M185 252q8-7 15-2 7-5 15 2-15 14-30 0z"/>`,
  },
  {
    name: "Choraengi",
    ko: "초랭이",
    weight: 14,
    svg:
      `<path class="fc" d="M200 92c40 0 68 33 66 83-2 50-26 110-61 137-5 4-10 0-15-6-30-26-56-81-56-131-2-50 26-83 66-83z"/>` +
      `<circle class="w" cx="170" cy="176" r="16"/><circle class="w" cx="232" cy="172" r="16"/>` +
      `<circle class="e" cx="174" cy="178" r="7"/><circle class="e" cx="228" cy="174" r="7"/>` +
      `<path ${S} d="M152 150l32-10M216 136l34 8M154 176a16 16 0 0 0 32 0M216 172a16 16 0 0 0 32 0M204 186l-8 34h14"/>` +
      `<path class="e" d="M175 250q25-12 53-6-4 24-28 28-18-4-25-22z"/><path class="w" d="M186 250h30v6h-30z"/>` +
      `<path class="fs" d="M150 112q20-12 40-10l-6 6zM250 112q-20-12-40-10l6 6z"/>`,
  },
  {
    name: "Imae",
    ko: "이매",
    weight: 12,
    svg:
      `<path class="fc" d="M132 160c0-52 33-70 68-70s68 18 68 70v90q-33 12-68 8-35 4-68-8z"/>` +
      `<path ${S} d="M152 186q16 12 32 2M216 188q16 10 32-2M154 166q14 4 28 12M218 178q14-8 28-12M205 175c-5 25-9 35-1 47M168 238q27 14 57-4"/>` +
      `<path class="e" d="M152 186q16 12 32 2q-16 4-32-2zM216 188q16 10 32-2q-16 8-32 2z"/>` +
      `<path class="fs" d="M132 250q33 12 68 8 35 4 68-8v8q-33 12-68 8-35 4-68-8z"/>`,
  },
  {
    name: "Halmi",
    ko: "할미",
    weight: 12,
    svg:
      `<path class="fc" d="M200 88c36 0 62 30 66 82 4 60-16 122-66 130-50-8-70-70-66-130 4-52 30-82 66-82z"/>` +
      `<circle class="e" cx="168" cy="180" r="11"/><circle class="e" cx="232" cy="180" r="11"/><circle class="e" cx="200" cy="252" r="16"/>` +
      `<path ${S} d="M164 120q36-10 72 0M160 134q40-10 80 0M168 148q32-8 64 0M150 202q8 14 4 30M250 202q-8 14-4 30M200 188v36M176 282q24 8 48 0"/>`,
  },
  {
    name: "Malttugi",
    ko: "말뚝이",
    weight: 12,
    svg:
      `<path class="fc" d="M128 170c-4-60 32-84 72-84s76 24 72 84c4 70-24 130-72 134-48-4-76-64-72-134z"/>` +
      `<circle class="fs" cx="175" cy="115" r="9"/><circle class="fs" cx="225" cy="115" r="9"/><circle class="fs" cx="200" cy="104" r="9"/>` +
      `<circle class="fs" cx="158" cy="140" r="9"/><circle class="fs" cx="242" cy="140" r="9"/>` +
      `<circle class="w" cx="166" cy="184" r="17"/><circle class="w" cx="234" cy="184" r="17"/><circle class="e" cx="166" cy="186" r="8"/><circle class="e" cx="234" cy="186" r="8"/>` +
      `<path class="e" d="M146 160l40-6-2 8-36 4zM254 160l-40-6 2 8 36 4z"/>` +
      `<path ${S} d="M190 196q-4 30 10 34 14-4 10-34"/>` +
      `<path class="e" d="M156 248q44 50 88 0-44 18-88 0z"/><path class="w" d="M172 254h56l-4 8h-48z"/>`,
  },
  {
    name: "Dokkaebi",
    ko: "도깨비",
    weight: 4,
    svg:
      `<path class="g" d="M160 112c-14-26-12-50 0-72 4 26 14 44 22 58zM240 112c14-26 12-50 0-72-4 26-14 44-22 58z"/>` +
      `<path class="fc" d="M126 160c0-48 34-66 74-66s74 18 74 66c0 40-4 70-16 100-12 30-34 46-58 46s-46-16-58-46c-12-30-16-60-16-100z"/>` +
      `<circle class="g" cx="166" cy="180" r="17"/><circle class="g" cx="234" cy="180" r="17"/>` +
      `<path class="e" d="M163 166h6v28h-6zM231 166h6v28h-6z"/><path class="e" d="M140 150l52 14-2 8-50-10zM260 150l-52 14 2 8 50-10z"/>` +
      `<path class="e" d="M186 214q14 10 28 0-4 12-14 12t-14-12z"/>` +
      `<path class="e" d="M150 248q50 30 100 0-10 40-50 44-40-4-50-44z"/><path class="w" d="M162 252l10 20 8-16zM238 252l-10 20-8-16z"/>`,
  },
];

export const HEADWEAR: (Trait & { svg: string })[] = [
  { name: "None", ko: "없음", weight: 34, svg: "" },
  {
    name: "Gat",
    ko: "갓",
    weight: 18,
    svg:
      `<path class="k" fill-opacity=".92" d="M166 100l5-56q29-8 58 0l5 56z"/><ellipse class="k" fill-opacity=".86" cx="200" cy="100" rx="112" ry="15"/>` +
      `<path class="k2" d="M168 88h64v6h-64z"/>` +
      `<path fill="none" class="k2s" stroke-width="5" stroke-linecap="round" stroke-dasharray=".1 9" d="M142 108q-10 100 28 190M258 108q10 100-28 190"/>`,
  },
  {
    name: "Jokduri",
    ko: "족두리",
    weight: 12,
    svg: `<path class="k" d="M168 92l6-30 26-12 26 12 6 30z"/><circle class="g" cx="200" cy="50" r="6"/><circle class="g" cx="176" cy="66" r="4"/><circle class="g" cx="224" cy="66" r="4"/><circle class="r" cx="200" cy="74" r="7"/><path class="g" d="M168 88h64v5h-64z"/>`,
  },
  {
    name: "Mugunghwa",
    ko: "무궁화",
    weight: 14,
    svg:
      `<g transform="translate(252 108)"><circle class="r" cx="0" cy="-15" r="12"/><circle class="r" cx="14" cy="-5" r="12"/><circle class="r" cx="9" cy="12" r="12"/>` +
      `<circle class="r" cx="-9" cy="12" r="12"/><circle class="r" cx="-14" cy="-5" r="12"/><circle class="w" opacity=".5" r="9"/><circle class="g" r="5"/></g>`,
  },
  {
    name: "Headband",
    ko: "머리띠",
    weight: 12,
    svg: `<path class="r" d="M128 146q72-26 144 0v14q-72-26-144 0z"/><path class="r" d="M270 150q26 10 36 40l-12 2q-8-22-26-30zM272 152q30-6 44 10l-10 8q-12-10-34-6z"/>`,
  },
  {
    name: "Straw Hat",
    ko: "패랭이",
    weight: 10,
    svg:
      `<ellipse class="g" cx="200" cy="104" rx="100" ry="14"/><path class="g" d="M160 104q6-50 40-54 34 4 40 54z"/>` +
      `<path fill="none" class="k2s" stroke-width="2" d="M170 72h60M164 88h72"/><circle class="r" cx="236" cy="80" r="8"/><circle class="w" cx="246" cy="88" r="7"/>`,
  },
];

export const CHARMS: (Trait & { svg: string })[] = [
  { name: "None", ko: "없음", weight: 55, svg: "" },
  {
    name: "Norigae",
    ko: "노리개",
    weight: 25,
    svg:
      `<path fill="none" class="rs" stroke-width="3" d="M306 250v34"/><circle class="b3" cx="306" cy="292" r="10"/><path class="r" d="M300 300h12l-2 8h-8z"/>` +
      `<path fill="none" class="rs" stroke-width="3" stroke-linecap="round" d="M299 310l-6 58M303 310l-2 60M309 310l2 60M313 310l6 58"/>`,
  },
  {
    name: "Folding Fan",
    ko: "합죽선",
    weight: 20,
    svg:
      `<path class="w" d="M92 372L20 300a100 100 0 0 1 72-40z"/>` +
      `<path fill="none" class="ls" stroke-width="2" d="M92 372L20 300M92 372L30 286M92 372L43 274M92 372L58 265M92 372L75 261M92 372V260"/>` +
      `<circle class="r" cx="92" cy="372" r="5"/>`,
  },
];

// ---- assembly (mirrored by TalRenderer.sol) ---------------------------------------------------

/** Each trait draws from its own 16 bits of keccak256(abi.encode(seed, id)). */
export function pick<T extends { weight: number }>(table: T[], r: bigint, slot: number): number {
  const total = table.reduce((a, t) => a + t.weight, 0);
  let x = Number((r >> BigInt(slot * 16)) & 0xffffn) % total;
  for (let i = 0; i < table.length; i++) {
    if (x < table[i].weight) return i;
    x -= table[i].weight;
  }
  return table.length - 1;
}

export interface Tal {
  backdrop: number;
  palette: number;
  wood: number;
  mask: number;
  headwear: number;
  charm: number;
}

export function traitsOf(seed: bigint, id: bigint): Tal {
  const r = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [seed, id])));
  return {
    backdrop: pick(BACKDROPS, r, 0),
    palette: pick(PALETTES, r, 1),
    wood: pick(WOODS, r, 2),
    mask: pick(MASKS, r, 3),
    headwear: pick(HEADWEAR, r, 4),
    charm: pick(CHARMS, r, 5),
  };
}

export function style(t: Tal): string {
  const p = PALETTES[t.palette];
  const w = WOODS[t.wood];
  return (
    `<style>.b{fill:${p.b}}.b2{fill:${p.b2}}.b3{fill:${p.b3}}.b2s{stroke:${p.b2}}.b3s{stroke:${p.b3}}` +
    `.fc{fill:url(#w);stroke:${w.l};stroke-opacity:.3;stroke-width:2}.fs{fill:${w.fs}}.f1{stop-color:${w.f1}}.f2{stop-color:${w.f}}.f3{stop-color:${w.fs}}` +
    `.e{fill:${w.l}}.ls{stroke:${w.l}}.s{fill:none;stroke:${w.l};stroke-width:4;stroke-linecap:round;stroke-linejoin:round}` +
    `.h{fill:#1d1a18}.r{fill:#b3312a}.rs{stroke:#b3312a}.w{fill:#f4ecdc}.g{fill:#d9a93c}.k{fill:#191716}.k2{fill:#6b5a3a}.k2s{stroke:#3b2f22}</style>`
  );
}

/** Shared defs: wood gradient, soft shadow, and hanji grain laid over the whole picture. */
export const DEFS =
  `<defs><radialGradient id="w" cx=".42" cy=".34" r=".78"><stop offset="0" class="f1"/><stop offset=".62" class="f2"/><stop offset="1" class="f3"/></radialGradient>` +
  `<filter id="p" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7"/>` +
  `<feColorMatrix values="0 0 0 0 .1 0 0 0 0 .08 0 0 0 0 .05 0 0 0 .5 0"/></filter></defs>`;

/** The mask and its headwear are drawn at 1.2× around the centre so the face carries the picture. */
export const LIFT = `<g transform="matrix(1.2 0 0 1.2 -40 -30)">`;
export const SHADOW = `<ellipse fill="#000" opacity=".22" cx="208" cy="318" rx="84" ry="12"/>`;
export const GRAIN = `<rect width="400" height="400" filter="url(#p)" opacity=".55"/>`;

export function render(t: Tal): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">` +
    DEFS +
    style(t) +
    BACKDROPS[t.backdrop].svg +
    LIFT +
    SHADOW +
    MASKS[t.mask].svg +
    HEADWEAR[t.headwear].svg +
    `</g>` +
    CHARMS[t.charm].svg +
    GRAIN +
    `</svg>`
  );
}

/** Before the reveal: the mask waits under a wrapping cloth. */
export const UNREVEALED =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">` +
  DEFS +
  `<rect width="400" height="400" fill="#1f2a44"/><path fill="#b3312a" d="M200 70l130 130-130 130L70 200z"/>` +
  `<path fill="#c8a24a" d="M200 70l130 130H70z" opacity=".9"/><path fill="none" stroke="#f4ecdc" stroke-width="3" stroke-dasharray="3 6" d="M200 70l130 130-130 130L70 200zM70 200h260"/>` +
  `<path fill="#b3312a" d="M186 56q14-24 28 0-14 22-28 0z"/><circle fill="#f4ecdc" cx="200" cy="200" r="26"/>` +
  `<text x="200" y="210" text-anchor="middle" font-family="serif" font-size="30" fill="#1f2a44">?</text>` +
  GRAIN +
  `</svg>`;
