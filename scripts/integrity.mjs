#!/usr/bin/env node
// Publish, and check, a hash of every file the client actually runs.
//
// C-1 in the threat model is the one risk that cannot be engineered away: whoever serves
// earthseed.js can serve a different earthseed.js, and the browser will run it. CSP does not help
// — a modified client is same-origin and permitted — and neither does vendoring the transport,
// because the same party serves that too.
//
// What can be done is make substitution *detectable*. INTEGRITY.md records the SHA-256 of each
// served file and is committed, so the record lives in git history on GitHub rather than on
// earthseed.live. An attacker who controls the origin controls what it serves, but not what was
// committed and signed into a repository they do not control — and `--verify` compares the two:
//
//   node scripts/integrity.mjs --verify              # fetch earthseed.live, compare to INTEGRITY.md
//   node scripts/integrity.mjs --verify http://…     # or any other origin, e.g. a self-host
//
// That is the whole guarantee, and it is worth being precise about its limits. It detects a client
// that differs from the published one. It does not tell you the published one is honest, and it
// cannot catch an origin that serves clean bytes to a checker and modified bytes to a target. It
// converts silent, undetectable substitution into something a motivated reviewer can catch — which
// is the honest ceiling for a web client, and the reason the file names it out loud.
//
//   node scripts/integrity.mjs --write               # regenerate after changing simple/
//   node scripts/integrity.mjs --check               # non-zero exit if stale (run before deploying)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { FILES, CUSTOMIZABLE, urlFor } from "./client-files.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "INTEGRITY.md");
const ORIGIN = "https://earthseed.live";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function render() {
  const rows = FILES.map((rel) => `| \`${urlFor(rel)}\` | \`${sha256(readFileSync(join(ROOT, rel)))}\` |`);
  return `# Integrity

SHA-256 of every file the client runs, as served by earthseed.live.

**Why this file exists.** The security of a web client rests on the browser running the code you
think it is running, and the party serving it can always serve something else. That cannot be
prevented. It can be made *detectable*: these hashes are committed here, so the record lives in git
history — a different place, under a different party — rather than on the site being checked.

**Check the site against it yourself:**

\`\`\`sh
node scripts/integrity.mjs --verify
\`\`\`

or by hand, for any one file:

\`\`\`sh
curl -s https://earthseed.live/earthseed.js | shasum -a 256
\`\`\`

**What this does not prove.** That the published client is honest — only that what you were served
matches what was published. It also cannot catch an origin that serves clean bytes to whoever is
checking and modified bytes to a target. It turns silent substitution into something a motivated
reviewer can catch, which is the honest ceiling for code delivered over the web. Self-hosting is
the answer for anyone who cannot accept that; the client is static and the repository is public.

| File | SHA-256 |
|---|---|
${rows.join("\n")}

_Regenerate with \`npm run integrity\`; \`npm run check\` fails if this file is stale._
`;
}

async function verify(origin) {
  // Styling is a self-hosting feature: earthseed.live offers none, so against the canonical origin
  // every file including custom.css must match exactly. Against any other origin a differing
  // custom.css is the expected result of someone restyling their own copy, and calling that FAIL
  // would train self-hosters to ignore the one check they have.
  const canonical = origin.replace(/\/+$/, "") === ORIGIN;
  let bad = 0;
  let customised = 0;
  for (const rel of FILES) {
    const want = sha256(readFileSync(join(ROOT, rel)));
    const url = origin + urlFor(rel);
    let got = "(unreachable)";
    try {
      const res = await fetch(url + "?cb=" + want.slice(0, 8), { redirect: "follow" });
      got = res.ok ? sha256(Buffer.from(await res.arrayBuffer())) : `HTTP ${res.status}`;
    } catch (e) {
      got = "fetch failed: " + e.message;
    }
    const matches = got === want;
    // Only a reachable, genuinely different file counts as customisation; an unreachable or
    // errored one is still a failure, or a self-host could hide a missing file behind this.
    const reachable = /^[0-9a-f]{64}$/.test(got);
    const tolerated = !matches && reachable && !canonical && CUSTOMIZABLE.has(rel);
    if (tolerated) customised++;
    else if (!matches) bad++;
    console.log(`${matches ? "ok  " : tolerated ? "cust" : "FAIL"}  ${urlFor(rel)}${tolerated ? "   (customised — yours to edit)" : ""}`);
    if (!matches && !tolerated) console.log(`        published ${want}\n        served    ${got}`);
  }
  const note = customised ? `, ${customised} customised` : "";
  console.log(
    bad
      ? `\n${bad} of ${FILES.length} differ from INTEGRITY.md${note}`
      : `\nall ${FILES.length} match INTEGRITY.md${note}`
  );
  if (customised && !bad) console.log(`Customised files are expected on a self-host; every file that carries code matched.`);
  return bad === 0;
}

const arg = process.argv[2];
if (arg === "--verify") {
  process.exit((await verify(process.argv[3] ?? ORIGIN)) ? 0 : 1);
} else if (arg === "--write") {
  writeFileSync(OUT, render());
  console.log(`wrote INTEGRITY.md (${FILES.length} files)`);
} else if (arg === "--check") {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing counts as stale */
  }
  if (current !== render()) {
    console.error("INTEGRITY.md is out of date — run: npm run integrity");
    process.exit(1);
  }
  console.log(`INTEGRITY.md is current (${FILES.length} files)`);
} else {
  console.error("usage: integrity.mjs --write | --check | --verify [origin]");
  process.exit(2);
}
