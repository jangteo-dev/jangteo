// Helpers shared by the UI e2e flows.
type Page = any;

export async function toast(p: Page, ms = 150_000): Promise<string> {
  // The app owns the toast nodes: mark the ones already read, never remove them.
  const t = await p.waitForSelector(".toast--ok:not([data-seen]), .toast--err:not([data-seen])", { timeout: ms });
  const text = (await t.textContent()) ?? "";
  const ok = await t.evaluate((e: Element) => (e.setAttribute("data-seen", "1"), e.classList.contains("toast--ok")));
  if (!ok) throw new Error(`error toast: ${text}`);
  return text;
}

export async function go(p: Page, hash: string) {
  await p.goto(`https://jangteo.org/${hash}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
}
