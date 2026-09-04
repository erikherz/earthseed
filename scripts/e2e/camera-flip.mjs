// Front camera ⇄ back camera, mid-broadcast, without dropping anyone watching.
//
// Three things have to hold, and the third is the one that is easy to get wrong:
//
//   1. The control is not offered before there is a picture to flip.
//   2. Pressing it asks for the OTHER facingMode, swaps the track the encoder is drawing from,
//      and gives the old camera back.
//   3. Stopping that old track does NOT end the broadcast. The camera watcher tears everything
//      down on an "ended" track, because that is what a camera dying looks like — and a flip
//      deliberately ends a track. Without detaching the watcher first, a flip is indistinguishable
//      from a camera failure and the broadcaster is told their camera stopped, mid-sentence, on
//      the one action most likely to be taken mid-sentence.
//
//   node scripts/e2e/camera-flip.mjs [origin]
//
// Like camera-yanked.mjs, this needs no deployed origin, no publish key and no relay: with no
// argument it serves simple/ itself and answers the requests between the page and getUserMedia.
// It goes one step further than that suite and serves a STAND-IN for the vendored MoQ module, so
// the broadcast actually reaches "live" — see MOQ_STUB below for why that seam is the honest one.
// What is under test is pure client: which track the encoder reads, and what the failure handling
// does about a track that ended on purpose.
//
// Exit 0 = the flip swapped the source and left the broadcast alone.

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

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// A stand-in for the vendored MoQ module, served in its place.
//
// THE SEAM, and it is worth being explicit about why it is legitimate. camera-yanked.mjs cannot
// reach a live broadcast locally: the relay is unreachable, going live fails, and it reports that
// scenario as SKIPPED. Every interesting assertion here is on the far side of that — a flip is
// something you do WHILE live — so skipping would leave the whole feature untested, and
// earthseed's broadcasting is shuttered (BROADCAST_OFFLINE=1), so a deployed run cannot cover it
// either.
//
// What this replaces is the transport and nothing else: connect, publish, and a Broadcast that
// accepts writes and drops them. The client's own capture loop, encoder, canvas, track handling
// and teardown all run for real, and those are exactly what a flip touches. It proves nothing
// about MoQ, which is not what is under test.
const MOQ_STUB = `
export const Path = { from: (s) => s };
class Track {
  constructor(name) { this.name = name; }
  appendGroup() { return { writeFrame() {}, close() {} }; }
  close() {}
}
export class Broadcast {
  constructor() { this.closed = new Promise(() => {}); }
  async requested() { return null; }   // never resolves a subscriber; the encoder still runs
  create(name) { return new Track(name); }
  close() {}
}
export class Connection {
  static async connect() { return new Connection(); }
  publish() {}
  consume() { return new Broadcast(); }
  close() {}
}
`;

let server = null;
let origin = process.argv[2]?.replace(/\/+$/, "") || "";
if (!origin) {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    if (rel.startsWith("vendor/moq-net")) {
      res.writeHead(200, { "content-type": "text/javascript" }).end(MOQ_STUB);
      return;
    }
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

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

// Everything between the Go live click and getUserMedia, answered locally. Grants nothing: the
// Worker still verifies the publish key and the claim signature for real, and this never reaches
// a relay. It exists so the flip can be tested without one.
const STUB_BROKER = () => {
  try { localStorage.setItem("es:code", "es1.e2e-not-a-real-key"); } catch { /* private mode */ }
  const real = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/api/config")) return new Response("not found", { status: 404 });
    if (url.includes("/api/broadcast/challenge")) return json({ challenge: "e2e-challenge" });
    if (url.includes("/api/broadcast/start")) {
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

// Record what each getUserMedia asked for, and hand back a DISTINGUISHABLE track each time.
//
// The fake device ignores facingMode, so "did the picture change?" is not answerable from the
// pixels. What is answerable is which constraints were requested and which track object the
// encoder ends up reading — and those are the two facts the flip is actually made of.
const TRACK_TAGS = () => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__asked = [];
  window.__served = 0;
  navigator.mediaDevices.getUserMedia = async (c) => {
    window.__asked.push(JSON.parse(JSON.stringify(c ?? {})));
    const s = await real(c);
    const tag = `t${++window.__served}`;
    for (const track of s.getVideoTracks()) track.__tag = tag;
    return s;
  };
};

const STATE = (page) =>
  page.evaluate(() => {
    const go = document.getElementById("go");
    const flip = document.getElementById("flip");
    const preview = document.getElementById("preview");
    const tracks = preview?.srcObject ? preview.srcObject.getVideoTracks() : [];
    return {
      live: !!go?.classList.contains("is-live"),
      flipPresent: !!flip,
      flipHidden: flip ? flip.hasAttribute("hidden") : null,
      flipLabel: flip?.getAttribute("aria-label") ?? null,
      note: (() => {
        const n = document.getElementById("capture-notice");
        return n && !n.hidden ? (n.textContent || "").trim() : "";
      })(),
      status: (document.getElementById("status")?.textContent || "").trim(),
      // Which track the preview — and therefore the encoder, which reads the same MediaStream —
      // is on, and whether it is still running.
      tag: tracks[0]?.__tag ?? null,
      liveTracks: tracks.filter((t) => t.readyState === "live").length,
      asked: window.__asked ?? [],
    };
  });

try {
  const page = await browser.newPage();
  // A phone-shaped viewport. The control is display:none under (hover:none) and (pointer:coarse),
  // which puppeteer only reports when the page is emulating touch — so the CSS visibility is
  // asserted separately below rather than inferred from the size.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(STUB_BROKER);
  await page.evaluateOnNewDocument(TRACK_TAGS);
  page.on("pageerror", (e) => { failures++; console.log("        page error:", e.message); });

  await page.goto(`${origin}/broadcast.html`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#go", { timeout: 30000 });

  const before = await STATE(page);
  check("Flip exists in the page", before.flipPresent, true);
  check("but is not offered before going live", before.flipHidden, true);
  check("and names where it would go, not where it is", before.flipLabel, "Switch to the back camera");

  await page.evaluate(() => document.getElementById("go")?.click());
  await page.waitForFunction(
    () => document.getElementById("go")?.classList.contains("is-live"),
    { timeout: 30000 }
  ).catch(() => {});

  const live = await STATE(page);
  check("the broadcast went live", live.live, true);
  check("Flip is now offered", live.flipHidden, false);
  check("the first camera came up without a facing constraint", !!live.asked[0]?.video?.facingMode, false);
  const firstTag = live.tag;
  check("the encoder is reading the camera we opened", typeof firstTag === "string", true);

  // On a touch viewport the media query is satisfied, so the button must actually be rendered —
  // not merely present in the DOM. getBoundingClientRect is what answers that; `hidden` alone
  // would still report a button that CSS has taken away.
  const box = await page.evaluate(() => {
    const r = document.getElementById("flip")?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
  check("and it is actually rendered on a touch device", !!(box && box.w > 0 && box.h > 0), true);

  await page.evaluate(() => document.getElementById("flip")?.click());
  await page.waitForFunction(
    () => (window.__asked ?? []).some((c) => c?.video?.facingMode),
    { timeout: 15000 }
  ).catch(() => {});
  // Give the swap, and any teardown it might wrongly have triggered, time to land.
  await new Promise((r) => setTimeout(r, 1500));

  const after = await STATE(page);
  const facing = after.asked.map((c) => c?.video?.facingMode?.ideal).filter(Boolean);
  check("pressing Flip asks for the other camera", facing, ["environment"]);
  check("the encoder is reading a different track", after.tag !== firstTag, true);
  check("exactly one video track is live — the old one was given back", after.liveTracks, 1);
  check("the label now offers the way back", after.flipLabel, "Switch to the front camera");

  // The point of the whole exercise.
  check("THE BROADCAST IS STILL LIVE", after.live, true);
  check("and nothing was reported as a camera failure", after.note, "");
} finally {
  await browser.close();
  server?.close();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
