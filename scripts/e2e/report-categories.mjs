// The report panel must not arrive with a category already chosen.
//
// A <select> selects its first option, and the first group in this list is child sexual abuse
// material. So "what is selected when the panel opens" is not a cosmetic question — it is the
// difference between a viewer choosing the gravest accusation there is and inheriting it.
//
// Asserted against what the browser RENDERS, not against the source: selectedIndex and the
// select's value are the only things that answer "what would be sent if they pressed the button
// now", and both are properties the DOM computes rather than ones we wrote.
//
//   node scripts/e2e/report-categories.mjs [origin]
//
// Like camera-yanked.mjs and unlike the rest of scripts/e2e, this needs no deployed origin, no
// publish key and no relay: with no argument it serves simple/ itself on a loopback port and
// stubs the handful of requests between the page and a mounted report control. Pass an origin to
// run the same checks against a deployment instead — but note that a deployed run FILES A REAL
// REPORT under `adult-services`, which is why the id it uses is obviously a test.
//
// Exit 0 = the placeholder holds, the groups render, and the severe category costs two clicks.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../simple");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
};
const SEVERE = "sexual-content-involving-minors";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Serve simple/ as-is. No _headers, so no CSP here; scripts/e2e/ui-chrome.mjs is what checks the
// enforced policy, and this measures the panel's own logic.
let server = null;
let origin = process.argv[2]?.replace(/\/+$/, "") || "";
if (!origin) {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = path.join(ROOT, rel || "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`  serving simple/ at ${origin}`);
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => { failures++; console.log("        page error:", e.message); });

// Two requests stand between the watch page and a mounted report control: the placement call and
// the salts. Both are answered locally with a relay that resolves to nothing — the control mounts
// as soon as placement succeeds, well before any connection is attempted, so the media path never
// has to work for this to be testable. The category config is served REAL where a deployed origin
// is given; only the local run needs it stubbed, and it is stubbed with what the Worker sends.
let posted = null;
await page.evaluateOnNewDocument(() => {
  const real = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  window.__posted = null;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/api/config")) return new Response("not found", { status: 404 });
    if (url.includes("/api/watch/start")) {
      return json({ relay_url: "https://relay.invalid/", origin_endpoint_id: "e2e", jwt: null });
    }
    if (url.includes("/pub/salt/") || url.includes("/api/salts")) {
      return json({ global: "ZTJlLWdsb2JhbC1zYWx0", stream: "ZTJlLXN0cmVhbS1zYWx0", epoch: 1 });
    }
    if (url.includes("/api/report/config")) {
      return json({
        categories: [
          "sexual-content-involving-minors", "adult-sexual-content", "adult-services",
          "adult-paid-performance", "adult-ai-generated", "violence-or-threats",
          "non-consensual-content", "harassment", "other",
        ],
        groups: [
          { label: "Most serious", ids: ["sexual-content-involving-minors"] },
          { label: "Sexual content", ids: ["adult-sexual-content", "adult-services", "adult-paid-performance", "adult-ai-generated"] },
          { label: "Other harm", ids: ["violence-or-threats", "non-consensual-content", "harassment", "other"] },
        ],
        note_max: 500,
        evidence: false,
        frame_max_b64: 96000,
        frame_retention_days: 30,
      });
    }
    if (url.endsWith("/api/report") && init && init.method === "POST") {
      // Read the category off the wire rather than off the select. What the panel displays and
      // what it transmits are two different claims, and only the second one reaches an operator.
      try { window.__posted = JSON.parse(init.body).category; } catch { window.__posted = "(unparseable)"; }
      return json({ ok: true, recorded: true });
    }
    return real(input, init);
  };
});

await page.goto(`${origin}/watch.html?node=zz9zz#k=${"A".repeat(43)}`, { waitUntil: "domcontentloaded" });

const opener = await page
  .waitForSelector(".report-open button", { visible: true, timeout: 20000 })
  .catch(() => null);
if (!opener) {
  console.log("FAIL  the Report control never mounted — cannot test the panel");
  await browser.close();
  server?.close();
  process.exit(1);
}
await opener.click();
await page.waitForSelector("#reportcat", { visible: true, timeout: 10000 });

// Let the /api/report/config round trip land and repaint, so this tests the final state a person
// actually sees rather than the pre-reconcile one.
await page.waitForFunction(
  () => document.querySelectorAll("#reportcat optgroup").length > 0,
  { timeout: 10000 }
).catch(() => {});

const state = await page.evaluate(() => {
  const s = document.querySelector("#reportcat");
  const opts = [...s.options];
  return {
    value: s.value,
    selectedIndex: s.selectedIndex,
    selectedText: opts[s.selectedIndex]?.textContent?.trim() ?? null,
    selectedDisabled: opts[s.selectedIndex]?.disabled ?? null,
    groups: [...s.querySelectorAll("optgroup")].map((g) => g.label),
    values: opts.map((o) => o.value),
  };
});

check("nothing is selected when the panel opens", state.value, "");
check("the selected option is the placeholder", state.selectedText, "Choose from a category below");
check("the placeholder cannot be re-chosen", state.selectedDisabled, true);
check("the placeholder is first", state.selectedIndex, 0);
check("the severe category is NOT what an untouched dropdown would send", state.value === SEVERE, false);
check("the severe category is still offered", state.values.includes(SEVERE), true);
check("the four categories the payment rules name are present", [
  "adult-sexual-content", "adult-services", "adult-paid-performance", "adult-ai-generated",
].every((v) => state.values.includes(v)), true);
check("the groups render", state.groups, ["Most serious", "Sexual content", "Other harm"]);

const sendSel = ".report-panel button:not(.linkish)";

// Pressing Send with nothing chosen must refuse rather than file anything.
await page.click(sendSel);
await new Promise((r) => setTimeout(r, 400));
posted = await page.evaluate(() => window.__posted);
check("Send with no category files nothing", posted, null);
const hint = await page.evaluate(() =>
  [...document.querySelectorAll(".report-panel .hint")].map((n) => n.textContent.trim())
);
check("and says so", hint.includes("Please choose a category above."), true);

// The severe category must cost two clicks, and the first must file nothing.
await page.select("#reportcat", SEVERE);
await page.click(sendSel);
await new Promise((r) => setTimeout(r, 400));
posted = await page.evaluate(() => window.__posted);
check("the severe category does not file on the first click", posted, null);
const warned = await page.evaluate(() =>
  [...document.querySelectorAll(".report-panel .hint")]
    .some((n) => n.textContent.includes("most serious report"))
);
check("it warns instead", warned, true);

// Changing the category must CANCEL the confirmation. Without this, a viewer who lands on the
// severe option, reads the warning, picks something else and presses Send once has their next
// click armed by a confirmation they gave for a different accusation.
await page.select("#reportcat", "adult-services");
await new Promise((r) => setTimeout(r, 100));
const relabelled = await page.evaluate(() => document.querySelector(".report-panel button:not(.linkish)").textContent);
check("choosing a different category cancels the confirmation", relabelled, "Send report");

// The positive path, and it is not optional. A guard that refused EVERY report would satisfy the
// checks above perfectly, so the suite has to prove an ordinary report still gets through with
// the category the person actually picked.
await page.click(sendSel);
await page.waitForFunction(() => window.__posted !== null, { timeout: 8000 }).catch(() => {});
posted = await page.evaluate(() => window.__posted);
check("choosing a category and sending files the report", posted !== null, true);
check("and the chosen category is the one sent", posted, "adult-services");

await browser.close();
server?.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
