#!/usr/bin/env node
// Regenerate the CSP lines in simple/_headers from the pages themselves.
//
// script-src carries a 'sha256-…' for every inline <script> block in the client pages, so the
// policy has to be rebuilt whenever one of those blocks changes — including whitespace, since
// the hash covers the element's text content byte for byte. A stale hash does not degrade
// gracefully: the browser refuses the script and the page silently does nothing.
//
//   node scripts/csp-hashes.mjs           # check — non-zero exit if _headers has drifted
//   node scripts/csp-hashes.mjs --write   # rewrite the policy lines in simple/_headers
//
// Run the check before deploying. The rewrite only touches the two lines between the
// BEGIN/END markers in simple/_headers; the surrounding comments are left alone.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEADERS = join(ROOT, "simple/_headers");
const PAGES = ["simple/index.html", "simple/broadcast.html", "simple/watch.html"];

// Everything the client talks to at runtime. WebTransport is governed by connect-src too, so
// the relay fleet has to be here as well as the broker.
//
// wss: is listed SEPARATELY and is not redundant. @moq/net falls back to a WebSocket when
// WebTransport does not come up — the common case being a network that blocks UDP — and Chrome
// will not match a wss: URL against an https: source expression. Omitting it enforced cleanly
// in every run where WebTransport happened to succeed, and would have broken precisely the
// users who depend on the fallback. Caught only by enforcing it locally first.
const CONNECT = [
  "'self'",
  "https://tinymoq.com",
  "https://*.moqcdn.net:*",
  "wss://*.moqcdn.net:*",
];

const sha256 = (s) => "'sha256-" + createHash("sha256").update(s, "utf8").digest("base64") + "'";

// Inline blocks only: a <script> with a src= loads a file and is covered by 'self'.
const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

const hashes = [];
for (const rel of PAGES) {
  const html = readFileSync(join(ROOT, rel), "utf8");
  for (const m of html.matchAll(INLINE)) {
    const h = sha256(m[1]);
    if (!hashes.includes(h)) hashes.push(h);
  }
}

// ENFORCED since 12 Aug 2026. Held at Report-Only until the policy had been observed clean on
// WebKit as well as Chromium, because the risk was never Chrome — it was Safari disagreeing
// about hashed inline import maps or the worklet, which would have broken broadcasting on iOS
// with no console to look at. Verified on WebKit 18.2 (the Safari 18 engine): inline blocks
// execute under their hashes, the worklet loads from a real file, no violations.
//
// Set back to false to return to reporting-without-blocking; that is the rollback if a browser
// we could not test turns out to disagree. `report-uri` stays on the enforced policy, so
// breakage still announces itself at /api/csp-report rather than only failing silently.
const ENFORCE = true;

// The subset that touches no script loading or connections, enforced since 11 Aug 2026.
const BASELINE = ["frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"];

const strict = [
  `script-src ${["'self'", ...hashes].join(" ")}`,
  `connect-src ${CONNECT.join(" ")}`,
  ...BASELINE,
  // Violations POST here; `wrangler tail` shows them, which is the only practical way to see
  // what an iPhone thinks of this policy. report-to is the modern spelling, but Safari still
  // only implements report-uri, and Safari is exactly the browser we need reports from.
  "report-uri /api/csp-report",
].join("; ");

const BEGIN = "  # BEGIN generated policy";
const END = "  # END generated policy";
const generated = [
  BEGIN,
  ENFORCE
    ? `  Content-Security-Policy: ${strict}`
    : `  Content-Security-Policy: ${BASELINE.join("; ")}\n  Content-Security-Policy-Report-Only: ${strict}`,
  END,
].join("\n");

const current = readFileSync(HEADERS, "utf8");
const region = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
if (!region.test(current)) {
  console.error(`No BEGIN/END generated-policy markers in ${HEADERS}`);
  process.exit(2);
}
const next = current.replace(region, generated);

if (process.argv.includes("--write")) {
  writeFileSync(HEADERS, next);
  console.log(`wrote ${HEADERS}`);
  console.log(`  ${hashes.length} inline script block(s) hashed`);
} else if (next !== current) {
  console.error("simple/_headers is out of date — run: node scripts/csp-hashes.mjs --write");
  console.error("\nexpected:\n" + generated);
  process.exit(1);
} else {
  console.log(`simple/_headers is current (${hashes.length} inline script block(s) hashed)`);
}
