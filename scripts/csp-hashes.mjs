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
// Every page the enforced policy applies to. simple/_headers matches /*, so a page left off this
// list still gets the policy and simply has no hash for its inline script — which fails silently,
// exactly the way this whole file exists to prevent. Add new pages here when you add them.
const PAGES = [
  "simple/index.html",
  "simple/broadcast.html",
  "simple/watch.html",
  "simple/request.html",
  "simple/reports.html",
  "simple/trust.html",
];

// Network destinations are deliberately UNRESTRICTED, so that anyone can run a fleet on their own
// domain. An earlier version named the broker and *.moqcdn.net explicitly, which quietly encoded
// "we own every relay" into the client: a partner-operated box on their own hostname, or an
// enterprise on-net relay inside a customer's network, would have been refused by the browser
// however correct everything else was.
//
// Why giving this up costs little here. connect-src is an exfiltration control, and it binds only
// an attacker who can run script in this origin WITHOUT controlling response headers. That vector
// does not exist in this client: script-src is 'self' plus per-block hashes, there is no eval,
// Function, innerHTML, document.write or insertAdjacentHTML in either earthseed.js or the vendored
// transport, every DOM write goes through textContent, and no user content is ever rendered. And
// anyone who CAN serve a modified earthseed.js also serves simple/_headers, so they would simply
// rewrite this policy rather than be constrained by it.
//
// What travels also matters: a relay only ever receives ciphertext and a broadcast-scoped token —
// the content key never leaves the browser — so an attacker-chosen relay hostname learns nothing.
// The one secret on the wire is the rotate secret in putSalt(), and it goes to the broker.
//
// The tempting middle path — have the Worker emit an allowlist built from the broker's registered
// fleets — was considered and rejected. The broker already chooses which relay you connect to, so
// if it is honest an open connect-src is fine, and if it is compromised it controls the allowlist
// too. It buys a guarantee that evaporates under the only threat it addresses, in exchange for
// run_worker_first, a new broker endpoint, cache invalidation, and a window where a freshly
// installed fleet does not work yet.
//
// wss: is listed separately because Chrome will not match a wss: URL against an https: source.
const CONNECT = ["'self'", "https:", "wss:"];

// Trusted Types is the compensating control: it makes the DOM-XSS sinks named above THROW rather
// than merely being absent by convention, so a later edit cannot quietly reintroduce the property
// that makes an open connect-src safe. 'none' allows no policies at all, which is correct while
// nothing in the client needs one. Chromium-only — Safari ignores it — so this hardens rather than
// guarantees, and script-src remains the control doing the real work.
const TRUSTED_TYPES = ["require-trusted-types-for 'script'", "trusted-types 'none'"];

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
  ...TRUSTED_TYPES,
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
