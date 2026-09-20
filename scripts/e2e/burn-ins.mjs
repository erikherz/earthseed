// The three things that get drawn INTO the picture: a location/time line, a watermark, a QR.
//
//   node scripts/e2e/burn-ins.mjs [origin]
//
// Self-serving with no argument. Needs no publish key, no relay and no deployed origin: all of
// this happens on the broadcaster's canvas before a byte leaves the page.
//
// ── WHAT IS WORTH ASSERTING HERE ────────────────────────────────────────────────────────────
//
// "setLinkQr was called" is worthless. So is "some pixels in the corner are not black". The
// whole feature is a claim about what a VIEWER can do with the frame they receive, and there
// are exactly two claims:
//
//   1. A phone pointed at the screen can read the QR. The only honest test of that is to read
//      the symbol back out of the composited frame — find the plate, work out the module size,
//      sample each module's centre, and run the result through the same standard-derived
//      decoder the encoder suite uses (./lib/qr-decode.mjs), Reed-Solomon check and all. If the
//      bytes that come back are the link that was typed, the thing on screen is a QR code.
//
//   2. The location line never renders a guess the way it renders a fix. A city centroid
//      printed with six decimals and a ± would be manufacturing exactly the false confidence
//      the feature exists to prevent, so the two shapes are asserted separately, against a
//      denied geolocation and then against a granted one.
//
// The time half is checked against a KNOWN edge clock: /api/whereami is stubbed with a fixed
// server_time_ms, so the burned-in UTC is predictable to within the round trip and a stamp
// reading from the local machine's clock instead would be caught.
//
// Exit 0 = the QR decodes off the frame, and the two location shapes stay distinguishable.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { decode } from "./lib/qr-decode.mjs";

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

// A fixed edge clock and a fixed network location, so both halves of the line are predictable.
// Manhattan, so the friendly description has an obvious right answer too.
const EDGE = { lat: 40.7128, lon: -74.006, city: "New York", region: "New York", country: "US", colo: "EWR" };
// A device fix somewhere unmistakably else, so "which source is this?" is never ambiguous.
const DEVICE = { lat: 37.774929, lon: -122.419418, accuracy: 12 };

const QR_LINK = "https://earthseed.live/hello";
// Long enough that no plate can give its modules six real pixels. The page has to say so rather
// than draw something a camera cannot read.
const QR_TOO_LONG = "https://example.com/" + "x".repeat(260);

const STUBS = () => {
  // A red camera, so the grey plate can be found by "r === g === b" with nothing to confuse it.
  const painted = (w, h, rgb) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d");
    setInterval(() => {
      x.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      x.fillRect(0, 0, w, h);
    }, 20);
    return c.captureStream(30);
  };
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (c?.audio && !c?.video) {
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    }
    return painted(1280, 720, [255, 0, 0]);
  };

  // A fixed edge answer. server_time_ms advances with real time so the clock's slew logic has
  // something sane to work with, but it is OFFSET far from this machine's clock — a stamp that
  // quietly used Date.now() instead would land a year away and be caught below.
  window.__edgeSkewMs = 366 * 24 * 3600 * 1000;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/api/whereami")) {
      return new Response(JSON.stringify({
        ...window.__edge,
        server_time_ms: Date.now() + window.__edgeSkewMs,
        source: "cloudflare-ip-geo",
        precision: "city",
      }), { headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  };

  // Geolocation, refused until a test grants it.
  window.__fix = null;
  navigator.geolocation.watchPosition = (ok, err) => {
    const tick = setInterval(() => {
      if (window.__fix) {
        ok({ coords: { latitude: window.__fix.lat, longitude: window.__fix.lon, accuracy: window.__fix.accuracy }, timestamp: Date.now() });
      } else {
        err?.({ code: 1, message: "denied by the test" });
      }
    }, 200);
    return tick;
  };
  navigator.geolocation.getCurrentPosition = (ok, err) => {
    if (window.__fix) ok({ coords: { latitude: window.__fix.lat, longitude: window.__fix.lon, accuracy: window.__fix.accuracy }, timestamp: Date.now() });
    else err?.({ code: 1, message: "denied by the test" });
  };
  navigator.geolocation.clearWatch = (id) => clearInterval(id);
};

// Find the QR plate in the composited frame and read every module out of it.
//
// The plate is the only perfectly grey region in the picture — the camera is pure red and the
// backdrop is black — so its bounding box is found by scanning for r===g===b in the two tones
// the compositor draws it with. The module size then follows from the symbol's own size, which
// the page recomputes from the same encoder, and each module is sampled at its centre.
const READ_QR = (text) =>
  new Function("text", `
    return (async () => {
      const el = document.getElementById("preview");
      if (!el) return { err: "no canvas" };
      const ctx = el.getContext("2d");
      const W = el.width, H = el.height;
      const img = ctx.getImageData(0, 0, W, H).data;
      const grey = (i) => {
        const r = img[i], g = img[i + 1], b = img[i + 2];
        if (Math.abs(r - g) > 3 || Math.abs(g - b) > 3) return null;
        if (Math.abs(r - 170) <= 6) return "light";
        if (Math.abs(r - 40) <= 6) return "dark";
        return null;
      };
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!grey((y * W + x) * 4)) continue;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return { err: "no plate found in the frame" };
      const side = x1 - x0 + 1;
      if (side !== y1 - y0 + 1) return { err: "the plate is not square: " + side + "x" + (y1 - y0 + 1) };

      const { encodeQr } = await import("./qr.js");
      const m = encodeQr(text, { ecl: "M", maxVersion: 10 });
      if (!m) return { err: "the test's own link does not encode" };
      const total = m.size + 8;
      const mod = side / total;
      if (mod !== Math.floor(mod)) return { err: "module size is fractional: " + mod };
      if (mod < 6) return { err: "modules are below the 6px floor: " + mod };

      const bits = [];
      for (let y = 0; y < m.size; y++) {
        for (let x = 0; x < m.size; x++) {
          const px = Math.round(x0 + (x + 4) * mod + mod / 2);
          const py = Math.round(y0 + (y + 4) * mod + mod / 2);
          bits.push(img[(py * W + px) * 4] < 105 ? 1 : 0);
        }
      }
      return { size: m.size, mod, side, x0, y0, bits, W, H };
    })();
  `);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.evaluateOnNewDocument(`window.__edge = ${JSON.stringify(EDGE)};`);
  await page.evaluateOnNewDocument(STUBS);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/broadcast.html`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#useburn", { timeout: 30000 });

  // Nothing is drawn until it is asked for, and the fields are hidden until their box is ticked.
  check("all three burn-ins start off",
    await page.evaluate(() => ["useburn", "usemark", "useqr"].every((id) => !document.getElementById(id).checked)));
  check("their fields are hidden until asked for",
    await page.evaluate(() => document.getElementById("markrow").hidden && document.getElementById("qrrow").hidden));

  // Open a camera so there is a picture to draw on.
  await page.evaluate(() => document.getElementById("cam-toggle").click());
  await page.waitForFunction(() => document.getElementById("preview"), { timeout: 15000 });
  await settle(900);

  // ── The watermark ──────────────────────────────────────────────────────────────────────
  const upperLeft = () => page.evaluate(() => {
    const el = document.getElementById("preview");
    const d = el.getContext("2d").getImageData(20, 18, 240, 44).data;
    // The watermark is white at 62% over a red camera, so "not pure red" is exactly what it
    // adds — and nothing else on this frame touches that band.
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 40 || d[i + 2] > 40) n++;
    return n;
  });
  check("nothing is in the watermark band before it is switched on", (await upperLeft()) === 0);

  await page.evaluate(() => {
    document.getElementById("usemark").click();
    const f = document.getElementById("markname");
    f.value = "@earthseed";
    f.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(700);
  check("the watermark field appears once it is asked for",
    await page.evaluate(() => !document.getElementById("markrow").hidden));
  const marked = await upperLeft();
  check("THE WATERMARK IS DRAWN INTO THE FRAME", marked > 100, `${marked} lit subpixels`);

  // Clearing the text takes it away again — a watermark that survived its own field being
  // emptied would keep publishing a name somebody had just deleted.
  await page.evaluate(() => {
    const f = document.getElementById("markname");
    f.value = "";
    f.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(500);
  check("emptying the field takes the watermark off the frame", (await upperLeft()) === 0);
  await page.evaluate(() => document.getElementById("usemark").click());

  // ── The QR ─────────────────────────────────────────────────────────────────────────────
  await page.evaluate((link) => {
    document.getElementById("useqr").click();
    const f = document.getElementById("qrlink");
    f.value = link;
    f.dispatchEvent(new Event("input", { bubbles: true }));
  }, QR_LINK);
  await settle(900);

  const read = await page.evaluate(READ_QR(QR_LINK), QR_LINK);
  if (read.err) {
    check("the QR plate is drawn into the frame", false, read.err);
  } else {
    check("the QR plate is drawn into the frame, square and on whole modules", true);
    check("its modules are at or above the 6px floor that survives a codec",
      read.mod >= 6, `${read.mod}px per module`);
    // The plate's home is the upper right, inset by the same margin as the watermark.
    check("it sits in the upper right, clear of the edges",
      read.x0 > read.W * 0.5 && read.y0 > 0 && read.x0 + read.side <= read.W,
      `x0=${read.x0} y0=${read.y0} side=${read.side} of ${read.W}x${read.H}`);

    const matrix = {
      size: read.size,
      version: (read.size - 17) / 4,
      get: (x, y) => (x < 0 || y < 0 || x >= read.size || y >= read.size ? false : read.bits[y * read.size + x] === 1),
    };
    let got = null;
    let err = "";
    try { got = decode(matrix); } catch (e) { err = e.message; }
    check("THE SYMBOL ON THE FRAME DECODES TO THE LINK THAT WAS TYPED",
      got?.text === QR_LINK, err || `got ${JSON.stringify(got?.text ?? null)}`);
  }

  // A link too long to draw at a scannable size is a sentence, not a smaller QR.
  await page.evaluate((link) => {
    const f = document.getElementById("qrlink");
    f.value = link;
    f.dispatchEvent(new Event("input", { bubbles: true }));
  }, QR_TOO_LONG);
  await settle(700);
  const overlong = await page.evaluate(() => ({
    warn: document.getElementById("qrwarn").hidden ? "" : document.getElementById("qrwarn").textContent.trim(),
    plate: (() => {
      const el = document.getElementById("preview");
      const d = el.getContext("2d").getImageData(0, 0, el.width, el.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - d[i + 1]) <= 3 && Math.abs(d[i + 1] - d[i + 2]) <= 3 && Math.abs(d[i] - 170) <= 6) return true;
      }
      return false;
    })(),
  }));
  check("an unscannable link is refused in words", /too long/i.test(overlong.warn), overlong.warn || "(nothing said)");
  check("and nothing is drawn rather than something no camera could read", overlong.plate === false);
  await page.evaluate(() => document.getElementById("useqr").click());
  await settle(400);

  // ── The location and time line ─────────────────────────────────────────────────────────
  //
  // Read as TEXT, from the stamp itself, rather than sniffed out of pixels: the shape of the
  // line is the whole claim, and a pixel test cannot tell six decimals from four.
  const lineWith = (frameSource) => page.evaluate(async (src) => {
    const { createGeoStamp } = await import("./geo-stamp.js");
    const s = await createGeoStamp();
    await new Promise((r) => setTimeout(r, 700)); // let a fix, if one is allowed, arrive
    const out = {
      line: s.line({ captureTime: src === "capture" ? performance.now() : null, source: src }),
      source: s.source(),
      place: s.place(),
    };
    s.stop();
    return out;
  }, frameSource);

  const denied = await lineWith("capture");
  check("with no device fix the line marks itself a guess", / ~city /.test(denied.line), denied.line);
  check("and prints FOUR decimals, not six",
    /Lat: -?\d+\.\d{4}\s\s/.test(denied.line) && !/Lat: -?\d+\.\d{6}/.test(denied.line), denied.line);
  check("naming the network as the source", denied.source === "network", denied.source);
  check("and describing it in words a person can check", /New York|NYC/.test(denied.place), denied.place);

  // The clock is the edge's, not this machine's. The stub puts the edge a year ahead.
  const stampedYear = Number(denied.line.match(/(\d{4})-\d{2}-\d{2}/)?.[1] ?? 0);
  check("THE BURNED-IN TIME COMES FROM THE EDGE, NOT THIS COMPUTER",
    stampedYear === new Date(Date.now() + 366 * 24 * 3600 * 1000).getUTCFullYear(),
    `stamped ${stampedYear}, local ${new Date().getUTCFullYear()}`);
  check("and it is UTC, said so", /\bUTC$/.test(denied.line.trim()), denied.line);

  // Now grant a device fix. The two shapes must not converge.
  await page.evaluate((fix) => { window.__fix = fix; }, DEVICE);
  const granted = await lineWith("capture");
  check("with a device fix the line carries an accuracy radius", /±12m/.test(granted.line), granted.line);
  check("and prints SIX decimals, which the radius earns",
    /Lat: 37\.774929\s\sLon: -122\.419418/.test(granted.line), granted.line);
  check("naming the device as the source", granted.source === "device", granted.source);
  check("THE TWO SOURCES NEVER RENDER ALIKE",
    denied.line.includes("~city") && !granted.line.includes("~city") &&
    granted.line.includes("±") && !denied.line.includes("±"),
    `network: ${denied.line}\n        device:  ${granted.line}`);

  // A frame whose capture time the browser would not report is marked approximate rather than
  // silently stamped with draw time, which runs late by the whole camera pipeline.
  const approx = await lineWith("draw");
  check("a frame with no capture time is marked ≈", approx.line.includes("≈"), approx.line);
  check("and one with a real capture time is not", !granted.line.includes("≈"), granted.line);

  // ── And it actually reaches the canvas ─────────────────────────────────────────────────
  await page.evaluate(() => document.getElementById("useburn").click());
  await settle(1800); // the clock takes a burst of five samples before it will answer
  const strip = await page.evaluate(() => {
    const el = document.getElementById("preview");
    const h = Math.round(40 * Math.max(0.6, Math.min(2, el.height / 720)));
    const d = el.getContext("2d").getImageData(0, el.height - h, el.width, h).data;
    let dark = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 120 && d[i + 1] < 120) dark++;            // the plate, over a red camera
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++; // the text
    }
    return { dark, white, total: d.length / 4 };
  });
  check("the stamp strip is laid across the bottom of the frame",
    strip.dark > strip.total * 0.5, `${strip.dark}/${strip.total} darkened`);
  check("with legible text in it", strip.white > 200, `${strip.white} lit subpixels`);

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
} finally {
  await browser.close();
  server?.close();
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
