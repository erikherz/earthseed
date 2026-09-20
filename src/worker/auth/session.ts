// Sessions, as a signed cookie and nothing else.
//
// Ported from Wallflower. There is no sessions table and there is not going to be one: a session
// here is `{userId, exp}` plus an HMAC-SHA256 over it, carried in a cookie. Nothing is stored
// server-side, so there is nothing to leak, nothing to reap, and no record anywhere of when a
// person was signed in. For a service whose whole argument is about what it declines to hold,
// stateless is not a shortcut — it is the smaller footprint for identical functionality.
//
// What that costs, stated plainly: a session cannot be revoked before it expires. Rotating
// SESSION_SECRET invalidates every session at once, which is the only lever, and it is the right
// one for the threat this has (a stolen laptop, not a compromised session store). Seven days is
// short enough that the blunt lever is rarely needed.
//
// ── One deviation from the Wallflower original ───────────────────────────────────────────────
//
// This encodes with base64URL where Wallflower used standard base64. Cookie values tolerate `+`
// and `/` in practice, but "in practice" is doing load-bearing work in that sentence across
// proxies and client libraries, and Earthseed has no existing cookies to keep compatible. The
// change is free here and would not have been there.

const ALGORITHM = { name: "HMAC", hash: "SHA-256" };

/** Seven days. Also the cookie's Max-Age, so the two cannot drift apart. */
const SESSION_DURATION = 7 * 24 * 60 * 60;

const bytesToB64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function getSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    ALGORITHM,
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(
  userId: number,
  secret: string,
  expiresInSeconds: number = SESSION_DURATION
): Promise<string> {
  const payload = JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + expiresInSeconds });
  const bytes = new TextEncoder().encode(payload);

  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign(ALGORITHM.name, key, bytes);

  return `${bytesToB64url(bytes)}.${bytesToB64url(new Uint8Array(signature))}`;
}

/**
 * Returns the user id, or null for anything that is not a currently valid token.
 *
 * The signature is verified BEFORE the payload is parsed, and the expiry is checked after. Doing
 * it the other way round would mean parsing attacker-controlled JSON on every request that
 * presents a cookie, which is a wider surface than it needs to be for no gain.
 */
export async function verifySessionToken(
  token: string,
  secret: string
): Promise<{ userId: number } | null> {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return null;

    const bytes = b64urlToBytes(payloadB64);
    const signature = b64urlToBytes(sigB64);

    const key = await getSigningKey(secret);
    if (!(await crypto.subtle.verify(ALGORITHM.name, key, signature, bytes))) return null;

    const { userId, exp } = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof userId !== "number" || typeof exp !== "number") return null;
    if (exp < Math.floor(Date.now() / 1000)) return null;

    return { userId };
  } catch {
    // Malformed base64, malformed JSON, anything at all: it is not a session.
    return null;
  }
}

/**
 * HttpOnly so script cannot read it, SameSite=Lax so it does not ride cross-site requests, and
 * Secure everywhere except localhost — where setting it would stop sign-in working over http and
 * teach whoever hit that to turn something off.
 */
export function setSessionCookie(token: string, isProduction: boolean): string {
  const parts = [
    `session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DURATION}`,
  ];
  if (isProduction) parts.push("Secure");
  return parts.join("; ");
}

export const clearSessionCookie = (): string => "session=; Path=/; HttpOnly; Max-Age=0";

export function getSessionFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
  return match ? match[1] : null;
}
