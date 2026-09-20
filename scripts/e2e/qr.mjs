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
// So this reads the symbol back the way a scanner does, and everything below is written from
// the standard rather than imported from qr.js — a reader that shared the writer's tables could
// only ever confirm that it agrees with itself:
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

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---------------------------------------------------------------- GF(256), reader side

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// ---------------------------------------------------------------- the reader

// Alignment-pattern centres, from the standard's construction rule.
function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// Which modules carry structure rather than data. Written out corner by corner rather than
// recorded as the writer goes, so a writer that reserved the wrong cells is caught here.
function functionMap(size, ver) {
  const map = new Uint8Array(size * size);
  const set = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) map[y * size + x] = 1;
  };
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) set(x, y);                  // TL finder+sep+format
  for (let y = 0; y <= 8; y++) for (let x = size - 8; x < size; x++) set(x, y);         // TR finder+sep+format
  for (let y = size - 8; y < size; y++) for (let x = 0; x <= 8; x++) set(x, y);         // BL finder+sep+format+dark
  for (let i = 0; i < size; i++) { set(6, i); set(i, 6); }                              // timing
  if (ver >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(size - 11 + j, i); set(i, size - 11 + j); }
  }
  const pos = alignPositions(ver);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy);
    }
  }
  return map;
}

const MASK = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// The standard's own ordering: M=00, L=01, H=10, Q=11. Deliberately spelled out here rather
// than shared with the writer — this mapping is the one qr.js calls out as silently fatal.
const LEVEL_FROM_BITS = { 0: "M", 1: "L", 2: "H", 3: "Q" };

// Read the first copy of the format field, wrapped around the top-left finder.
function readFormat(m) {
  let bits = 0;
  const take = (i, x, y) => { if (m.get(x, y)) bits |= 1 << i; };
  for (let i = 0; i <= 5; i++) take(i, 8, i);
  take(6, 8, 7);
  take(7, 8, 8);
  take(8, 7, 8);
  for (let i = 9; i < 15; i++) take(i, 14 - i, 8);
  const data = (bits ^ 0x5412) >>> 10;
  return { level: LEVEL_FROM_BITS[(data >>> 3) & 3], mask: data & 7 };
}

// The zig-zag: two-module columns walked right to left, alternating up and down, skipping the
// vertical timing column. Data modules only, unmasked on the way out.
function readCodewords(m, fn, mask) {
  const size = m.size;
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y * size + x]) continue;
        bits.push((m.get(x, y) ? 1 : 0) ^ (MASK[mask](x, y) ? 1 : 0));
      }
    }
  }
  const bytes = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bytes.length * 8; i++) if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  return bytes;
}

// Table lookups the reader needs to size the blocks. Same numbers as the writer's — they are
// the standard's, and there is nowhere else to get them; the structural work above is where
// the independence lives.
const ECC_PER_BLOCK = {
  L: [-1, 7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  M: [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  Q: [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  H: [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
};
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
};
function rawCodewordCount(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return Math.floor(n / 8);
}

// Undo the interleaving and hand back one codeword (data ++ parity) per block.
function deinterleave(stream, ver, level) {
  const numBlocks = NUM_BLOCKS[level][ver];
  const eccLen = ECC_PER_BLOCK[level][ver];
  const raw = rawCodewordCount(ver);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const dataLen = (j) => shortLen - eccLen + (j < numShort ? 0 : 1);

  const data = Array.from({ length: numBlocks }, () => []);
  const ecc = Array.from({ length: numBlocks }, () => []);
  let at = 0;
  for (let i = 0; i <= shortLen - eccLen; i++) {
    for (let j = 0; j < numBlocks; j++) if (i < dataLen(j)) data[j].push(stream[at++]);
  }
  for (let i = 0; i < eccLen; i++) {
    for (let j = 0; j < numBlocks; j++) ecc[j].push(stream[at++]);
  }
  return data.map((d, j) => ({ words: [...d, ...ecc[j]], dataLen: d.length, eccLen }));
}

// A codeword is valid exactly when every syndrome is zero. This is the check a real decoder
// runs before it trusts a byte of the payload.
function syndromesZero(words, eccLen) {
  const n = words.length;
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s ^= mul(words[j], EXP[(i * (n - 1 - j)) % 255]);
    if (s !== 0) return false;
  }
  return true;
}

/** Decode a matrix the way a scanner would. Returns {text, level, version} or throws. */
function decode(m) {
  const { level, mask } = readFormat(m);
  if (!level) throw new Error("format field does not name an ECC level");
  const version = (m.size - 17) / 4;
  const stream = readCodewords(m, functionMap(m.size, version), mask);
  const blocks = deinterleave(stream, version, level);
  for (const [i, b] of blocks.entries()) {
    if (!syndromesZero(b.words, b.eccLen)) throw new Error(`block ${i} fails its Reed-Solomon check`);
  }

  const data = [];
  for (const b of blocks) for (let i = 0; i < b.dataLen; i++) data.push(b.words[i]);
  let bit = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  const mode = take(4);
  if (mode !== 0x4) throw new Error(`mode ${mode}, expected byte mode (4)`);
  const count = take(version <= 9 ? 8 : 16);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = take(8);
  return { text: new TextDecoder().decode(out), level, version };
}

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
