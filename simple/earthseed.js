// @ts-check
/*
 * earthseed.js — the ENTIRE client for a private, end-to-end-encrypted live-streaming app.
 * =============================================================================================
 *
 * This one file is all of our code. It runs in the browser AS-IS — no build step, no bundler,
 * no minification. What you read here is exactly what executes. Open source:
 *   https://github.com/erikherz/earthseed   (this file lives at simple/earthseed.js)
 *
 * The ONLY third-party code we use is the transport library, @moq/net (Media over QUIC by Luke
 * Curley / moq-dev). We do NOT vendor or modify it: the HTML page loads it directly from a
 * version-pinned CDN via an <script type="importmap"> entry, so you can confirm it is exactly the
 * published package. Everything above the wire — camera capture, encode, ENCRYPT, decrypt, decode,
 * render — is the readable code below, on native browser APIs (WebCodecs, WebCrypto, Canvas).
 *
 * ── Trust model, in one paragraph ──
 * Each broadcast has a content key derived in the browser:
 *     CK = HKDF-SHA256(fragmentKey, globalSalt ‖ streamSalt, "earthseed-media-v1|<id>|<epoch>")
 * The fragmentKey is 32 random bytes that live ONLY in the "#k=" fragment of the share link, which
 * browsers never transmit to any server. A broadcaster can OPTIONALLY also require a passcode — a
 * short second secret deliberately kept OUT of the link and handed to the viewer over a different
 * channel (spoken, SMS). It is stretched with PBKDF2 into PW and mixed in, which selects v2:
 *     CK = HKDF-SHA256(fragmentKey ‖ PW, globalSalt ‖ streamSalt, "earthseed-media-v2|<id>|<epoch>")
 * The passcode is never stored on, sent to, or verified by any server — a wrong one simply yields a
 * wrong key and the GCM tag fails in the viewer's browser.
 * Media is encrypted with AES-256-GCM per frame BEFORE it
 * touches @moq/net, so the relay and the broker only ever move ciphertext they cannot read. The
 * broker (tinymoq.com) gates the *connection* (a short-lived per-broadcast token) and serves the
 * public salts; it never sees the key. The codec catalog (resolution/codec, not content) is sent
 * in the clear by design. This is not DRM: an authorized viewer can still capture decoded frames.
 *
 * ── Layout of this file ──
 *   1. Config            relay choice, browser-support gate
 *   2. Crypto            varint framing, AES-GCM encrypt/decrypt, HKDF, link keys, node identity, passcode
 *   3. Broker client     assign a gated relay + token, get/put the public salts
 *   4. Media loop        capture→encode→encrypt→publish ; consume→decrypt→decode→paint/play
 *   5. Page controllers  runBroadcast() / runWatch() — wire the two HTML pages
 */

import * as Moq from "@moq/net";

/* ═══════════════════════════════ 1. CONFIG ═══════════════════════════════ */

// The relay is PURE TRANSPORT and sits OUTSIDE the trust boundary. Every media frame is
// AES-256-GCM encrypted in the browser (§2) BEFORE it ever reaches @moq/net, so the relay only
// forwards opaque, already-encrypted MoQ objects it can't read and never holds the key. The relay
// is not part of the encryption, it's a dumb pipe. @moq/net negotiates the wire dialect at session
// setup (moq-lite, a forwards-compatible subset of IETF moq-transport), so it interoperates with
// any moq-transport relay/CDN.
//
// There is exactly ONE path to a relay: the broker assigns one and issues a short-lived token for
// it. An earlier "open-relay" mode let a page skip the broker and use any public MoQ endpoint
// directly. It was removed deliberately: with no broker there is nothing to authorize a publisher,
// so ANYONE could publish to ANY broadcast name — the hole that the claim proof in §3 closes on
// the brokered path could never be closed on that one. Keeping a second, unauthorized path would
// have meant keeping the hole. Content encryption was never the difference between the two; the
// difference was whether anyone checked who was allowed to publish.

// Native-only: we ship no WASM/WebSocket fallback (that is what keeps the review surface tiny).
// Broadcasting needs WebTransport + WebCodecs encode; watching needs WebTransport + WebCodecs
// decode. Both are present on recent Chrome/Edge AND Safari on iOS 18+ / macOS. (Capture avoids
// MediaStreamTrackProcessor, which is Chromium-only, so Safari/iOS can broadcast too.)
/** @returns {string|null} a human reason if unsupported, else null */
function unsupportedReason(forBroadcast) {
  const need = "Try a recent Chrome or Edge, or Safari on iOS 18+ / macOS.";
  if (!("WebTransport" in globalThis)) return `This browser can't stream here — no WebTransport. ${need}`;
  if (typeof VideoDecoder === "undefined") return `This browser is missing WebCodecs. ${need}`;
  if (forBroadcast && (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined"))
    return `This browser can't encode video here (no WebCodecs). ${need}`;
  return null;
}

/* ═══════════════════════════════ 2. CRYPTO ═══════════════════════════════ */
// All AES-GCM/HKDF is WebCrypto; this section has no @moq dependency. It operates on plain byte
// arrays, and the media loop below calls encryptFrame/decryptFrame directly.

const ALGO = "AES-GCM";
const NONCE_BYTES = 12;

// WebCrypto's TS types want ArrayBuffer-backed views; a subarray is typed ArrayBufferLike.
// Identical at runtime — this cast just satisfies the type checker. @param {Uint8Array} u
const bs = (u) => /** @type {BufferSource} */ (/** @type {unknown} */ (u));

// ── QUIC varint (RFC 9000 §16): the top 2 bits of the first byte select a 1/2/4/8-byte length.
// We prefix each media frame with its timestamp as a varint (kept in the clear; see below).
/** @param {number} first */
function varintLen(first) {
  return 1 << ((first & 0xc0) >> 6);
}
/** @param {number} n */
function encodeVarint(n) {
  if (n < 0 || !Number.isFinite(n)) throw new Error("varint: bad value");
  if (n < 2 ** 6) return Uint8Array.of(n);
  if (n < 2 ** 14) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n | 0x4000);
    return b;
  }
  if (n < 2 ** 30) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, (n | 0x80000000) >>> 0);
    return b;
  }
  const b = new Uint8Array(8); // 8-byte form (n is a JS number ≤ 2^53, safe to split hi/lo)
  const dv = new DataView(b.buffer);
  dv.setUint32(0, (Math.floor(n / 2 ** 32) | 0xc0000000) >>> 0);
  dv.setUint32(4, n >>> 0);
  return b;
}
/** @param {Uint8Array} buf */
function decodeVarint(buf) {
  const len = varintLen(buf[0]);
  const dv = new DataView(buf.buffer, buf.byteOffset, len);
  if (len === 1) return { value: buf[0] & 0x3f, len };
  if (len === 2) return { value: dv.getUint16(0) & 0x3fff, len };
  if (len === 4) return { value: dv.getUint32(0) & 0x3fffffff, len };
  return { value: (dv.getUint32(0) & 0x3fffffff) * 2 ** 32 + dv.getUint32(4), len };
}

/** Pack an encoded codec chunk + its timestamp → a frame `[varint ts][payload]`.
 * @param {number} tsMicros @param {Uint8Array} payload */
function packFrame(tsMicros, payload) {
  const ts = encodeVarint(tsMicros);
  const out = new Uint8Array(ts.byteLength + payload.byteLength);
  out.set(ts, 0);
  out.set(payload, ts.byteLength);
  return out;
}
/** Split a decrypted frame back into `{ tsMicros, payload }`. @param {Uint8Array} frame */
function unpackFrame(frame) {
  const { value, len } = decodeVarint(frame);
  return { tsMicros: value, payload: frame.subarray(len) };
}

// ── key state. Frames can be produced before the key arrives (the encoder warms up while the
// broker /assign + salt fetch are in flight); encrypt/decrypt await keyReady so nothing is ever
// emitted in the clear.
/** @type {CryptoKey|null} */ let key = null;
/** @type {Promise<void>} */ let keyReady = Promise.resolve();
/** @type {(() => void)|null} */ let keyReadyResolve = null;
/** @type {number|null} */ let derivedEpoch = null;

// ── decrypt-failure signal. A missing or wrong passcode is indistinguishable from any other wrong
// key: AES-GCM simply fails its tag check. That failure IS the verifier — no passcode is ever
// checked against a server, and none is published anywhere — so the watch page listens here to
// decide when to ask for one. Called with the running count of CONSECUTIVE tag failures, or 0 the
// moment a frame decrypts cleanly again (i.e. "recovered").
/** @type {((consecutiveFailures:number) => void)|null} */ let onDecryptStatus = null;
let decryptFailures = 0;
// Recovery is reported on the failures→success TRANSITION, so zeroing the counter would swallow it:
// a viewer who typed the RIGHT passcode got playing video under a frozen "unlocking…" and a passcode
// box that never went away — the success path never announced itself. This flag survives the reset
// so the next clean frame still reports.
let reportNextSuccess = false;
/** Clear the failure run — call when a viewer submits a new passcode, so the next run is fresh. */
function resetDecryptFailures() {
  decryptFailures = 0;
  reportNextSuccess = true;
}

/** Re-arm: subsequent frames queue until the next deriveMediaKey(). Call before going live/connecting. */
function armKey() {
  key = null;
  derivedEpoch = null;
  keyReady = new Promise((resolve) => (keyReadyResolve = resolve));
}
/** The epoch of the installed key (or null) — lets a viewer skip redundant re-derives on salt polls. */
function currentEpoch() {
  return derivedEpoch;
}

/** @param {string} s base64url → bytes */
function b64urlToBytes(s) {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Derive the per-broadcast content key CK and release any queued frames. Re-callable on rotation
 * (a new salt/epoch yields a fresh key).
 *
 * `pw` is the ALREADY-STRETCHED passcode from stretchPasscode(), or null/absent when the broadcast
 * has no passcode. Its presence is what selects the derivation version, which is why turning the
 * feature on breaks nothing: without a passcode this is byte-identical to what shipped before.
 * Pass the stretched bytes, never the raw passcode — this runs again on every salt rotation and
 * must stay cheap (see stretchPasscode).
 * @param {{fragmentKeyB64:string, globalSaltB64:string, streamSaltB64:string, streamId:string, epoch:number, pw?:Uint8Array|null}} p
 */
async function deriveMediaKey(p) {
  const g = b64urlToBytes(p.globalSaltB64);
  const s = b64urlToBytes(p.streamSaltB64);
  const salt = new Uint8Array(g.byteLength + s.byteLength);
  salt.set(g, 0);
  salt.set(s, g.byteLength);
  const fk = b64urlToBytes(p.fragmentKeyB64);
  const pw = p.pw || null;
  let ikmBytes = fk;
  if (pw) {
    ikmBytes = new Uint8Array(fk.byteLength + pw.byteLength);
    ikmBytes.set(fk, 0);
    ikmBytes.set(pw, fk.byteLength);
  }
  const info = new TextEncoder().encode(`earthseed-media-${pw ? "v2" : "v1"}|${p.streamId}|${p.epoch}`);
  const ikm = await crypto.subtle.importKey("raw", bs(ikmBytes), "HKDF", false, ["deriveKey"]);
  key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(info) },
    ikm,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  derivedEpoch = p.epoch;
  keyReadyResolve?.();
}

// The frame on the wire is `[varint timestamp][12-byte nonce][AES-256-GCM ciphertext+tag]`. The
// timestamp stays clear (the decoder needs it) and is bound as GCM additional-authenticated-data,
// so a tampering relay fails decryption. Only the codec payload is encrypted.
/** @param {Uint8Array} frame */
async function encryptFrame(frame) {
  await keyReady;
  if (!key) throw new Error("crypto: encrypt with no key");
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen);
  const payload = frame.subarray(vlen);
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv: bs(nonce), additionalData: bs(ts) }, key, bs(payload))
  );
  const out = new Uint8Array(vlen + NONCE_BYTES + ct.byteLength);
  out.set(ts, 0);
  out.set(nonce, vlen);
  out.set(ct, vlen + NONCE_BYTES);
  return out;
}
/** Reverse of encryptFrame. Throws on tamper/wrong-key (GCM tag check). @param {Uint8Array} frame */
async function decryptFrame(frame) {
  await keyReady;
  if (!key) throw new Error("crypto: decrypt with no key");
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen);
  const nonce = frame.subarray(vlen, vlen + NONCE_BYTES);
  const ct = frame.subarray(vlen + NONCE_BYTES);
  /** @type {Uint8Array} */ let pt;
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt({ name: ALGO, iv: bs(nonce), additionalData: bs(ts) }, key, bs(ct))
    );
  } catch (e) {
    onDecryptStatus?.(++decryptFailures); // wrong key — the watch page turns a run of these into a passcode prompt
    throw e;
  }
  if (decryptFailures || reportNextSuccess) {
    decryptFailures = 0;
    reportNextSuccess = false;
    onDecryptStatus?.(0); // recovered: the key in hand is the right one
  }
  const out = new Uint8Array(vlen + pt.byteLength);
  out.set(ts, 0);
  out.set(pt, vlen);
  return out;
}

// ── link keys: the #k= fragment key + rotatable salts. The fragment key is minted by the
// broadcaster and kept in localStorage so the share link is stable across reloads; it is put into
// the "#k=" fragment of the share link and nowhere else.
const FRAGMENT_KEY_BYTES = 32; // AES-256 IKM
const STREAM_SALT_BYTES = 16;
const ROTATE_SECRET_BYTES = 24;

/** @param {number} nBytes */
function randomB64url(nBytes) {
  const bytes = new Uint8Array(nBytes);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** @param {string} storageKey @param {() => string} make */
function getOrCreate(storageKey, make) {
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh = make();
    localStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    return make(); // private-mode fallback: ephemeral
  }
}
/** The broadcaster's fragment key for this stream (stable across reloads → stable share link). @param {string} id */
const getOrCreateFragmentKey = (id) => getOrCreate(`es:k:${id}`, () => randomB64url(FRAGMENT_KEY_BYTES));
/** The broadcaster's rotate secret (proves salt ownership to the broker). @param {string} id */
const getOrCreateRotateSecret = (id) => getOrCreate(`es:rs:${id}`, () => randomB64url(ROTATE_SECRET_BYTES));
/**
 * Mint a FRESH fragment key, invalidating every link already handed out. Without this the key is
 * immortal: anyone who ever received a link could decrypt every later broadcast, since salts are
 * public and re-fetchable, so rotating them revokes nobody.
 *
 * Takes effect at the NEXT go-live (the content key is not re-derived mid-broadcast, so current
 * viewers are not cut off). Deliberately touches ONLY the fragment key — clearing the rotate secret
 * would lock this broadcaster out of its own stream salt until the broker's record expires, and
 * clearing the node identity would change the stream id too.
 * @param {string} id
 */
function regenerateFragmentKey(id) {
  const fresh = randomB64url(FRAGMENT_KEY_BYTES);
  try {
    localStorage.setItem(`es:k:${id}`, fresh);
  } catch {
    /* private-mode: this session only */
  }
  return fresh;
}
/** A fresh per-broadcast salt (minted on go-live and on every "reset key"). */
const newStreamSalt = () => randomB64url(STREAM_SALT_BYTES);
/** Read the fragment key a viewer received in the share link's #k= fragment. */
function fragmentKeyFromHash() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const k = new URLSearchParams(hash).get("k");
  return k && /^[A-Za-z0-9_-]{16,}$/.test(k) ? k : null;
}

// ── node identity: an Ed25519 public key rendered as 52-char base32. This is the stream's
// IDENTITY / discovery handle / moq broadcast name — NOT the content key. Persisted so the
// broadcaster keeps a stable share link; the private key never leaves the browser.
const B32 = "abcdefghijklmnopqrstuvwxyz234567"; // RFC4648 lower, no padding
const NODE_STORAGE_KEY = "es:node"; // LEGACY: an exported JWK. Read once, then deleted (see migrateLegacyNode).
const ED25519 = /** @type {AlgorithmIdentifier} */ (/** @type {unknown} */ ({ name: "Ed25519" }));

/** @param {Uint8Array} bytes */
function base32(bytes) {
  let bits = 0,
    value = 0,
    out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
/** @param {CryptoKeyPair} keyPair */
async function finalizeNode(keyPair) {
  // Public keys are ALWAYS extractable in WebCrypto regardless of the generateKey flag,
  // so this still works with a non-extractable private half.
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { id: base32(raw), keyPair, raw };
}

// The private half is NON-EXTRACTABLE and lives in IndexedDB as a CryptoKey object, never as
// bytes. Script on this page can still ASK it to sign (that is unavoidable — the broadcaster's
// own code has to sign the broker's claim challenge), but cannot read the key out and publish
// as this identity from somewhere else, later, forever. That is the difference between a
// session-long compromise and a permanent theft of the stream name. It is also why there is no
// "export my identity" feature: the bytes do not exist anywhere they could be copied from.
const NODE_DB = "earthseed";
const NODE_STORE = "identity";
const NODE_DB_KEY = "node-v1";
const IDB_TIMEOUT_MS = 3000;

/** @template T @param {Promise<T>} p @returns {Promise<T>} */
function withTimeout(p) {
  // A hung indexedDB.open would hang go-live itself; fail fast to the ephemeral path instead.
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error("indexeddb timeout")), IDB_TIMEOUT_MS)),
  ]);
}
/** @param {IDBRequest} req */
function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbOpen() {
  const req = indexedDB.open(NODE_DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(NODE_STORE);
  return withTimeout(/** @type {Promise<IDBDatabase>} */ (idbRequest(req)));
}
/** @param {"readonly"|"readwrite"} mode @param {(s: IDBObjectStore) => IDBRequest} fn */
async function idbWith(mode, fn) {
  const db = await idbOpen();
  try {
    return await withTimeout(idbRequest(fn(db.transaction(NODE_STORE, mode).objectStore(NODE_STORE))));
  } finally {
    db.close();
  }
}

async function mintKeyPair() {
  return /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(ED25519, false, ["sign", "verify"]));
}
/** Import a legacy exported JWK, dropping extractability on the way in. @param {JsonWebKey} jwk */
async function importFromJwk(jwk) {
  const privateKey = await crypto.subtle.importKey("jwk", jwk, ED25519, false, ["sign"]);
  const publicKey = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, ED25519, true, [
    "verify",
  ]);
  return /** @type {CryptoKeyPair} */ ({ privateKey, publicKey });
}

/**
 * One-time move of a pre-existing identity out of localStorage. Same key, so the node id — and
 * so every link already shared — is unchanged. The plaintext JWK is deleted ONLY after the
 * IndexedDB write has resolved, so a failure anywhere leaves the old identity intact.
 * @returns {Promise<CryptoKeyPair|null>}
 */
async function migrateLegacyNode() {
  let stored = null;
  try {
    stored = localStorage.getItem(NODE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!stored) return null;
  let keyPair;
  try {
    keyPair = await importFromJwk(JSON.parse(stored));
  } catch {
    localStorage.removeItem(NODE_STORAGE_KEY); // corrupt — nothing to preserve
    return null;
  }
  await idbWith("readwrite", (s) => s.put(keyPair, NODE_DB_KEY));
  localStorage.removeItem(NODE_STORAGE_KEY);
  return keyPair;
}

/**
 * The identity for this page, shared by every caller.
 *
 * Memoised because loadOrMintNode() is not safe to run twice concurrently: two callers that both
 * find IndexedDB empty will each mint a keypair and each store it, and the loser's id is lost while
 * its localStorage entries survive as orphans. That is not hypothetical — ticking "require a
 * passcode" and pressing "Go live" in quick succession did exactly that, and because the passcode
 * is keyed by node id, the broadcaster could be shown a passcode belonging to the identity that
 * lost the race. Reading that one aloud would hand a viewer a code that cannot decrypt.
 * @type {Promise<{id:string,keyPair:CryptoKeyPair,raw:Uint8Array}>|null}
 */
let nodePromise = null;

/** The broadcaster's persistent node identity, minted at most once per page. */
function getOrCreateNode() {
  return (nodePromise ??= loadOrMintNode());
}

/** Load the stored identity, migrate a legacy one, or mint a fresh one. Call via getOrCreateNode. */
async function loadOrMintNode() {
  try {
    const found = /** @type {CryptoKeyPair|undefined} */ (await idbWith("readonly", (s) => s.get(NODE_DB_KEY)));
    if (found?.privateKey) return await finalizeNode(found);
    const migrated = await migrateLegacyNode();
    if (migrated) return await finalizeNode(migrated);
    const keyPair = await mintKeyPair();
    await idbWith("readwrite", (s) => s.put(keyPair, NODE_DB_KEY));
    return await finalizeNode(keyPair);
  } catch {
    // No IndexedDB (private mode, storage disabled, hung open): stay usable, but this
    // identity — and so the share link — lasts only for this page.
    return finalizeNode(await mintKeyPair());
  }
}

/**
 * Discard this identity and mint a new one.
 *
 * There is no rotation-in-place to offer: the node id IS the Ed25519 public key, so keeping the
 * name while changing the key is impossible by construction. A new key is a new name is a new link.
 *
 * Stronger than "New link", and differently so. A fresh fragment key stops old links from
 * DECRYPTING, but the node id inside them is unchanged — and a watch assignment needs no claim
 * proof, so anyone still holding one can learn when this broadcaster is live for as long as the
 * identity exists. Only a new id closes that: old links then name someone who never publishes again.
 *
 * Irreversible. The old private key is non-extractable and is dropped here, so nobody — including
 * us — can recover the old identity. The old per-stream material is cleared with it, so the new
 * identity starts on a fresh fragment key, passcode and rotate secret instead of inheriting them.
 * @param {string|null} oldId
 */
async function mintNewIdentity(oldId) {
  const keyPair = await mintKeyPair();
  let persisted = false;
  try {
    await idbWith("readwrite", (s) => s.put(keyPair, NODE_DB_KEY));
    persisted = true;
  } catch {
    /* no IndexedDB: the new identity is real but lasts only for this page */
  }
  // Only discard the old stream's material once the new identity is actually stored. If the write
  // failed, a reload returns to the old identity, and it should find its keys intact.
  if (persisted && oldId) {
    try {
      for (const k of [`es:k:${oldId}`, `es:pc:${oldId}`, `es:rs:${oldId}`]) localStorage.removeItem(k);
    } catch {
      /* private mode — nothing was persisted to clear */
    }
  }
  const node = await finalizeNode(keyPair);
  nodePromise = Promise.resolve(node); // everyone asking from here on gets the NEW identity
  return node;
}

// ── passcode: an OPTIONAL second secret required for playback, deliberately NOT in the link.
// The broadcaster reads it to the viewer over a different channel than the link (phone, SMS, in
// person), so no single intermediary — not the broker, not the relay, not whatever carried the
// link — ever holds both halves. It is never stored on, sent to, or verified by any server. It is
// stretched into PW and mixed into the content key (see deriveMediaKey), so a wrong passcode just
// produces a wrong AES key and the GCM tag fails locally in the viewer's browser. There is nothing
// in the middle to leak, and no verifier is published anywhere.
//
// It also gives the broadcaster the revocation they otherwise lack: regenerating locks out everyone
// holding an old link, WITHOUT changing the link or burning the node identity.
const PASSCODE_CHARS = 8; // 8 × 5 bits = 40 bits — see PBKDF2_ITERATIONS for why that is enough
const PASSCODE_GROUP = 4; // rendered xxxx-xxxx, easier to read aloud

// PBKDF2 cost. This is the whole defense for a short passcode: an attacker who has the link already
// holds the fragment key and can fetch the public salts, so the passcode is their only unknown and
// they can grind it offline with no rate limiting. Unstretched, 40 bits falls in seconds. Iteration
// count multiplies THEIR cost per guess and OUR cost exactly once per session, so the budget is
// whatever the slowest device we support can spend on connect. Retune by measuring
// crypto.subtle.deriveBits on a mid-range phone, not a laptop.
const PBKDF2_ITERATIONS = 5_000_000;

/** Mint a passcode: PASSCODE_CHARS symbols from B32, grouped for reading aloud. */
function newPasscode() {
  // B32 is exactly 32 symbols and a byte has 256 values, so masking the low 5 bits is uniform —
  // no modulo bias. B32 (RFC4648) also has no 0/O or 1/l/I to misread over a phone.
  const bytes = new Uint8Array(PASSCODE_CHARS);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < PASSCODE_CHARS; i++) {
    if (i && i % PASSCODE_GROUP === 0) out += "-";
    out += B32[bytes[i] & 31];
  }
  return out;
}
/** This stream's passcode — stable across reloads until regenerated. @param {string} id */
const getOrCreatePasscode = (id) => getOrCreate(`es:pc:${id}`, newPasscode);
/**
 * Replace the stored passcode. Deliberately does NOT re-derive: a regenerated passcode takes effect
 * at the next go-live, so viewers of a broadcast in progress are not cut off mid-stream. Revoking
 * therefore means regenerate → stop → go live again.
 * @param {string} id
 */
function regeneratePasscode(id) {
  const fresh = newPasscode();
  try {
    localStorage.setItem(`es:pc:${id}`, fresh);
  } catch {
    /* private-mode: this session only */
  }
  return fresh;
}
/** Canonical KDF input. PBKDF2 is exact-match, so "K7FM-3QXR" and "k7fm3qxr" must agree. */
const normalizePasscode = (s) => s.replace(/[\s-]/g, "").toLowerCase();

/**
 * Stretch a passcode into 32 bytes of key material (PW).
 *
 * Salted with the STREAM ID rather than the rotating salts, for two reasons. First, links must not
 * break: a broadcaster shares a link, stops, and goes live again later, and streamId is stable
 * across that while the stream salt is not — anything rotating here would silently invalidate a
 * passcode on every restart. Second, cost: this way PW is computed ONCE per session and cached,
 * while the rotating salts still do their work in the cheap HKDF step. streamId is public, so
 * precomputation against one stream is possible; it is unique per broadcaster, so there is no
 * cross-stream table.
 * @param {string} passcode @param {string} streamId
 */
async function stretchPasscode(passcode, streamId) {
  const ikm = await crypto.subtle.importKey(
    "raw",
    bs(new TextEncoder().encode(normalizePasscode(passcode))),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const salt = new TextEncoder().encode(`earthseed-pc-v1|${streamId}`);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: bs(salt), iterations: PBKDF2_ITERATIONS },
    ikm,
    256
  );
  return new Uint8Array(bits);
}

/* ═══════════════════════════════ 3. CONTROL PLANE CLIENT ═══════════════════════════════ */
// Everything that is not media. Placement on a relay, the short-lived token that authorizes one
// connection, and the public salts. None of it ever sees the content key, so all of it is
// content-blind — that is unchanged and is the property the whole design rests on.
//
// WHAT CHANGED, and why. This used to call the broker (tinymoq.com) directly, carrying a `pk_`
// publishable key that shipped in the page. That worked, and it made moderation impossible: with
// the credential printed in the HTML and no server of ours in the path, there was no moment at
// which anyone could decline. A stream could be seen to exist and could not be stopped.
//
// So placement now goes through this site's own Worker, which holds a real secret, checks a
// publish code, checks the broadcast name is yours, and refuses outright for a terminated stream.
// The cost is honest and worth naming: a self-hosted copy of these files reaches its OWN origin,
// so self-hosting now means running the Worker too.
//
// Salts still go straight to the broker. They are public HKDF inputs and the rotate secret is the
// broadcaster's own; putting our Worker in that path would add a hop and protect nothing.

const BROKER = "https://tinymoq.com";
/** Same-origin by construction: whoever served this file is who we ask. */
const api = (path) => new URL(path, location.href).toString();

/** @param {string} path @param {Record<string, unknown>} body */
async function postJson(path, body) {
  try {
    const r = await fetch(api(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) {
      return { error: (d && (d.error || d.reason)) || `HTTP ${r.status}`, status: r.status, need_code: !!d?.need_code };
    }
    return d;
  } catch (e) {
    return { error: String(e) };
  }
}

// ── the publish code. A capability, not an account: it carries its own expiry under a MAC only
// the Worker can produce, so nothing about the person who requested it is written down anywhere.
// Kept per-device in localStorage; ?code= lets one be moved to a phone by QR without typing it.
const CODE_STORAGE_KEY = "es:code";

function getPublishCode() {
  const fromUrl = new URLSearchParams(location.search).get("code");
  if (fromUrl) {
    setPublishCode(fromUrl.trim());
    return fromUrl.trim();
  }
  try {
    return localStorage.getItem(CODE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}
/** @param {string} code */
function setPublishCode(code) {
  try {
    if (code) localStorage.setItem(CODE_STORAGE_KEY, code);
    else localStorage.removeItem(CODE_STORAGE_KEY);
  } catch {
    /* private mode — this session only */
  }
}

// ── proving the broadcast name is ours. The name travels in every share link, so knowing one is
// evidence of nothing. The name is also an Ed25519 public key (§2), so we settle it with the
// private half: a short-lived challenge comes back and we sign it. Nothing is registered
// anywhere; only the holder of the key that MADE the name can ever produce this signature.
const CLAIM_CONTEXT = "earthseed-claim-v1";

/** @param {string} nodeId */
async function fetchChallenge(nodeId) {
  try {
    const r = await fetch(api(`/api/broadcast/challenge?broadcast=${encodeURIComponent(nodeId)}`));
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d && typeof d.challenge === "string" ? d.challenge : null;
  } catch {
    return null;
  }
}
/** Sign the claim challenge with the node's private key. @param {{id:string, keyPair:CryptoKeyPair}} node @param {string} challenge */
async function signClaim(node, challenge) {
  const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${node.id}|${challenge}`);
  const sig = new Uint8Array(await crypto.subtle.sign(ED25519, node.keyPair.privateKey, bs(msg)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * PROOF OF LINK. A tag derived from the fragment key, registered by the broadcaster at go-live and
 * presented by every viewer who wants to be placed.
 *
 * Before this, anyone who knew a broadcast name could get a relay assignment for it. The name is
 * public — it is in every share link and is the moq track name — so that check was never a check.
 *
 * Derived with a DIFFERENT salt and a DIFFERENT info string than the content key, which makes the
 * two cryptographically independent: the server may hold every tag ever registered and still
 * decrypt nothing. The tag proves exactly one thing, that its holder was given a link.
 * @param {string} fragmentKeyB64 @param {string} nodeId
 */
async function deriveRouteTag(fragmentKeyB64, nodeId) {
  const ikm = await crypto.subtle.importKey("raw", bs(b64urlToBytes(fragmentKeyB64)), "HKDF", false, ["deriveBits"]);
  const enc = new TextEncoder();
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bs(enc.encode(`es-route|${nodeId}`)), info: bs(enc.encode("earthseed-route-auth-v1")) },
    ikm,
    256
  );
  let bin = "";
  for (const b of new Uint8Array(bits)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Assign an origin relay + publish token. @param {{id:string, keyPair:CryptoKeyPair}} node @param {string} tag @param {string} code */
async function assignPublish(node, tag, code) {
  const challenge = await fetchChallenge(node.id);
  if (!challenge) return { error: "could not get a claim challenge" };
  const sig = await signClaim(node, challenge);
  const d = await postJson("/api/broadcast/start", { broadcast: node.id, challenge, sig, tag, code });
  if (d.error) return d;
  if (!d.relay_url || !d.origin_endpoint_id) return { error: "origin assign incomplete" };
  return { relay_url: d.relay_url, origin_endpoint_id: d.origin_endpoint_id, jwt: d.jwt ?? null };
}
/** Place a viewer edge that pulls from the given origin; get the subscribe token.
 * @param {string} nodeId @param {string} originEid @param {string} tag */
async function assignWatch(nodeId, originEid, tag) {
  const d = await postJson("/api/watch/start", { broadcast: nodeId, origin: originEid, tag });
  if (d.error) return d;
  if (!d.relay_url) return { error: "edge assign incomplete" };
  return { relay_url: d.relay_url, jwt: d.jwt ?? null, ttl: d.ttl ?? null };
}
/** Tell the control plane this broadcast is over. Best-effort; nothing depends on it arriving. */
async function endBroadcast(nodeId) {
  try {
    await fetch(api("/api/broadcast/end"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broadcast: nodeId }),
      keepalive: true,
    });
  } catch {
    /* the row is superseded at the next go-live anyway */
  }
}

/**
 * Poll "should I still be showing this?" and stop when the answer is no.
 *
 * This is the COOPERATING half of termination and it is the fast one — a few seconds. It is also,
 * by construction, only as good as the client running it: a browser pointed at a patched copy of
 * this file would simply not call it. That case is covered elsewhere and differently, by the relay
 * token expiring and not being reissued, which binds whatever software the viewer is running.
 * Both halves are real; neither is sufficient alone.
 * @param {string} nodeId @param {string} tag @param {() => void} onKilled
 */
const KILL_POLL_MS = 5000;

function watchKill(nodeId, tag, onKilled) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await fetch(api(`/api/stream/${encodeURIComponent(nodeId)}/status?tag=${encodeURIComponent(tag)}`));
      // A network blip must not stop a broadcast — only an explicit "killed" does. 404 is left
      // alone for the same reason: it is also what a viewer sees before the broadcaster registers.
      if (!r.ok) return;
      const d = await r.json().catch(() => null);
      if (d?.killed) {
        stopped = true;
        onKilled();
      }
    } catch {
      /* offline: try again next tick */
    }
  };
  const timer = setInterval(tick, KILL_POLL_MS);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
// No getSalt(): viewers no longer read salts from the broker at all — the broadcaster publishes
// them on the catalog track. Only the broadcaster still calls putSalt, once per go-live, and it is
// the PUT response that tells it the current global salt and epoch.
/** @param {string} nodeId @param {string} stream @param {string} secret */
async function putSalt(nodeId, stream, secret) {
  try {
    const r = await fetch(`${BROKER}/pub/salt/${nodeId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream, secret }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return { global: d.global, stream: d.stream ?? null, epoch: d.epoch ?? 0 };
  } catch {
    return null;
  }
}
/** Append the token to the relay URL (relay_url ends in "/", so ?jwt= appends cleanly). @param {string} relayUrl @param {string|null} jwt */
const connectUrl = (relayUrl, jwt) => (jwt ? `${relayUrl}?jwt=${jwt}` : relayUrl);

/* ═══════════════════════════════ 4. MEDIA LOOP ═══════════════════════════════ */
// Native WebCodecs only: video = VP8 (self-contained keyframes, no out-of-band description),
// audio = Opus. A broadcast is a set of named moq tracks: "catalog" (cleartext JSON codec config),
// "video" (a new GROUP per keyframe), "audio" (one GROUP per Opus frame). The relay subscribes to
// the origin ONCE per track and fans out identical ciphertext to every viewer.

const VIDEO_CODEC = "vp8";
const AUDIO_CODEC = "opus";
const KEYFRAME_INTERVAL_MS = 2000;

/**
 * Go live: capture → encode → encrypt → publish. Returns a handle with stop().
 * @param {{relayUrl:string, broadcastName:string, stream:MediaStream, onStatus?:(m:string)=>void,
 *          salts?:{global:string,stream:string,epoch:number}}} opts
 */
async function startBroadcast(opts) {
  const status = opts.onStatus ?? (() => {});
  const videoTrack = opts.stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error("no video track in stream");
  const audioTrack = opts.stream.getAudioTracks()[0];
  const vsettings = videoTrack.getSettings();
  const width = vsettings.width ?? 1280;
  const height = vsettings.height ?? 720;

  const conn = await Moq.Connection.connect(new URL(opts.relayUrl));
  status("connected to relay");
  const broadcast = new Moq.Broadcast();
  conn.publish(Moq.Path.from(opts.broadcastName), broadcast);

  // The salts ride the catalog so a VIEWER never has to ask the broker for them. They are public
  // HKDF inputs (they decrypt nothing on their own), and putting them here is strictly tighter than
  // the endpoint they replace: reading them now requires a subscribe connection, where GET
  // /pub/salt/<nodeId> answered anyone holding a node id.
  /** @type {{video?:object, audio?:object, salt?:{global:string,stream:string,epoch:number}}} */
  const catalog = { salt: opts.salts };
  let running = true;

  /** @typedef {{track: any, group: any}} Sink */
  /** @type {{video:Set<Sink>, audio:Set<Sink>}} */
  const sinks = { video: new Set(), audio: new Set() };
  let forceKeyframe = true;

  // Single worker serializes encrypt→write so frame order is preserved globally.
  /** @type {Array<{track:"video"|"audio", bytes:Uint8Array, ts:number, key:boolean}>} */
  const queue = [];
  /** @type {(()=>void)|null} */ let wake = null;
  const push = (item) => {
    queue.push(item);
    wake?.();
    wake = null;
  };
  (async () => {
    while (running) {
      if (queue.length === 0) {
        await new Promise((r) => (wake = /** @type {() => void} */ (r)));
        continue;
      }
      const item = queue.shift();
      if (!item) continue;
      const enc = await encryptFrame(packFrame(item.ts, item.bytes));
      if (item.track === "video") {
        for (const sink of sinks.video) {
          if (item.key) {
            try {
              sink.group?.close();
            } catch {}
            sink.group = sink.track.appendGroup();
          }
          try {
            sink.group?.writeFrame(enc);
          } catch {}
        }
      } else {
        for (const sink of sinks.audio) {
          try {
            const g = sink.track.appendGroup();
            g.writeFrame(enc);
            g.close();
          } catch {}
        }
      }
    }
  })();

  const vEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!catalog.video) {
        const dc = meta?.decoderConfig;
        catalog.video = {
          codec: dc?.codec ?? VIDEO_CODEC,
          codedWidth: dc?.codedWidth ?? width,
          codedHeight: dc?.codedHeight ?? height,
        };
        status("● live");
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      push({ track: "video", bytes, ts: chunk.timestamp, key: chunk.type === "key" });
    },
    error: (e) => status(`video encoder error: ${e.message}`),
  });
  // NOTE: the video encoder is configured LATER (in the capture section), once we know the
  // camera's DISPLAYED dimensions/orientation. Configuring here from getSettings() would pin
  // us to the sensor's landscape coded size and letterbox/rotate portrait phone capture.

  // Audio encoder is created lazily by whichever capture path succeeds (below), so its config
  // matches the capture's real sample rate. @type {AudioEncoder|null}
  let aEncoder = null;
  /** @param {number} sampleRate @param {number} numberOfChannels */
  const makeAudioEncoder = (sampleRate, numberOfChannels) => {
    const enc = new AudioEncoder({
      output: (chunk) => {
        if (!catalog.audio) catalog.audio = { codec: AUDIO_CODEC, sampleRate, numberOfChannels };
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        push({ track: "audio", bytes, ts: chunk.timestamp, key: true });
      },
      error: (e) => status(`audio encoder error: ${e.message}`),
    });
    enc.configure({ codec: AUDIO_CODEC, sampleRate, numberOfChannels, bitrate: 64_000 });
    return enc;
  };

  // Serve the tracks the relay asks for.
  (async () => {
    for (;;) {
      const req = await broadcast.requested();
      if (!req) break;
      const track = req.track;
      if (track.name === "catalog") {
        (async () => {
          while (running && !catalog.video) await new Promise((r) => setTimeout(r, 50));
          if (catalog.video) track.writeJson(catalog);
        })();
      } else if (track.name === "video") {
        const sink = { track, group: null };
        sinks.video.add(sink);
        forceKeyframe = true;
        track.closed.then(() => sinks.video.delete(sink));
      } else if (track.name === "audio") {
        const sink = { track, group: null };
        sinks.audio.add(sink);
        track.closed.then(() => sinks.audio.delete(sink));
      }
    }
  })();

  // ── VIDEO capture (cross-browser) + orientation normalization ──
  // Pull frames from a hidden <video> playing the stream. We deliberately avoid
  // MediaStreamTrackProcessor (Chromium-only, absent on iOS/Safari); this path works on
  // Chrome/Edge AND Safari 17+/iOS 17+.
  //
  // ORIENTATION: a phone camera delivers frames in the SENSOR's fixed orientation plus a
  // "rotate this for display" flag. The <video> element honors that flag, but on iOS Safari
  // `new VideoFrame(videoElement)` does NOT — it hands back the un-rotated sensor pixels, which
  // then encode/decode straight and show up rotated 90°/180° for the viewer. Drawing the <video>
  // into a 2D canvas, by contrast, ALWAYS renders it as displayed (rotation applied) on every
  // browser. So we capture through a canvas: the encoded pixels are always upright and correctly
  // shaped, and no rotation metadata has to survive the encode→relay→decode path. Sizing to the
  // DISPLAYED dimensions (videoWidth/Height, which are post-rotation) also fixes portrait letterbox.
  const capVideo = document.createElement("video");
  capVideo.srcObject = new MediaStream([videoTrack]);
  capVideo.muted = true;
  capVideo.playsInline = true;
  // Must be attached to the DOM (not display:none) or the compositor never presents frames.
  // Keep it effectively invisible.
  capVideo.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(capVideo);
  try {
    await capVideo.play();
  } catch {
    /* autoplay of a muted stream is allowed; ignore */
  }
  // Wait for the real DISPLAYED dimensions (post-rotation) before configuring the encoder.
  await new Promise((res) => {
    if (capVideo.videoWidth && capVideo.videoHeight) return res(undefined);
    capVideo.addEventListener("loadedmetadata", () => res(undefined), { once: true });
    setTimeout(() => res(undefined), 3000);
  });

  const fps = vsettings.frameRate ?? 30;
  // Offscreen canvas we draw each displayed frame into, then wrap as a VideoFrame. Sized to the
  // displayed orientation; re-sized (and the encoder reconfigured) if the phone is rotated.
  const capCanvas = document.createElement("canvas");
  const capCtx = /** @type {CanvasRenderingContext2D} */ (capCanvas.getContext("2d"));
  let capW = 0;
  let capH = 0;
  /** @param {number} w @param {number} h */
  const configureVideo = (w, h) => {
    capW = w;
    capH = h;
    capCanvas.width = w;
    capCanvas.height = h;
    try {
      vEncoder.configure({ codec: VIDEO_CODEC, width: w, height: h, framerate: fps, bitrate: 2_000_000, latencyMode: "realtime" });
    } catch (e) {
      status(`video configure error: ${e instanceof Error ? e.message : e}`);
    }
    forceKeyframe = true; // a reconfigure must be followed by a keyframe so the decoder re-syncs
  };
  configureVideo(capVideo.videoWidth || width, capVideo.videoHeight || height);

  // Poll the video for new frames (dedup by currentTime so we don't re-encode a held frame and so
  // timestamps stay strictly increasing). A timer works everywhere — including offscreen/headless —
  // where requestVideoFrameCallback can stall. Poll a bit above the source rate.
  let lastKey = 0;
  let lastCt = -1;
  const captureTimer = setInterval(() => {
    if (!running) return;
    const ct = capVideo.currentTime;
    if (capVideo.readyState < 2 || ct === lastCt || vEncoder.encodeQueueSize > 2) return;
    lastCt = ct;
    // Orientation change (portrait⇄landscape): re-size the canvas + reconfigure the encoder. VP8
    // decoders re-sync on the next keyframe, and the viewer's canvas tracks displayWidth/Height.
    const vw = capVideo.videoWidth;
    const vh = capVideo.videoHeight;
    if (vw && vh && (vw !== capW || vh !== capH)) configureVideo(vw, vh);
    const tsMs = ct * 1000;
    try {
      capCtx.drawImage(capVideo, 0, 0, capW, capH); // renders AS DISPLAYED → upright pixels
    } catch {
      return; // nothing decodable yet
    }
    let frame = null;
    try {
      frame = new VideoFrame(capCanvas, { timestamp: Math.max(0, Math.round(tsMs * 1000)) });
    } catch {
      return;
    }
    const key = forceKeyframe || tsMs - lastKey >= KEYFRAME_INTERVAL_MS;
    if (key) {
      lastKey = tsMs;
      forceKeyframe = false;
    }
    try {
      vEncoder.encode(frame, { keyFrame: key });
    } catch {}
    frame.close();
  }, Math.max(10, Math.round(1000 / (fps * 1.5))));

  // ── AUDIO capture (best-effort) ──
  // Chromium: MediaStreamTrackProcessor. Safari/iOS: an AudioWorklet that forwards PCM. If neither
  // works, we broadcast video-only rather than failing.
  /** @type {() => void} */ let stopAudio = () => {};
  if (audioTrack) {
    (async () => {
      try {
        if (typeof MediaStreamTrackProcessor !== "undefined") {
          const a = audioTrack.getSettings();
          aEncoder = makeAudioEncoder(a.sampleRate ?? 48000, a.channelCount ?? 1);
          const reader = /** @type {any} */ (new MediaStreamTrackProcessor({ track: audioTrack })).readable.getReader();
          stopAudio = () => {
            try {
              reader.cancel();
            } catch {}
          };
          while (running) {
            const { value, done } = await reader.read();
            if (done || !value) break;
            try {
              aEncoder.encode(value);
            } catch {}
            value.close();
          }
        } else {
          // Safari/iOS: capture PCM through an AudioWorklet → AudioData → encoder (mono).
          const ac = new AudioContext();
          try {
            await ac.resume();
          } catch {}
          const sampleRate = ac.sampleRate;
          const source = ac.createMediaStreamSource(new MediaStream([audioTrack]));
          // A real file, not a blob: URL — see audio-capture-worklet.js for why. Resolved
          // against this module's own URL so it works regardless of the page's path.
          await ac.audioWorklet.addModule(new URL("./audio-capture-worklet.js", import.meta.url).href);
          const node = new AudioWorkletNode(ac, "es-cap");
          source.connect(node); // NOT connected to destination — no local echo
          aEncoder = makeAudioEncoder(sampleRate, 1);
          let tsSamples = 0;
          node.port.onmessage = (e) => {
            if (!running || !aEncoder) return;
            const block = /** @type {Float32Array} */ (e.data);
            if (!block?.length) return;
            try {
              const ad = new AudioData({
                format: "f32-planar",
                sampleRate,
                numberOfFrames: block.length,
                numberOfChannels: 1,
                timestamp: Math.round((tsSamples / sampleRate) * 1e6),
                data: /** @type {BufferSource} */ (/** @type {unknown} */ (block)),
              });
              aEncoder.encode(ad);
              ad.close();
            } catch {}
            tsSamples += block.length;
          };
          stopAudio = () => {
            try {
              source.disconnect();
              node.disconnect();
              ac.close();
            } catch {}
          };
        }
      } catch {
        status("audio unavailable — broadcasting video only");
      }
    })();
  }

  return {
    stop() {
      running = false;
      wake?.();
      try {
        clearInterval(captureTimer);
        capVideo.pause();
        capVideo.srcObject = null;
        capVideo.remove();
      } catch {}
      try {
        stopAudio();
      } catch {}
      try {
        vEncoder.close();
      } catch {}
      try {
        aEncoder?.close();
      } catch {}
      for (const set of [sinks.video, sinks.audio])
        for (const s of set)
          try {
            s.group?.close();
          } catch {}
      conn.close();
    },
  };
}

/**
 * Watch: consume → decrypt → decode → paint/play. Returns a handle with stop().
 * @param {{relayUrl:string, broadcastName:string, canvas:HTMLCanvasElement, onStatus?:(m:string)=>void,
 *          onSalts?:(s:{global:string,stream:string,epoch:number})=>Promise<void>}} opts
 */
async function startWatch(opts) {
  const status = opts.onStatus ?? (() => {});
  const ctx = opts.canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");

  const conn = await Moq.Connection.connect(new URL(opts.relayUrl));
  status("connected to relay");
  const broadcast = conn.consume(Moq.Path.from(opts.broadcastName));
  let running = true;
  let painted = false; // gate the "playing" status on a real painted frame, not just the catalog

  // Catalog first (one JSON group), then build the decoders.
  const catalogTrack = broadcast.subscribe("catalog", 1);
  status("waiting for broadcaster…");
  const catGroup = await catalogTrack.nextGroupOrdered();
  const catalog = /** @type {{video?:any, audio?:any, salt?:any}} */ (await catGroup?.readJson());
  if (!catalog?.video) throw new Error("no catalog");
  // Derive the content key from the salts the broadcaster just published, before any frame is
  // handled. Decryption already waits on keyReady, so ordering here is a formality rather than a
  // race — but doing it first keeps "no plaintext without a key" obvious.
  if (catalog.salt) await opts.onSalts?.(catalog.salt);

  // Replaceable on purpose: WebCodecs CLOSES a decoder permanently on any error, and every later
  // decode() then throws "VideoDecoder is not configured" — so one bad chunk means video is dead for
  // the session unless we rebuild. Safari/iOS is far stricter than Chromium about what counts as bad.
  /** @type {VideoDecoder} */ let vDecoder;
  const makeVideoDecoder = () => {
    vDecoder = new VideoDecoder({
      output: (frame) => {
        if (opts.canvas.width !== frame.displayWidth) opts.canvas.width = frame.displayWidth;
        if (opts.canvas.height !== frame.displayHeight) opts.canvas.height = frame.displayHeight;
        ctx.drawImage(frame, 0, 0);
        frame.close();
        if (!painted) {
          painted = true;
          status("▶ playing");
        }
      },
      error: (e) => status(`video decoder error: ${e.message}`),
    });
    try {
      vDecoder.configure({
        codec: catalog.video.codec,
        codedWidth: catalog.video.codedWidth,
        codedHeight: catalog.video.codedHeight,
      });
    } catch (e) {
      status(`video configure error: ${e instanceof Error ? e.message : e}`);
    }
  };
  makeVideoDecoder();
  status("connected — waiting for video…");

  const videoTrack = broadcast.subscribe("video", 2);
  (async () => {
    while (running) {
      const group = await videoTrack.nextGroupOrdered();
      if (!group) break;
      // Every group opens with a keyframe, and `first` labels it. It advances ONLY on a successful
      // decode, so if the keyframe is lost — a wrong key while a viewer is still typing a passcode,
      // most obviously — the next delta would inherit the "key" label. Feeding a delta as a keyframe
      // is exactly what kills the decoder on iOS. Abandon the group instead: without its keyframe
      // nothing in it is decodable anyway, and the next group brings a fresh one.
      let first = true;
      let lost = false;
      for (;;) {
        const raw = await group.readFrame();
        if (!raw) break;
        if (lost) continue; // drain the group so the transport can advance
        try {
          const { tsMicros, payload } = unpackFrame(await decryptFrame(raw));
          if (first && vDecoder.state !== "configured") makeVideoDecoder(); // a keyframe is the only safe place to resync
          if (vDecoder.state !== "configured") {
            lost = true; // closed mid-group — wait for the next keyframe to rebuild
            continue;
          }
          vDecoder.decode(new EncodedVideoChunk({ type: first ? "key" : "delta", timestamp: tsMicros, data: payload }));
          first = false;
        } catch (e) {
          if (first) lost = true;
          status(`video frame dropped: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  })();

  // Audio (optional): decode Opus, schedule playback on an AudioContext timeline.
  /** @type {AudioContext|null} */ let audioCtx = null;
  if (catalog.audio) {
    audioCtx = new AudioContext({ sampleRate: catalog.audio.sampleRate });
    let playHead = 0;
    const aDecoder = new AudioDecoder({
      output: (data) => {
        const ac = /** @type {AudioContext} */ (audioCtx);
        const buf = ac.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
        for (let c = 0; c < data.numberOfChannels; c++) {
          const arr = new Float32Array(data.numberOfFrames);
          data.copyTo(arr, { planeIndex: c, format: "f32-planar" });
          buf.copyToChannel(arr, c);
        }
        data.close();
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(ac.destination);
        // Keep a small, BOUNDED buffer so audio stays near-live. Re-sync to a ~80ms cushion on
        // BOTH underrun (playHead behind now) AND overrun (playHead too far ahead) — the latter is
        // what fixes accumulating latency when frames arrive in bursts or the source runs fast.
        const now = ac.currentTime;
        const TARGET = 0.08; // ~80ms cushion
        const MAX_AHEAD = 0.25; // never let scheduled audio drift more than 250ms ahead
        if (playHead < now + 0.02 || playHead - now > MAX_AHEAD) playHead = now + TARGET;
        src.start(playHead);
        playHead += buf.duration;
      },
      error: (e) => status(`audio decoder error: ${e.message}`),
    });
    aDecoder.configure({
      codec: catalog.audio.codec,
      sampleRate: catalog.audio.sampleRate,
      numberOfChannels: catalog.audio.numberOfChannels,
    });
    // Autoplay policy: an AudioContext often starts suspended until a user gesture.
    document.addEventListener("click", (/** @type {Event} */ _e) => void audioCtx?.resume(), { once: true });

    const audioTrack = broadcast.subscribe("audio", 3);
    (async () => {
      while (running) {
        const group = await audioTrack.nextGroupOrdered();
        if (!group) break;
        for (;;) {
          const raw = await group.readFrame();
          if (!raw) break;
          try {
            const { tsMicros, payload } = unpackFrame(await decryptFrame(raw));
            aDecoder.decode(new EncodedAudioChunk({ type: "key", timestamp: tsMicros, data: payload }));
          } catch {
            /* one bad audio frame — keep going */
          }
        }
      }
    })();
  }

  return {
    stop() {
      running = false;
      try {
        vDecoder.close();
      } catch {}
      try {
        audioCtx?.close();
      } catch {}
      conn.close();
    },
  };
}

/* ═══════════════════════════════ 5. PAGE CONTROLLERS ═══════════════════════════════ */
// One path: node identity → broker-gated relay + token (proving the name is ours) → per-stream
// salt → content key. See §1 for why the unauthorized second path was removed.

/** @param {string} id */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

/** Wire the broadcast page (#preview #go #share #copy #status + the passcode controls). */
export async function runBroadcast() {
  const set = (m) => ($("status").textContent = m);
  const reason = unsupportedReason(true);
  if (reason) return set(reason);

  const preview = $("preview");
  const goBtn = $("go");
  /** @type {{stop():void}|null} */ let bc = null;

  // ── passcode controls.
  const pcToggle = $("usepc"), pcRow = $("pcrow"), pcField = $("passcode"),
    regenBtn = $("regen"), pcHint = $("pchint");
  const PC_PREF = "es:pc-on"; // remember the broadcaster's choice across sessions
  /** @type {string|null} */ let nodeId = null;

  /** Reflect the toggle: show the passcode when on, and remember the choice. */
  const syncPcUi = async () => {
    const on = !!pcToggle?.checked;
    if (pcRow) pcRow.hidden = !on;
    if (pcHint) pcHint.hidden = !on;
    try {
      localStorage.setItem(PC_PREF, on ? "1" : "0");
    } catch {
      /* private mode — the toggle just won't persist */
    }
    if (!on || !pcField || pcField.value) return;
    // Identity is minted lazily, here and at go-live, so merely opening this page doesn't create one.
    if (!nodeId) nodeId = (await getOrCreateNode()).id;
    pcField.value = getOrCreatePasscode(nodeId);
  };
  pcToggle?.addEventListener("change", syncPcUi);

  const newLinkBtn = $("newlink");
  newLinkBtn?.addEventListener("click", async () => {
    // Same rule as the passcode: not applied mid-broadcast, so nobody watching is cut off and we
    // never display a link that isn't the working one.
    if (bc || !newLinkBtn) return;
    newLinkBtn.disabled = true;
    try {
      if (!nodeId) nodeId = (await getOrCreateNode()).id;
      regenerateFragmentKey(nodeId);
      $("share").value = ""; // the old link is dead; don't leave it sitting there looking valid
      set("new link minted — go live to get it. Every link you shared before now is dead.");
    } finally {
      newLinkBtn.disabled = false;
    }
  });

  const newIdBtn = $("newid");
  newIdBtn?.addEventListener("click", async () => {
    if (bc || !newIdBtn) return;
    // The only control here that is both irreversible and total, so it is the only one that asks.
    if (
      !confirm(
        "Mint a new ID?\n\n" +
          "Every link you have already shared stops working — not just for watching, but for " +
          "seeing when you go live.\n\n" +
          "This cannot be undone. Anyone who should still have access will need the new link."
      )
    )
      return;
    newIdBtn.disabled = true;
    try {
      nodeId = (await mintNewIdentity(nodeId)).id;
      $("share").value = ""; // the old link is dead in every sense; don't leave it looking valid
      if (pcField) pcField.value = ""; // the old passcode belonged to the old identity
      await syncPcUi(); // mints a fresh one if the toggle is on
      set("new ID minted — go live to get your new link. Everything you shared before now is dead.");
    } finally {
      newIdBtn.disabled = false;
    }
  });

  regenBtn?.addEventListener("click", () => {
    // Guarded rather than live-applied: the content key is NOT re-derived mid-broadcast, so showing
    // a new passcode while the old one is still the working one would hand out a code that fails.
    if (bc || !nodeId || !pcField) return;
    pcField.value = regeneratePasscode(nodeId);
    set("new passcode — it takes effect the next time you go live");
  });

  // ── the publish key. Broadcasting needs one; watching never does. It is a capability with an
  // expiry baked in under a MAC, not an account — nothing about who asked for it is recorded, here
  // or on the server. The row stays hidden until it is actually needed, so a broadcaster who
  // already has one never sees it.
  const keyRow = $("keyrow"), keyField = $("pubkey"), keySave = $("keysave"), keyHint = $("keyhint");
  const showKeyPrompt = (message) => {
    if (keyRow) keyRow.hidden = false;
    if (keyHint) keyHint.hidden = false;
    if (keyField) {
      keyField.value = getPublishCode();
      keyField.focus();
    }
    set(message);
  };
  keySave?.addEventListener("click", () => {
    const typed = keyField?.value.trim() ?? "";
    if (!typed) return;
    setPublishCode(typed);
    set("publish key saved — press “Go live”");
  });

  /** @type {(() => void)|null} */ let stopKillWatch = null;
  const teardown = (message) => {
    stopKillWatch?.();
    stopKillWatch = null;
    bc?.stop();
    bc = null;
    goBtn.textContent = "Go live";
    if (pcToggle) pcToggle.disabled = false;
    if (regenBtn) regenBtn.disabled = false;
    if (newLinkBtn) newLinkBtn.disabled = false;
    if (newIdBtn) newIdBtn.disabled = false;
    set(message);
  };

  goBtn.addEventListener("click", async () => {
    if (bc) {
      const id = nodeId;
      teardown("stopped");
      if (id) void endBroadcast(id);
      return;
    }
    goBtn.disabled = true;
    try {
      const code = getPublishCode();
      if (!code) {
        // Asked for before the camera, not after. Prompting once the preview is already running
        // would leave someone looking at their own face believing they were live.
        return showKeyPrompt("A publish key is required to broadcast — paste one below, or request one.");
      }

      const node = await getOrCreateNode();
      nodeId = node.id;
      const fragmentKey = getOrCreateFragmentKey(node.id);

      // Stretch ONCE here, then hand the bytes to every deriveMediaKey call (including rotations).
      /** @type {Uint8Array|null} */ let pw = null;
      if (pcToggle?.checked) {
        const passcode = getOrCreatePasscode(node.id);
        if (pcField) pcField.value = passcode;
        set("preparing passcode…");
        pw = await stretchPasscode(passcode, node.id);
      }
      armKey();

      set("assigning a relay…");
      // The tag is registered here so every viewer can be checked against it. Derived from the
      // fragment key, which never leaves this browser — the tag does, and cannot be walked back.
      const routeTag = await deriveRouteTag(fragmentKey, node.id);
      const pub = await assignPublish(node, routeTag, code); // signs a challenge to prove the name is ours
      if (pub.error) {
        // A refused key is not an error to shrug at — it is the one failure the broadcaster can
        // actually fix, so it gets the prompt rather than a status line they cannot act on.
        if (pub.need_code) return showKeyPrompt(pub.error);
        return set(`could not go live: ${pub.error}`);
      }
      const salt = await putSalt(node.id, newStreamSalt(), getOrCreateRotateSecret(node.id));
      if (!salt?.stream) return set("could not set the stream salt");
      await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: salt.global, streamSaltB64: salt.stream, streamId: node.id, epoch: salt.epoch, pw });
      const relay = connectUrl(pub.relay_url, pub.jwt);
      const originEid = pub.origin_endpoint_id;

      set("starting camera…");
      // `ideal` (not exact) lets a phone hand us its natural orientation (portrait or landscape)
      // instead of being forced into a landscape 1280×720 buffer.
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
      preview.srcObject = stream;

      set("connecting…");
      bc = await startBroadcast({ relayUrl: relay, broadcastName: node.id, stream, onStatus: set, salts: salt });

      const link = new URL("watch.html", location.href);
      link.searchParams.set("node", node.id);
      if (originEid) link.searchParams.set("o", originEid);
      link.hash = `k=${fragmentKey}`;
      $("share").value = link.toString();
      goBtn.textContent = "Stop";
      if (keyRow) keyRow.hidden = true;
      if (keyHint) keyHint.hidden = true;
      // Locked while live: the key is fixed for this broadcast, so none of these can take effect now.
      if (pcToggle) pcToggle.disabled = true;
      if (regenBtn) regenBtn.disabled = true;
      if (newLinkBtn) newLinkBtn.disabled = true;
      if (newIdBtn) newIdBtn.disabled = true;

      // The broadcaster is told too, rather than left transmitting into a relay that has stopped
      // accepting viewers. Being cut off silently is worse than being cut off.
      stopKillWatch = watchKill(node.id, routeTag, () => {
        const id = nodeId;
        teardown("This broadcast was terminated by the operator.");
        if (id) void endBroadcast(id);
      });
    } catch (e) {
      set(`error: ${e instanceof Error ? e.message : e}`);
    } finally {
      goBtn.disabled = false;
    }
  });

  /** @param {string} btnId @param {() => string} value @param {string} label */
  const wireCopy = (btnId, value, label) =>
    $(btnId)?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(value());
        $(btnId).textContent = "Copied!";
        setTimeout(() => ($(btnId).textContent = label), 1500);
      } catch {
        /* clipboard blocked — the value is visible in the field */
      }
    });
  wireCopy("copy", () => $("share").value, "Copy viewer link");
  wireCopy("copypc", () => $("passcode").value, "Copy");

  try {
    if (pcToggle) pcToggle.checked = localStorage.getItem(PC_PREF) === "1";
  } catch {
    /* private mode — default off */
  }
  await syncPcUi(); // restores the passcode into the field if the toggle was left on

  set("ready — press “Go live”");
}

// How many consecutive AES-GCM tag failures before we conclude the key is wrong rather than the
// stream being briefly odd. With a correct key decryption never fails, so this only needs to be
// high enough to not fire on a single corrupt frame; video alone delivers ~30/s, so it is quick.
const PASSCODE_PROMPT_AFTER = 5;

/**
 * Turn a run of tag failures into a passcode prompt, and a submitted passcode into a re-derived key.
 *
 * This is the entirety of "checking" a passcode. Nothing is sent anywhere and nothing is compared
 * against a stored copy: the viewer's browser rebuilds the content key from what was typed, and the
 * GCM tag either validates or it does not. That is why no system in the middle can leak, approve, or
 * be tricked about a passcode — none of them is ever told one.
 * @param {{node:string, fragmentKey:string, getSalts:() => ({global:string,stream:string,epoch:number}|null),
 *          setPw:(v:Uint8Array|null) => void, hasPw:() => boolean,
 *          lock:(m:string) => void, unlock:(m:string) => void}} p
 */
function wirePasscodePrompt(p) {
  const row = $("pcrow"), field = $("passcode"), btn = $("pcgo");
  if (!row || !field || !btn) return;
  let asking = false;

  const ask = () => {
    if (asking) return;
    asking = true;
    row.hidden = false;
    // Same signal, read at two moments: before any passcode was tried, and after one was. The
    // wording hedges on purpose — a failed tag means "wrong key", and this page cannot tell a
    // missing passcode from a link the broadcaster has since replaced. Claiming "wrong passcode"
    // outright would send someone chasing a passcode when what they need is a new link.
    p.lock(
      p.hasPw()
        ? "that didn’t unlock it — the passcode may be wrong, or this link may be out of date"
        : "this link may be out of date, or this stream needs a passcode"
    );
    field.focus();
    field.select();
  };

  const submit = async () => {
    const typed = field.value.trim();
    const salts = p.getSalts();
    if (!typed || !salts) return;
    btn.disabled = true;
    p.lock("checking passcode…");
    try {
      const pw = await stretchPasscode(typed, p.node); // the deliberately slow step
      p.setPw(pw);
      resetDecryptFailures(); // fresh run: if this key is wrong too, ask() fires again
      asking = false;
      await deriveMediaKey({ fragmentKeyB64: p.fragmentKey, globalSaltB64: salts.global, streamSaltB64: salts.stream, streamId: p.node, epoch: salts.epoch, pw });
      p.lock("unlocking…"); // the next frame decides; onDecryptStatus reports either way
    } catch (e) {
      p.lock(`passcode error: ${e instanceof Error ? e.message : e}`);
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener("click", submit);
  field.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Enter") submit();
  });

  onDecryptStatus = (consecutive) => {
    if (consecutive === 0) {
      row.hidden = true; // a frame decrypted — the key in hand is right
      asking = false;
      p.unlock("▶ playing");
      return;
    }
    if (consecutive >= PASSCODE_PROMPT_AFTER) ask();
  };
}

/**
 * The report control, built here rather than in watch.html.
 *
 * Every node is created and filled with textContent — no innerHTML anywhere. That is not style:
 * the CSP sets `require-trusted-types-for 'script'`, so an innerHTML assignment THROWS on Chromium
 * rather than degrading, and the property that makes an open connect-src safe (no injection sinks
 * in this client) is one this code has to keep true.
 *
 * What is sent: the stream id and a category. Not the link, not the key, not who is reporting.
 * The id alone is enough for the only action available to an operator, which is to stop the
 * stream — they still cannot watch it, and filing this does not let them.
 * @param {string} nodeId
 */
function mountReportControl(nodeId) {
  const wrap = document.querySelector(".wrap");
  if (!wrap) return;

  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

  const open = el("button", { textContent: "Report this stream", className: "linkish", type: "button" });
  const row = el("div", { className: "row report-open" });
  row.appendChild(open);
  wrap.appendChild(row);

  const panel = el("div", { className: "report-panel", hidden: true });
  panel.appendChild(el("div", { className: "report-title", textContent: "Report this stream" }));
  panel.appendChild(
    el("div", {
      className: "hint",
      textContent:
        "This goes to the operator, who can stop the stream. They cannot see it — nobody can " +
        "decrypt an Earthseed stream without the link you were given, and the passcode if there is one.",
    })
  );

  const select = el("select", { id: "reportcat" });
  for (const [value, label] of [
    ["sexual-content-involving-minors", "Sexual content involving a minor"],
    ["violence-or-threats", "Violence or threats"],
    ["non-consensual-content", "Non-consensual content"],
    ["harassment", "Harassment"],
    ["other", "Something else"],
  ]) {
    select.appendChild(el("option", { value, textContent: label }));
  }
  panel.appendChild(el("div", { className: "row" })).appendChild(select);

  const note = el("textarea", {
    id: "reportnote",
    rows: 3,
    maxLength: 500,
    placeholder: "Anything else the operator should know (optional)",
  });
  panel.appendChild(el("div", { className: "row" })).appendChild(note);

  const send = el("button", { textContent: "Send report", type: "button" });
  const cancel = el("button", { textContent: "Cancel", type: "button", className: "linkish" });
  const actions = el("div", { className: "row" });
  actions.append(send, cancel);
  panel.appendChild(actions);

  const result = el("div", { className: "hint" });
  panel.appendChild(result);
  wrap.appendChild(panel);

  open.addEventListener("click", () => {
    panel.hidden = false;
    row.hidden = true;
  });
  cancel.addEventListener("click", () => {
    panel.hidden = true;
    row.hidden = false;
  });
  send.addEventListener("click", async () => {
    send.disabled = true;
    result.textContent = "sending…";
    try {
      const r = await fetch(api("/api/report"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream_id: nodeId, category: select.value, note: note.value.slice(0, 500) }),
      });
      // 202 means "recorded elsewhere or rate-limited" and is deliberately indistinguishable to
      // the reporter: telling someone their report was throttled invites them to work around it.
      result.textContent = r.ok
        ? "Thank you — this has been sent to the operator."
        : "That did not send. Please try again.";
      if (r.ok) {
        send.hidden = true;
        cancel.textContent = "Close";
      }
    } catch {
      result.textContent = "That did not send. Please try again.";
    } finally {
      send.disabled = false;
    }
  });
}

/** Wire the watch page (#video #status + the passcode prompt). */
export async function runWatch() {
  // The status line has two writers — this controller and the media loop, which reports every
  // dropped frame. While we are asking for a passcode the media loop is dropping EVERY frame, so
  // lock the line or the prompt is instantly overwritten by the noise it caused.
  let statusLocked = false;
  const setForced = (m) => ($("status").textContent = m);
  const set = (m) => {
    if (!statusLocked) setForced(m);
  };
  const reason = unsupportedReason(false);
  if (reason) return set(reason);

  const params = new URLSearchParams(location.search);
  const node = (params.get("node") || "").trim();
  const originEid = params.get("o");
  const fragmentKey = fragmentKeyFromHash();
  if (!node || !fragmentKey) return set("this link is missing its stream id or #k= key");

  // The stretched passcode, once (and if) the viewer supplies one. Held here so the rotation poller
  // re-derives WITH it rather than silently dropping back to the no-passcode key.
  /** @type {Uint8Array|null} */ let pw = null;
  /** @type {{global:string, stream:string, epoch:number}|null} */ let salts = null;

  armKey();

  /**
   * Install the content key from the salts the broadcaster published in-band. Nothing tells us up
   * front whether this stream needs a passcode — asking would mean the broker knowing which
   * streams are protected — so we derive without one and let the GCM tag answer.
   * @param {{global:string, stream:string, epoch:number}} s
   */
  const onSalts = async (s) => {
    if (s.epoch === currentEpoch()) return; // already holding this key
    salts = s;
    await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: s.global, streamSaltB64: s.stream, streamId: node, epoch: s.epoch, pw });
  };

  // A viewer's ENTIRE conversation with the broker is this one placement request. The salts arrive
  // on the broadcaster's catalog track, so there is no salt fetch and no rotation poll — an earlier
  // version polled GET /pub/salt every 5s for the life of the tab, uncancelled, which handed the
  // broker a per-viewer attendance record at 5-second resolution and outlived the broadcast itself.
  // It was watching for an epoch change that only ever happens at go-live, before any viewer of
  // that session has connected.
  //
  // Retried rather than failed, because a viewer who opens the link early is the normal case: the
  // broker cannot place an edge for a broadcast that has not started.
  set("waiting for broadcaster…");
  // Proof of link. Derived from the #k= fragment we were given, so it can only be produced by
  // someone holding the whole link — which is the point: the broadcast name alone is public.
  const routeTag = await deriveRouteTag(fragmentKey, node);
  let edge = await assignWatch(node, originEid || "", routeTag);
  for (let i = 0; i < 20 && edge.error; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    edge = await assignWatch(node, originEid || "", routeTag);
  }
  if (edge.error) return set("stream is not live");
  const relay = connectUrl(edge.relay_url, edge.jwt);

  // Reporting is offered only to someone who actually got placed, because only they can have seen
  // anything. Mounted before playback starts so it is there the moment it might be wanted.
  mountReportControl(node);

  /** @type {{stop():void}|null} */ let player = null;
  const stopKillWatch = watchKill(node, routeTag, () => {
    try {
      player?.stop();
    } catch {
      /* already gone */
    }
    statusLocked = true;
    setForced("This stream was terminated by the operator.");
    const canvas = $("video");
    // Blank the canvas. The last painted frame would otherwise sit there indefinitely, which
    // reads as "still watching" for precisely the content someone asked to have stopped.
    const c = canvas?.getContext?.("2d");
    if (c && canvas) c.clearRect(0, 0, canvas.width, canvas.height);
  });
  addEventListener("pagehide", () => stopKillWatch(), { once: true });

  wirePasscodePrompt({
    node,
    fragmentKey,
    getSalts: () => salts,
    setPw: (v) => (pw = v),
    hasPw: () => !!pw,
    lock: (m) => {
      statusLocked = true;
      setForced(m);
    },
    unlock: (m) => {
      statusLocked = false;
      setForced(m);
    },
  });

  set("connecting…");
  try {
    player = await startWatch({ relayUrl: relay, broadcastName: node, canvas: $("video"), onStatus: set, onSalts });
  } catch (e) {
    set(`watch error: ${e instanceof Error ? e.message : e}`);
  }
}
