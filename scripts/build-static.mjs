// Tier-2 STAGE B assembler (v2 — hosted ES build).
//
//   1. npx vite build --config vite.hosted.config.ts   (dist-app/, assets → tinymoq.com/app/)
//   2. node scripts/build-static.mjs                    (this)
//   3. (tinymoq) wrangler deploy   +   (earthseed) wrangler deploy
//
// The app is the PROVEN ES-module build (no IIFE mangling of the decode worker),
// with base=https://tinymoq.com/app/ so its entry + chunks are absolute. We host
// dist-app/assets on tinymoq/public/app/assets (served with ACAO via run_worker_first),
// turn dist-app/index.html into send.html / view.html (a mode meta + crossorigin),
// and lay out earthseed dist/ = landing + the two files + favicon.
import fs from "node:fs";
import path from "node:path";

const ES = path.resolve(import.meta.dirname, "..");
const TMQ = path.resolve(ES, "..", "tinymoq");
const APP = path.join(ES, "dist-app");

if (!fs.existsSync(path.join(APP, "index.html"))) {
  console.error("missing dist-app/index.html — run: npx vite build --config vite.hosted.config.ts");
  process.exit(1);
}

// 1) Host the ES chunks (+ vendor wasm) on tinymoq under /app/.
const appOut = path.join(TMQ, "public", "app");
fs.rmSync(appOut, { recursive: true, force: true });
fs.mkdirSync(appOut, { recursive: true });
fs.cpSync(path.join(APP, "assets"), path.join(appOut, "assets"), { recursive: true });
if (fs.existsSync(path.join(APP, "vendor"))) fs.cpSync(path.join(APP, "vendor"), path.join(appOut, "vendor"), { recursive: true });

// 2) Transform the built app HTML → send.html / view.html.
let appHtml = fs.readFileSync(path.join(APP, "index.html"), "utf8");
if (!appHtml.includes('id="broadcast-view"')) {
  console.error("dist-app/index.html is not the app (no #broadcast-view).");
  process.exit(1);
}
appHtml = appHtml
  .split("\n").filter((l) => !l.includes("unpkg.com/leaflet")).join("\n")   // maps unused in send/view
  // cross-origin module + preload fetches need crossorigin (the JS is on tinymoq).
  .replace(/<script type="module"(?![^>]*crossorigin)/g, '<script type="module" crossorigin')
  .replace(/<link rel="modulepreload"(?![^>]*crossorigin)/g, '<link rel="modulepreload" crossorigin')
  // vite's base=tinymoq.com/app/ rewrote the SITE-ROOT assets too (favicon, PWA manifest,
  // touch icon) — those live at the serving host's root, not on tinymoq/app, so put them back.
  // (The JS entry + chunks correctly stay on tinymoq/app.)
  .replaceAll("https://tinymoq.com/app/favicon.svg", "/favicon.svg")
  .replaceAll("https://tinymoq.com/app/manifest.webmanifest", "/manifest.webmanifest")
  .replaceAll("https://tinymoq.com/app/apple-touch-icon.png", "/apple-touch-icon.png");

function withMode(mode) {
  const meta = `<meta name="earthseed-mode" content="${mode}">`;
  return appHtml.replace(/(<meta name="earthseed-key"[^>]*>)/, `$1\n    ${meta}`);
}
const sendHtml = withMode("broadcast");
const viewHtml = withMode("watch");
fs.writeFileSync(path.join(ES, "send.html"), sendHtml);
fs.writeFileSync(path.join(ES, "view.html"), viewHtml);

// 3) earthseed dist/ = landing (index.html) + the two files + favicon. (Assets live on tinymoq.)
const dist = path.join(ES, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(ES, "landing.html"), path.join(dist, "index.html"));
fs.writeFileSync(path.join(dist, "send.html"), sendHtml);
fs.writeFileSync(path.join(dist, "view.html"), viewHtml);
// Static assets served from the site root: favicon, PWA manifest + icons, QR, and
// the "Own your copy" self-contained bundle (own.zip, produced by build-own.mjs).
for (const f of ["favicon.svg", "manifest.webmanifest", "icon-192.png", "icon-512.png",
                 "icon-180.png", "apple-touch-icon.png", "qr-send.svg", "own.zip"]) {
  const src = path.join(ES, "public", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dist, f));
}
// Publish the trust doc (self-contained HTML) at /trust.html, linked from the landing.
const trust = path.join(ES, "docs", "trust-and-flows.html");
if (fs.existsSync(trust)) fs.copyFileSync(trust, path.join(dist, "trust.html"));

const entry = (appHtml.match(/src="(https:\/\/tinymoq\.com\/app\/assets\/[^"]+\.js)"/) || [])[1] || "(entry not found)";
console.log(`hosted assets → tinymoq/public/app/assets (${fs.readdirSync(path.join(appOut, "assets")).length} files)`);
console.log(`entry:  ${entry}`);
console.log(`dist:   ${fs.readdirSync(dist).join(", ")}`);
