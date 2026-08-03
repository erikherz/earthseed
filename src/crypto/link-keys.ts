// Browser-side key material for relay-blind media encryption.
//
// The per-broadcast content key is NEVER minted or stored by any server. The
// broadcaster's browser mints a 32-byte fragment key, keeps it ONLY in the #k=
// fragment of the share link (which browsers never transmit), and both sides
// derive CK = HKDF(fragmentKey, globalSalt ‖ streamSalt) — see media-crypto.ts.
//
// Two pieces are persisted in the broadcaster's OWN localStorage, keyed by stream
// id, so a page reload keeps the SAME share link and keeps control of the stream:
//   - the fragment key (so the share link is stable across reloads)
//   - a rotate secret (proves ownership when setting/rotating the stream salt)
// Both are local to the broadcaster's device — never sent to viewers, never a
// privacy leak. Viewers never touch this module's storage; they read #k= from the URL.

const FRAGMENT_KEY_BYTES = 32; // AES-256 IKM
const STREAM_SALT_BYTES = 16;
const ROTATE_SECRET_BYTES = 24;

function randomB64url(nBytes: number): string {
  const bytes = new Uint8Array(nBytes);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function getOrCreate(storageKey: string, nBytes: number): string {
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh = randomB64url(nBytes);
    localStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    // localStorage unavailable (private mode edge cases) — fall back to ephemeral.
    return randomB64url(nBytes);
  }
}

/** The broadcaster's fragment key for this stream (stable across reloads). */
export function getOrCreateFragmentKey(streamId: string): string {
  return getOrCreate(`es:k:${streamId}`, FRAGMENT_KEY_BYTES);
}

/** The broadcaster's rotate secret for this stream (proves salt ownership). */
export function getOrCreateRotateSecret(streamId: string): string {
  return getOrCreate(`es:rs:${streamId}`, ROTATE_SECRET_BYTES);
}

/** A fresh per-broadcast salt (minted on go-live and on every "reset key"). */
export function newStreamSalt(): string {
  return randomB64url(STREAM_SALT_BYTES);
}

/** Read the fragment key a viewer received in the share link's #k= fragment. */
export function fragmentKeyFromHash(): string | null {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const k = params.get("k");
  return k && /^[A-Za-z0-9_-]{16,}$/.test(k) ? k : null;
}
