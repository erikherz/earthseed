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
// forwards opaque, already-encrypted MoQ objects it can't read and never holds the key. That is
// exactly why the security works over ANY relay — Cloudflare's, our fleet's, or a hostile one: the
// relay is not part of the encryption, it's a dumb pipe. @moq/net negotiates the wire dialect at
// session setup (moq-lite, a forwards-compatible subset of IETF moq-transport), so it interoperates
// with any moq-transport relay/CDN.
//
// DEFAULT_RELAY is used ONLY in "open-relay mode" (?relay= or window.ES_RELAY): the zero-backend
// path where broadcaster and viewer share one public relay directly, no broker. It points at
// Cloudflare's public MoQ endpoint; "draft-14" is version-matched to the pinned @moq/net@0.1.5 —
// NOT stale (a newer draft-NN host would negotiate a protocol version this client doesn't speak).
// Broadcaster and viewer must use the SAME relay. Broker mode (the default) ignores this and uses
// the gated relay the broker assigns.
const DEFAULT_RELAY = "https://draft-14.cloudflare.mediaoverquic.com/";

/** The relay this page should use: ?relay= param → window.ES_RELAY → the default. */
function relayChoice() {
  const param = new URLSearchParams(location.search).get("relay");
  return (param && param.trim()) || window.ES_RELAY || DEFAULT_RELAY;
}

/** The relay connect URL as https://host/ (default port stripped). */
function relayUrl() {
  const u = new URL(relayChoice());
  if (u.port === "443") u.port = "";
  return `${u.origin}/`;
}

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
/** Clear the failure run — call when a viewer submits a new passcode, so the next run is fresh. */
function resetDecryptFailures() {
  decryptFailures = 0;
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
  if (decryptFailures) {
    decryptFailures = 0;
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
const NODE_STORAGE_KEY = "es:node";
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
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { id: base32(raw), keyPair, raw };
}
async function mintKeyPair() {
  return /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"]));
}
/** @param {JsonWebKey} jwk */
async function importFromJwk(jwk) {
  const privateKey = await crypto.subtle.importKey("jwk", jwk, ED25519, true, ["sign"]);
  const publicKey = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, ED25519, true, [
    "verify",
  ]);
  return /** @type {CryptoKeyPair} */ ({ privateKey, publicKey });
}
/** @param {CryptoKeyPair} keyPair */
async function persistNode(keyPair) {
  try {
    localStorage.setItem(NODE_STORAGE_KEY, JSON.stringify(await crypto.subtle.exportKey("jwk", keyPair.privateKey)));
  } catch {
    /* private-mode: identity stays ephemeral this session */
  }
}
/** The broadcaster's persistent node identity — loaded from localStorage or minted + saved. */
async function getOrCreateNode() {
  try {
    const stored = localStorage.getItem(NODE_STORAGE_KEY);
    if (stored) return await finalizeNode(await importFromJwk(JSON.parse(stored)));
  } catch {
    /* corrupt — mint fresh */
  }
  const keyPair = await mintKeyPair();
  await persistNode(keyPair);
  return finalizeNode(keyPair);
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

/* ═══════════════════════════════ 3. BROKER CLIENT ═══════════════════════════════ */
// The only network call besides the media relay. It gates the *connection* (a short-lived,
// per-broadcast token) and serves the public *salts*; it never sees the content key, so it is
// content-blind. The publishable key (pk_) is PUBLIC by design — it identifies a tenant for
// quota/rate-limit/revoke, can mint tokens, but can never decode media.

const BROKER = "https://tinymoq.com";

function pubKey() {
  const fromUrl = new URLSearchParams(location.search).get("key");
  if (fromUrl && fromUrl.startsWith("pk_")) return fromUrl.trim();
  const meta = document.querySelector('meta[name="earthseed-key"]')?.getAttribute("content")?.trim();
  return meta && meta.startsWith("pk_") ? meta : "pk_Am-UpPEuGCt5dsnR8xqzOFX2mEYDSCeMGrDWxXli4LU";
}
/** @param {Record<string, unknown>} body */
async function brokerAssign(body) {
  try {
    const r = await fetch(`${BROKER}/cdn/assign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pubKey()}` },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) return { error: (d && (d.error || d.reason)) || `HTTP ${r.status}` };
    return d;
  } catch (e) {
    return { error: String(e) };
  }
}
// ── proving the broadcast name is ours. The publishable key above is PUBLIC, so on
// its own it would let anyone ask the broker for a publish token on anyone's
// broadcast — the name travels in every share link. The name is also an Ed25519
// public key (§2), so we settle it with the private half: the broker hands out a
// short-lived challenge and we sign it. Nothing is registered anywhere; only the
// holder of the key that MADE the name can ever produce this signature.
const CLAIM_CONTEXT = "earthseed-claim-v1";

/** @param {string} nodeId */
async function fetchChallenge(nodeId) {
  const r = await fetch(`${BROKER}/cdn/challenge?broadcast=${encodeURIComponent(nodeId)}`);
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return d && typeof d.challenge === "string" ? d.challenge : null;
}
/** Sign the broker's challenge with the node's private key. @param {{id:string, keyPair:CryptoKeyPair}} node @param {string} challenge */
async function signClaim(node, challenge) {
  const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${node.id}|${challenge}`);
  const sig = new Uint8Array(await crypto.subtle.sign(ED25519, node.keyPair.privateKey, bs(msg)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Assign an origin relay + publish token for this broadcaster. @param {{id:string, keyPair:CryptoKeyPair}} node */
async function assignPublish(node) {
  const challenge = await fetchChallenge(node.id);
  if (!challenge) return { error: "could not get a claim challenge from the broker" };
  const sig = await signClaim(node, challenge);
  const d = await brokerAssign({ broadcast: node.id, role: "publish", challenge, sig });
  if (d.error) return d;
  if (!d.relay || !d.origin_endpoint_id) return { error: "origin assign incomplete" };
  return { relay_url: `https://${d.relay}/`, origin_endpoint_id: d.origin_endpoint_id, jwt: d.jwt ?? null };
}
/** Place a viewer edge that pulls from the given origin; mint the subscribe token. @param {string} nodeId @param {string} originEid */
async function assignWatch(nodeId, originEid) {
  const d = await brokerAssign({ broadcast: nodeId, role: "watch", origin: originEid, xport: "iroh" });
  if (d.error) return d;
  if (!d.relay) return { error: "edge assign incomplete" };
  return { relay_url: `https://${d.relay}/`, jwt: d.jwt ?? null };
}
/** @param {string} nodeId */
async function getSalt(nodeId) {
  try {
    const r = await fetch(`${BROKER}/pub/salt/${nodeId}`);
    if (!r.ok) return null;
    const d = await r.json();
    return { global: d.global, stream: d.stream ?? null, epoch: d.epoch ?? 0 };
  } catch {
    return null;
  }
}
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
 * @param {{relayUrl:string, broadcastName:string, stream:MediaStream, onStatus?:(m:string)=>void}} opts
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

  /** @type {{video?:object, audio?:object}} */
  const catalog = {};
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
          const code =
            "class Cap extends AudioWorkletProcessor{process(i){const c=i[0];if(c&&c[0])this.port.postMessage(c[0].slice(0));return true}}registerProcessor('es-cap',Cap)";
          const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
          await ac.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
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
 * @param {{relayUrl:string, broadcastName:string, canvas:HTMLCanvasElement, onStatus?:(m:string)=>void}} opts
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
  const catalog = /** @type {{video?:any, audio?:any}} */ (await catGroup?.readJson());
  if (!catalog?.video) throw new Error("no catalog");

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
// Two modes, chosen by the presence of ?relay= :
//   • Broker mode (default): identity + broker-gated relay/token + per-stream salt.
//   • Open-relay mode (?relay=<url>): no broker; any open MoQ relay; fixed dev salts. Still E2E.

// Fixed salts for open-relay mode ONLY. (Broker mode uses per-stream salts from the broker.)
const DEV_GLOBAL_SALT = "c3Bpa2UtZ2xvYmFs"; // "spike-global"
const DEV_STREAM_SALT = "c3Bpa2Utc3RyZWFt"; // "spike-stream"

/** @param {string} id */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

/** Wire the broadcast page (#preview #go #share #copy #status + the passcode controls). */
export async function runBroadcast() {
  const set = (m) => ($("status").textContent = m);
  const reason = unsupportedReason(true);
  if (reason) return set(reason);

  const openRelay = new URLSearchParams(location.search).has("relay");
  const preview = $("preview");
  const goBtn = $("go");
  /** @type {{stop():void}|null} */ let bc = null;

  // ── passcode controls. Broker mode only: open-relay mode is the zero-backend dev path with fixed
  // salts, so there is no per-stream secret to layer a passcode onto.
  const pcWrap = $("pcwrap"), pcToggle = $("usepc"), pcRow = $("pcrow"), pcField = $("passcode"),
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

  regenBtn?.addEventListener("click", () => {
    // Guarded rather than live-applied: the content key is NOT re-derived mid-broadcast, so showing
    // a new passcode while the old one is still the working one would hand out a code that fails.
    if (bc || !nodeId || !pcField) return;
    pcField.value = regeneratePasscode(nodeId);
    set("new passcode — it takes effect the next time you go live");
  });

  goBtn.addEventListener("click", async () => {
    if (bc) {
      bc.stop();
      bc = null;
      goBtn.textContent = "Go live";
      if (pcToggle) pcToggle.disabled = false;
      if (regenBtn) regenBtn.disabled = false;
      if (newLinkBtn) newLinkBtn.disabled = false;
      set("stopped");
      return;
    }
    goBtn.disabled = true;
    try {
      const node = await getOrCreateNode();
      nodeId = node.id;
      const fragmentKey = getOrCreateFragmentKey(node.id);

      // Stretch ONCE here, then hand the bytes to every deriveMediaKey call (including rotations).
      /** @type {Uint8Array|null} */ let pw = null;
      if (!openRelay && pcToggle?.checked) {
        const passcode = getOrCreatePasscode(node.id);
        if (pcField) pcField.value = passcode;
        set("preparing passcode…");
        pw = await stretchPasscode(passcode, node.id);
      }
      armKey();

      let relay, originEid = null;
      if (openRelay) {
        await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: DEV_GLOBAL_SALT, streamSaltB64: DEV_STREAM_SALT, streamId: node.id, epoch: 0 });
        relay = relayUrl();
      } else {
        set("assigning a relay…");
        const pub = await assignPublish(node); // signs a broker challenge to prove the name is ours
        if (pub.error) return set(`broker error: ${pub.error}`);
        const salt = await putSalt(node.id, newStreamSalt(), getOrCreateRotateSecret(node.id));
        if (!salt?.stream) return set("could not set the stream salt");
        await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: salt.global, streamSaltB64: salt.stream, streamId: node.id, epoch: salt.epoch, pw });
        relay = connectUrl(pub.relay_url, pub.jwt);
        originEid = pub.origin_endpoint_id;
      }

      set("starting camera…");
      // `ideal` (not exact) lets a phone hand us its natural orientation (portrait or landscape)
      // instead of being forced into a landscape 1280×720 buffer.
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
      preview.srcObject = stream;

      set("connecting…");
      bc = await startBroadcast({ relayUrl: relay, broadcastName: node.id, stream, onStatus: set });

      const link = new URL("watch.html", location.href);
      link.searchParams.set("node", node.id);
      if (openRelay) link.searchParams.set("relay", relayChoice());
      if (originEid) link.searchParams.set("o", originEid);
      link.hash = `k=${fragmentKey}`;
      $("share").value = link.toString();
      goBtn.textContent = "Stop";
      // Locked while live: the key is fixed for this broadcast, so none of these can take effect now.
      if (pcToggle) pcToggle.disabled = true;
      if (regenBtn) regenBtn.disabled = true;
      if (newLinkBtn) newLinkBtn.disabled = true;
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

  // Open-relay mode has no broker-issued per-stream salt, so no passcode either.
  if (openRelay) {
    if (pcWrap) pcWrap.hidden = true;
  } else {
    try {
      if (pcToggle) pcToggle.checked = localStorage.getItem(PC_PREF) === "1";
    } catch {
      /* private mode — default off */
    }
    await syncPcUi(); // restores the passcode into the field if the toggle was left on
  }

  set(openRelay ? "ready (open-relay mode) — press “Go live”" : "ready — press “Go live”");
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
  const openRelay = params.has("relay");
  if (!node || !fragmentKey) return set("this link is missing its stream id or #k= key");

  // The stretched passcode, once (and if) the viewer supplies one. Held here so the rotation poller
  // re-derives WITH it rather than silently dropping back to the no-passcode key.
  /** @type {Uint8Array|null} */ let pw = null;
  /** @type {{global:string, stream:string, epoch:number}|null} */ let salts = null;

  armKey();
  let relay;
  if (openRelay) {
    await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: DEV_GLOBAL_SALT, streamSaltB64: DEV_STREAM_SALT, streamId: node, epoch: 0 });
    relay = relayUrl();
  } else {
    set("waiting for broadcaster…");
    let salt = await getSalt(node);
    for (let i = 0; i < 30 && !salt?.stream; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      salt = await getSalt(node);
    }
    if (!salt?.stream) return set("stream is not live");
    salts = salt;
    // Nothing tells us up front whether this stream needs a passcode — asking the broker would mean
    // the broker knowing which streams are protected. So try without one; the GCM tag answers.
    await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: salt.global, streamSaltB64: salt.stream, streamId: node, epoch: salt.epoch, pw });
    const edge = await assignWatch(node, originEid || "");
    if (edge.error) return set(`broker error: ${edge.error}`);
    relay = connectUrl(edge.relay_url, edge.jwt);
    // Rotation: if the broadcaster resets the salt, its epoch bumps — re-derive so playback follows.
    setInterval(async () => {
      const s = await getSalt(node);
      if (s?.stream && s.epoch !== currentEpoch()) {
        salts = s;
        await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: s.global, streamSaltB64: s.stream, streamId: node, epoch: s.epoch, pw });
      }
    }, 5000);

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
  }

  set("connecting…");
  try {
    await startWatch({ relayUrl: relay, broadcastName: node, canvas: $("video"), onStatus: set });
  } catch (e) {
    set(`watch error: ${e instanceof Error ? e.message : e}`);
  }
}
