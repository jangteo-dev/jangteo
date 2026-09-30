// Rasterize every SVG in the kit to PNG at the listed sizes.
const { chromium } = require("playwright");
const fs = require("fs");
const K = process.argv[2];
const jobs = [
  ["logo/jangteo-mark.svg", [[1024, "logo/jangteo-mark-1024.png"], [512, "logo/jangteo-mark-512.png"], [256, "logo/jangteo-mark-256.png"]]],
  ["logo/jangteo-mark-transparent-dark.svg", [[1024, "logo/jangteo-mark-transparent-dark-1024.png"]]],
  ["logo/jangteo-mark-transparent-light.svg", [[1024, "logo/jangteo-mark-transparent-light-1024.png"]]],
  ["logo/jangteo-lockup-light.svg", [[2, "logo/jangteo-lockup-light@2x.png"]]],
  ["logo/jangteo-lockup-dark.svg", [[2, "logo/jangteo-lockup-dark@2x.png"]]],
  ["logo/jangteo-stacked-light.svg", [[1, "logo/jangteo-stacked-light.png"]]],
  ["logo/jangteo-stacked-dark.svg", [[1, "logo/jangteo-stacked-dark.png"]]],
  ["social/x-avatar-400.svg", [[400, "social/x-avatar-400.png"]]],
  ["social/discord-icon-512.svg", [[512, "social/discord-icon-512.png"]]],
  ["social/x-banner-1500x500.svg", [[1, "social/x-banner-1500x500.png"]]],
  ["social/discord-banner-960x540.svg", [[1, "social/discord-banner-960x540.png"]]],
  ["web/og-image-1200x630.svg", [[1, "web/og-image-1200x630.png"]]],
  ["coin/jangteo-coin.svg", [[1024, "coin/jangteo-coin-1024.png"], [512, "coin/jangteo-coin-512.png"], [256, "coin/jangteo-coin-256.png"], [128, "coin/jangteo-coin-128.png"], [64, "coin/jangteo-coin-64.png"], [32, "coin/jangteo-coin-32.png"]]],
  ["coin/jangteo-coin-flat.svg", [[512, "coin/jangteo-coin-flat-512.png"]]],
  ["favicon/favicon.svg", [[32, "favicon/favicon-32.png"], [180, "favicon/apple-touch-icon-180.png"], [192, "favicon/icon-192.png"], [512, "favicon/icon-512.png"]]],
];
(async () => {
  const b = await chromium.launch();
  for (const [src, outs] of jobs) {
    const svg = fs.readFileSync(`${K}/${src}`, "utf8");
    const [, w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).map(Number);
    for (const [size, out] of outs) {
      // size < 10 = scale factor; otherwise the square edge in px
      const sc = size < 10 ? size : size / w;
      const p = await b.newPage({ viewport: { width: Math.round(w), height: Math.round(h) }, deviceScaleFactor: sc });
      await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="[\d.]+" height="[\d.]+"/, `width="${w}" height="${h}"`)}</body></html>`);
      await p.waitForTimeout(150);
      await p.screenshot({ path: `${K}/${out}`, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
      await p.close();
    }
  }
  await b.close();
})();
