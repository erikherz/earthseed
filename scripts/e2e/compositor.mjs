// Camera, screen, and the two of them together — measured in PIXELS, not in flags.
//
//   node scripts/e2e/compositor.mjs [origin]
//
// Self-serving like camera-yanked.mjs and camera-flip.mjs: with no argument it serves simple/
// itself. It needs no publish key, no relay and no deployed origin, because everything under
// test happens before a single byte leaves the page.
//
// ── WHY PIXELS ──────────────────────────────────────────────────────────────────────────────
//
// "hasScreen() is true and the button is lit" is satisfied by a compositor that acquired a
// screen share and then drew nothing with it. The only assertion that cannot be satisfied that
// way is reading the composited canvas back: the middle of the frame has to be the screen's
// colour and the corner has to be the camera's. So both sources are stubbed as solid-colour
// canvases with colours nothing else in the page uses, and the composite is sampled.
//
// The other half is the promise the compositor exists to keep: ONE video track and ONE audio
// track for the whole session, whatever sources come and go behind them. A viewer cannot
// re-subscribe after a track reset, so a compositor that swapped tracks when the screen share
// started would freeze every viewer at exactly the moment the broadcaster started presenting.
// That is checked by holding the track OBJECT across the change, not by counting tracks.
//
// Exit 0 = the composite is really composited, and the published tracks never moved.

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

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

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

// Colours nothing else in the page draws, so a sample can only have come from the source that
// owns it. Pure primaries survive the canvas round trip exactly — no interpolation to allow for.
const CAM_RGB = [255, 0, 0];
const SCREEN_RGB = [0, 0, 255];

// Replace both capture APIs with solid-colour canvases of known size.
//
// A painted canvas is the one source whose exact dimensions and exact pixels we choose, which
// is what makes "the canvas followed its base layer" and "the inset is the camera" answerable
// at all. Chrome's own fake device gives neither.
const FAKE_SOURCES = () => {
  window.__captured = [];
  /** A canvas repainting itself forever, as a MediaStream. */
  const painted = (w, h, rgb) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d");
    // captureStream only emits when the canvas is touched, so keep touching it. A timer, not
    // rAF: this has to keep producing frames even when the page is not being presented.
    setInterval(() => {
      x.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      x.fillRect(0, 0, w, h);
    }, 20);
    return c.captureStream(30);
  };

  window.__camSize = { w: 640, h: 480 };
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (c?.audio && !c?.video) {
      // A real audio track: the mix graph calls createMediaStreamSource on it, which refuses a
      // stream with nothing in it.
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    }
    return painted(window.__camSize.w, window.__camSize.h, [255, 0, 0]);
  };
  navigator.mediaDevices.getDisplayMedia = async () => painted(1600, 900, [0, 0, 255]);

  // Watch the composite track come into existence, so its identity can be held across changes.
  const realCapture = HTMLCanvasElement.prototype.captureStream;
  HTMLCanvasElement.prototype.captureStream = function (...args) {
    const s = realCapture.apply(this, args);
    window.__captured.push({ canvas: this, stream: s });
    return s;
  };
};

// The composite is whichever captureStream came off an element the page then mounted as
// #preview — the source canvases above are never in the document.
const PROBE = () => {
  const el = document.getElementById("preview");
  if (!el || el.tagName !== "CANVAS") return { mounted: false };
  const ctx = el.getContext("2d");
  const at = (fx, fy) => {
    const d = ctx.getImageData(Math.round(el.width * fx), Math.round(el.height * fy), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const rec = (window.__captured || []).find((c) => c.canvas === el);
  const track = rec?.stream.getVideoTracks()[0] ?? null;
  if (track && !window.__trackIds) window.__trackIds = new WeakMap();
  return {
    mounted: true,
    w: el.width,
    h: el.height,
    centre: at(0.5, 0.5),
    corner: at(0.87, 0.85),      // inside the default camera inset, bottom right
    topLeft: at(0.08, 0.08),
    trackId: track?.id ?? null,  // a track's id is stable for its lifetime and unique to it
    videoTracks: rec ? rec.stream.getVideoTracks().length : 0,
  };
};

const near = (got, want, tol = 24) =>
  Array.isArray(got) && got.length === 3 && got.every((v, i) => Math.abs(v - want[i]) <= tol);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(FAKE_SOURCES);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/broadcast.html`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#cam-toggle", { timeout: 30000 });

  // ── Nothing is open until something is asked for ───────────────────────────────────────
  check("the page opens with no canvas and no device",
    (await page.evaluate(PROBE)).mounted === false);
  check("all three source toggles start unlit",
    await page.evaluate(() =>
      ["cam-toggle", "mic-toggle", "screen-toggle"].every(
        (id) => document.getElementById(id)?.getAttribute("aria-pressed") === "false")));

  // ── Camera alone ───────────────────────────────────────────────────────────────────────
  await page.evaluate(() => document.getElementById("cam-toggle").click());
  await page.waitForFunction(() => document.getElementById("preview"), { timeout: 15000 });
  await settle(900);
  let st = await page.evaluate(PROBE);
  check("Camera mounts the composite canvas", st.mounted);
  check("the camera lights its own toggle",
    await page.evaluate(() => document.getElementById("cam-toggle").getAttribute("aria-pressed")) === "true");
  // The earthseed-specific behaviour: the frame IS the source's shape, rather than the source
  // being cropped into a fixed one.
  check("the frame takes the camera's own dimensions", st.w === 640 && st.h === 480, `${st.w}x${st.h}`);
  check("and the whole frame is the camera", near(st.centre, CAM_RGB) && near(st.corner, CAM_RGB),
    `centre ${st.centre}, corner ${st.corner}`);
  check("exactly one video track is published", st.videoTracks === 1, String(st.videoTracks));
  const camOnlyTrack = st.trackId;

  // ── Camera + screen: the picture-in-picture ────────────────────────────────────────────
  await page.evaluate(() => document.getElementById("screen-toggle").click());
  await settle(1600); // past the resize rate limit
  st = await page.evaluate(PROBE);
  check("the frame follows the screen share, which is now the base layer",
    st.w === 1600 && st.h === 900, `${st.w}x${st.h}`);
  check("the middle of the frame is the screen", near(st.centre, SCREEN_RGB), String(st.centre));
  check("THE CAMERA IS COMPOSITED INTO THE CORNER", near(st.corner, CAM_RGB), String(st.corner));
  check("the upper left is still the screen, so the inset is an inset",
    near(st.topLeft, SCREEN_RGB), String(st.topLeft));

  // The whole reason the compositor exists.
  check("THE PUBLISHED VIDEO TRACK DID NOT CHANGE", st.trackId === camOnlyTrack && !!st.trackId,
    `${camOnlyTrack} -> ${st.trackId}`);
  check("and there is still exactly one of it", st.videoTracks === 1, String(st.videoTracks));

  // ── The screen goes away again ─────────────────────────────────────────────────────────
  await page.evaluate(() => document.getElementById("screen-toggle").click());
  await settle(1600);
  st = await page.evaluate(PROBE);
  check("the frame goes back to the camera's dimensions", st.w === 640 && st.h === 480, `${st.w}x${st.h}`);
  check("and the whole frame is the camera again",
    near(st.centre, CAM_RGB) && near(st.corner, CAM_RGB), `centre ${st.centre}, corner ${st.corner}`);
  check("still the same published track", st.trackId === camOnlyTrack, `${camOnlyTrack} -> ${st.trackId}`);
  check("the screen toggle went dark",
    await page.evaluate(() => document.getElementById("screen-toggle").getAttribute("aria-pressed")) === "false");

  // ── A portrait camera stays portrait ───────────────────────────────────────────────────
  //
  // This is the divergence from Wallflower's compositor, and the reason for it. There, a
  // 720x1280 phone is cropped into a fixed landscape frame and loses about two thirds of its
  // vertical field of view, because a viewer built on <moq-watch> cannot survive the encoder
  // being reconfigured. Here the encoder is ours, so the whole frame goes out.
  await page.evaluate(() => document.getElementById("cam-toggle").click());
  await settle(400);
  await page.evaluate(() => { window.__camSize = { w: 480, h: 640 }; });
  await page.evaluate(() => document.getElementById("cam-toggle").click());
  await settle(1800);
  st = await page.evaluate(PROBE);
  check("A PORTRAIT CAMERA PUBLISHES A PORTRAIT FRAME", st.w === 480 && st.h === 640, `${st.w}x${st.h}`);
  check("with no letterbox bars baked into it",
    near(st.centre, CAM_RGB) && near(st.topLeft, CAM_RGB), `centre ${st.centre}, topLeft ${st.topLeft}`);

  // ── Turning it all off gives the devices back ──────────────────────────────────────────
  await page.evaluate(() => document.getElementById("mic-toggle").click());
  await settle(500);
  check("the microphone lights its toggle",
    await page.evaluate(() => document.getElementById("mic-toggle").getAttribute("aria-pressed")) === "true");
  await page.evaluate(() => document.getElementById("mic-toggle").click());
  await page.evaluate(() => document.getElementById("cam-toggle").click());
  await settle(500);
  check("and every toggle is dark once every source is off",
    await page.evaluate(() =>
      ["cam-toggle", "mic-toggle", "screen-toggle"].every(
        (id) => document.getElementById(id)?.getAttribute("aria-pressed") === "false")));

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
} finally {
  await browser.close();
  server?.close();
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
