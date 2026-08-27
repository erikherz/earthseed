// The broadcast shutter, proved in a real browser against a DEPLOYED origin.
//
//   node scripts/e2e/offline-notice.mjs [origin]      # default https://earthseed.live
//
// Two things have to be true at once and only one of them is testable by curl. The Worker
// answering 503 is the enforcement; this checks the OTHER half — that a person clicking the
// button gets a sentence, and specifically that the click is intercepted rather than merely
// followed by an error somewhere downstream.
//
// The negative is the point of the whole file: clicking Broadcast must NOT navigate. A modal
// that appears on the next page instead of on the click looks nearly identical in a screenshot
// and is a different feature.
//
// Skips itself when the origin reports it is open, so it can stay in the suite across the
// reopening rather than becoming a failing test the day the relays come back.
import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://earthseed.live").replace(/\/+$/, "");
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fails++;
};

const cfg = await (await fetch(`${ORIGIN}/api/config`)).json().catch(() => null);
if (!cfg?.broadcast_offline) {
  console.log(`\n${ORIGIN} reports broadcasting is OPEN — shutter test skipped.\n`);
  process.exit(0);
}
const MESSAGE = cfg.offline_message;
console.log(`\nshutter is on: "${MESSAGE}"\n`);

const browser = await puppeteer.launch({
  headless: "new",
  // broadcast.html asks for a camera on load; give it a fake one so the page reaches a steady
  // state instead of hanging on a permission prompt that never gets answered.
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

// The notice installs itself after an async fetch, so the handler is not attached on first paint.
const waitForHandler = (page) => page.waitForFunction(() => !!document.getElementById("offline-notice-css") || true, { timeout: 5000 }).then(() => new Promise((r) => setTimeout(r, 600)));

const dialogState = (page) =>
  page.evaluate(() => {
    const d = document.querySelector("dialog.offline-notice");
    return {
      present: !!d,
      open: !!(d && d.open),
      text: d ? (d.querySelector("p")?.textContent || "").trim() : "",
      mailto: d ? !!d.querySelector('a[href^="mailto:"]') : false,
    };
  });

/* ── 1. The landing page: clicking Broadcast must show the modal and NOT navigate ────────── */
{
  const page = await browser.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle0" });
  await waitForHandler(page);

  const before = page.url();
  const link = await page.$('a[href$="broadcast.html"]');
  check("the landing page has a Broadcast link", !!link);
  if (link) {
    await link.click();
    await new Promise((r) => setTimeout(r, 700));
    const d = await dialogState(page);
    check("clicking Broadcast opens the notice", d.open, `present=${d.present}`);
    check("the notice carries the operator's message", d.text === MESSAGE, `got "${d.text}"`);
    check("the address is a mailto link", d.mailto);
    // THE ASSERTION. Navigating and then explaining is a different, worse feature.
    check("the click did NOT navigate away", page.url() === before, `now ${page.url()}`);
  }
  await page.close();
}

/* ── 2. The broadcast page: Go live must be intercepted before it asks for a relay ───────── */
{
  const page = await browser.newPage();
  const posted = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/broadcast/")) posted.push(r.url());
  });
  await page.goto(`${ORIGIN}/broadcast.html`, { waitUntil: "networkidle0" });
  await waitForHandler(page);

  const go = await page.$("#go");
  check("the broadcast page has a Go live button", !!go);
  if (go) {
    posted.length = 0;
    await go.click();
    await new Promise((r) => setTimeout(r, 900));
    const d = await dialogState(page);
    check("clicking Go live opens the notice", d.open, `present=${d.present}`);
    check("the notice carries the operator's message", d.text === MESSAGE, `got "${d.text}"`);
    // Capture-phase interception means the placement call is never even attempted. If this
    // fails the modal still shows, but we hit a broker that is not running to do it.
    check("no /api/broadcast/* call was made", posted.length === 0, posted.join(", ") || "none");
  }
  await page.close();
}

/* ── 3. The Worker refuses regardless of the client ──────────────────────────────────────── */
{
  const r = await fetch(`${ORIGIN}/api/broadcast/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ broadcast: "abc12" }),
  });
  const body = await r.json().catch(() => ({}));
  check("POST /api/broadcast/start is 503", r.status === 503, `got ${r.status}`);
  check("it flags offline:true for the client", body.offline === true);
  // Watching must NOT be shuttered: a 503 here would break playback the moment the relays
  // return but before the var is flipped.
  const w = await fetch(`${ORIGIN}/api/watch/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ broadcast: "abc12" }),
  });
  check("the watch path is NOT shuttered", w.status !== 503, `got ${w.status}`);
}

await browser.close();
console.log(fails ? `\n${fails} FAILURES\n` : "\nthe shutter holds, on both entry points\n");
process.exit(fails ? 1 : 0);
