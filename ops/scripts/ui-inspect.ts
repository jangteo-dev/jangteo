// Prints every input and button (with a usable selector hint) on the given pages, connected.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
await p.addInitScript(`window.ethereum={request:async({method})=>method==="eth_chainId"?"0x164ce":method.includes("ccounts")?[(process.env.W ?? "0xc4e0b655b96911fE6ed483311507395F848d7727")]:null,on(){},removeListener(){}};`);
for (const r of process.argv.slice(2)) {
  await p.goto("https://jangteo.org/" + r, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3500);
  const btn = p.getByRole("button", { name: "Connect wallet" }).first();
  if (await btn.count()) { await btn.click(); await p.waitForTimeout(1500); }
  const d = await p.$$eval("main input, main button, main select, main textarea", (xs) =>
    xs.map((x) => `${x.tagName.toLowerCase()}${x.className ? "." + String(x.className).trim().split(/\s+/).join(".") : ""}${x.getAttribute("role") ? "[role=" + x.getAttribute("role") + "]" : ""} ${x.getAttribute("placeholder") ? "ph=" + x.getAttribute("placeholder") : ""} ${x.getAttribute("aria-label") ? "aria=" + x.getAttribute("aria-label") : ""} "${(x.textContent || "").trim().slice(0, 40)}"${(x as HTMLButtonElement).disabled ? " [disabled]" : ""}`));
  console.log(`\n== ${r}\n` + [...new Set(d)].slice(0, 60).join("\n"));
}
await b.close();
