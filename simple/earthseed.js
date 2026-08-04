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
 * browsers never transmit to any server. Media is encrypted with AES-256-GCM per frame BEFORE it
 * touches @moq/net, so the relay and the broker only ever move ciphertext they cannot read. The
 * broker (tinymoq.com) gates the *connection* (a short-lived per-broadcast token) and serves the
 * public salts; it never sees the key. The codec catalog (resolution/codec, not content) is sent
 * in the clear by design. This is not DRM: an authorized viewer can still capture decoded frames.
 *
 * ── Layout of this file ──
 *   1. Config            relay choice, browser-support gate
 *   2. Crypto            varint framing, AES-GCM encrypt/decrypt, HKDF, link keys, node identity
 *   3. Broker client     assign a gated relay + token, get/put the public salts
 *   4. Media loop        capture→encode→encrypt→publish ; consume→decrypt→decode→paint/play
 *   5. Page controllers  runBroadcast() / runWatch() — wire the two HTML pages
 */

import * as Moq from "@moq/net";

/* ═══════════════════════════════ 1. CONFIG ═══════════════════════════════ */

// A free, public, OPEN MoQ relay (Cloudflare's). Used only in "open-relay mode" (see below).
// Broadcaster and viewer must use the same relay. Change it here or via ?relay=<url>.
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
 * @param {{fragmentKeyB64:string, globalSaltB64:string, streamSaltB64:string, streamId:string, epoch:number}} p
 */
async function deriveMediaKey(p) {
  const g = b64urlToBytes(p.globalSaltB64);
  const s = b64urlToBytes(p.streamSaltB64);
  const salt = new Uint8Array(g.byteLength + s.byteLength);
  salt.set(g, 0);
  salt.set(s, g.byteLength);
  const info = new TextEncoder().encode(`earthseed-media-v1|${p.streamId}|${p.epoch}`);
  const ikm = await crypto.subtle.importKey("raw", bs(b64urlToBytes(p.fragmentKeyB64)), "HKDF", false, [
    "deriveKey",
  ]);
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
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: ALGO, iv: bs(nonce), additionalData: bs(ts) }, key, bs(ct))
  );
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
/** @param {string} storageKey @param {number} nBytes */
function getOrCreate(storageKey, nBytes) {
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh = randomB64url(nBytes);
    localStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    return randomB64url(nBytes); // private-mode fallback: ephemeral
  }
}
/** The broadcaster's fragment key for this stream (stable across reloads → stable share link). @param {string} id */
const getOrCreateFragmentKey = (id) => getOrCreate(`es:k:${id}`, FRAGMENT_KEY_BYTES);
/** The broadcaster's rotate secret (proves salt ownership to the broker). @param {string} id */
const getOrCreateRotateSecret = (id) => getOrCreate(`es:rs:${id}`, ROTATE_SECRET_BYTES);
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
/** Assign an origin relay + publish token for this broadcaster. @param {string} nodeId */
async function assignPublish(nodeId) {
  const d = await brokerAssign({ broadcast: nodeId, role: "publish" });
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
  vEncoder.configure({
    codec: VIDEO_CODEC,
    width,
    height,
    framerate: vsettings.frameRate ?? 30,
    bitrate: 2_000_000,
    latencyMode: "realtime",
  });

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

  // ── VIDEO capture (cross-browser) ──
  // Pull frames from a hidden <video> playing the stream, via requestVideoFrameCallback +
  // new VideoFrame(video). We deliberately avoid MediaStreamTrackProcessor (Chromium-only, absent
  // on iOS/Safari). This path works on Chrome/Edge AND Safari 17+/iOS 17+.
  const capVideo = document.createElement("video");
  capVideo.srcObject = new MediaStream([videoTrack]);
  capVideo.muted = true;
  capVideo.playsInline = true;
  // Must be attached to the DOM (not display:none) or the compositor never presents frames and
  // requestVideoFrameCallback won't fire. Keep it effectively invisible.
  capVideo.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(capVideo);
  try {
    await capVideo.play();
  } catch {
    /* autoplay of a muted stream is allowed; ignore */
  }
  // Poll the video for new frames (dedup by currentTime so we don't re-encode a held frame and so
  // timestamps stay strictly increasing). A timer works everywhere — including offscreen/headless —
  // where requestVideoFrameCallback can stall. Poll a bit above the source rate so we don't miss frames.
  const fps = vsettings.frameRate ?? 30;
  let lastKey = 0;
  let lastCt = -1;
  const captureTimer = setInterval(() => {
    if (!running) return;
    const ct = capVideo.currentTime;
    if (capVideo.readyState < 2 || ct === lastCt || vEncoder.encodeQueueSize > 2) return;
    lastCt = ct;
    const tsMs = ct * 1000;
    let frame = null;
    try {
      frame = new VideoFrame(capVideo, { timestamp: Math.max(0, Math.round(tsMs * 1000)) });
    } catch {
      /* no current frame yet */
    }
    if (!frame) return;
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

  const vDecoder = new VideoDecoder({
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
  vDecoder.configure({
    codec: catalog.video.codec,
    codedWidth: catalog.video.codedWidth,
    codedHeight: catalog.video.codedHeight,
  });
  status("connected — waiting for video…");

  const videoTrack = broadcast.subscribe("video", 2);
  (async () => {
    while (running) {
      const group = await videoTrack.nextGroupOrdered();
      if (!group) break;
      let first = true; // first frame of a group is the keyframe
      for (;;) {
        const raw = await group.readFrame();
        if (!raw) break;
        try {
          const { tsMicros, payload } = unpackFrame(await decryptFrame(raw));
          vDecoder.decode(new EncodedVideoChunk({ type: first ? "key" : "delta", timestamp: tsMicros, data: payload }));
          first = false;
        } catch (e) {
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
        const now = ac.currentTime;
        if (playHead < now) playHead = now + 0.05; // fell behind → resync with a little slack
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

/** Wire the broadcast page (#preview #go #share #copy #status). */
export async function runBroadcast() {
  const set = (m) => ($("status").textContent = m);
  const reason = unsupportedReason(true);
  if (reason) return set(reason);

  const openRelay = new URLSearchParams(location.search).has("relay");
  const preview = $("preview");
  const goBtn = $("go");
  /** @type {{stop():void}|null} */ let bc = null;

  goBtn.addEventListener("click", async () => {
    if (bc) {
      bc.stop();
      bc = null;
      goBtn.textContent = "Go live";
      set("stopped");
      return;
    }
    goBtn.disabled = true;
    try {
      const node = await getOrCreateNode();
      const fragmentKey = getOrCreateFragmentKey(node.id);
      armKey();

      let relay, originEid = null;
      if (openRelay) {
        await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: DEV_GLOBAL_SALT, streamSaltB64: DEV_STREAM_SALT, streamId: node.id, epoch: 0 });
        relay = relayUrl();
      } else {
        set("assigning a relay…");
        const pub = await assignPublish(node.id);
        if (pub.error) return set(`broker error: ${pub.error}`);
        const salt = await putSalt(node.id, newStreamSalt(), getOrCreateRotateSecret(node.id));
        if (!salt?.stream) return set("could not set the stream salt");
        await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: salt.global, streamSaltB64: salt.stream, streamId: node.id, epoch: salt.epoch });
        relay = connectUrl(pub.relay_url, pub.jwt);
        originEid = pub.origin_endpoint_id;
      }

      set("starting camera…");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
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
    } catch (e) {
      set(`error: ${e instanceof Error ? e.message : e}`);
    } finally {
      goBtn.disabled = false;
    }
  });

  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("share").value);
      $("copy").textContent = "Copied!";
      setTimeout(() => ($("copy").textContent = "Copy viewer link"), 1500);
    } catch {
      /* clipboard blocked — the link is visible in the field */
    }
  });

  set(openRelay ? "ready (open-relay mode) — press “Go live”" : "ready — press “Go live”");
}

/** Wire the watch page (#video #status). */
export async function runWatch() {
  const set = (m) => ($("status").textContent = m);
  const reason = unsupportedReason(false);
  if (reason) return set(reason);

  const params = new URLSearchParams(location.search);
  const node = (params.get("node") || "").trim();
  const originEid = params.get("o");
  const fragmentKey = fragmentKeyFromHash();
  const openRelay = params.has("relay");
  if (!node || !fragmentKey) return set("this link is missing its stream id or #k= key");

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
    await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: salt.global, streamSaltB64: salt.stream, streamId: node, epoch: salt.epoch });
    const edge = await assignWatch(node, originEid || "");
    if (edge.error) return set(`broker error: ${edge.error}`);
    relay = connectUrl(edge.relay_url, edge.jwt);
    // Rotation: if the broadcaster resets the salt, its epoch bumps — re-derive so playback follows.
    setInterval(async () => {
      const s = await getSalt(node);
      if (s?.stream && s.epoch !== currentEpoch())
        await deriveMediaKey({ fragmentKeyB64: fragmentKey, globalSaltB64: s.global, streamSaltB64: s.stream, streamId: node, epoch: s.epoch });
    }, 5000);
  }

  set("connecting…");
  try {
    await startWatch({ relayUrl: relay, broadcastName: node, canvas: $("video"), onStatus: set });
  } catch (e) {
    set(`watch error: ${e instanceof Error ? e.message : e}`);
  }
}
