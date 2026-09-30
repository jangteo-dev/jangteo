// Preview grid of Tal masks: node src/nft/talPreview.ts <out.html> [seed]
import { writeFileSync } from "node:fs";
import { BACKDROPS, CHARMS, HEADWEAR, MASKS, PALETTES, WOODS, render, traitsOf, UNREVEALED } from "./talArt.ts";

const out = process.argv[2] ?? "tal.html";
const seed = BigInt(process.argv[3] ?? "123456789");
const cells: string[] = [`<figure><img width=240 src="data:image/svg+xml;base64,${Buffer.from(UNREVEALED).toString("base64")}"><figcaption>unrevealed</figcaption></figure>`];
for (let id = 1n; id <= 23n; id++) {
  const t = traitsOf(seed, id);
  const cap = [MASKS[t.mask].name, WOODS[t.wood].name, BACKDROPS[t.backdrop].name, PALETTES[t.palette].name, HEADWEAR[t.headwear].name, CHARMS[t.charm].name].join(" · ");
  cells.push(`<figure><img width=240 src="data:image/svg+xml;base64,${Buffer.from(render(t)).toString("base64")}"><figcaption>#${id} ${cap}</figcaption></figure>`);
}
writeFileSync(out, `<html><body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(6,1fr);gap:6px;font:10px sans-serif;color:#ccc">${cells.join("")}</body></html>`);
