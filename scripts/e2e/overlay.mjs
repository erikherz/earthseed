// Does the overlay renderer build what it says, and refuse what it says?
//
// The overlay is the one place in this client where content from one person is rendered in
// another person's document — and that document holds the media key derived from the `#k=`
// fragment. Anything that executes there can read the key and post it anywhere. Nothing else in
// simple/ has that property.
//
// ── THE FAILURE THIS SUITE IS SHAPED AROUND ─────────────────────────────────────────────────
//
// On 20 Sep 2026 this feature was first built on DOMPurify, ported from Wallflower. Against the
// deployed origin, under `require-trusted-types-for 'script'; trusted-types 'none'`, DOMPurify
// returns an EMPTY result for every input — it parses internally through an innerHTML sink and
// swallows the violation. Every "no script survived" assertion passed. They were true and they
// measured nothing, because nothing had been rendered at all.
//
// So this suite asserts POSITIVELY first: the safe blocks must actually appear. A run where the
// overlay renders nothing fails here rather than reporting a clean bill of health. Checking that
// bad things are absent is worthless without also checking that good things are present.
//
//   node scripts/e2e/overlay.mjs [origin]
//
// Self-serving like camera-yanked.mjs: with no argument it serves simple/ on a loopback port.
// Pass an origin to run against a deployment — which is where the CSP is real, and therefore the
// run that counts.
//
// Exit 0 = every safe block rendered, and every refused shape was refused.

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
  console.log("  NOTE: no _headers here, so Trusted Types is NOT enforced. The deployed run is the real one.\n");
}

const browser = await puppeteer.launch({ headless: "new" });

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${origin}/watch.html`, { waitUntil: "domcontentloaded" });

  const loaded = await page.evaluate(async (o) => {
    const m = await import(`${o}/overlay.js`);
    window.__mount = m.mountOverlay;
    return typeof m.mountOverlay === "function";
  }, origin);
  check("the module loads and exports mountOverlay", loaded);
  if (!loaded) throw new Error("cannot continue without the module");

  const ttEnforced = await page.evaluate(() => {
    try {
      document.createElement("div").innerHTML = "<b>x</b>";
      return false;
    } catch {
      return true;
    }
  });
  console.log(ttEnforced
    ? "  --   Trusted Types IS enforced on this origin. This is the run that counts.\n"
    : "  --   Trusted Types is not enforced on this origin (local harness).\n");

  /**
   * Mount blocks into a live, attached element and report what the DOM actually holds.
   * Attached, not detached: a detached subtree would not exercise the document's CSP.
   */
  const mount = (blocks) =>
    page.evaluate((b) => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const removed = window.__mount(host, b);
      const out = {
        removed,
        tags: [...host.querySelectorAll("*")].map((n) => n.tagName.toLowerCase()),
        textContent: host.textContent,
        // innerHTML as a GETTER is not a Trusted Types sink. Only ever used for messages.
        html: host.innerHTML,
        iframe: (() => {
          const f = host.querySelector("iframe");
          return f && {
            src: f.getAttribute("src"),
            sandbox: f.getAttribute("sandbox"),
            allow: f.getAttribute("allow"),
            referrerpolicy: f.getAttribute("referrerpolicy"),
            height: f.getAttribute("height"),
          };
        })(),
        link: (() => {
          const a = host.querySelector("a");
          return a && { href: a.getAttribute("href"), rel: a.getAttribute("rel"), target: a.getAttribute("target") };
        })(),
        img: (() => {
          const i = host.querySelector("img");
          return i && { src: i.getAttribute("src"), alt: i.getAttribute("alt"), rp: i.getAttribute("referrerpolicy") };
        })(),
      };
      host.remove();
      return out;
    }, blocks);

  console.log("── the safe blocks must actually RENDER ────────────────────────────────────");
  //
  // First, because a renderer that produces nothing passes every negative assertion below.

  const full = await mount([
    { t: "h", text: "Tonight" },
    { t: "p", text: "Doors at eight." },
    { t: "ul", items: ["first", "second"] },
    { t: "ol", items: ["one", "two"] },
    { t: "hr" },
  ]);
  check("heading, paragraph, lists and rule all render",
    ["h2", "p", "ul", "li", "ol", "hr"].every((t) => full.tags.includes(t)), JSON.stringify(full.tags));
  check("their text is present", full.textContent.includes("Tonight") && full.textContent.includes("Doors at eight."),
    JSON.stringify(full.textContent));
  check("list items render as separate <li>", full.tags.filter((t) => t === "li").length === 4,
    JSON.stringify(full.tags));
  check("a heading is h2, never h1 (the page owns h1)", !full.tags.includes("h1"));
  check("nothing was reported removed for clean input", full.removed.length === 0, JSON.stringify(full.removed));

  console.log("\n── markup in a text field is TEXT ──────────────────────────────────────────");

  const asText = await mount([
    { t: "h", text: "<script>window.__pwned=1</script>" },
    { t: "p", text: "<img src=x onerror='window.__pwned=1'>" },
    { t: "ul", items: ["<b>not bold</b>"] },
  ]);
  check("no script or img element is created from text",
    !asText.tags.includes("script") && !asText.tags.includes("img") && !asText.tags.includes("b"),
    JSON.stringify(asText.tags));
  check("the markup appears as visible characters instead",
    asText.textContent.includes("<script>") && asText.textContent.includes("<b>not bold</b>"),
    JSON.stringify(asText.textContent.slice(0, 90)));
  check("and it is escaped in the serialised DOM",
    asText.html.includes("&lt;script&gt;"), asText.html.slice(0, 120));

  const pwned = await page.evaluate(() => "__pwned" in window);
  check("nothing executed", !pwned);

  console.log("\n── links ───────────────────────────────────────────────────────────────────");

  const link = await mount([{ t: "a", text: "tickets", href: "https://example.com/t" }]);
  check("an https link renders", link.link?.href === "https://example.com/t", JSON.stringify(link.link));
  check("  with rel=noopener noreferrer", link.link?.rel === "noopener noreferrer", link.link?.rel);
  for (const [label, href] of [
    ["javascript:", "javascript:window.__pwned=1"],
    ["plain http", "http://example.com/"],
    ["data:text/html", "data:text/html,<script>1</script>"],
  ]) {
    const r = await mount([{ t: "a", text: "x", href }]);
    check(`refused link — ${label}`, !r.link, JSON.stringify(r.link));
  }

  console.log("\n── images ──────────────────────────────────────────────────────────────────");

  const img = await mount([{ t: "img", src: "https://example.com/a.png", alt: "a photo" }]);
  check("an https image renders", img.img?.src === "https://example.com/a.png", JSON.stringify(img.img));
  check("  with referrerpolicy=no-referrer (the link is in the URL)",
    img.img?.rp === "no-referrer", img.img?.rp);
  const inline = await mount([{ t: "img", src: "data:image/png;base64,iVBORw0KGgo=", alt: "" }]);
  check("an inline raster renders", !!inline.img, JSON.stringify(inline.img));
  const svg = await mount([{ t: "img", src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }]);
  check("an inline SVG is refused (it can carry script)", !svg.img, JSON.stringify(svg.img));

  console.log("\n── embeds: cross-origin https only, attributes forced by us ────────────────");

  const host = new URL(origin).host;
  for (const [label, src] of [
    ["same-origin, absolute", `${origin}/index.html`],
    ["same-origin, root-relative", "/index.html"],
    ["same-origin, protocol-relative", `//${host}/x`],
    ["plain http", "http://example.com/"],
    ["javascript:", "javascript:1"],
  ]) {
    const r = await mount([{ t: "embed", src }]);
    check(`refused embed — ${label}`, !r.iframe, JSON.stringify(r.iframe));
  }

  const emb = await mount([{ t: "embed", src: "https://example.com/poll", height: 400 }]);
  check("allowed — a cross-origin https embed renders", !!emb.iframe, emb.html.slice(0, 100));
  check("  sandbox is ours, with NO allow-top-navigation",
    emb.iframe?.sandbox === "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation",
    emb.iframe?.sandbox);
  check("  allow is media-only — no camera, mic, geolocation",
    !!emb.iframe && !/camera|microphone|geolocation|display-capture/i.test(emb.iframe.allow || ""),
    emb.iframe?.allow);
  check("  referrerpolicy forced to no-referrer", emb.iframe?.referrerpolicy === "no-referrer",
    emb.iframe?.referrerpolicy);
  check("  height honoured", emb.iframe?.height === "400", emb.iframe?.height);

  // Attributes the format cannot express at all. In Wallflower these had to be stripped from
  // author markup; here there is no way to write them.
  const sneaky = await mount([
    { t: "embed", src: "https://example.com/p", sandbox: "allow-top-navigation", allow: "camera; microphone",
      referrerpolicy: "unsafe-url", srcdoc: "<script>window.__pwned=1</script>", id: "x", onload: "window.__pwned=1" },
  ]);
  check("extra keys on a block are ignored, not honoured",
    sneaky.iframe?.sandbox === "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation" &&
    !/camera/i.test(sneaky.iframe?.allow || "") &&
    !sneaky.html.includes("srcdoc") && !sneaky.html.includes("onload") && !sneaky.html.includes(" id="),
    sneaky.html.slice(0, 160));
  const clamped = await mount([{ t: "embed", src: "https://example.com/p", height: 99999 }]);
  check("an absurd height is clamped", clamped.iframe?.height === "1080", clamped.iframe?.height);

  console.log("\n── malformed input is an empty overlay, not a crash ────────────────────────");

  for (const [label, input] of [
    ["not JSON", "<h1>I am markup</h1>"],
    ["JSON, not a list", '{"t":"p","text":"x"}'],
    ["a list of junk", '[null, 3, "x", {"t":"nope"}]'],
    ["empty string", ""],
  ]) {
    const r = await mount(input);
    check(`${label}: renders nothing and says why`,
      r.tags.length === 0 && (label === "empty string" ? r.removed.length === 0 : r.removed.length > 0),
      JSON.stringify(r.removed));
  }

  const over = await mount(Array.from({ length: 45 }, (_, i) => ({ t: "p", text: `line ${i}` })));
  check("too many blocks are truncated and reported",
    over.tags.filter((t) => t === "p").length === 40 && over.removed.some((r) => r.includes("past the limit")),
    JSON.stringify(over.removed));

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
} finally {
  await browser.close();
  server?.close();
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
