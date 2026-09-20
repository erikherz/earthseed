// Per-broadcast MoQ relay tokens. Short-lived, scope-limited JWTs minted by the Worker
// and passed to the TinyMoQ relay as the `?jwt=` query param on the WebTransport URL.
// The relay verifies the signature, then enforces the `put`/`get` scopes + `exp`.
//
// TWO signing modes, selected by configuration (so this file is tenant-agnostic):
//
//   BYOK (asymmetric):  EdDSA (Ed25519) with the tenant's OWN private key
//                       (MOQ_AUTH_PRIVATE_JWK). Only the matching PUBLIC key is
//                       registered with TinyMoQ — the relay never holds a signing key.
//
//   Managed (symmetric): HS256 with a per-stream HMAC secret that /assign returns
//                       (`key` field). TinyMoQ keys the relay per broadcast; a
//                       reap/respawn rotates the key (old tokens die = revocation).
//                       Do NOT cache it — sign on demand with what /assign returned.
//
// Same claim contract either way (PER-BROADCAST-TOKENS.md): unpadded base64url
// everywhere, `exp` in unix SECONDS. Signing input is base64url(header) + "." +
// base64url(payload); the token is that + "." + base64url(signature).

// Earthseed's Ed25519 key id (RFC 7638 JWK thumbprint) — fallback if the private JWK
// secret omits its own `kid`. The relay selects the verifying key by this kid.
export const MOQ_KID = "X3KzNJpRvVarbKBM2mk_M5JGt0dDYu85ZA5z2nLb1Qk";
// Managed HS256 mode: the relay has the per-stream key and ignores `kid`; keep it
// constant so tokens stay identical to the moq-token-cli tooling.
const HS256_KID = "9309ffde64e0bf0f";

const ED25519 = { name: "Ed25519" } as const;

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = new Uint8Array(buf as ArrayBuffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecodeToBytes = (s: string): Uint8Array => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export interface MoqClaims {
  put: string[]; // path prefixes the holder may publish to ([] = none)
  get: string[]; // path prefixes the holder may subscribe to
  exp: number; // expiry, unix SECONDS
  // Cross-cluster pull flag. Set only on the `&pull=` token handed to a viewer-CDN edge
  // relay so it may pull this broadcast from the publisher's origin relay across clusters.
  // Omitted (undefined) on ordinary publisher/viewer tokens, so they are byte-identical
  // to before — JSON.stringify drops undefined fields.
  cluster?: boolean;
}

const sign = async (header: object, claims: MoqClaims, signFn: (input: Uint8Array) => Promise<ArrayBuffer>): Promise<string> => {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const sig = await signFn(new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
};

/**
 * Parse a stored private OKP JWK, correcting the one field Node and workerd disagree about.
 *
 * RFC 8037 §3.1 names the JWA algorithm for Ed25519 **"EdDSA"**. Node's WebCrypto exports the
 * key with `alg: "Ed25519"` — the CURVE name — and workerd's importKey refuses that outright.
 * The failure is a bare 500 from `crypto.subtle.importKey` with nothing in it that names the
 * cause, at token-minting time, long after the key was generated and registered. It reads as a
 * broken CDN rather than a one-word mismatch in a JWK.
 *
 * `scripts/moq-keygen.mjs` now stamps "EdDSA" when it writes the secret, so freshly generated
 * keys are correct at rest. This exists for the ones that are not: a key stored before that fix,
 * or one pasted in by hand from `node --experimental-...`. Deleting the field entirely also works
 * — `alg` is optional on a JWK — and is what this does, because "absent" cannot be wrong in a
 * future runtime the way a guessed value can.
 */
function parsePrivateOkpJwk(privateJwk: string): JsonWebKey & { kid?: string } {
  const jwk = JSON.parse(privateJwk) as JsonWebKey & { kid?: string };
  if (jwk.alg && jwk.alg !== "EdDSA") delete jwk.alg;
  // `ext` and `key_ops` from a Node export describe Node's key, not the one being imported here,
  // and workerd validates key_ops against the requested usages. Dropping both is safe: the
  // import below states the usage it wants.
  delete (jwk as { ext?: boolean }).ext;
  delete (jwk as { key_ops?: string[] }).key_ops;
  return jwk;
}

// BYOK: sign with the tenant's Ed25519 private key. `privateJwk` is an OKP JWK (JSON
// string with `d`), e.g. env.MOQ_AUTH_PRIVATE_JWK.
export async function mintEd25519Token(privateJwk: string, claims: MoqClaims): Promise<string> {
  const jwk = parsePrivateOkpJwk(privateJwk);
  const key = await crypto.subtle.importKey("jwk", jwk, ED25519, false, ["sign"]);
  const header = { typ: "JWT", alg: "EdDSA", kid: jwk.kid ?? MOQ_KID };
  return sign(header, claims, (input) => crypto.subtle.sign(ED25519, key, input));
}

// The PUBLIC verify JWK for our BYOK signing key — what an operator installs/pastes as the
// relay's verify_jwk. Returns ONLY public material (the `x` coordinate is public; the
// private `d` is dropped), so this is safe to expose. The `kid` matches what
// mintEd25519Token() stamps on tokens (jwk.kid ?? MOQ_KID), so the relay selects this key.
export interface PublicVerifyJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "EdDSA";
  use: "sig";
  key_ops: ["verify"];
  kid: string;
}
export function publicVerifyJwk(privateJwk: string): PublicVerifyJwk {
  const jwk = JSON.parse(privateJwk) as { kty?: string; crv?: string; x?: string; kid?: string };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("MOQ_AUTH_PRIVATE_JWK is not an Ed25519 (OKP) JWK");
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: jwk.x, // public coordinate only — never the private `d`
    alg: "EdDSA",
    use: "sig",
    key_ops: ["verify"],
    kid: jwk.kid ?? MOQ_KID,
  };
}

// Managed: sign with a per-stream HMAC secret (base64url "k") returned by /assign.
export async function mintHs256Token(secretK: string, claims: MoqClaims): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64urlDecodeToBytes(secretK),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const header = { typ: "JWT", alg: "HS256", kid: HS256_KID };
  return sign(header, claims, (input) => crypto.subtle.sign("HMAC", key, input));
}

// ── moq.pro (Luke Curley's hosted CDN) ────────────────────────────────────────────────────────
//
// A DIFFERENT claim shape from the fleet tokens above, and that difference is why this section
// exists rather than reusing MoqClaims. moq.pro scopes a token to an ACCOUNT ROOT plus the
// broadcast names beneath it, so the claim carries `root` and the put/get entries are names
// relative to that root — not the absolute path prefixes the tinymoq fleet matches on.
//
// Two signing modes, and the asymmetric one is strongly preferred:
//
//   EdDSA   moq.pro holds only the PUBLIC half, imported through its admin UI. It can verify our
//           tokens and cannot forge one, so a breach on their side yields nothing that lets
//           anyone publish or subscribe as us.
//
//   HS256   the legacy symmetric key moq.pro issues. Verification needs the identical secret
//           used to sign, so moq.pro necessarily holds everything needed to mint any token we
//           could — their Keys page even offers it back as a download. Kept only so that
//           unsetting MOQ_PRO_JWK restores previous behaviour rather than breaking.

/** moq.pro's own symmetric key id. Fixed; the HS256 path does not select on kid anyway. */
export const MOQ_PRO_KID = "f865ebbc-4bb8-4a1f-834c-7d2fc0ae1d07";

export interface MoqProClaims {
  /** Account root — the path namespace under cdn.moq.pro, e.g. "erik". */
  root: string;
  /** Broadcast names, relative to root, this token may publish to ([] = none). */
  put: string[];
  /** Broadcast names, relative to root, this token may subscribe to. */
  get: string[];
  /** Expiry, unix SECONDS. */
  exp: number;
}

const signMoqPro = async (
  header: object,
  claims: MoqProClaims,
  signFn: (input: Uint8Array) => Promise<ArrayBuffer>
): Promise<string> => {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const sig = await signFn(new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
};

/** HS256 with the account's symmetric key (base64url "k" of the JWK moq.pro issued). */
export async function mintMoqProToken(secretK: string, claims: MoqProClaims): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64urlDecodeToBytes(secretK),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return signMoqPro({ typ: "JWT", alg: "HS256", kid: MOQ_PRO_KID }, claims, (input) =>
    crypto.subtle.sign("HMAC", key, input)
  );
}

/**
 * EdDSA with a key whose PUBLIC half was uploaded through moq.pro's "Import Asymmetric".
 *
 * The kid travels in the header so moq.pro selects the right verify key, which means the kid on
 * the stored private JWK must match the one registered there. A mismatch is not a signature
 * error you can see: moq.pro finds no key to check against, the WebTransport session opens
 * normally, and the connection dies the moment it speaks MoQ. Register the public half BEFORE
 * setting the secret.
 */
export async function mintMoqProTokenEd25519(privateJwk: string, claims: MoqProClaims): Promise<string> {
  const jwk = parsePrivateOkpJwk(privateJwk);
  const key = await crypto.subtle.importKey("jwk", jwk, ED25519, false, ["sign"]);
  return signMoqPro({ typ: "JWT", alg: "EdDSA", kid: jwk.kid }, claims, (input) =>
    crypto.subtle.sign(ED25519, key, input)
  );
}
