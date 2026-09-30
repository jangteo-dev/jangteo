/**
 * Site-wide checks with no wallet: every internal link renders a page with content, no page throws,
 * and no page breaks the Content-Security-Policy. Prints "links: PASS|FAIL …" and "csp: PASS|FAIL …".
 *   node scripts/ui-links.ts
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "https://jangteo.org/";
const seeds = ["#/", "#/market", "#/swap", "#/swap?tab=pool", "#/swap?tab=bridge", "#/ppeongtwigi", "#/insa", "#/insa/tal", "#/cheongyak", "#/jangoe", "#/listings", "#/gye", "#/yut", "#/points", "#/faq", "#/docs", "#/me"];

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
const errors: string[] = [];
const csp: string[] = [];
p.on("pageerror", (e: Error) => errors.push(`${p.url().split("#")[1]}: ${e.message.slice(0, 120)}`));
p.on("console", (m: any) => /Content Security Policy|Refused to/.test(m.text()) && csp.push(`${p.url().split("#")[1]}: ${m.text().slice(0, 120)}`));
const links = new Set(seeds);
for (const r of seeds) {
  await p.goto(BASE + r, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  for (const h of await p.$$eval("a[href^='#/']", (as: Element[]) => as.map((a) => a.getAttribute("href")!))) links.add(h);
}
// Hundreds of links share a few shapes (/market/<token>, /insa/c/<collection>/<id>…): three of each is enough.
const shape = (h: string) => h.replace(/0x[0-9a-fA-F]{40}/g, ":addr").replace(/\/\d+/g, "/:n");
const byShape = new Map<string, string[]>();
for (const h of links) byShape.set(shape(h), [...(byShape.get(shape(h)) ?? []), h].slice(0, 3));
const sample = [...byShape.values()].flat();
const empty: string[] = [];
for (const h of sample) {
  await p.goto(BASE + h, { waitUntil: "domcontentloaded" });
  // Pages read the chain on load: give them time, then look once more before calling a page empty.
  let n = 0;
  for (let i = 0; i < 3 && n < 40; i++) {
    await p.waitForTimeout(1500 + i * 2500);
    n = await p.$eval("main", (m: Element) => (m as HTMLElement).innerText.trim().length).catch(() => 0);
  }
  if (n < 40) empty.push(h);
}
await b.close();
console.log(`links: ${empty.length || errors.length ? "FAIL" : "PASS"} ${links.size} links, ${sample.length} pages opened${empty.length ? ` · empty: ${empty.slice(0, 5).join(" ")}` : ""}${errors.length ? ` · errors: ${errors.slice(0, 3).join(" | ")}` : ""}`);
console.log(`csp: ${csp.length ? `FAIL ${csp.slice(0, 3).join(" | ")}` : "PASS no violations"}`);
