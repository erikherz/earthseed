// A real broadcast, watched, with the pixels checked.
//
//   node scripts/e2e/broadcast-watch.mjs [origin] --admin <password>
//
// This is the test that the control-plane suite cannot be a substitute for. Every refusal in
// control-plane.mjs would still pass against a Worker that had broken publishing entirely — a
// door that refuses everyone refuses attackers too. This one drives the whole path: admission,
// the ownership signature, the broker, a Worker-minted relay token, capture, encrypt, relay,
// decrypt, decode, paint.
//
// It reads PIXELS rather than status text. "▶ playing" is written by our own code and would keep
// saying so if the frames were garbage; the canvas is the only witness that decryption produced
// something a decoder accepted. Two samples, seconds apart, so a single static frame — or a
// letterboxed black canvas — cannot pass for live video.
//
// Also asserted, because they are cheap here and expensive to discover in production:
//   • the viewer is refused when the route tag is wrong (proof of link actually binds)
//   • the report control is present on the watch page
//   • terminating the stream stops the viewer

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
const step = (m) => console.log(`\n${m}`);

// Is this canvas showing moving video, or a black rectangle with a hopeful status line?
//
// Passed to puppeteer as a function value, never stringified and rebuilt with `new Function` in
// the page: this site enforces `require-trusted-types-for 'script'`, so that throws and the
// sampler silently never runs — which reads as "no video" against a page that was playing fine.
const SAMPLER = () => {
  const c = document.getElementById("video");
  if (!c || !c.width || !c.height) return null;
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  let nonBlack = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += v;
    if (v > 12) nonBlack++;
  }
  const px = d.length / 4;
  return { w: c.width, h: c.height, mean: sum / px, litFraction: nonBlack / px };
};

if (!ADMIN) {
  console.error("This test mints its own publish key. Pass --admin <password>.");
  process.exit(2);
}

const mint = await fetch(`${ORIGIN}/api/admin/mint-code`, {
  method: "POST",
  headers: { Authorization: `Bearer ${ADMIN}` },
}).then((r) => r.json());
if (!mint?.code) {
  console.error(`could not mint a publish key: ${JSON.stringify(mint)}`);
  process.exit(2);
}

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

let streamId = null;
try {
  // Separate contexts: the broadcaster's identity and publish key live in storage, and a viewer
  // sharing them would let this test pass for the wrong reason.
  const bctx = await browser.createBrowserContext();
  const bpage = await bctx.newPage();
  bpage.on("console", (m) => {
    if (m.type() === "error") console.log(`    [broadcast console] ${m.text()}`);
  });

  step("Broadcaster goes live");
  await bpage.goto(`${ORIGIN}/broadcast.html?code=${encodeURIComponent(mint.code)}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await bpage.waitForSelector("#go", { timeout: 30000 });
  await bpage.click("#go");

  await bpage
    .waitForFunction(() => {
      const v = document.getElementById("share")?.value || "";
      return v.includes("#k=");
    }, { timeout: 90000 })
    .catch(async () => {
      const s = await bpage.$eval("#status", (e) => e.textContent);
      throw new Error(`never went live — status says: ${s}`);
    });

  const share = await bpage.$eval("#share", (e) => e.value);
  streamId = new URL(share).searchParams.get("node");
  check("a share link was produced", share.includes("#k="), true);
  check("  ...naming a 52-character stream id", streamId?.length, 52);
  console.log(`    ${share.replace(/#k=.*/, "#k=<redacted>")}`);

  // Waited for, not sampled. The share link appears as soon as the relay is connected, but "● live"
  // is only written when the encoder emits its first frame — reading the line at the same instant
  // catches "connecting…" and fails for no reason.
  const live = await bpage
    .waitForFunction(() => /live|playing/i.test(document.getElementById("status")?.textContent || ""), {
      timeout: 30000,
      polling: 500,
    })
    .then(() => true)
    .catch(() => false);
  check("the broadcaster reports being live", live, true);

  step("Viewer with the whole link");
  const vctx = await browser.createBrowserContext();
  const vpage = await vctx.newPage();
  vpage.on("console", (m) => {
    if (m.type() === "error") console.log(`    [watch console] ${m.text()}`);
  });
  await vpage.goto(share, { waitUntil: "networkidle2", timeout: 60000 });

  await vpage
    .waitForFunction(
      () => {
        const c = document.getElementById("video");
        if (!c || !c.width || !c.height) return false;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 12) lit++;
        }
        return lit / (d.length / 4) > 0.05;
      },
      { timeout: 120000, polling: 1000 }
    )
    .catch(async () => {
      const s = await vpage.$eval("#status", (e) => e.textContent);
      throw new Error(`no decoded video appeared — status says: ${s}`);
    });

  const first = await vpage.evaluate(SAMPLER);
  check("the canvas has real dimensions", first.w > 100 && first.h > 100, true);
  check("it is painting lit pixels, not black", first.litFraction > 0.05, true);
  console.log(`    ${first.w}x${first.h}, mean luma ${first.mean.toFixed(1)}, lit ${(first.litFraction * 100).toFixed(0)}%`);

  await new Promise((r) => setTimeout(r, 6000));
  const second = await vpage.evaluate(SAMPLER);
  // A frozen frame would give an identical mean. Fake-device video moves continuously.
  check("the picture is still moving six seconds later", Math.abs(second.mean - first.mean) > 0.01, true);

  check("the report control is offered", await vpage.$eval("body", (b) => /Report this stream/.test(b.textContent)), true);

  step("A viewer without the link is refused");
  // Same stream, same origin parameter, a route tag that is not derived from the real key. This
  // is the check that makes the broadcast name stop being a credential.
  const refused = await vpage.evaluate(async (id) => {
    const r = await fetch("/api/watch/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broadcast: id, origin: "", tag: "z".repeat(43) }),
    });
    return r.status;
  }, streamId);
  check("a wrong route tag gets 404 (not 403, which would confirm it exists)", refused, 404);

  step("Terminating stops the viewer");
  await fetch(`${ORIGIN}/api/admin/kill`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ stream_id: streamId, note: "e2e" }),
  });
  const stopped = await vpage
    .waitForFunction(() => /terminated/i.test(document.getElementById("status")?.textContent || ""), {
      timeout: 30000,
      polling: 500,
    })
    .then(() => true)
    .catch(() => false);
  check("the viewer is told, within 30s", stopped, true);

  const afterKill = await vpage.evaluate(SAMPLER);
  check("and the canvas is cleared rather than left frozen", afterKill.litFraction < 0.02, true);
} catch (e) {
  failures++;
  console.error(`\nERROR: ${e.message}`);
} finally {
  if (streamId && ADMIN) {
    // Leave nothing terminated behind: this id belongs to a throwaway identity, but a stale kill
    // row is exactly the sort of thing that makes a later test fail for an unrelated reason.
    await fetch(`${ORIGIN}/api/admin/unkill`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId }),
    }).catch(() => {});
  }
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: broadcast → watch works end to end\n");
process.exit(failures ? 1 : 0);
