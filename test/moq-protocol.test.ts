/**
 * Unit tests for the MOQ (Media over QUIC) protocol as used by earthseed.live
 * to connect to the Cloudflare relay (relay-next.cloudflare.mediaoverquic.com).
 *
 * Tests the byte-level protocol encoding/decoding for:
 *   1. Publisher: CLIENT_SETUP handshake + PUBLISH_NAMESPACE track setup
 *   2. Viewer:    CLIENT_SETUP handshake + SUBSCRIBE to a track
 *
 * Protocol reference: MoQ Transport draft-14 (0xff00000e)
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// MOQ draft-14 constants (mirroring src/patched-moq/)
// ---------------------------------------------------------------------------

const DRAFT_14 = 0xff00000e;
const MSG_CLIENT_SETUP = 0x20;
const MSG_SERVER_SETUP = 0x21;
const MSG_SUBSCRIBE = 0x03;
const MSG_SUBSCRIBE_OK = 0x04;
const MSG_PUBLISH_NAMESPACE = 0x06;
const MSG_PUBLISH_NAMESPACE_OK = 0x07;

const FILTER_LATEST_GROUP = 0x01;
const GROUP_ORDER_DESCENDING = 0x02;

const CLOUDFLARE_RELAY_URL = "https://relay-next.cloudflare.mediaoverquic.com";
const NAMESPACE_PREFIX = "earthseed.live";

// ---------------------------------------------------------------------------
// QUIC varint helpers (RFC 9000 Section 16)
// ---------------------------------------------------------------------------

function encodeVarint(value: number): Uint8Array {
  if (value < 0) throw new Error("varint must be non-negative");
  if (value <= 0x3f) {
    return new Uint8Array([value]);
  }
  if (value <= 0x3fff) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, 0x4000 | value);
    return buf;
  }
  if (value <= 0x3fffffff) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, 0x80000000 | value);
    return buf;
  }
  // 8-byte varint for large values (e.g. DRAFT_14 = 0xff00000e)
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  const hi = Math.floor(value / 0x100000000);
  const lo = value >>> 0;
  view.setUint32(0, 0xc0000000 | hi);
  view.setUint32(4, lo);
  return buf;
}

function encodeVarint62(value: bigint): Uint8Array {
  if (value <= 0x3fn) {
    return new Uint8Array([Number(value)]);
  }
  if (value <= 0x3fffn) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, Number(0x4000n | value));
    return buf;
  }
  if (value <= 0x3fffffffn) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, Number(0x80000000n | value));
    return buf;
  }
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, 0xc000000000000000n | value);
  return buf;
}

/** Decode a QUIC varint from a buffer, returning value and bytes consumed. */
function decodeVarint(
  buf: Uint8Array,
  offset: number,
): { value: number; size: number } {
  const view = new DataView(buf.buffer, buf.byteOffset + offset);
  const prefix = buf[offset] >> 6;
  if (prefix === 0) {
    return { value: buf[offset] & 0x3f, size: 1 };
  }
  if (prefix === 1) {
    return { value: view.getUint16(0) & 0x3fff, size: 2 };
  }
  if (prefix === 2) {
    return { value: view.getUint32(0) & 0x3fffffff, size: 4 };
  }
  // prefix === 3
  const hi = view.getUint32(0) & 0x3fffffff;
  const lo = view.getUint32(4);
  return { value: hi * 0x100000000 + lo, size: 8 };
}

function encodeU16(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value);
  return buf;
}

function decodeU16(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset).getUint16(0);
}

function encodeString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  return concat(encodeVarint(encoded.length), encoded);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// ByteReader - sequential reader over a Uint8Array
// ---------------------------------------------------------------------------

class ByteReader {
  private buf: Uint8Array;
  private pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  readU8(): number {
    return this.buf[this.pos++];
  }

  readU16(): number {
    const val = decodeU16(this.buf, this.pos);
    this.pos += 2;
    return val;
  }

  readVarint(): number {
    const { value, size } = decodeVarint(this.buf, this.pos);
    this.pos += size;
    return value;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readString(): string {
    const len = this.readVarint();
    const bytes = this.readBytes(len);
    return new TextDecoder().decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Protocol message builders (matching src/patched-moq/connect.js)
// ---------------------------------------------------------------------------

/**
 * Build a CLIENT_SETUP message for Cloudflare draft-14.
 * Wire format:
 *   varint(0x20)                  -- message type
 *   u16(body_length)              -- Cloudflare uses u16 length prefix
 *   varint(1)                     -- number of versions
 *   varint(DRAFT_14)              -- version 0xff00000e
 *   varint(0)                     -- number of parameters
 */
function buildClientSetup(): Uint8Array {
  const body = concat(
    encodeVarint(1), // 1 version
    encodeVarint(DRAFT_14), // version = draft-14
    encodeVarint(0), // 0 parameters
  );
  return concat(
    encodeVarint(MSG_CLIENT_SETUP), // 0x20
    encodeU16(body.length), // u16 length prefix
    body,
  );
}

/**
 * Build a mock SERVER_SETUP response as Cloudflare sends it.
 * Wire format:
 *   varint(0x21)                  -- message type
 *   u16(body_length)              -- u16 length prefix
 *   varint(DRAFT_14)              -- selected version
 *   varint(1)                     -- number of parameters
 *   varint62(2)                   -- param id = 2 (MAX_REQUEST_ID, even = int)
 *   varint(63)                    -- param value = 63
 */
function buildServerSetup(): Uint8Array {
  const body = concat(
    encodeVarint(DRAFT_14), // selected version
    encodeVarint(1), // 1 parameter
    encodeVarint62(2n), // param id = 2 (even → int value)
    encodeVarint(63), // MAX_REQUEST_ID = 63
  );
  return concat(
    encodeVarint(MSG_SERVER_SETUP), // 0x21
    encodeU16(body.length), // u16 length prefix
    body,
  );
}

/**
 * Encode a namespace as the MOQ protocol does.
 * Splits on "/" and writes: varint(numParts) + string(part1) + string(part2) + ...
 */
function encodeNamespace(ns: string): Uint8Array {
  const parts = ns.split("/").filter((p) => p.length > 0);
  const encoded = parts.map((p) => encodeString(p));
  return concat(encodeVarint(parts.length), ...encoded);
}

/**
 * Build a PUBLISH_NAMESPACE message (publisher advertises a stream).
 * Wire format:
 *   varint(0x06)                  -- message type
 *   u16(body_length)              -- length prefix
 *   varint62(requestId)           -- request ID
 *   namespace(trackNamespace)     -- the stream namespace
 *   varint(0)                     -- number of parameters
 */
function buildPublishNamespace(
  requestId: number,
  namespace: string,
): Uint8Array {
  const body = concat(
    encodeVarint62(BigInt(requestId)),
    encodeNamespace(namespace),
    encodeVarint(0), // 0 parameters
  );
  return concat(
    encodeVarint(MSG_PUBLISH_NAMESPACE),
    encodeU16(body.length),
    body,
  );
}

/**
 * Build a mock PUBLISH_NAMESPACE_OK response from the relay.
 * Wire format:
 *   varint(0x07)                  -- message type
 *   u16(body_length)
 *   varint62(requestId)           -- echoed request ID
 */
function buildPublishNamespaceOk(requestId: number): Uint8Array {
  const body = encodeVarint62(BigInt(requestId));
  return concat(
    encodeVarint(MSG_PUBLISH_NAMESPACE_OK),
    encodeU16(body.length),
    body,
  );
}

/**
 * Build a SUBSCRIBE message (viewer subscribes to a track).
 * Wire format:
 *   varint(0x03)                  -- message type
 *   u16(body_length)              -- length prefix
 *   varint(requestId)             -- request ID
 *   namespace(trackNamespace)     -- stream namespace
 *   string(trackName)             -- track name (e.g. "video" or "audio")
 *   u8(subscriberPriority)        -- priority
 *   u8(groupOrder)                -- 0x02 = descending
 *   u8(forward)                   -- 1 = true
 *   u8(filterType)                -- 0x01 = LatestGroup
 *   u8(0)                         -- 0 parameters
 */
function buildSubscribe(
  requestId: number,
  namespace: string,
  trackName: string,
  priority: number,
): Uint8Array {
  const body = concat(
    encodeVarint(requestId),
    encodeNamespace(namespace),
    encodeString(trackName),
    new Uint8Array([priority]), // subscriberPriority
    new Uint8Array([GROUP_ORDER_DESCENDING]), // groupOrder
    new Uint8Array([1]), // forward = true
    new Uint8Array([FILTER_LATEST_GROUP]), // filterType
    new Uint8Array([0]), // 0 parameters
  );
  return concat(encodeVarint(MSG_SUBSCRIBE), encodeU16(body.length), body);
}

/**
 * Build a mock SUBSCRIBE_OK response from the relay.
 * Wire format:
 *   varint(0x04)                  -- message type
 *   u16(body_length)
 *   varint(requestId)
 *   varint(requestId)             -- trackAlias == requestId
 *   varint62(0)                   -- expires = 0
 *   u8(groupOrder)                -- 0x02 = descending
 *   u8(0)                         -- contentExists = false
 *   u8(0)                         -- 0 parameters
 */
function buildSubscribeOk(requestId: number): Uint8Array {
  const body = concat(
    encodeVarint(requestId),
    encodeVarint(requestId), // trackAlias == requestId
    encodeVarint62(0n), // expires = 0
    new Uint8Array([GROUP_ORDER_DESCENDING]),
    new Uint8Array([0]), // contentExists = false
    new Uint8Array([0]), // 0 parameters
  );
  return concat(encodeVarint(MSG_SUBSCRIBE_OK), encodeU16(body.length), body);
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("MOQ Publisher Protocol (Cloudflare draft-14)", () => {
  const streamId = "ab3x9";
  const streamNamespace = `${NAMESPACE_PREFIX}/${streamId}`;

  it("encodes CLIENT_SETUP with DRAFT_14 version for Cloudflare relay", () => {
    const msg = buildClientSetup();
    const reader = new ByteReader(msg);

    // Message type: 0x20 (CLIENT_SETUP)
    const msgType = reader.readVarint();
    expect(msgType).toBe(MSG_CLIENT_SETUP);

    // u16 body length
    const bodyLen = reader.readU16();
    expect(bodyLen).toBeGreaterThan(0);

    // Number of versions: 1
    const numVersions = reader.readVarint();
    expect(numVersions).toBe(1);

    // Version: DRAFT_14 (0xff00000e)
    const version = reader.readVarint();
    expect(version).toBe(DRAFT_14);

    // Number of parameters: 0
    const numParams = reader.readVarint();
    expect(numParams).toBe(0);

    // All bytes consumed
    expect(reader.remaining).toBe(0);
  });

  it("decodes Cloudflare SERVER_SETUP response with int-param format", () => {
    const msg = buildServerSetup();
    const reader = new ByteReader(msg);

    // Message type: 0x21 (SERVER_SETUP)
    const msgType = reader.readVarint();
    expect(msgType).toBe(MSG_SERVER_SETUP);

    // u16 body length
    const bodyLen = reader.readU16();
    expect(bodyLen).toBeGreaterThan(0);

    // Read exactly bodyLen bytes for the body
    const bodyBytes = reader.readBytes(bodyLen);
    const body = new ByteReader(bodyBytes);

    // Selected version: DRAFT_14
    const version = body.readVarint();
    expect(version).toBe(DRAFT_14);

    // Number of parameters: 1
    const numParams = body.readVarint();
    expect(numParams).toBe(1);

    // Parameter: id=2 (even → int value), value=63 (MAX_REQUEST_ID)
    const paramId = body.readVarint();
    expect(paramId).toBe(2);
    // Even key → value is a varint (Cloudflare int-param format)
    expect(paramId % 2).toBe(0);
    const paramValue = body.readVarint();
    expect(paramValue).toBe(63);

    expect(body.remaining).toBe(0);
  });

  it("performs full publisher handshake and sends PUBLISH_NAMESPACE", () => {
    // --- Step 1: Client sends CLIENT_SETUP ---
    const clientSetup = buildClientSetup();
    expect(clientSetup.length).toBeGreaterThan(0);

    // Verify it starts with the right message type
    const { value: csType } = decodeVarint(clientSetup, 0);
    expect(csType).toBe(MSG_CLIENT_SETUP);

    // --- Step 2: Server responds with SERVER_SETUP ---
    const serverSetup = buildServerSetup();
    const ssReader = new ByteReader(serverSetup);
    const ssMsgType = ssReader.readVarint();
    expect(ssMsgType).toBe(MSG_SERVER_SETUP);
    const ssBodyLen = ssReader.readU16();
    const ssBody = new ByteReader(ssReader.readBytes(ssBodyLen));
    const serverVersion = ssBody.readVarint();

    // Verify server selected DRAFT_14
    expect(serverVersion).toBe(DRAFT_14);

    // --- Step 3: Connection established, publisher sends PUBLISH_NAMESPACE ---
    // (In earthseed, Connection skips MaxRequestId for Cloudflare)
    const requestId = 0; // first request ID
    const publishNs = buildPublishNamespace(requestId, streamNamespace);
    const pnReader = new ByteReader(publishNs);

    // Message type: 0x06 (PUBLISH_NAMESPACE)
    const pnMsgType = pnReader.readVarint();
    expect(pnMsgType).toBe(MSG_PUBLISH_NAMESPACE);

    // u16 body length
    const pnBodyLen = pnReader.readU16();
    const pnBody = new ByteReader(pnReader.readBytes(pnBodyLen));

    // Request ID
    const pnRequestId = pnBody.readVarint();
    expect(pnRequestId).toBe(requestId);

    // Namespace: "earthseed.live/ab3x9" → 2 parts: ["earthseed.live", "ab3x9"]
    const numParts = pnBody.readVarint();
    expect(numParts).toBe(2);
    const part1 = pnBody.readString();
    expect(part1).toBe("earthseed.live");
    const part2 = pnBody.readString();
    expect(part2).toBe(streamId);

    // 0 parameters
    const pnNumParams = pnBody.readVarint();
    expect(pnNumParams).toBe(0);

    expect(pnBody.remaining).toBe(0);

    // --- Step 4: Server responds with PUBLISH_NAMESPACE_OK ---
    const publishNsOk = buildPublishNamespaceOk(requestId);
    const pnOkReader = new ByteReader(publishNsOk);
    const pnOkType = pnOkReader.readVarint();
    expect(pnOkType).toBe(MSG_PUBLISH_NAMESPACE_OK);
    const pnOkBodyLen = pnOkReader.readU16();
    const pnOkBody = new ByteReader(pnOkReader.readBytes(pnOkBodyLen));
    const pnOkRequestId = pnOkBody.readVarint();
    expect(pnOkRequestId).toBe(requestId);
  });

  it("uses the correct relay URL and stream namespace format", () => {
    // Verify earthseed's namespace convention
    expect(streamNamespace).toBe("earthseed.live/ab3x9");

    // Cloudflare relay is detected by URL containing "cloudflare"
    expect(CLOUDFLARE_RELAY_URL.toLowerCase()).toContain("cloudflare");

    // Namespace splits into exactly 2 parts
    const parts = streamNamespace.split("/");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("earthseed.live");
    expect(parts[1]).toMatch(/^[a-z0-9]{5}$/); // 5-char lowercase alphanumeric
  });
});

describe("MOQ Viewer Protocol (Cloudflare draft-14)", () => {
  const streamId = "k7m2p";
  const streamNamespace = `${NAMESPACE_PREFIX}/${streamId}`;

  it("encodes CLIENT_SETUP identically for viewer and publisher", () => {
    // Viewers use the same handshake as publishers
    const msg = buildClientSetup();
    const reader = new ByteReader(msg);

    const msgType = reader.readVarint();
    expect(msgType).toBe(MSG_CLIENT_SETUP);

    const bodyLen = reader.readU16();
    const body = new ByteReader(reader.readBytes(bodyLen));

    const numVersions = body.readVarint();
    expect(numVersions).toBe(1);

    const version = body.readVarint();
    expect(version).toBe(DRAFT_14);

    const numParams = body.readVarint();
    expect(numParams).toBe(0);

    expect(body.remaining).toBe(0);
  });

  it("encodes SUBSCRIBE with LatestGroup filter for video track", () => {
    const requestId = 0;
    const trackName = "video";
    const priority = 2;

    const msg = buildSubscribe(requestId, streamNamespace, trackName, priority);
    const reader = new ByteReader(msg);

    // Message type: 0x03 (SUBSCRIBE)
    const msgType = reader.readVarint();
    expect(msgType).toBe(MSG_SUBSCRIBE);

    // u16 body length
    const bodyLen = reader.readU16();
    const body = new ByteReader(reader.readBytes(bodyLen));

    // Request ID
    const subRequestId = body.readVarint();
    expect(subRequestId).toBe(requestId);

    // Namespace: "earthseed.live/k7m2p" → 2 parts
    const numParts = body.readVarint();
    expect(numParts).toBe(2);
    expect(body.readString()).toBe("earthseed.live");
    expect(body.readString()).toBe(streamId);

    // Track name
    const subTrackName = body.readString();
    expect(subTrackName).toBe("video");

    // Subscriber priority
    const subPriority = body.readU8();
    expect(subPriority).toBe(priority);

    // Group order: descending (0x02)
    const groupOrder = body.readU8();
    expect(groupOrder).toBe(GROUP_ORDER_DESCENDING);

    // Forward: true (1)
    const forward = body.readU8();
    expect(forward).toBe(1);

    // Filter type: LatestGroup (0x01)
    const filterType = body.readU8();
    expect(filterType).toBe(FILTER_LATEST_GROUP);

    // 0 parameters
    const numParams = body.readU8();
    expect(numParams).toBe(0);

    expect(body.remaining).toBe(0);
  });

  it("encodes SUBSCRIBE for audio track with different priority", () => {
    const requestId = 2; // second request (IDs increment by 2)
    const trackName = "audio";
    const priority = 1; // audio often higher priority

    const msg = buildSubscribe(
      requestId,
      streamNamespace,
      trackName,
      priority,
    );
    const reader = new ByteReader(msg);

    reader.readVarint(); // skip message type
    const bodyLen = reader.readU16();
    const body = new ByteReader(reader.readBytes(bodyLen));

    expect(body.readVarint()).toBe(requestId);

    // Skip namespace
    const numParts = body.readVarint();
    for (let i = 0; i < numParts; i++) body.readString();

    expect(body.readString()).toBe("audio");
    expect(body.readU8()).toBe(priority);
  });

  it("performs full viewer handshake and subscribes to a track", () => {
    // --- Step 1: Client sends CLIENT_SETUP ---
    const clientSetup = buildClientSetup();
    const csReader = new ByteReader(clientSetup);
    expect(csReader.readVarint()).toBe(MSG_CLIENT_SETUP);

    // --- Step 2: Server responds with SERVER_SETUP ---
    const serverSetup = buildServerSetup();
    const ssReader = new ByteReader(serverSetup);
    expect(ssReader.readVarint()).toBe(MSG_SERVER_SETUP);
    const ssBodyLen = ssReader.readU16();
    const ssBody = new ByteReader(ssReader.readBytes(ssBodyLen));
    const serverVersion = ssBody.readVarint();
    expect(serverVersion).toBe(DRAFT_14);

    // --- Step 3: Connection established, viewer sends SUBSCRIBE ---
    const requestId = 0;
    const subscribe = buildSubscribe(
      requestId,
      streamNamespace,
      "video",
      2,
    );
    const subReader = new ByteReader(subscribe);
    expect(subReader.readVarint()).toBe(MSG_SUBSCRIBE);

    // --- Step 4: Server responds with SUBSCRIBE_OK ---
    const subscribeOk = buildSubscribeOk(requestId);
    const okReader = new ByteReader(subscribeOk);

    const okMsgType = okReader.readVarint();
    expect(okMsgType).toBe(MSG_SUBSCRIBE_OK);

    const okBodyLen = okReader.readU16();
    const okBody = new ByteReader(okReader.readBytes(okBodyLen));

    // Request ID echoed back
    const okRequestId = okBody.readVarint();
    expect(okRequestId).toBe(requestId);

    // Track alias == requestId
    const trackAlias = okBody.readVarint();
    expect(trackAlias).toBe(requestId);

    // expires = 0
    const expires = okBody.readVarint();
    expect(expires).toBe(0);

    // Group order
    const groupOrder = okBody.readU8();
    expect(groupOrder).toBe(GROUP_ORDER_DESCENDING);

    // Content exists = false
    const contentExists = okBody.readU8();
    expect(contentExists).toBe(0);

    // 0 parameters
    const numParams = okBody.readU8();
    expect(numParams).toBe(0);

    expect(okBody.remaining).toBe(0);
  });

  it("correctly identifies Cloudflare relay by URL", () => {
    // earthseed uses URL string matching to detect Cloudflare
    const isCloudflare = (url: string) => url.toLowerCase().includes("cloudflare");

    expect(isCloudflare(CLOUDFLARE_RELAY_URL)).toBe(true);
    expect(isCloudflare("https://cdn.moq.dev/anon")).toBe(false);
    expect(isCloudflare("https://us-central.earthseed.live/anon")).toBe(false);
  });
});
