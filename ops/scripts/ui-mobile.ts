import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices["iPhone 13"] });
const p = await ctx.newPage();
const out: string[] = [];
for (const r of ["#/", "#/points", "#/swap", "#/ppeongtwigi", "#/insa", "#/market", "#/me", "#/yut", "#/gye", "#/cheongyak", "#/jangoe", "#/listings", "#/faq", "#/swap?tab=bridge"]) {
  await p.goto("https://jangteo.org/" + r, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3500);
  const w = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll("body *")].filter((e) => { const b = e.getBoundingClientRect(); return b.right > vw + 1 && b.width > 0 && getComputedStyle(e).position !== "fixed"; }).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}(${Math.round(e.getBoundingClientRect().right)})`);
    return { sw: document.documentElement.scrollWidth, vw, wide };
  });
  out.push(`${r} scroll=${w.sw}/${w.vw} ${w.wide.join(" ")}`);
  await p.screenshot({ path: `/tmp/claude-0/-root/fffb2a43-d9ee-4815-8364-e42aa7bf993f/scratchpad/m_${r.replace(/[^a-z]/g, "") || "hub"}.png` });
}
console.log(out.join("\n"));
await b.close();
