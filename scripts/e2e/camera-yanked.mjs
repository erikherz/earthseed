// When the camera will not start, or goes away, does the broadcaster get told?
//
// Windows hands a camera to one application at a time, which produces failures no other platform
// shows much of. Reported 2026-08-28 from Edge on Windows as "the camera does not stay open —
// I see it for a second and then it goes away":
//
//   REFUSED   getUserMedia rejects with NotReadableError ("Could not start video source")
//             because something else already holds the camera.
//   ABSENT    getUserMedia rejects with NotFoundError because the machine has no webcam at all.
//             This turned out to be the actual report, and it needs its own words: telling
//             someone to close Teams is useless advice for a desktop with no camera in it.
//   YANKED    capture starts, then the OS takes the camera back — Teams waking up, the Camera
//             app, a driver reset. The track ends, the encoder stops being fed, viewers freeze
//             on the last frame, and #status still reads "● live".
//
// All three used to end in a terse `error: Requested device not found` or in nothing at all.
//
//   node scripts/e2e/camera-yanked.mjs [origin]
//
// UNLIKE the rest of scripts/e2e, this needs no deployed origin, no publish key and no relay: with
// no argument it serves simple/ itself on a loopback port and stubs the four requests that stand
// between the page and getUserMedia. Everything under test — which DOMException gets which
// sentence, and what happens when a live track ends — is pure client. Pass an origin to run the
// same checks against a deployed one instead.
//
// Exit 0 = every reachable scenario reported itself.

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

const failures = [];
const fail = (m) => {
  failures.push(m);
  process.exitCode = 1;
};

// Serve simple/ as-is. No _headers, so no CSP: this measures the client's own logic, and the
// enforced policy is what scripts/e2e/ui-chrome.mjs and the deployed run below are for.
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
const URL_ = `${origin}/broadcast.html`;

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

// Everything between the Go live click and getUserMedia, answered locally.
//
// This grants nothing and proves nothing about the control plane: the Worker still verifies the
// publish key and the Ed25519 claim signature for real, and this test never reaches a relay. It
// exists so the camera's failure handling can be tested without one — the alternative is a suite
// that cannot run at all while broadcasting is shuttered (BROADCAST_OFFLINE=1, see wrangler.jsonc).
const STUB_BROKER = () => {
  try {
    localStorage.setItem("es:code", "es1.e2e-not-a-real-key");
  } catch { /* private mode: the click path reads it back and would prompt, which the test reports */ }
  const real = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    // The shutter. 404 is the fail-open answer offline-notice.js already handles.
    if (url.includes("/api/config")) return new Response("not found", { status: 404 });
    if (url.includes("/api/broadcast/challenge")) return json({ challenge: "e2e-challenge" });
    if (url.includes("/api/broadcast/start")) {
      // A relay URL that resolves to nothing: capture is what is under test, and the connection
      // attempt after it is expected to fail. See the YANKED scenario for what that costs.
      return json({ relay_url: "https://relay.invalid/", origin_endpoint_id: "e2e-origin", jwt: null });
    }
    if (url.includes("/pub/salt/")) {
      return json({ global: "ZTJlLWdsb2JhbC1zYWx0", stream: "ZTJlLXN0cmVhbS1zYWx0", epoch: 1 });
    }
    if (url.includes("/api/broadcast/end")) return json({ ok: true });
    if (url.includes("/api/stream/")) return json({ killed: false });
    return real(input, init);
  };
};

// Hand back a relay URL that cannot be parsed, so going live fails IMMEDIATELY and after the
// camera is already open. An unreachable host would do the same eventually, but "eventually" is
// indistinguishable from "still connecting", which is not something to assert on.
//
// Installed after STUB_BROKER, so this wrapper is the one window.fetch points at.
const BAD_RELAY = () => {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/api/broadcast/start")) {
      return new Response(
        JSON.stringify({ relay_url: "://not a url", origin_endpoint_id: "e2e-origin", jwt: null }),
        { headers: { "content-type": "application/json" } }
      );
    }
    return real(input, init);
  };
};

// Keep every stream getUserMedia hands out, so a scenario can end one later — and so that
// "is the camera still held?" can be answered from the DEVICE GRANTS rather than from the DOM.
//
// It used to be answered by reading #preview.srcObject. That stopped being the truth when the
// compositor landed: the preview is now the composited canvas, the camera is held by a <video>
// the compositor keeps to itself, and a canvas has no srcObject at all. The old probe would
// have reported "not holding" for every scenario — which reads as a pass in one place here and
// as a SKIP in another, so the suite would have gone quiet rather than red. Hence installed on
// every page below, not just the one scenario that yanks a track.
const KEEP_STREAMS = () => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__streams = [];
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await real(c);
    window.__streams.push(s);
    return s;
  };
};

// Refuse the camera the way Windows does.
//
// Built as a factory because evaluateOnNewDocument serialises the function, so the error it
// should throw has to be baked into the source rather than closed over.
const refuseVideo = (name, message) =>
  new Function(`
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (c && c.video) throw new DOMException(${JSON.stringify(message)}, ${JSON.stringify(name)});
      return real(c);
    };
  `);

const STATE = (page) =>
  page.evaluate(() => {
    const n = document.getElementById("capture-notice");
    const go = document.getElementById("go");
    const granted = window.__streams || [];
    return {
      note: n && !n.hidden ? (n.textContent || "").trim() : "",
      status: (document.getElementById("status")?.textContent || "").trim(),
      // Any video track the browser ever handed this page, still running, is the camera still
      // being held — whoever in the page happens to be holding it.
      holding: granted.some((s) => s.getVideoTracks().some((t) => t.readyState === "live")),
      // The microphone lights an indicator too, and letting go of one device but not the other
      // is exactly the kind of half-teardown that goes unnoticed.
      holdingMic: granted.some((s) => s.getAudioTracks().some((t) => t.readyState === "live")),
      live: !!go?.classList.contains("is-live"),
      // Go live is disabled for the duration of an attempt, so this separates "still trying"
      // from "tried and stopped" — which is the whole question in the last scenario.
      busy: !!go?.disabled,
      keyPrompt: !document.getElementById("keyrow")?.hidden,
    };
  });

const open = async (prep) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(STUB_BROKER);
  await page.evaluateOnNewDocument(KEEP_STREAMS);
  if (prep) await page.evaluateOnNewDocument(prep);
  await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#go", { timeout: 30000 });
  await page.evaluate(() => document.getElementById("go")?.click());
  return page;
};

try {
  // ── 1. REFUSED / ABSENT ───────────────────────────────────────────────────────────
  const REFUSALS = [
    {
      what: "camera already in use by another app",
      name: "NotReadableError",
      message: "Could not start video source",
      wants: /only one app/i,
    },
    {
      what: "no camera attached to the machine at all",
      name: "NotFoundError",
      message: "Requested device not found",
      wants: /no camera or microphone was found/i,
    },
  ];
  for (const r of REFUSALS) {
    console.log(`\n  scenario: ${r.what}`);
    const a = await open(refuseVideo(r.name, r.message));
    await new Promise((s) => setTimeout(s, 4000));
    const st = await STATE(a);
    console.log(`    status="${st.status}" note="${st.note}"`);
    if (st.keyPrompt) fail(`${r.name}: never reached the camera — the page asked for a publish key`);
    if (!st.note) fail(`${r.name}: nothing on screen explains why the camera did not start`);
    else if (!r.wants.test(st.note)) fail(`${r.name}: the notice does not name this cause — "${st.note}"`);
    if (st.live) fail(`${r.name}: the page reads as live after capture failed`);
    await a.close();
  }

  // ── 2. YANKED ─────────────────────────────────────────────────────────────────────
  //
  // Only meaningful once the camera is actually open. Against the stub above the relay is
  // unreachable, which is a legitimate go-live failure and now releases the camera on its way
  // out — so there is nothing left to yank. Reported rather than silently skipped.
  console.log("\n  scenario: camera taken away mid-capture");
  const b = await open();
  await new Promise((r) => setTimeout(r, 5000));
  const before = await STATE(b);
  console.log(`    before: holding=${before.holding} live=${before.live} status="${before.status}"`);
  if (!before.holding) {
    console.log(
      "    SKIPPED: the camera is not open — go-live did not get far enough.\n" +
      "    Expected without a reachable relay; run against a deployed origin with the fleet up\n" +
      "    to cover this one. The two refusal scenarios above do not depend on it."
    );
  } else {
    const n = await b.evaluate(() => {
      let k = 0;
      for (const s of window.__streams || []) {
        for (const t of s.getVideoTracks()) {
          t.stop();
          // stop() does not fire "ended" — the spec only fires it when the source ends by
          // itself, which IS what the OS taking the camera does. Raise it explicitly.
          t.dispatchEvent(new Event("ended"));
          k++;
        }
      }
      return k;
    });
    console.log(`    stopped ${n} camera track(s) from outside the app`);
    await new Promise((r) => setTimeout(r, 2000));
    const after = await STATE(b);
    console.log(`    after:  holding=${after.holding} live=${after.live} note="${after.note}"`);
    if (after.live) fail("yanked: the page still reads as live over a dead camera");
    if (!after.note) fail("yanked: the camera died and nothing on screen says so");
  }
  await b.close();

  // ── 3. THE CAMERA LIGHT ───────────────────────────────────────────────────────────
  //
  // A go-live that fails after capture must give the device back. Nothing did that before: the
  // camera stayed lit under a "Go live" button, and on Windows the next attempt would then fail
  // against our own abandoned capture — the app reporting an error it had itself caused.
  console.log("\n  scenario: the camera light after a failed go-live");
  const c = await open(BAD_RELAY);
  await new Promise((r) => setTimeout(r, 5000));
  const st = await STATE(c);
  console.log(`    holding=${st.holding} mic=${st.holdingMic} live=${st.live} busy=${st.busy} status="${st.status}"`);
  if (st.busy) fail("the camera light: go-live never finished failing, so nothing was measured");
  else if (st.live) fail("the camera light: go-live was expected to fail against an unparseable relay URL");
  else if (st.holding) fail("the camera is still held after go-live failed and the page went back to idle");
  else if (st.holdingMic) fail("the camera was released after go-live failed but the microphone was not");
  await c.close();

  if (!failures.length) console.log("\nPASS: the camera reports itself");
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
  server?.close();
  for (const f of failures) console.error(`\nFAIL: ${f}`);
}
