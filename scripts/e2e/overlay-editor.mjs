// Writing an overlay, and a viewer reading it.
//
//   node scripts/e2e/overlay-editor.mjs [origin]
//
// Self-serving with no argument. The settings endpoints are stubbed in the page, so this needs
// no publish key, no relay and no signature the Worker would accept — what is under test is the
// editor, what it stores, and what the viewer's page does with it.
//
// ── THE TWO THINGS WORTH ASSERTING ──────────────────────────────────────────────────────────
//
//   1. WHAT IS STORED IS WHAT WAS TYPED, as blocks. The whole reason this is a row editor and
//      not a text box is that it cannot emit malformed JSON, so the test reads the body that
//      actually goes to the Worker rather than trusting the form.
//
//   2. A REFUSAL REACHES THE AUTHOR. The renderer drops a same-origin embed, because a frame on
//      our own origin can reach through window.parent into the document holding the viewer's
//      media key. The editor previews through that same renderer, so the author is told while
//      they are typing — the alternative is a broadcaster who thinks their poll is on screen
//      and a viewer looking at a gap.
//
// Then the other end: a watch page given a stored overlay renders it, and one given nothing
// leaves no empty box behind.
//
// Exit 0 = the editor round-trips, refuses what the renderer refuses, and viewers see it.

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

// An overlay already stored for this broadcast, so the editor has something to read back.
const STORED = [
  { t: "h", text: "Tonight's set" },
  { t: "p", text: "Requests in the chat." },
  { t: "ul", items: ["one", "two"] },
];

const STUB_SETTINGS = () => {
  window.__saved = [];
  const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/settings") && (!init || (init.method ?? "GET") === "GET")) {
      return json({ require_auth: 0, overlay_html: JSON.stringify(window.__stored), chat_enabled: 0, link_enc: null });
    }
    if (url.includes("/api/stream/challenge")) return json({ challenge: "1.deadbeef" });
    if (url.includes("/settings")) {
      window.__saved.push(JSON.parse(init.body));
      return json({ ok: true });
    }
    if (url.includes("/api/config")) return json({ broadcast_offline: false, offline_message: null });
    return real(input, init);
  };
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ── The editor ─────────────────────────────────────────────────────────────────────────
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  await page.evaluateOnNewDocument(`window.__stored = ${JSON.stringify(STORED)};`);
  await page.evaluateOnNewDocument(STUB_SETTINGS);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/broadcast.html`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#ovbox", { timeout: 30000 });

  check("the editor is not loaded until the panel is opened",
    await page.evaluate(() => document.getElementById("ovedit").children.length === 0));

  await page.evaluate(() => document.getElementById("ovbox").open = true);
  await page.evaluate(() => document.getElementById("ovbox").dispatchEvent(new Event("toggle")));
  await page.waitForFunction(() => document.querySelectorAll(".ov-row").length > 0, { timeout: 20000 });
  await settle(400);

  check("what is already stored comes back as rows",
    await page.evaluate(() => document.querySelectorAll(".ov-row").length) === STORED.length,
    `${await page.evaluate(() => document.querySelectorAll(".ov-row").length)} rows`);
  check("each row names its own block type",
    await page.evaluate(() =>
      [...document.querySelectorAll(".ov-type")].map((s) => s.value).join(",")) === "h,p,ul");

  // The preview is the viewer's renderer, on the blocks that would be stored.
  const preview = () => page.evaluate(() =>
    [...document.querySelectorAll(".ov-preview *")].map((e) => e.tagName.toLowerCase()).join(","));
  check("the preview renders them through the real renderer",
    (await preview()) === "h2,p,ul,li,li", await preview());
  check("and the text is the text that was stored",
    await page.evaluate(() => document.querySelector(".ov-preview h2")?.textContent) === "Tonight's set");

  // ── Adding a block ─────────────────────────────────────────────────────────────────────
  await page.evaluate(() => document.querySelector(".ov-add").click());
  await settle(200);
  await page.evaluate(() => {
    const rows = document.querySelectorAll(".ov-row");
    const last = rows[rows.length - 1];
    last.querySelector(".ov-type").value = "a";
    last.querySelector(".ov-type").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle(200);
  await page.evaluate(() => {
    const rows = document.querySelectorAll(".ov-row");
    const last = rows[rows.length - 1];
    const fields = last.querySelectorAll(".ov-field");
    fields[0].value = "The tickets";
    fields[0].dispatchEvent(new Event("input", { bubbles: true }));
    fields[1].value = "https://example.com/tickets";
    fields[1].dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(300);
  check("a new block appears in the preview as you type",
    await page.evaluate(() => {
      const a = document.querySelector(".ov-preview a");
      return a?.textContent === "The tickets" && a.getAttribute("href") === "https://example.com/tickets";
    }));
  check("and the link is given rel=noopener, which the editor never had to ask for",
    await page.evaluate(() => (document.querySelector(".ov-preview a")?.getAttribute("rel") || "").includes("noopener")));

  // ── A refusal reaches the author ───────────────────────────────────────────────────────
  //
  // An embed pointed at our own origin is the one that matters: a same-origin frame can reach
  // window.parent and read the media key out of the viewer's document.
  await page.evaluate(() => document.querySelector(".ov-add").click());
  await settle(200);
  await page.evaluate((self) => {
    const rows = document.querySelectorAll(".ov-row");
    const last = rows[rows.length - 1];
    last.querySelector(".ov-type").value = "embed";
    last.querySelector(".ov-type").dispatchEvent(new Event("change", { bubbles: true }));
    setTimeout(() => {
      const r = document.querySelectorAll(".ov-row");
      const f = r[r.length - 1].querySelector(".ov-field");
      f.value = self + "/watch.html";
      f.dispatchEvent(new Event("input", { bubbles: true }));
    }, 50);
  }, origin);
  await settle(600);
  const note = await page.evaluate(() => {
    const n = document.querySelector(".ov-notes");
    return n && !n.hidden ? n.textContent.trim() : "";
  });
  check("A SAME-ORIGIN EMBED IS REFUSED, AND THE AUTHOR IS TOLD WHY",
    /embed/i.test(note) && /on this site/i.test(note), note || "(nothing said)");
  check("and no iframe for it reaches the preview",
    await page.evaluate(() => document.querySelectorAll(".ov-preview iframe").length) === 0);

  // ── What actually gets stored ──────────────────────────────────────────────────────────
  await page.evaluate(() => document.querySelector(".ov-save").click());
  await page.waitForFunction(() => (window.__saved || []).length > 0, { timeout: 15000 });
  await settle(300);
  const saved = await page.evaluate(() => window.__saved[window.__saved.length - 1]);
  let blocks = null;
  try { blocks = JSON.parse(saved.overlay_html); } catch { /* reported below */ }
  check("the save is signed, so the Worker can tell whose broadcast it is",
    typeof saved.challenge === "string" && typeof saved.signature === "string");
  check("WHAT IS STORED IS VALID BLOCKS, NEVER MARKUP", Array.isArray(blocks),
    JSON.stringify(saved.overlay_html).slice(0, 80));
  check("carrying everything that was typed, in order",
    JSON.stringify(blocks) === JSON.stringify([
      ...STORED,
      { t: "a", text: "The tickets", href: "https://example.com/tickets" },
      { t: "embed", src: `${origin}/watch.html` },
    ]), JSON.stringify(blocks));
  check("the editor says the save landed",
    /saved/i.test(await page.evaluate(() => document.querySelector(".ov-status")?.textContent || "")));

  // The refused embed IS stored, and refused again at render time. Storing only what renders
  // today would quietly delete a block the rules might later allow, and the author saw the
  // refusal already.
  check("a refused block is still stored rather than silently dropped",
    blocks.some((b) => b.t === "embed"));
  await page.close();

  // ── The viewer's end ───────────────────────────────────────────────────────────────────
  const watch = await browser.newPage();
  await watch.evaluateOnNewDocument(`window.__stored = ${JSON.stringify(STORED)};`);
  await watch.evaluateOnNewDocument(STUB_SETTINGS);
  watch.on("pageerror", (e) => pageErrors.push(e.message));
  await watch.goto(`${origin}/watch.html?node=abc123#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, {
    waitUntil: "networkidle2", timeout: 60000,
  });
  await watch.waitForFunction(() => document.querySelector("#overlay-mount")?.children.length > 0, { timeout: 20000 })
    .catch(() => {});
  const shown = await watch.evaluate(() => ({
    tags: [...document.querySelectorAll("#overlay-mount *")].map((e) => e.tagName.toLowerCase()).join(","),
    heading: document.querySelector("#overlay-mount h2")?.textContent ?? null,
  }));
  check("THE VIEWER SEES THE OVERLAY", shown.tags === "h2,p,ul,li,li", shown.tags);
  check("with the broadcaster's own words in it", shown.heading === "Tonight's set", String(shown.heading));
  // It renders before the stream does, on purpose: someone who opens the link early has nothing
  // else to read while they wait.
  check("and it is there before the stream is",
    /waiting for broadcaster|stream is not live/i.test(
      await watch.evaluate(() => document.getElementById("status")?.textContent || "")),
    await watch.evaluate(() => document.getElementById("status")?.textContent || ""));
  await watch.close();

  // No overlay means no empty box, which is a CSS rule and therefore easy to lose.
  const bare = await browser.newPage();
  await bare.evaluateOnNewDocument(`window.__stored = [];`);
  await bare.evaluateOnNewDocument(STUB_SETTINGS);
  await bare.goto(`${origin}/watch.html?node=abc123#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, {
    waitUntil: "networkidle2", timeout: 60000,
  });
  await settle(1500);
  check("a broadcast with no overlay leaves no empty box behind",
    await bare.evaluate(() => {
      const el = document.getElementById("overlay-mount");
      return el.children.length === 0 && getComputedStyle(el).display === "none";
    }));
  await bare.close();

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
} finally {
  await browser.close();
  server?.close();
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
