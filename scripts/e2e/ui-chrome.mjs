// The page furniture: branding, theme toggle, footer panels, and the live-state affordances.
//
//   node scripts/e2e/ui-chrome.mjs [origin] [--admin <password>]
//
// None of this carries a security property, which is exactly why it needs a test. A broken
// security check fails loudly in one of the other suites; a footer panel that renders nothing,
// a theme that doesn't persist, or a "live" pill left showing after the stream stopped all look
// fine from the outside and are only noticed by a user.
//
// The live half needs --admin (it mints a throwaway publish key). Without it, the static half
// still runs.
//
// Two assertions here are about NOT lying rather than about working:
//   • the relay panel says "(not connected)" before going live, rather than naming a plausible host
//   • the live pill goes off again when the broadcast stops

import puppeteer from "puppeteer";

const args = process.argv.slice(2);
const ORIGIN = (args.find((a) => !a.startsWith("--")) || "https://earthseed.live").replace(/\/+$/, "");
const adminFlag = args.indexOf("--admin");
const ADMIN = adminFlag >= 0 ? args[adminFlag + 1] : process.env.EARTHSEED_ADMIN;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const section = (s) => console.log(`\n${s}`);

const visible = (page, sel) =>
  page.$eval(sel, (e) => {
    const s = getComputedStyle(e);
    return s.display !== "none" && s.visibility !== "hidden" && !e.hidden;
  }).catch(() => false);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  for (const path of ["/broadcast.html", "/watch.html"]) {
    section(`Chrome on ${path}`);
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle2", timeout: 60000 });

    check("the globe mark is there", await visible(page, ".brand-mark"), true);
    check("the wordmark reads earthseed.live", (await page.$eval(".brand-name", (e) => e.textContent))?.trim(), "earthseed.live");
    check("a tagline is shown", (await page.$eval(".tagline", (e) => e.textContent))?.trim().length > 0, true);
    check("the trust page is linked from the header", await page.$eval(".header-right a", (e) => new URL(e.href).pathname), "/trust");

    // ── Theme ──────────────────────────────────────────────────────────────────────────────
    check("dark is the default", await page.evaluate(() => document.documentElement.classList.contains("light")), false);
    await page.click("#theme-toggle");
    check("the toggle switches to light", await page.evaluate(() => document.documentElement.classList.contains("light")), true);
    check("  ...and the choice is stored", await page.evaluate(() => localStorage.getItem("es:theme")), "light");
    // Reloading is the real test: the inline block in <head> has to apply it before paint, or the
    // page flashes the wrong theme on every visit.
    await page.reload({ waitUntil: "networkidle2" });
    check("it survives a reload", await page.evaluate(() => document.documentElement.classList.contains("light")), true);
    // A light theme that leaves the body dark would mean the variables are not actually reaching.
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check("  ...and actually repaints the page", bodyBg, "rgb(255, 255, 255)");
    await page.click("#theme-toggle");
    check("and back to dark", await page.evaluate(() => localStorage.getItem("es:theme")), "dark");

    // ── Footer panels ──────────────────────────────────────────────────────────────────────
    for (const [link, panel, mustSay] of [
      ["#howitworks-link", "#howitworks-panel", "key never reaches us"],
      ["#support-link", "#support-panel", "WebTransport"],
      ["#server-link", "#server-panel", "not connected"],
    ]) {
      check(`${panel} starts closed`, await visible(page, panel), false);
      await page.click(link);
      await page.waitForFunction((p) => !document.querySelector(p).classList.contains("hidden"), { timeout: 5000 }, panel);
      check(`${link} opens it`, await visible(page, panel), true);
      const text = await page.$eval(panel, (e) => e.textContent);
      check(`  ...with real content`, text.includes(mustSay), true);
    }
    // Opening the third should have closed the first two: three stacked panels push the video off
    // a phone screen.
    check("only one panel is open at a time", await visible(page, "#howitworks-panel"), false);
    await page.click("#server-link");
    check("clicking again closes it", await visible(page, "#server-panel"), false);

    await ctx.close();
  }

  if (!ADMIN) {
    console.log("\n(no --admin password given — skipping the live-state half)");
  } else {
    section("Live-state affordances on the broadcast page");
    const mint = await fetch(`${ORIGIN}/api/admin/mint-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.json());

    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/broadcast.html?code=${encodeURIComponent(mint.code)}`, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    check("the stream name says it has not started", (await page.$eval("#stream-id", (e) => e.textContent)).trim(), "not started");
    check("there is nothing to copy yet", await visible(page, "#copy"), false);
    check("the live pill is off", await visible(page, "#live-pill"), false);

    await page.click("#go");
    await page.waitForFunction(() => (document.getElementById("share")?.value || "").includes("#k="), { timeout: 90000 });

    const streamId = await page.$eval("#stream-id", (e) => e.textContent.trim());
    check("the stream name appears", streamId.length, 52);
    check("the copy button appears", await visible(page, "#copy"), true);
    check("the live pill comes on", await visible(page, "#live-pill"), true);
    check("Go live becomes Stop", (await page.$eval("#go", (e) => e.textContent)).trim(), "Stop");
    check("  ...and stops looking like the start button", await page.$eval("#go", (e) => e.classList.contains("is-live")), true);
    check("the publish key row stays hidden", await visible(page, "#keyrow"), false);

    await page.click("#server-link");
    const relayText = await page.$eval("#server-panel", (e) => e.textContent);
    check("the relay panel now names a real host", /moqcdn\.net|:\d{4}/.test(relayText), true);
    check("  ...and no longer says not connected", relayText.includes("not connected"), false);
    console.log(`    ${relayText.replace(/\s+/g, " ").slice(0, 90)}…`);

    await page.click("#go"); // stop
    await page.waitForFunction(() => document.getElementById("go")?.textContent.trim() === "Go live", { timeout: 20000 });
    check("stopping turns the live pill off again", await visible(page, "#live-pill"), false);
    await page.click("#server-link");
    await page.click("#server-link"); // re-render: the panel is rebuilt every open
    check("  ...and the relay panel stops naming a host", (await page.$eval("#server-panel", (e) => e.textContent)).includes("not connected"), true);

    if (streamId) {
      await fetch(`${ORIGIN}/api/broadcast/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broadcast: streamId }),
      }).catch(() => {});
    }
    await ctx.close();
  }
} catch (e) {
  failures++;
  console.error(`\nERROR: ${e.message}`);
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: the page chrome behaves\n");
process.exit(failures ? 1 : 0);
