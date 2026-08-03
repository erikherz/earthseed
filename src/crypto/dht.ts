// Browser-side watch-by-pubkey discovery on the public Mainline DHT (pkarr / BEP44).
//
// Ported from wallflower/src/dht.ts (proven end-to-end). Two halves of one contract
// (see tinymoq fleet/directory/FEDERATION.md):
//   publish  — the broadcaster signs a record with its OWN browser Ed25519 key and PUTs
//              it to the DHT: z32(pubkey) -> "origin=<EID>;name=<nodeId>;access=public".
//   resolve  — a viewer reads that record straight off the DHT, verifies the signature,
//              and learns the origin relay's iroh EndpointId. No directory server; the
//              DHT is the entire interop surface, so even earthseed holds no list of
//              broadcasts.
//
// Provisioning (getting an origin/edge relay) is a SEPARATE concern handled by the
// Worker (/api/publish, /api/edge) so the provisioning bearer never touches the browser.
// Media is still relay-blind encrypted (see media-crypto.ts) — discovery is orthogonal
// to encryption, so this path is NOT the old plaintext node-id demo.
import { Buffer } from "buffer";
import { Pkarr, SignedPacket, generateKeyPair } from "pkarr";

// pkarr's own lib (signed_packet.js, tools.js, relay.js) and its bencode dependency use
// the Node GLOBAL `Buffer` without ever importing it. Aliasing the `buffer` module in
// vite.config only fixes packages that DO import it — it cannot help these, so without
// this shim the DHT calls die at runtime with "Buffer is not defined" while the build
// stays green. Safe here: every such use is inside a function body.
if (!(globalThis as unknown as { Buffer?: unknown }).Buffer) {
  (globalThis as unknown as { Buffer: unknown }).Buffer = Buffer;
}

// The pkarr relays the browser resolves/publishes through. These are HTTP↔DHT gateways
// (NOT the storage — the record lives on the mainline DHT itself), operated by the pkarr
// project (Pubky). They can see viewer-IP ↔ pubkey lookups but CANNOT forge records
// (Ed25519-signed) or hold them exclusively. TO SELF-HOST: run the open-source pkarr relay
// on a UDP-capable box and replace this list with your own URL(s) — nothing else changes.
const PKARR_RELAYS = ["https://relay.pkarr.org", "https://pkarr.pubky.org"];

// iroh's RFC4648 lowercase base32 alphabet (no padding) — the nodeId encoding used in
// URLs. pkarr keys records by z32 instead, but relayGet/relayPut transcode internally
// from the raw key BYTES, so we only need to get from base32 text back to those 32 bytes.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Decode(s: string): Uint8Array {
  const lookup: Record<string, number> = {};
  for (let i = 0; i < B32.length; i++) lookup[B32[i]] = i;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toLowerCase()) {
    const v = lookup[ch];
    if (v === undefined) continue; // skip any stray char
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// Derive the pkarr keypair from the browser's minted Ed25519 key. WebCrypto has no "export
// the seed" call, but an Ed25519 PKCS8 export is a 48-byte DER whose trailing 32 bytes are
// exactly the seed libsodium's crypto_sign_seed_keypair() wants.
async function pkarrKeyPair(cryptoKeyPair: CryptoKeyPair): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", cryptoKeyPair.privateKey));
  return generateKeyPair(pkcs8.slice(-32)) as { publicKey: Uint8Array; secretKey: Uint8Array };
}

export async function publishDhtRecord(
  cryptoKeyPair: CryptoKeyPair,
  nodeId: string,
  originEndpointId: string
): Promise<void> {
  const kp = await pkarrKeyPair(cryptoKeyPair);

  // Go-live assertion on BYTES: proves the seed extraction reproduced the nodeId's key.
  // A z32-vs-base32 STRING compare here would fail permanently even when correct (same 32
  // bytes, different alphabets), so never reintroduce one.
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", cryptoKeyPair.publicKey));
  const same = kp.publicKey.length === rawPub.length && rawPub.every((b, i) => kp.publicKey[i] === b);
  if (!same) throw new Error("pkarr key != nodeId key — seed extraction wrong");

  // One "_moq" TXT record. The record's DHT key is z32(pubkey) (auto, from the signing
  // key); the `name` field carries the nodeId the viewer subscribes to on moq.
  const packet = {
    id: 0,
    type: "response",
    flags: 0,
    answers: [
      {
        name: "_moq",
        type: "TXT",
        class: "IN",
        ttl: 300,
        data: `origin=${originEndpointId};name=${nodeId};access=public`,
      },
    ],
  };

  const signed = SignedPacket.fromPacket(kp, packet);
  // relayPut resolves with the raw fetch Response and does NOT throw on 4xx/5xx, so check
  // .ok explicitly. Succeed if AT LEAST ONE relay accepted it — a single relay outage must
  // not block go-live — but fail loudly if BOTH rejected (the viewer would never resolve).
  const results = await Promise.allSettled(PKARR_RELAYS.map((r) => Pkarr.relayPut(r, signed)));
  const anyOk = results.some((r) => r.status === "fulfilled" && r.value.ok);
  if (!anyOk) {
    const detail = results
      .map((r, i) => `${PKARR_RELAYS[i]}: ${r.status === "fulfilled" ? r.value.status : String(r.reason)}`)
      .join("; ");
    throw new Error(`pkarr relayPut failed on all relays — ${detail}`);
  }
}

export interface DhtRecord {
  originEndpointId: string; // 64-hex iroh EndpointId of the origin relay
  name: string; // the moq broadcast name the viewer subscribes to
  access: string; // "public" today
}

// Resolve a shared base32 nodeId to its DHT record. Returns null when nothing is published
// yet (the caller polls) or when neither relay holds a verifiable record.
export async function resolveDhtRecord(nodeId: string): Promise<DhtRecord | null> {
  const pub = base32Decode(nodeId);
  if (pub.length !== 32) return null;
  const pubBuf = Buffer.from(pub);
  for (const relay of PKARR_RELAYS) {
    try {
      // relayGet keys by z32(pub) and verifies the Ed25519 signature; null on 404.
      const packet = await Pkarr.relayGet(relay, pubBuf);
      if (!packet) continue;
      for (const rr of packet.resourceRecords("_moq")) {
        const parsed = parseMoqRecord(txtData((rr as { data: unknown }).data));
        if (parsed) return parsed;
      }
    } catch {
      // Relay unreachable or bad record — try the next one.
    }
  }
  return null;
}

// dns-packet hands TXT data back as a Buffer, or an array of Buffers for multi-string TXT.
function txtData(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map((b) => Buffer.from(b as Uint8Array).toString()).join("");
  if (typeof raw === "string") return raw;
  return Buffer.from(raw as Uint8Array).toString();
}

function parseMoqRecord(data: string): DhtRecord | null {
  const fields: Record<string, string> = {};
  for (const part of data.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (!fields.origin || !fields.name) return null;
  return { originEndpointId: fields.origin, name: fields.name, access: fields.access ?? "public" };
}
