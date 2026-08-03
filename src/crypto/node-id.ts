// Broadcaster identity for the watch-by-pubkey (DHT) path.
//
// A node id is an Ed25519 public key rendered in iroh-style lowercase base32 (52 chars). It is
// the stream's IDENTITY and discovery handle: viewers resolve it off the DHT (see dht.ts), and
// it's the moq broadcast track name. It is NOT the content key — media is encrypted with the
// separate #k= fragment key (see link-keys.ts / media-crypto.ts); a public key could never be
// the secret that decrypts the media.
//
// Unlike wallflower (where the key is ephemeral per tab), earthseed PERSISTS the keypair in
// localStorage so the broadcaster keeps a stable pubkey — a stable share link and stable
// ownership of their stream's salt across reloads. The private key never leaves the browser.
// Call newNode() to deliberately rotate to a fresh, unlinkable identity.

const B32 = "abcdefghijklmnopqrstuvwxyz234567"; // RFC4648 lower, no padding
const NODE_STORAGE_KEY = "es:node"; // stores the private key JWK (kty OKP, crv Ed25519)

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
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

export interface MintedNode {
  id: string; // 52-char base32 pubkey — the shareable handle + moq broadcast name
  keyPair: CryptoKeyPair; // extractable so dht.ts can derive the pkarr signing key
  raw: Uint8Array; // 32 raw pubkey bytes
}

const ED25519 = { name: "Ed25519" } as unknown as AlgorithmIdentifier;

async function finalize(keyPair: CryptoKeyPair): Promise<MintedNode> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { id: base32(raw), keyPair, raw };
}

async function mintKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
}

// Reconstruct an extractable CryptoKeyPair from a stored private-key JWK. The public half is
// re-imported from the JWK's `x` (dropping `d`) so both keys exist for dht.ts's exports.
async function importFromJwk(jwk: JsonWebKey): Promise<CryptoKeyPair> {
  const privateKey = await crypto.subtle.importKey("jwk", jwk, ED25519, true, ["sign"]);
  const pubJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  const publicKey = await crypto.subtle.importKey("jwk", pubJwk, ED25519, true, ["verify"]);
  return { privateKey, publicKey } as CryptoKeyPair;
}

async function persist(keyPair: CryptoKeyPair): Promise<void> {
  try {
    const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    localStorage.setItem(NODE_STORAGE_KEY, JSON.stringify(jwk));
  } catch {
    // localStorage unavailable (private-mode edge cases) — identity stays ephemeral this session.
  }
}

/** The broadcaster's persistent node identity — loaded from localStorage or minted + saved. */
export async function getOrCreateNode(): Promise<MintedNode> {
  try {
    const stored = localStorage.getItem(NODE_STORAGE_KEY);
    if (stored) return await finalize(await importFromJwk(JSON.parse(stored) as JsonWebKey));
  } catch {
    // Corrupt/unreadable — fall through and mint a fresh one.
  }
  const keyPair = await mintKeyPair();
  await persist(keyPair);
  return finalize(keyPair);
}

/** Deliberately rotate to a fresh, unlinkable identity (new pubkey → new share link). */
export async function newNode(): Promise<MintedNode> {
  const keyPair = await mintKeyPair();
  await persist(keyPair);
  return finalize(keyPair);
}
