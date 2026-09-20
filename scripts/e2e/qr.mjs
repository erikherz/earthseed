// Does simple/qr.js actually produce a QR code, or just a plausible pattern of squares?
//
//   node scripts/e2e/qr.mjs
//
// No browser and no origin: qr.js touches no DOM, so this runs the real module directly.
//
// ── WHY THIS SUITE IS A DECODER AND NOT A SET OF SHAPE CHECKS ───────────────────────────────
//
// The tempting test is "the finders are in the corners, the size is right, roughly half the
// modules are dark". Every one of those passes on a symbol that no scanner can read — which is
// precisely the failure mode qr.js warns about in its own comments, where the error-correction
// level is written into the format field under the wrong bit pattern and the result "looks
// perfect and scans as nothing".
//
// So this reads the symbol back the way a scanner does, through ./lib/qr-decode.mjs, which is
// written from the standard rather than imported from qr.js — a reader that shared the writer's
// tables could only ever confirm that it agrees with itself:
//
//   1. recover the mask and ECC level from the format field (XOR 0x5412),
//   2. re-derive which modules are function patterns, and unmask everything else,
//   3. read the codeword bits back out along the zig-zag,
//   4. de-interleave into blocks,
//   5. check each block's Reed-Solomon syndromes are ZERO — the strongest single statement
//      available here, because a valid codeword is exactly what a decoder will accept, and
//      a single wrong byte anywhere in the data or the parity makes a syndrome non-zero,
//   6. parse the byte-mode payload and compare it to the string we asked for.
//
// Exit 0 = every symbol decodes back to its own input.

import { encodeQr } from "../../simple/qr.js";
import { decode } from "./lib/qr-decode.mjs";

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---------------------------------------------------------------- the suite

console.log("\nQR encoder — read back through an independent decoder\n");

// A link that actually carries a fragment key is the shape this feature exists for, and it is
// also the longest thing anyone will put through it.
const REAL_LINK = "https://earthseed.live/watch.html?node=f7d2c1a9b4e6083d5c2a1f9e7b3d6c04&k=kPq2Lm9xR4tZ8vN1wE5sA7dG0hJ3fK6c";

for (const [label, text, ecl] of [
  ["a short URL, level M", "https://earthseed.live", "M"],
  ["a viewer link with a key, level M", REAL_LINK, "M"],
  ["the same link at level L", REAL_LINK, "L"],
  ["the same link at level Q", REAL_LINK, "Q"],
  ["the same link at level H", REAL_LINK, "H"],
  ["past 9, where the count field widens to 16 bits", "https://earthseed.live/?" + "a".repeat(200), "M"],
  ["past 7, where the symbol carries its own version", "https://earthseed.live/?" + "b".repeat(90), "M"],
  ["non-ASCII, which byte mode carries as UTF-8", "https://earthseed.live/?q=café–π", "M"],
]) {
  const m = encodeQr(text, { ecl });
  if (!m) { check(label, false, "encodeQr returned null"); continue; }
  let got;
  try { got = decode(m); } catch (e) { check(label, false, e.message); continue; }
  check(`${label} — decodes to its own input`, got.text === text,
    got.text === text ? "" : `got ${JSON.stringify(got.text.slice(0, 40))}`);
  check(`${label} — the format field names level ${ecl}`, got.level === ecl, `read ${got.level}`);
}

// The version bits are a separate BCH field that only exists from version 7 up, and nothing
// above would notice if they were wrong: a decoder that already knows the size ignores them.
{
  const m = encodeQr("https://earthseed.live/?" + "c".repeat(120), { ecl: "M" });
  const ver = (m.size - 17) / 4;
  let bits = 0;
  for (let i = 0; i < 18; i++) if (m.get(m.size - 11 + (i % 3), Math.floor(i / 3))) bits |= 1 << i;
  let rem = bits >>> 12;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  check("version ≥ 7 carries a correct BCH(18,6) version field",
    ver >= 7 && (bits >>> 12) === ver && (bits & 0xfff) === (rem & 0xfff),
    `version ${ver}, field ${(bits >>> 12)}`);
}

// The quiet zone is the caller's job, and get() has to agree: a scanner finds the symbol by
// its light border, so out-of-range reading dark would put a frame around every code.
{
  const m = encodeQr("https://earthseed.live", { ecl: "M" });
  const outside = [[-1, 0], [0, -1], [m.size, 0], [0, m.size], [-4, -4], [m.size + 3, m.size + 3]];
  check("outside the matrix reads light, so the quiet zone comes free",
    outside.every(([x, y]) => m.get(x, y) === false));
}

// "Too long to draw at a scannable size" is a normal answer here, and the caller turns it into
// a sentence rather than an exception.
check("a payload past maxVersion returns null rather than throwing",
  encodeQr("x".repeat(400), { maxVersion: 5 }) === null);
check("the same payload fits when the version cap is lifted",
  encodeQr("x".repeat(400), { maxVersion: 40 }) !== null);

// Higher correction costs capacity. If this ever stopped being true the level would not be
// reaching the encoder at all.
{
  const l = encodeQr(REAL_LINK, { ecl: "L" });
  const h = encodeQr(REAL_LINK, { ecl: "H" });
  check("level H needs a bigger symbol than level L for the same text",
    h.version > l.version, `L=v${l.version}, H=v${h.version}`);
}

// ── Can this suite go red? ──────────────────────────────────────────────────────────────────
//
// Everything above is a positive assertion, and a decoder with a bug that happened to mirror an
// encoder bug would report a clean sheet. So: damage a symbol on purpose and require the same
// path to reject it. If these two ever pass silently, nothing above means anything.
{
  const good = encodeQr(REAL_LINK, { ecl: "M" });
  // A module out in the data area, well away from every function pattern.
  const tamper = (x, y) => ({
    size: good.size,
    version: good.version,
    get: (gx, gy) => (gx === x && gy === y ? !good.get(gx, gy) : good.get(gx, gy)),
  });

  let rejected = false;
  try { decode(tamper(good.size - 2, good.size - 2)); } catch { rejected = true; }
  check("one flipped data module fails the Reed-Solomon check", rejected,
    "the syndromes came back zero on a corrupted symbol");

  // The format field is 5 data bits plus 10 of BCH parity, so most of it can be flipped
  // without changing what a simple reader concludes. (1,8) is not one of those: it carries
  // data bit 3, the low bit of the ECC level, so flipping it turns this M symbol into an L
  // one — a different number of blocks, of different lengths. That is the failure qr.js calls
  // out as "looks perfect and scans as nothing", and it has to be fatal here.
  let wrong = false;
  try {
    const got = decode(tamper(1, 8));
    wrong = got.level !== "M" && got.text !== REAL_LINK;
  } catch { wrong = true; }
  check("a flipped ECC-level bit does not still decode as the original", wrong,
    "a damaged format field decoded cleanly, so the field is not being read");
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
