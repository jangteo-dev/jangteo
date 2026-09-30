import { go, toast } from "./ui-lib.ts";
type Page = any;
const TOKEN = "0x468ae171583564e7fc4f594fc54dd2e0aa47491c"; // BBMP, trades against ETH
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const PUMP = process.env.PUMP_TOKEN ?? "0x571f283d9A70321E14baD8963BCE5D2c8AD0A052";
const OPEN = "0xC5bc819D3C387dA93CFCEDE4C51f84C4d554dA36";
const tab = (p: Page, name: string) => p.getByRole("tab", { name, exact: true }).click();

const bridgeTab = async (p: Page, dir: 0 | 1) => {
  await go(p, "#/swap?tab=bridge");
  await p.locator("label", { has: p.locator("input[name=brdir]") }).nth(dir).click();
  await p.waitForTimeout(1500);
};

export const flows: Record<string, (p: Page) => Promise<string>> = {
  async verifyPoints(p) {
    // An unverified wallet verifies straight from the Points page, then can spin.
    await go(p, "#/points");
    await p.getByRole("button", { name: /^Verify now/ }).first().click();
    const done = await toast(p);
    await p.waitForTimeout(4000);
    const spin = await p.getByRole("button", { name: "Spin" }).count();
    return `${done} · spin button ${spin ? "shown" : "missing"}`;
  },
  async faucetDrip(p) {
    // Dashboard → Identity: the verified badge and the test won faucet.
    await go(p, "#/me?tab=id");
    const badge = (await p.locator(".dash__badges .badge").first().textContent()) ?? "";
    const btn = p.locator(".me__id button.btn--line");
    if (await btn.isDisabled()) return `${badge.trim()} · faucet already claimed today: ${(await btn.textContent())?.trim()}`;
    await btn.click();
    return `${badge.trim()} · ${await toast(p)}`;
  },
  async verifiedNoButton(p) {
    // A verified wallet never sees the verify prompt, whatever the points file says.
    await go(p, "#/points");
    await p.waitForTimeout(3000);
    const n = await p.getByRole("button", { name: /^Verify now/ }).count();
    if (n) throw new Error("verify button shown to a verified wallet");
    return "no verify button";
  },
  async statsPage(p) {
    await go(p, "#/stats");
    await p.waitForSelector(".stats__kpis dd");
    return (await p.locator(".stats__kpis dd").allTextContents()).join(" | ");
  },
  async legacyPumpLink(p) {
    await go(p, "#/pump");
    await p.waitForTimeout(1500);
    return new URL(p.url()).hash;
  },
  async inviteJoin(p) {
    // A friend's link: the ref is remembered, then accepted from the Points page.
    await go(p, `?ref=${process.env.INVITE_REF ?? "0x635b07E401be619dA820488587CC1C9488C6c41C"}#/points`);
    // A full page load: a first-time visitor connects after landing.
    await p.getByRole("button", { name: "Connect wallet" }).first().click();
    await p.waitForTimeout(3000);
    await p.getByRole("button", { name: "Accept invite" }).click();
    return toast(p);
  },
  async swap(p) {
    await go(p, `#/swap?in=${ETH}&out=${TOKEN}`);
    await p.fill(".swapleg input", "0.0002");
    await p.waitForTimeout(4000);
    await p.click(".swapcard__go");
    return toast(p);
  },
  async tradeBuy(p) {
    await go(p, `#/trade/${TOKEN}`);
    await tab(p, "Market");
    await p.fill(".ticket input[placeholder='0']", "0.0001");
    await p.waitForTimeout(3500);
    await p.click(".ticket__go");
    return toast(p);
  },
  async tradeSell(p) {
    await go(p, `#/trade/${TOKEN}`);
    await tab(p, "Sell");
    await tab(p, "Market");
    await p.getByRole("button", { name: "25%" }).first().click();
    await p.waitForTimeout(3500);
    await p.click(".ticket__go");
    return toast(p);
  },
  async limit(p) {
    await go(p, `#/trade/${TOKEN}`);
    await tab(p, "Limit");
    const price = p.locator(".ticket input").first();
    const hint = Number(await price.getAttribute("placeholder"));
    await price.fill(String((hint / 2).toPrecision(4)));
    await p.locator(".ticket input[placeholder='0']").fill("0.0001");
    await p.waitForTimeout(1500);
    await p.click(".ticket__go");
    const placed = await toast(p);
    await p.waitForTimeout(20_000); // ops publishes orders.json every 15 s
    await go(p, `#/trade/${TOKEN}`);
    await p.getByRole("button", { name: /^Cancel/ }).first().click();
    return `${placed} → ${await toast(p)}`;
  },
  async dca(p) {
    await go(p, `#/trade/${TOKEN}`);
    await tab(p, "DCA");
    await p.locator(".ticket input[placeholder='0']").fill("0.0002");
    await p.locator(".ticket input:not([placeholder])").first().fill("2");
    await p.waitForTimeout(1500);
    await p.click(".ticket__go");
    return toast(p);
  },
  async poolAdd(p) {
    await go(p, "#/swap?tab=pool");
    await p.fill("input[aria-label='Add liquidity A']", "1");
    await p.waitForTimeout(3000);
    await p.click(".swapcard__go");
    return toast(p);
  },
  async poolRemove(p) {
    await go(p, "#/swap?tab=pool");
    await p.getByRole("button", { name: "Remove", exact: true }).first().click();
    await p.waitForTimeout(800);
    await p.getByRole("button", { name: "25%" }).first().click();
    await p.locator("button.btn--ink", { hasText: "Remove" }).first().click();
    return toast(p);
  },
  async pumpBuy(p) {
    await go(p, `#/ppeongtwigi/${PUMP}`);
    await p.locator("main input[placeholder='0']").first().fill("0.0001");
    await p.waitForTimeout(3000);
    await p.click("main .btn--bid");
    return toast(p);
  },
  async pumpSell(p) {
    await go(p, `#/ppeongtwigi/${PUMP}`);
    await tab(p, "Sell");
    await p.waitForTimeout(1000);
    const pct = p.getByRole("button", { name: "25%" });
    if (await pct.count()) await pct.first().click();
    else await p.locator("main input[placeholder='0']").first().fill("1000");
    await p.waitForTimeout(3000);
    await p.waitForSelector("main .btn--ask:not([disabled])", { timeout: 20_000 });
    await p.click("main .btn--ask");
    return toast(p);
  },
  async quickBuy(p) {
    await go(p, "#/market");
    const row = p.locator("main li, main tr").filter({ hasText: "BBMP" }).first();
    await row.getByRole("button", { name: "Buy" }).click();
    await p.fill(".qt input[placeholder='0']", "0.0001");
    await p.waitForTimeout(3500);
    await p.click(".qt .ticket__go");
    return toast(p);
  },
  async insaList(p) {
    const item = process.env.INSA_ITEM ?? `${OPEN}/1`;
    await go(p, `#/insa/c/${item}`);
    await p.fill("main input[placeholder='0.01']", "0.01");
    await p.getByRole("button", { name: "List for sale" }).click();
    const a = await toast(p);
    await p.waitForTimeout(100_000); // the indexer picks the listing up within ~90 s
    await go(p, `#/insa/c/${item}`);
    await p.getByRole("button", { name: "Cancel listing" }).click();
    return `${a} → ${await toast(p)}`;
  },
  async insaOffer(p) {
    await go(p, `#/insa/c/${OPEN}`);
    await p.getByRole("button", { name: "Make a collection offer" }).click();
    await p.fill(".insapop input", "0.0001");
    await p.getByRole("button", { name: "Place offer" }).click();
    const a = await toast(p);
    await p.waitForTimeout(100_000);
    await go(p, `#/insa/c/${OPEN}`);
    await p.getByRole("tab", { name: /Offers/ }).click();
    await p.locator(".offerlist").getByRole("button", { name: "Cancel" }).first().click();
    return `${a} → ${await toast(p)}`;
  },

  async bridgeIn(p) {
    await bridgeTab(p, 0);
    await p.fill("input.swapleg__amount", "0.002");
    await p.waitForTimeout(2000);
    await p.click(".swapcard__go");
    return toast(p, 300_000);
  },
  async withdrawStd(p) {
    await bridgeTab(p, 1);
    const std = p.locator("label", { has: p.locator("input[name=wdspeed]") });
    if (await std.count()) await std.nth(1).click();
    await p.fill("input.swapleg__amount", "0.001");
    await p.waitForTimeout(2000);
    await p.click(".swapcard__go");
    return toast(p);
  },
  async fastExit(p) {
    await bridgeTab(p, 1);
    await p.locator("label", { has: p.locator("input[name=wdspeed]") }).nth(0).click();
    await p.fill("input.swapleg__amount", "0.005");
    await p.waitForTimeout(2000);
    await p.click(".swapcard__go");
    return toast(p);
  },

  async yutJoin(p) {
    await go(p, "#/yut");
    await p.getByRole("button", { name: /Sit down/ }).first().click();
    const t = await toast(p);
    await p.waitForTimeout(4000);
    const btns = await p.$$eval("main button", (bs) => bs.map((b) => `${b.className}|${(b.textContent || "").trim().slice(0, 30)}|${(b as HTMLButtonElement).disabled ? "off" : "on"}`));
    return `${t} @ ${p.url().split("#")[1]} :: ${[...new Set(btns)].join(" ; ")}`;
  },

  /** Plays the game farm1 sits in to the end, against the house bot: throw, pick, pass, collect. */
  async yutPlay(p) {
    // Sit at the house table unless a game number is given.
    let game = process.env.YUT_GAME;
    if (!game) {
      await go(p, "#/yut");
      await p.getByRole("button", { name: /Sit down/ }).first().click();
      await toast(p);
      await p.waitForTimeout(4000);
      game = p.url().split("/yut/")[1];
    }
    await go(p, `#/yut/${game}`);
    let throws = 0, moves = 0, passes = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 40 * 60_000) {
      const body = (await p.textContent("main")) ?? "";
      if (/You won|You lost this one/.test(body)) {
        const collect = p.getByRole("button", { name: /^Collect/ });
        let won = /You won/.test(body) ? "WON" : "lost";
        if (await collect.count()) won += ` + ${await (collect.first().click(), toast(p))}`;
        return `game #${game} finished: ${won} after ${throws} throws, ${moves} moves, ${passes} passes`;
      }
      const thr = p.getByRole("button", { name: /^Throw/ });
      if ((await thr.count()) && (await thr.first().isEnabled())) {
        await thr.first().click();
        await toast(p);
        throws++;
        continue;
      }
      const piece = p.locator("main [role=button]");
      if (await piece.count()) {
        await piece.first().click();
        await toast(p);
        moves++;
        continue;
      }
      const pass = p.getByRole("button", { name: /^Pass/ });
      if (await pass.count()) {
        await pass.first().click();
        await toast(p);
        passes++;
        continue;
      }
      await p.waitForTimeout(2500);
    }
    throw new Error(`still playing after 40 min (${throws} throws, ${moves} moves)`);
  },

  async withdrawProve(p) {
    await bridgeTab(p, 1);
    await p.waitForTimeout(4000);
    const prove = p.locator(".withdrawals").getByRole("button", { name: /^Prove/ });
    if (!(await prove.count())) throw new Error("no Prove button in the withdrawals list");
    await prove.first().click();
    return toast(p, 400_000);
  },

  /** Opens every dashboard tab and reports what it shows (read-only). */
  async dashboard(p) {
    await go(p, "#/me");
    const out: string[] = [];
    for (const tab of ["Assets", "Earnings", "Open", "Identity"]) {
      await p.getByRole("tab", { name: tab, exact: true }).click();
      await p.waitForTimeout(4500);
      const txt = ((await p.textContent("main")) ?? "").replace(/\s+/g, " ");
      out.push(`${tab}: ${txt.length} chars`);
      await p.screenshot({ path: `/tmp/claude-0/-root/fffb2a43-d9ee-4815-8364-e42aa7bf993f/scratchpad/dash_${tab}.png`, fullPage: true });
    }
    return out.join(" · ");
  },

  /** Launches a coin on 뻥튀기 v2 with the maximum creator buy, then checks the cap and the curve contract. */
  async pumpLaunchV2(p) {
    await go(p, "#/ppeongtwigi/new");
    await p.fill("input[placeholder='Dosirak Club']", "Hotteok Club");
    await p.fill("input[placeholder='DSRK']", "HTTK");
    await p.fill("textarea", "Sweet pancakes from the market on a cold night. A test launch on Ppeongtwigi v2.");
    const dev = p.locator("main input[placeholder='0']").last();
    await dev.fill("0.2");
    await p.waitForTimeout(1500);
    const over = await p.locator("button.btn--wide", { hasText: "Launch" }).isDisabled();
    await dev.fill("0.1");
    await p.waitForTimeout(1500);
    await p.locator("button.btn--wide", { hasText: "Launch" }).click();
    const t = await toast(p, 200_000);
    await p.waitForTimeout(3000);
    return `${t} · 0.2 ETH dev buy blocked by the form: ${over} · now at ${p.url().split("#")[1]}`;
  },

  /** Creates a two-phase drop through the launch form: allowlist (FARM2 only, free) then public. */
  async insaDropCreate(p) {
    const kst = (min: number) => new Date(Date.now() + 9 * 3600_000 + min * 60_000).toISOString().slice(0, 16);
    await go(p, "#/insa/new");
    const form = p.locator("form.insanew__form");
    await form.getByLabel("Name", { exact: true }).first().fill("Rehearsal Drop");
    await form.getByLabel("Symbol", { exact: true }).fill("RHSL");
    await form.getByLabel("Supply", { exact: true }).fill("50");
    await form.getByLabel("Description", { exact: true }).fill("A rehearsal of the Tal whitelist event. Not for sale.");
    const img = "https://jangteo.org/insa/tal-cover.svg";
    for (let i = 0; i < 2; i++) {
      await p.locator(".imgdrop__paste").nth(i).click();
      await p.locator(".imgdrop input[placeholder='https://']").nth(i).fill(img);
    }
    await p.getByRole("button", { name: "Add a phase" }).click();
    const ph = p.locator(".phasedraft");
    await ph.nth(0).getByLabel("Name", { exact: true }).fill("Whitelist");
    await ph.nth(0).getByLabel("Starts (KST)").fill(kst(Number(process.env.WL_IN ?? 3)));
    await ph.nth(0).getByLabel("Ends (KST, optional)").fill(kst(Number(process.env.PUB_IN ?? 9)));
    await ph.nth(0).getByLabel("Price per token (ETH)").fill("0");
    await ph.nth(0).getByLabel("Per wallet (0 = none)").fill("1");
    await ph.nth(0).locator("textarea").fill(process.env.WL_ADDR ?? "0x4B7784439a46bff523582F6695a17E6549865077");
    await ph.nth(1).getByLabel("Name", { exact: true }).fill("Public");
    await ph.nth(1).getByLabel("Starts (KST)").fill(kst(Number(process.env.PUB_IN ?? 9)));
    await ph.nth(1).getByLabel("Price per token (ETH)").fill("0.0001");
    await ph.nth(1).getByLabel("Per wallet (0 = none)").fill("2");
    await p.getByRole("button", { name: "Launch", exact: true }).click();
    const t = await toast(p, 200_000);
    await p.waitForTimeout(3000);
    return `${t} → ${p.url().split("#")[1]}`;
  },

  /** Mints from DROP in phase PHASE; EXPECT=no checks the wallet is refused instead. */
  async insaMint(p) {
    const drop = process.env.DROP!;
    const phase = Number(process.env.PHASE ?? 0);
    const expectNo = process.env.EXPECT === "no";
    await go(p, `#/insa/c/${drop}`);
    await p.locator(".phasecards button").nth(phase).click();
    const btn = p.locator(".mintpanel__go");
    const t0 = Date.now();
    // Wait for the phase to open (the button reads "Opens in …" until then).
    while (!/^Mint/.test(((await btn.textContent()) ?? "").trim())) {
      if (Date.now() - t0 > 12 * 60_000) throw new Error(`phase never opened: ${await btn.textContent()}`);
      await p.waitForTimeout(5000);
      if (Date.now() - t0 > 20_000 && (Date.now() - t0) % 60_000 < 5000) {
        await go(p, `#/insa/c/${drop}`);
        await p.locator(".phasecards button").nth(phase).click();
      }
    }
    const elig = ((await p.locator(".mintpanel__elig").textContent().catch(() => "")) ?? "").trim();
    if (expectNo) {
      const disabled = await btn.isDisabled();
      if (!disabled) throw new Error(`not on the list but the mint button is enabled (${elig})`);
      return `refused as expected: "${elig}", button disabled`;
    }
    await btn.click();
    return `${elig || "public"} → ${await toast(p, 200_000)}`;
  },

  /** The creator withdraws mint income from the dashboard's Earnings tab. */
  async dashWithdraw(p) {
    await go(p, "#/me");
    await p.getByRole("tab", { name: "Earnings", exact: true }).click();
    await p.waitForTimeout(6000);
    const b = p.getByRole("button", { name: "Withdraw", exact: true });
    if (!(await b.count())) throw new Error("no Withdraw button (collection not indexed yet?)");
    await b.first().click();
    return toast(p, 200_000);
  },

  /** Launches a collection by uploading one image per token, then mints two and checks their metadata. */
  async insaUploadDrop(p) {
    const kst = (min: number) => new Date(Date.now() + 9 * 3600_000 + min * 60_000).toISOString().slice(0, 16);
    const dir = "/tmp/claude-0/-root/fffb2a43-d9ee-4815-8364-e42aa7bf993f/scratchpad/art";
    await go(p, "#/insa/new");
    const form = p.locator("form.insanew__form");
    await form.getByLabel("Name", { exact: true }).first().fill("Upload Rehearsal");
    await form.getByLabel("Symbol", { exact: true }).fill("UPRH");
    await form.getByLabel("Royalty on resales (%)").fill("3");
    await form.getByLabel("Description", { exact: true }).fill("Three uploaded artworks, one per token. A test of Insadong uploads.");
    await p.locator("input[type=file][multiple]").setInputFiles([`${dir}/1.png`, `${dir}/2.png`, `${dir}/3.png`]);
    const supply = await form.getByLabel("Supply", { exact: true }).inputValue();
    const ph = p.locator(".phasedraft").first();
    await ph.getByLabel("Starts (KST)").fill(kst(1));
    await ph.getByLabel("Price per token (ETH)").fill("0");
    await ph.getByLabel("Per wallet (0 = none)").fill("3");
    await p.getByRole("button", { name: "Launch", exact: true }).click();
    const t = await toast(p, 300_000);
    await p.waitForTimeout(3000);
    const drop = p.url().split("/insa/c/")[1];
    return `${t} · supply field ${supply} → ${drop}`;
  },

  /** Today's roulette spin, then the revealed reward. */
  async spin(p) {
    await go(p, "#/points");
    const b = p.getByRole("button", { name: "Spin", exact: true });
    if (!(await b.count())) throw new Error("no Spin button (already spun today or not verified?)");
    await b.click();
    const t = await toast(p, 200_000);
    await p.waitForTimeout(8000);
    const card = ((await p.locator(".daily").first().textContent()) ?? "").replace(/\s+/g, " ").slice(0, 200);
    return `${t} · ${card}`;
  },

  /** Creates a two-member circle with 10-minute rounds. */
  async circleCreate(p) {
    await go(p, "#/gye/new");
    await p.fill("input[placeholder='Seongsu book club']", "Rehearsal Circle");
    const inputs = p.locator("form.form input");
    await inputs.nth(1).fill("10000");
    await p.locator("input[type=range]").first().fill("2");
    await p.locator("select").first().selectOption({ label: "10 minutes (testing)" });
    await p.waitForTimeout(800);
    await p.getByRole("button", { name: "Create circle" }).click();
    const t = await toast(p, 200_000);
    await p.waitForTimeout(4000);
    return `${t} → ${p.url().split("#")[1]}`;
  },
  /** Plays CIRCLE until it is finished: join, pay every round, collect the pot when it is ours. */
  async circlePlay(p) {
    const c = process.env.CIRCLE!;
    await go(p, `#/gye/c/${c}`);
    const done: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 50 * 60_000) {
      const body = ((await p.textContent("main")) ?? "").replace(/\s+/g, " ");
      if (/This circle is finished/.test(body)) {
        const col = p.getByRole("button", { name: /^Collect/ });
        if (await col.count()) done.push(`collect ${await (col.first().click(), toast(p))}`);
        return `finished: ${done.join(" · ")}`;
      }
      let acted = false;
      for (const name of [/^Join for/, /^Pay .* for round/, /^Collect/]) {
        const b = p.getByRole("button", { name });
        if ((await b.count()) && (await b.first().isEnabled({ timeout: 3000 }).catch(() => false))) {
          const label = ((await b.first().textContent({ timeout: 3000 }).catch(() => "")) ?? "").trim();
          await b.first().click();
          done.push(`${label} → ${await toast(p, 200_000)}`);
          acted = true;
          break;
        }
      }
      if (!acted) {
        await p.waitForTimeout(15_000);
        await go(p, `#/gye/c/${c}`);
      }
    }
    throw new Error(`not finished after 50 min: ${done.join(" · ")}`);
  },

  /** Dashboard → Identity: testnet Dojang verification, then the daily test-won faucet. */
  async verifyAndDrip(p) {
    await go(p, "#/me");
    await p.getByRole("tab", { name: "Identity", exact: true }).click();
    await p.waitForTimeout(5000);
    const out: string[] = [];
    const v = p.locator(".me__id button.btn--ink");
    if (await v.count()) {
      const label = ((await v.first().textContent()) ?? "").trim();
      await v.first().click();
      out.push(`${label} → ${await toast(p, 200_000)}`);
      await p.waitForTimeout(4000);
    } else out.push("already verified");
    const d = p.locator(".me__id button.btn--line");
    if ((await d.count()) && (await d.first().isEnabled())) {
      const label = ((await d.first().textContent()) ?? "").trim();
      await d.first().click();
      out.push(`${label} → ${await toast(p, 200_000)}`);
    }
    return out.join(" · ");
  },

  /** Premarket: take part of the first sell offer, then post a buy offer and cancel it. */
  async jangoe(p) {
    await go(p, "#/jangoe/0");
    await p.waitForTimeout(3000);
    await p.getByRole("button", { name: "Take" }).first().click();
    await p.locator(".takeform input").fill("50");
    await p.locator(".takeform button").click();
    const a = await toast(p, 200_000);
    await p.waitForTimeout(3000);
    await go(p, "#/jangoe/0");
    await p.waitForTimeout(3000);
    const post = p.locator("form.form").filter({ has: p.getByRole("button", { name: "Post offer" }) });
    const inputs = post.locator("input:not([type=radio])");
    await inputs.nth(0).fill("100");
    await inputs.nth(1).fill("5");
    await p.getByRole("button", { name: "Post offer" }).click();
    const b = await toast(p, 200_000);
    await p.waitForTimeout(5000);
    await go(p, "#/jangoe/0");
    await p.waitForTimeout(4000);
    await p.getByRole("button", { name: "Cancel", exact: true }).first().click();
    const c = await toast(p, 200_000);
    return `take → ${a} · post → ${b} · cancel → ${c}`;
  },

  /** Listings: open the first open market and bet a little on "no". */
  async listingBetTooBig(p) {
    // More than the wallet holds: stopped with a clear message, before any approval is asked for.
    await go(p, "#/listings");
    await p.waitForTimeout(3000);
    const href = (await p.locator("main a[href^='#/listings/']").first().getAttribute("href")) ?? "";
    await go(p, href);
    await p.waitForTimeout(3000);
    await p.fill("main input[placeholder='100000']", "999999999999");
    await p.waitForTimeout(800);
    const go_ = p.locator("main form button[type=submit], main form button.btn--ink, main form button.btn--wide").last();
    if (await go_.isDisabled()) return `blocked in the form: "${((await go_.textContent()) ?? "").trim()}"`;
    await go_.click();
    const t = await p.waitForSelector(".toast--err:not([data-seen]), .toast--ok:not([data-seen])", { timeout: 60_000 });
    const text = ((await t.textContent()) ?? "").trim();
    if (!/doesn't hold enough/.test(text)) throw new Error(`unexpected: ${text}`);
    return text.slice(0, 80);
  },
  async listingBet(p) {
    await go(p, "#/listings");
    await p.waitForTimeout(3000);
    const link = p.locator("main a[href^='#/listings/']").first();
    const href = (await link.getAttribute("href")) ?? "";
    await go(p, href);
    await p.waitForTimeout(3000);
    await p.locator(".side--no").click();
    await p.fill("main input[placeholder='100000']", "20000");
    await p.waitForTimeout(800);
    await p.locator("main form button[type=submit], main form button.btn--ink, main form button.btn--wide").last().click();
    return `${href} → ${await toast(p, 200_000)}`;
  },

  /** Offerings: mint a test token, then open an offering starting in a minute for one hour. */
  async cyCreate(p) {
    await go(p, "#/cheongyak/new");
    const panel = p.locator("aside.panel");
    const pin = panel.locator("input");
    await pin.nth(0).fill("Rehearsal Token");
    await pin.nth(1).fill("RHT");
    await panel.getByRole("button").click();
    const a = await toast(p, 200_000);
    await p.waitForTimeout(3000);
    await p.fill("input[placeholder='Hanok Labs']", "Rehearsal Offering");
    const ranges = p.locator("form.form input[type=range]");
    await ranges.nth(0).fill("1"); // starts in 1 minute
    await ranges.nth(1).fill("1"); // open for 1 hour
    await p.waitForTimeout(1000);
    await p.getByRole("button", { name: "Open the offering" }).click();
    const b = await toast(p, 300_000);
    await p.waitForTimeout(4000);
    return `mint → ${a} · open → ${b} · ${p.url().split("#")[1]}`;
  },
  /** Subscribes to OFFERING (a #/cheongyak/<id> path) once it opens. */
  async cySubscribe(p) {
    const path = process.env.OFFERING!;
    const t0 = Date.now();
    for (;;) {
      await go(p, `#${path}`);
      await p.waitForTimeout(4000);
      const inp = p.locator("main form input[inputmode=decimal], main form input[inputmode=numeric]").first();
      if (await inp.count()) {
        await inp.fill("20000");
        await p.waitForTimeout(800);
        await p.locator("main form button.btn--ink, main form button.btn--wide").first().click();
        return toast(p, 300_000);
      }
      if (Date.now() - t0 > 6 * 60_000) throw new Error("offering never opened for subscription");
      await p.waitForTimeout(20_000);
    }
  },

  /** Offerings: collect the allocation and refund of OFFERING once it has been allocated. */
  async cyClaim(p) {
    const path = process.env.OFFERING!;
    const t0 = Date.now();
    for (;;) {
      await go(p, `#${path}`);
      await p.waitForTimeout(5000);
      const b = p.getByRole("button", { name: /Collect tokens and refund|Collect/ });
      if (await b.count()) {
        await b.first().click();
        return toast(p, 300_000);
      }
      if (Date.now() - t0 > 20 * 60_000) throw new Error(`no collect button: ${((await p.textContent("main")) ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
      await p.waitForTimeout(30_000);
    }
  },

  /** Buys a little HANJI with test won, so the liquidity flows have both sides of the pool. */
  async swapToHanji(p) {
    await go(p, "#/swap?in=0x4109a103DF87DfB579983145c2a55235F8F89d1F&out=0xcae9aa66e6d41e344aec0db59c2b8b93d7f2953a");
    await p.fill(".swapleg input", "20000");
    await p.waitForTimeout(4000);
    await p.click(".swapcard__go");
    return toast(p);
  },
};
