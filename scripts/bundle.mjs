#!/usr/bin/env node
// Package the client for self-hosting: `npm run bundle` → dist/earthseed-<date>-<sha>.zip
//
// The point of this script is that the bundle is GENERATED, never committed. A checked-in copy of
// the client is a copy that stops tracking the client — self-contained/ sat in this repo for nine
// days advertising itself as "your copy of Earthseed" while missing every security fix made since.
//
// Two rules make the bundle trustworthy, and both are load-bearing:
//
//   1. The client files are copied BYTE-FOR-BYTE from simple/. Nothing is stamped, minified or
//      rewritten, because the hashes in INTEGRITY.md have to match both this zip and what
//      earthseed.live serves. A version string injected into earthseed.js would break the one
//      check a self-hoster has. Provenance therefore lives in sidecar files instead.
//   2. The zip is reproducible. File order is fixed, mtimes are normalised to the commit date and
//      -X drops platform extras, so the same commit yields the same bytes and its SHA-256 can be
//      published alongside a release.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { FILES, urlFor } from "./client-files.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const sha = git("rev-parse", "--short", "HEAD");
const isoDate = git("show", "-s", "--format=%cI", "HEAD");
const day = isoDate.slice(0, 10);
const commitTime = new Date(isoDate);
const dirty = git("status", "--porcelain").length > 0;

// The enforced policy, lifted from simple/_headers rather than retyped, so the hosting notes
// cannot drift away from what is actually deployed.
function cspLine() {
  const headers = readFileSync(join(ROOT, "simple/_headers"), "utf8");
  const m = headers.match(/Content-Security-Policy:\s*(.+)/);
  if (!m) throw new Error("no Content-Security-Policy found in simple/_headers");
  return m[1].trim();
}

function hostingDoc() {
  // report-uri points at a route only earthseed.live serves; a self-host has nowhere to send them.
  const policy = cspLine().replace(/;\s*report-uri\s+\S+/, "");
  return `# Hosting your own copy of Earthseed

Built from commit \`${sha}\` (${day})${dirty ? " — **from a dirty working tree, not a clean checkout**" : ""}.

These are the exact files earthseed.live serves, copied byte for byte. No build step, no npm
install, no dependencies.

## Host it

Unzip into any directory your web server serves **over HTTPS** and open \`broadcast.html\`. That is
the whole procedure — the client talks to the broker and the relay fleet directly, and never to
earthseed.live.

Two things your server must get right:

- **HTTPS.** WebCrypto, WebTransport and IndexedDB all require a secure context. \`localhost\`
  counts, so local development works; a plain \`http://\` host does not.
- **\`.mjs\` served as JavaScript.** \`vendor/moq-net-0.1.5.mjs\` must come back as
  \`text/javascript\` or \`application/javascript\`. A server that sends
  \`application/octet-stream\` will fail the module load and the page will do nothing.

Opening the files directly from disk (\`file://\`) does **not** work, and that is a browser rule
rather than a choice made here: module scripts, \`audioWorklet.addModule()\` and IndexedDB are all
refused on a filesystem origin. Serve the folder instead — \`python3 -m http.server\` is enough for
a local trial.

## Verify what you are running

Every file's SHA-256 is published in \`INTEGRITY.md\`, which is also committed to the public
repository — so the record lives somewhere other than the server being checked.

    shasum -a 256 earthseed.js        # compare against INTEGRITY.md

Or, from a checkout of the repository, point the verifier at your own host:

    node scripts/integrity.mjs --verify https://your-host/your-path

Your viewers can run that too. It is worth telling them so: when you self-host, they load the
watch page from *you*, and this is how they check you are serving the published client.

## Make it yours

Edit **\`custom.css\`**. It ships empty, loads after \`theme.css\` so your rules win, and is the one
file this project will never change — so downloading a newer release will not undo your work.
Everything else, \`theme.css\` included, is overwritten on update.

    body   { background: #0b0f0d; color: #e7efe9; }
    button { border-color: #2ecc8f; background: #2ecc8f; color: #04120c; }
    .wrap  { max-width: 900px; }

Both pages carry a body class to target: \`.page-broadcast\` and \`.page-watch\`.

Styling cannot change what the client does — a stylesheet runs no script — but it can hide things.
Take care not to conceal the status line or the passcode hint: those are what tell a broadcaster
whether the stream is actually live and encrypted.

Because \`custom.css\` is yours, the verifier below expects it to differ and reports it as
\`customised\` rather than a failure. Every other file, including \`theme.css\`, is still checked
strictly — so restyling never costs you the ability to detect a tampered client.

## Security headers

earthseed.live sets a Content-Security-Policy that your server will not set for you. The client
works without it, but you lose the control that stops injected script from running. If your server
can send headers, send these:

    Content-Security-Policy: ${policy}
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer

The \`sha256-\` values cover the inline blocks in the shipped pages. **Edit any \`.html\` file and
they stop matching** — the browser will then silently refuse to run that block, with no visible
error. If you modify a page, regenerate with \`node scripts/csp-hashes.mjs --write\`.

## What self-hosting changes, and what it does not

**It does not weaken the encryption.** Media is encrypted in your browser; relays only ever carry
ciphertext, and the key in the \`#k=\` fragment of a share link is never sent to any server. Your
web host serves files and sees nothing else.

**It moves who you trust for the code** — from earthseed.live to you. That is the point, and it is
the one risk that cannot be engineered away: whoever serves the client can serve a different
client. Note that it moves for your *viewers* too, since they load the watch page from your server
as well. \`INTEGRITY.md\` is what makes that checkable in either direction.

**It does not hide you from the broker.** Relay placement still goes through the broker, which
learns which broadcast went live and when, regardless of who hosts these files.

**Updates become yours.** This copy is frozen at commit \`${sha}\`. It will not pick up security
fixes on its own, and a client that has drifted behind is the most likely way this bundle ends up
being the weak part. Re-download when the repository moves:

    https://github.com/erikherz/earthseed
`;
}

rmSync(DIST, { recursive: true, force: true });
const name = `earthseed-${day}-${sha}`;
const stage = join(DIST, name);
mkdirSync(join(stage, "vendor"), { recursive: true });

const staged = [];
for (const rel of FILES) {
  const dest = join(stage, urlFor(rel).replace(/^\//, ""));
  cpSync(join(ROOT, rel), dest);
  staged.push(dest);
}
for (const [rel, body] of [["INTEGRITY.md", readFileSync(join(ROOT, "INTEGRITY.md"), "utf8")], ["HOSTING.md", hostingDoc()]]) {
  const dest = join(stage, rel);
  writeFileSync(dest, body);
  staged.push(dest);
}

// Normalise timestamps so the archive is byte-identical for a given commit.
for (const f of staged) utimesSync(f, commitTime, commitTime);

const zipPath = join(DIST, `${name}.zip`);
const entries = staged.map((f) => join(name, f.slice(stage.length + 1)));
execFileSync("zip", ["-X", "-q", zipPath, ...entries], { cwd: DIST });

const digest = sha256(readFileSync(zipPath));
console.log(`dist/${name}.zip`);
console.log(`  commit    ${sha} (${day})${dirty ? "  ** DIRTY TREE **" : ""}`);
console.log(`  contents  ${FILES.length} client files + INTEGRITY.md + HOSTING.md`);
console.log(`  sha256    ${digest}`);
if (dirty) console.log(`\n  warning: built from uncommitted changes; publish only from a clean checkout.`);
