// A QR reader, written from the standard — the other half of every test of simple/qr.js.
//
// It exists so that "is this a real QR code?" can be answered the way a scanner answers it, and
// so that the answer is not simply the encoder agreeing with itself: everything structural here
// is derived independently (the function-pattern map, the mask formulas, the zig-zag), and the
// verdict rests on Reed-Solomon syndromes being zero, which is the check a real decoder runs
// before it trusts a byte.
//
// Two suites use it. scripts/e2e/qr.mjs reads a matrix the encoder just produced.
// scripts/e2e/burn-ins.mjs reads one back out of the COMPOSITED VIDEO FRAME, module by module,
// which is the only way to show that what a viewer receives is a scannable code rather than a
// convincing pattern of squares.

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

/** Decode a matrix the way a scanner would. Returns {text, level, version} or throws.
 *  @param {{size:number, get:(x:number,y:number)=>boolean}} m */
export function decode(m) {
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

