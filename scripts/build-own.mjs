// #85 "Own your copy" assembler — turns the self-contained ES build (dist-own/)
// into a fully portable app the broadcaster OWNS: send.html + view.html + all JS +
// wasm, every path relative, no code loaded from tinymoq.com. Unzip it and run it
// locally (double-click send.html), or drop it on any static host.
//
//   1. npx vite build --config vite.selfcontained.config.ts   (→ dist-own/)
//   2. node scripts/build-own.mjs                              (this → own/ + public/own.zip)
//
// Trust model is unchanged (broker mode: pk_ → tinymoq.com/cdn/assign, DHT
// discovery, gated fleet). What changes is only WHERE the code lives — inside the
// pin — so the person capturing + transmitting media runs their own copy of the app.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ES = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ES, "dist-own");
const OWN = path.join(ES, "own");
const PUBLIC = path.join(ES, "public");

if (!fs.existsSync(path.join(SRC, "index.html"))) {
  console.error("missing dist-own/index.html — run: npx vite build --config vite.selfcontained.config.ts");
  process.exit(1);
}

// 1) Transform the built app HTML → self-contained send.html / view.html.
let appHtml = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
if (!appHtml.includes('id="broadcast-view"')) {
  console.error("dist-own/index.html is not the app (no #broadcast-view).");
  process.exit(1);
}
appHtml = appHtml
  .split("\n").filter((l) => !l.includes("unpkg.com/leaflet")).join("\n")  // maps unused in send/view
  // Same-origin as the page now (the JS sits right next to it), so crossorigin is
  // unnecessary — and on file:// it can actively break the module fetch. Strip it.
  .replace(/(<script type="module")\s+crossorigin/g, "$1")
  .replace(/(<link rel="modulepreload")\s+crossorigin/g, "$1");

function withMode(mode) {
  const meta = `<meta name="earthseed-mode" content="${mode}">`;
  return appHtml.replace(/(<meta name="earthseed-key"[^>]*>)/, `$1\n    ${meta}`);
}
const sendHtml = withMode("broadcast");
const viewHtml = withMode("watch");

// 2) Lay out own/ = the two files + all assets + a RELATIVE manifest + a chooser
//    index so ipfs://<CID>/ lands somewhere friendly.
fs.rmSync(OWN, { recursive: true, force: true });
fs.mkdirSync(OWN, { recursive: true });
fs.cpSync(path.join(SRC, "assets"), path.join(OWN, "assets"), { recursive: true });
if (fs.existsSync(path.join(SRC, "vendor"))) fs.cpSync(path.join(SRC, "vendor"), path.join(OWN, "vendor"), { recursive: true });
fs.writeFileSync(path.join(OWN, "send.html"), sendHtml);
fs.writeFileSync(path.join(OWN, "view.html"), viewHtml);
for (const f of ["favicon.svg", "icon-192.png", "icon-512.png", "icon-180.png", "apple-touch-icon.png"]) {
  const src = path.join(PUBLIC, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OWN, f));
}

// Relative manifest (the shipped one uses site-absolute paths that 404 under an
// IPFS subpath like ipfs://<CID>/). start_url/scope/icons all relative.
const manifest = {
  name: "Earthseed — Broadcast", short_name: "Earthseed",
  description: "Private live streaming — your own copy.",
  start_url: "send.html", scope: "./", display: "standalone", orientation: "any",
  background_color: "#0b0f0d", theme_color: "#0b0f0d",
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};
fs.writeFileSync(path.join(OWN, "manifest.webmanifest"), JSON.stringify(manifest, null, 2));
// Point the two pages at the relative manifest (dist-own baked an absolute one? no —
// base "./" already emitted ./manifest.webmanifest; the file above satisfies it).

// A tiny chooser at own/index.html so opening the folder root offers both roles.
fs.writeFileSync(path.join(OWN, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="./favicon.svg">
<title>Earthseed — your copy</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f0d;color:#e7efe9;
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px}
  .card{max-width:34rem}
  h1{font-size:1.5rem;margin:0 0 .4rem} p{color:#9db3a6;margin:0 0 1.6rem}
  .row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
  a.btn{display:inline-block;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:600}
  a.go{background:#2ecc8f;color:#04120c} a.watch{background:#152019;color:#e7efe9;border:1px solid #29382f}
  small{display:block;margin-top:1.6rem;color:#5f7568}
</style></head><body>
<div class="card">
  <h1>Your copy of Earthseed</h1>
  <p>This is your own copy of the app — served from wherever you put it. Nothing here loads code from someone else's server.</p>
  <div class="row">
    <a class="btn go" href="./send.html">Go live →</a>
    <a class="btn watch" href="./view.html">Watch a stream</a>
  </div>
  <small>Broker mode: relays are provided by tinymoq.com via a public key baked into these pages.</small>
</div>
</body></html>`);

// 3) Zip own/ → public/own.zip for the earthseed.live download (build-static copies
//    public/own.zip → dist/). Shell out to the platform `zip` (build-time only).
const zipPath = path.join(PUBLIC, "own.zip");
fs.rmSync(zipPath, { force: true });
execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: OWN });

const bytes = fs.statSync(zipPath).size;
console.log(`own/     → ${fs.readdirSync(OWN).join(", ")}`);
console.log(`own.zip  → public/own.zip (${(bytes / 1024).toFixed(0)} KB)`);
console.log(`run      → unzip and open send.html locally, or host the folder on any static site`);
