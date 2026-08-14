// Going live WITHOUT a publish key. Does anything actually get sent?
//
//   node scripts/e2e/no-key-no-publish.mjs [origin]
//
// Worth checking rather than reasoning about, because the reassuring signal is not evidence: the
// broadcast page shows a local <video> of your own camera, which is a preview of the capture
// MediaStream and would look identical whether or not a single byte left the machine. If
// admission failed but publishing started anyway, someone who dismissed the prompt would be
// transmitting while believing they had not begun.
//
// Checked from three independent angles, because any one could pass for a bad reason:
//   1. no WebTransport session is opened at all
//   2. no placement request reaches the Worker
//   3. no share link is produced (there is no stream to share)
//
// Runs in a fresh context with empty localStorage, so it genuinely has no key to find.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://earthseed.live").replace(/\/+$/, "");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  const placements = [];
  page.on("request", (r) => {
    if (/\/api\/(broadcast|watch)\/start/.test(r.url())) placements.push(r.url());
  });

  await page.evaluateOnNewDocument(() => {
    window.__sessions = [];
    const Real = window.WebTransport;
    if (!Real) return;
    window.WebTransport = function (...args) {
      window.__sessions.push(String(args[0]));
      return new Real(...args);
    };
    window.WebTransport.prototype = Real.prototype;
  });

  await page.goto(`${ORIGIN}/broadcast.html`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#go", { timeout: 30000 });
  await page.click("#go");

  // The prompt appearing IS the expected outcome. Without it, admission is not gating anything.
  const prompted = await page
    .waitForFunction(() => {
      const row = document.getElementById("keyrow");
      return !!row && !row.hidden;
    }, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check("a publish key is demanded", prompted, true);

  // Give it a generous window to misbehave. A race that only loses sometimes would otherwise pass
  // here and fail in front of a broadcaster.
  await new Promise((r) => setTimeout(r, 10000));

  const state = await page.evaluate(() => ({
    sessions: window.__sessions ?? [],
    share: document.getElementById("share")?.value ?? "",
    promptStillUp: !document.getElementById("keyrow")?.hidden,
    status: document.getElementById("status")?.textContent ?? "",
  }));

  check("the prompt is still waiting", state.promptStillUp, true);
  check("no WebTransport session was opened", state.sessions.length, 0);
  check("no relay placement was requested", placements.length, 0);
  check("no share link was produced", state.share, "");
  console.log(`    status: ${state.status}`);

  // And the offer of a way forward is present rather than a dead end.
  const hasLink = await page.$eval("body", (b) => /Request a publish key/.test(b.textContent));
  check("the page says how to get one", hasLink, true);
} catch (e) {
  failures++;
  console.error(`\nERROR: ${e.message}`);
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: no publish key means nothing is transmitted\n");
process.exit(failures ? 1 : 0);
