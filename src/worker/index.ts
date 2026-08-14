// Cloudflare Worker for earthseed.live.
//
// It serves the static client in simple/ and owns the CONTROL PLANE: who may publish, who may be
// placed on a relay, and which streams have been terminated. Media never touches it.
//
// ── Why this Worker grew ──────────────────────────────────────────────────────────────────────
// Until August 2026 the client talked to the tinymoq broker directly, holding a public `pk_` that
// shipped in the page. That is a fine arrangement for a demo and an impossible one for moderation:
// with the credential public and the Worker out of the path, there was no moment at which anyone
// could decline. An operator could see that a stream existed and had no way to stop it.
//
// So the Worker is now the single door. It:
//   • admits a broadcaster (a MAC'd publish code — see "Publish codes"),
//   • checks the broadcast NAME is theirs (Ed25519 challenge-response; the name IS the public key),
//   • asks the broker for a relay on their behalf, with a credential that is a SECRET,
//   • records a proof-of-link tag so a viewer must show they were given the link,
//   • refuses all of the above for a terminated stream, and tells live browsers to stop.
//
// What did NOT change, and must not: the content key is still derived only in the two browsers,
// from the `#k=` fragment that browsers never transmit. This Worker cannot decrypt a broadcast, and
// nothing added here brings it closer to being able to. Every check below operates on names, tags
// and capabilities — never on media, and never on the fragment key.
//
// ── The one thing this costs ──────────────────────────────────────────────────────────────────
// A self-hosted copy of simple/ used to reach the broker with no earthseed.live involvement at all.
// It now points at whatever origin serves it, so a self-hoster gets the same control plane only if
// they run this Worker too. That is the honest trade: publisher admission and a working kill switch
// cannot exist without someone in a position to say no.

import { publicVerifyJwk, mintEd25519Token, type MoqClaims } from "./auth/moq-token";

// Per-stream live chat Durable Object. Bound in wrangler.jsonc; removing it needs a deletion
// migration. Nothing in the shipped client uses it yet.
export { ChatRoom } from "./chat-room";

export interface Env {
  ASSETS: Fetcher;

  // ── Relay tokens (BYOK). The tenant's Ed25519 PRIVATE signing key as an OKP JWK. Only its
  // public half is exposed, via /api/pubkey, for an operator to install as the fleet's verify_jwk.
  MOQ_AUTH_PRIVATE_JWK?: string;

  // ── Broker credential. The `cdn_…` CUSTOMER token from tinymoq/cdnadmin, sent as a Bearer to
  // /cdn/assign. A SECRET, unlike the `pk_` it replaces: the whole point of moving assignment
  // behind this Worker is that the credential stops shipping in the page.
  CDN_API_TOKEN?: string;

  // ── Publish codes. Signing key for the capability MAC. Unset ⇒ nobody can publish (fail-closed).
  ISSUE_KEY?: string;
  // Optional shared secret that also admits, for an operator testing without minting a code.
  PUBLISH_SECRET?: string;
  // Bearer for /api/admin/*. Unset ⇒ admin is locked.
  ADMIN_PASSWORD?: string;
  // Where abuse reports are pushed as they arrive. Unset ⇒ they only land in D1.
  REPORT_WEBHOOK?: string;

  // ── Vars (wrangler.jsonc) ──
  BROKER_BASE?: string;
  /** Legacy name for the full assign URL. Read only if BROKER_BASE is unset. */
  FLEET_ENDPOINT?: string;
  /** The PUBLIC publishable key, used as the broker credential when CDN_API_TOKEN is unset. */
  PUBLIC_KEY?: string;
  /** "worker" mints relay tokens here (short TTLs, revocable); "broker" passes through the
   *  broker's own token. See tokenSource() — this is the flip that makes expiry ours to set. */
  TOKEN_SOURCE?: string;
  PUBLISH_CODE_BATCH?: string;
  PUBLISH_CODE_TTL_DAYS?: string;
  PUBLISH_CODE_DELAY_HOURS?: string;
  PUBLISH_CODE_POW_BITS?: string;
  VIEWER_TOKEN_TTL?: string;
  PUBLISHER_TOKEN_TTL?: string;

  DB: D1Database;
  SALTS: KVNamespace;
  CHAT_ROOMS: DurableObjectNamespace;
}

// Standalone pages that are real files in simple/ but want a bare path. Served explicitly because
// html_handling is "none" (see wrangler.jsonc), which is also why "/" is mapped below.
const STANDALONE_PAGES: Record<string, string> = {
  "/": "/index.html",
  "/request": "/request.html",
  "/reports": "/reports.html",
  "/trust": "/trust.html",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApiRoutes(request, env, url, ctx);
    }

    const page = STANDALONE_PAGES[url.pathname];
    if (page) {
      const target = new URL(page, url.origin);
      return withSecurityHeaders(
        await env.ASSETS.fetch(
          new Request(target.toString(), { method: request.method, headers: request.headers })
        )
      );
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

// The baseline subset only, and that is enough here. These headers reach just the responses the
// Worker actually serves — "/" and the standalone pages — because with no `run_worker_first` the
// asset server answers the .html/.js paths itself; simple/_headers is where the real policy lives,
// including the enforced `script-src`/`connect-src`.
function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    // GET /api/pubkey — the PUBLIC verify JWK for this deployment's BYOK signing key, as plain
    // JSON, for an operator to paste into their CDN console as the verify_jwk. Public material
    // only; the private half (MOQ_AUTH_PRIVATE_JWK) is never exposed here.
    if (request.method === "GET" && url.pathname === "/api/pubkey") {
      if (!env.MOQ_AUTH_PRIVATE_JWK) {
        return new Response("signing key not configured", { status: 503 });
      }
      try {
        return Response.json(publicVerifyJwk(env.MOQ_AUTH_PRIVATE_JWK));
      } catch (e) {
        console.error("/api/pubkey:", e);
        return new Response("invalid signing key", { status: 500 });
      }
    }

    // POST /api/csp-report — where Content-Security-Policy violations are sent. `npx wrangler tail`
    // is the read side; nothing is stored. Unauthenticated because a browser reporting a violation
    // has no credentials to offer — that is the shape of the feature, not an oversight — and
    // bounded to POST, a hard body cap, and no persistence.
    if (url.pathname === "/api/csp-report") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await request.text().catch(() => "")).slice(0, 4096);
      if (body) console.warn("csp-report", request.headers.get("user-agent") ?? "?", body);
      return new Response(null, { status: 204 });
    }

    if (url.pathname.startsWith("/api/publish-code/")) {
      return handlePublishCodeRoutes(request, env, url);
    }
    if (url.pathname.startsWith("/api/broadcast/") || url.pathname.startsWith("/api/watch/")) {
      return handlePlacementRoutes(request, env, url);
    }
    if (url.pathname.startsWith("/api/stream/")) {
      return handleStreamStatus(request, env, url);
    }
    if (url.pathname === "/api/report" || url.pathname === "/api/report/config") {
      return handleReportRoutes(request, env, url, ctx);
    }
    if (url.pathname.startsWith("/api/admin/")) {
      return handleAdminRoutes(request, env, url);
    }

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    console.error("API error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

/* ═════════════════════════ Small shared primitives ═════════════════════════ */

const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Length-independent comparison, so a wrong credential leaks nothing through timing. */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToB64url(new Uint8Array(sig));
}

const numVar = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/* ═════════════════════════ Broadcast names and ownership ═════════════════════════ */
// A broadcast name is an Ed25519 PUBLIC KEY rendered as RFC4648 lower-case base32. That is the
// whole ownership story: there is no registry, no account, and nothing to steal from us, because
// only the holder of the private half can sign for the name — and that half is minted
// non-extractably in the broadcaster's browser and never leaves it.

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CLAIM_CONTEXT = "earthseed-claim-v1";
/** 32-byte Ed25519 key at 5 bits per character. */
const NODE_ID_CHARS = 52;

function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Is this a syntactically valid broadcast name? Cheap, and it keeps junk out of every table. */
function isNodeId(s: unknown): s is string {
  return typeof s === "string" && s.length === NODE_ID_CHARS && /^[a-z2-7]+$/.test(s);
}

/**
 * Did the holder of the private key behind this name sign OUR view of the broker's challenge?
 *
 * The Worker verifies this even though the broker verifies it too. Not redundancy for its own
 * sake: the route tag registered a few lines later is what every viewer of this broadcast is
 * checked against, so if anyone could register a tag under someone else's name, proof-of-link
 * would be proof of nothing. This check is what makes that row trustworthy to us specifically,
 * rather than trustworthy because a third party said so.
 */
async function claimIsValid(nodeId: string, challenge: string, signatureB64: string): Promise<boolean> {
  try {
    const raw = base32Decode(nodeId);
    if (!raw || raw.length < 32) return false;
    const key = await crypto.subtle.importKey("raw", raw.subarray(0, 32), { name: "Ed25519" }, false, [
      "verify",
    ]);
    const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${nodeId}|${challenge}`);
    return await crypto.subtle.verify("Ed25519", key, b64urlToBytes(signatureB64), msg);
  } catch {
    return false; // malformed key or signature — indistinguishable from a bad one, deliberately
  }
}

/* ═════════════════════════ Publish codes ═════════════════════════ */
// A code is a self-describing capability, not a database row:
//
//     es1.<base64url payload>.<truncated HMAC>
//
// The payload is plaintext — anyone can read their own not-before, expiry and batch. The MAC is
// what makes those claims unforgeable: only this Worker holds ISSUE_KEY, so an abuser who edits
// `exp` from 2026 to 2036 cannot produce a MAC that matches the edited payload. That is why the
// expiry can safely ride INSIDE the credential instead of in a table.
//
// Issuing one therefore writes NOTHING down. There is no per-person row to subpoena and nothing to
// correlate against a broadcast, which is the property that keeps a broadcaster's identity out of
// reach even from us. The cost, accepted deliberately: we cannot tell one person's tenth code from
// ten people's first. That is the same property viewed from the other side, and it cannot be had
// one way only.

const CODE_VERSION = "es1";
const CODE_CONTEXT = "earthseed-publish-code-v1";
const POW_CONTEXT = "earthseed-pow-v1";
const POW_CHALLENGE_TTL_SECONDS = 15 * 60; // generous: the client spends real time on the PoW
const DEFAULT_CODE_TTL_DAYS = 30;
const DEFAULT_CODE_DELAY_HOURS = 0;
const DEFAULT_POW_BITS = 18;
/** MAC length in base64url chars. 22 chars ≈ 132 bits — far beyond forgeable, much shorter. */
const CODE_MAC_CHARS = 22;

interface CodePayload {
  nbf: number; // not-before (unix seconds)
  exp: number; // expiry (unix seconds)
  batch: number;
  n: string; // nonce, so two codes minted in the same second still differ
}

/** Verdicts are distinct internally for tests and logs; the API collapses them (see below). */
type CodeVerdict = "ok" | "not-a-code" | "bad-mac" | "too-early" | "expired" | "revoked";

function codeConfig(env: Env) {
  return {
    batch: Math.floor(numVar(env.PUBLISH_CODE_BATCH, 1)),
    ttlDays: numVar(env.PUBLISH_CODE_TTL_DAYS, DEFAULT_CODE_TTL_DAYS),
    delayHours: numVar(env.PUBLISH_CODE_DELAY_HOURS, DEFAULT_CODE_DELAY_HOURS),
    powBits: Math.floor(numVar(env.PUBLISH_CODE_POW_BITS, DEFAULT_POW_BITS)),
  };
}

/** base64url SHA-256 — the only form of a code we are ever willing to store. */
async function codeHash(code: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return bytesToB64url(new Uint8Array(d));
}

async function mintPublishCode(env: Env): Promise<{ code: string; nbf: number; exp: number } | null> {
  if (!env.ISSUE_KEY) return null;
  const { batch, ttlDays, delayHours } = codeConfig(env);
  const now = Math.floor(Date.now() / 1000);
  const nbf = now + Math.round(delayHours * 3600);
  const exp = nbf + Math.round(ttlDays * 86400);
  const payload: CodePayload = {
    nbf,
    exp,
    batch,
    n: bytesToB64url(crypto.getRandomValues(new Uint8Array(9))),
  };
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = (await hmac(env.ISSUE_KEY, `${CODE_CONTEXT}|${body}`)).slice(0, CODE_MAC_CHARS);
  return { code: `${CODE_VERSION}.${body}.${mac}`, nbf, exp };
}

/**
 * Verify the MAC, and only then believe anything the payload says.
 *
 * The order is load-bearing: parsing first and checking the seal afterwards would mean acting on
 * attacker-chosen JSON, and any bug in between would be reachable by anyone.
 */
async function verifyPublishCode(env: Env, code: string): Promise<CodeVerdict> {
  if (!env.ISSUE_KEY) return "not-a-code";
  const parts = code.split(".");
  if (parts.length !== 3 || parts[0] !== CODE_VERSION) return "not-a-code";
  const [, body, mac] = parts;

  const expected = (await hmac(env.ISSUE_KEY, `${CODE_CONTEXT}|${body}`)).slice(0, CODE_MAC_CHARS);
  if (!constantTimeEqual(mac, expected)) return "bad-mac";

  let payload: CodePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return "bad-mac"; // authentic MAC over unparseable bytes can only be our own bug
  }
  if (typeof payload?.nbf !== "number" || typeof payload?.exp !== "number") return "bad-mac";

  const now = Math.floor(Date.now() / 1000);
  if (now < payload.nbf) return "too-early";
  if (now >= payload.exp) return "expired";

  const batchRow = await env.DB
    .prepare("SELECT batch FROM revoked_batches WHERE batch = ?")
    .bind(payload.batch)
    .first();
  if (batchRow) return "revoked";

  const codeRow = await env.DB
    .prepare("SELECT code_hash FROM revoked_codes WHERE code_hash = ?")
    .bind(await codeHash(code))
    .first();
  if (codeRow) return "revoked";

  return "ok";
}

/**
 * May this credential publish at all?
 *
 * Fails CLOSED when nothing is configured. Wallflower shipped a version of this check that
 * returned true unconditionally while still being called, so the code read as though it gated
 * something and the endpoint was open to anyone who knew the URL. Hence the explicit first branch.
 */
async function admissionVerdict(
  env: Env,
  credential: string | undefined
): Promise<{ ok: boolean; reason: string }> {
  if (!env.PUBLISH_SECRET && !env.ISSUE_KEY) {
    return { ok: false, reason: "publisher authorization is not configured" };
  }
  if (!credential) return { ok: false, reason: "A publish key is required to broadcast." };

  if (env.PUBLISH_SECRET && constantTimeEqual(credential, env.PUBLISH_SECRET)) {
    return { ok: true, reason: "shared" };
  }

  switch (await verifyPublishCode(env, credential)) {
    case "ok":
      return { ok: true, reason: "code" };
    case "too-early":
      // Worth naming precisely: someone waiting out the activation delay has done nothing wrong,
      // and "your key is invalid" would send them to request another one.
      return { ok: false, reason: "This code is not active yet. Check back shortly." };
    case "expired":
      return { ok: false, reason: "This code has expired. Request a new one." };
    default:
      // revoked / bad-mac / not-a-code collapse into one message on purpose: distinguishing them
      // turns this endpoint into an oracle for probing which codes exist.
      return { ok: false, reason: "That publish key was not accepted." };
  }
}

// ── Proof of work for code requests ───────────────────────────────────────────────────────────
// Friction, not identification. It stops a script minting ten thousand codes; it does not stop a
// determined person minting ten, and no setting would without punishing the phone users this app
// is for. PUBLISH_CODE_DELAY_HOURS is the lever that actually bites.

async function mintPowChallenge(env: Env): Promise<string | null> {
  if (!env.ISSUE_KEY) return null;
  const issued = Math.floor(Date.now() / 1000).toString();
  return `${issued}.${await hmac(env.ISSUE_KEY, `${POW_CONTEXT}|${issued}`)}`;
}

async function powChallengeIsValid(env: Env, challenge: string): Promise<boolean> {
  if (!env.ISSUE_KEY) return false;
  const [issued, mac] = challenge.split(".");
  if (!issued || !mac) return false;
  const age = Math.floor(Date.now() / 1000) - Number(issued);
  if (!Number.isFinite(age) || age < -5 || age > POW_CHALLENGE_TTL_SECONDS) return false;
  return constantTimeEqual(mac, await hmac(env.ISSUE_KEY, `${POW_CONTEXT}|${issued}`));
}

/** Does SHA-256(challenge|nonce) start with at least `bits` zero bits? */
async function powIsValid(challenge: string, nonce: string, bits: number): Promise<boolean> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${challenge}|${nonce}`))
  );
  let seen = 0;
  for (const byte of digest) {
    if (byte === 0) {
      seen += 8;
      continue;
    }
    seen += Math.clz32(byte) - 24; // leading zeros within this byte
    break;
  }
  return seen >= bits;
}

async function handlePublishCodeRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  const { powBits, delayHours, ttlDays } = codeConfig(env);

  if (!env.ISSUE_KEY) {
    return Response.json({ error: "code issuance is not enabled" }, { status: 503 });
  }

  // GET /api/publish-code/challenge — a work target. Self-authenticating, so no nonce table is
  // needed and this stays stateless.
  if (request.method === "GET" && url.pathname === "/api/publish-code/challenge") {
    const challenge = await mintPowChallenge(env);
    if (!challenge) {
      return Response.json({ error: "code issuance is not enabled" }, { status: 503 });
    }
    return Response.json({
      challenge,
      bits: powBits,
      delay_hours: delayHours,
      ttl_days: ttlDays,
      expires_in: POW_CHALLENGE_TTL_SECONDS,
    });
  }

  // POST /api/publish-code/request — spend the work, receive a code.
  //
  // Nothing about the requester is read, logged, or stored. That is the feature: we cannot be
  // compelled to identify a broadcaster we never learned anything about. Cloudflare still sees the
  // requesting IP on its way in, which is why the page tells people to use a VPN or Tor — a limit
  // we can name honestly rather than paper over.
  if (request.method === "POST" && url.pathname === "/api/publish-code/request") {
    const body = (await request.json().catch(() => null)) as { challenge?: string; nonce?: string } | null;
    if (!body?.challenge || typeof body.nonce !== "string") {
      return Response.json({ error: "challenge and nonce required" }, { status: 400 });
    }
    if (!(await powChallengeIsValid(env, body.challenge))) {
      return Response.json({ error: "challenge expired — reload and try again" }, { status: 403 });
    }
    if (!(await powIsValid(body.challenge, body.nonce, powBits))) {
      return Response.json({ error: "proof of work is not valid" }, { status: 403 });
    }

    const minted = await mintPublishCode(env);
    if (!minted) {
      return Response.json({ error: "code issuance is not enabled" }, { status: 503 });
    }
    return Response.json({
      code: minted.code,
      active_at: new Date(minted.nbf * 1000).toISOString(),
      expires_at: new Date(minted.exp * 1000).toISOString(),
      active_immediately: delayHours === 0,
    });
  }

  return new Response("Not Found", { status: 404 });
}

/* ═════════════════════════ The kill switch ═════════════════════════ */
// The only moderation lever available to an operator who cannot see content. It does three things,
// and it is worth being exact about which of them binds whom:
//
//   1. No further placement or token is issued for the id.       (binds everyone, immediately)
//   2. Live browsers polling /api/stream/<id>/status stop.       (binds cooperating clients, ~5s)
//   3. The relay token in flight expires and is not reissued.    (binds ANY client, ≤ its TTL)
//
// (3) is the one that survives a patched client, which is why TOKEN_SOURCE=worker matters: when
// the broker mints the token we do not choose its lifetime, and the guarantee weakens to "whatever
// the broker chose". See tokenSource().

async function streamIsKilled(env: Env, streamId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT killed_at FROM stream_kill WHERE stream_id = ?")
    .bind(streamId)
    .first<{ killed_at: string | null }>();
  return !!row?.killed_at;
}

/* ═════════════════════════ Proof of link ═════════════════════════ */
// Before this, anyone who knew a broadcast name could be placed on a relay for it. The name is not
// a secret — it travels in every share link and is the moq track name — so "knows the name" was
// never evidence of anything. A viewer now presents a tag derived from the link's fragment key,
// which the broadcaster registered at go-live.
//
// The tag is HKDF over the fragment key with a DIFFERENT salt and a DIFFERENT info string than the
// media key, so it is cryptographically independent of it: every tag ever registered, plus every
// public salt, still decrypts nothing. It proves one thing only — the holder was given a link.
//
// A wrong tag is answered with 404, not 403. 403 would confirm the stream exists.

/** The tag the broadcaster registered for the live session of this name, if any. */
async function liveRouteTag(env: Env, streamId: string): Promise<{ tag: string | null } | null> {
  const row = await env.DB
    .prepare("SELECT route_tag FROM broadcasts WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1")
    .bind(streamId)
    .first<{ route_tag: string | null }>();
  return row ? { tag: row.route_tag } : null;
}

/* ═════════════════════════ Broker + relay tokens ═════════════════════════ */

const brokerBase = (env: Env): string => {
  if (env.BROKER_BASE) return env.BROKER_BASE.replace(/\/+$/, "");
  // Legacy var held the full assign URL; keep reading it so a rollback needs no code change.
  if (env.FLEET_ENDPOINT) return env.FLEET_ENDPOINT.replace(/\/cdn\/assign\/?$/, "").replace(/\/+$/, "");
  return "https://tinymoq.com";
};

/**
 * The credential we present to the broker.
 *
 * PUBLIC_KEY (the `pk_` publishable key) first, and that ordering is measured rather than assumed.
 * Against tinymoq on 14 Aug 2026, the two credentials get materially different answers from
 * /cdn/assign for role=publish:
 *
 *   Bearer pk_…    → {relay, box, origin_endpoint_id, jwt}   ← complete; publishing works
 *   Bearer cdn_…   → {relay, box}                            ← no origin id, no token
 *
 * Without origin_endpoint_id a viewer's edge has nothing to pull from, so the cdn_ customer token
 * cannot carry this path today whatever we would prefer about its secrecy.
 *
 * Be clear about what that costs, because it is the one claim this file must not overstate: the
 * publishable key is PUBLIC and always was. Moving assignment behind this Worker therefore does
 * NOT make the broker unreachable to someone who reads it out of the repository. What it does buy
 * is that every request arriving through earthseed.live is admitted, name-checked, tag-checked and
 * kill-checked first — and that is what binds our client and our origin, which is where essentially
 * everyone is. Closing the remaining gap needs a broker-side credential that is genuinely secret;
 * that is a tinymoq change, not one this repository can make.
 */
const brokerCredential = (env: Env): string | null => env.PUBLIC_KEY ?? env.CDN_API_TOKEN ?? null;

/** "worker" (we mint, we choose the TTL) or "broker" (pass its token through). Default: broker. */
function tokenSource(env: Env): "worker" | "broker" {
  return env.TOKEN_SOURCE === "worker" && env.MOQ_AUTH_PRIVATE_JWK ? "worker" : "broker";
}

const PUBLISHER_TOKEN_TTL_DEFAULT = 12 * 3600;
const VIEWER_TOKEN_TTL_DEFAULT = 3600;

async function brokerAssign(env: Env, body: Record<string, unknown>): Promise<Record<string, any>> {
  const credential = brokerCredential(env);
  if (!credential) return { error: "relay placement is not configured" };
  try {
    const r = await fetch(`${brokerBase(env)}/cdn/assign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
    });
    const d = (await r.json().catch(() => null)) as Record<string, any> | null;
    if (!r.ok || !d || d.error) return { error: (d && (d.error || d.reason)) || `HTTP ${r.status}` };
    return d;
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * The token that authorizes ONE WebTransport session, scope-limited to this broadcast.
 *
 * `put` and `get` are separate lists rather than a role flag, so a viewer's token is structurally
 * incapable of publishing — not merely un-permitted. It carries no identity and is not a content
 * key: holding it lets you move ciphertext, nothing more.
 */
async function mintRelayToken(
  env: Env,
  broadcast: string,
  role: "publish" | "watch",
  ttlSeconds: number,
  brokerJwt: string | null
): Promise<string | null> {
  if (tokenSource(env) === "broker") return brokerJwt;
  const claims: MoqClaims = {
    put: role === "publish" ? [broadcast] : [],
    get: role === "watch" ? [broadcast] : [],
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  try {
    return await mintEd25519Token(env.MOQ_AUTH_PRIVATE_JWK!, claims);
  } catch (e) {
    console.error("mintRelayToken:", e);
    return brokerJwt; // a signing failure must not take broadcasting down with it
  }
}

async function handlePlacementRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  // GET /api/broadcast/challenge?broadcast=… — the broker's claim challenge, relayed. The
  // broadcaster signs it with the private half of the key its name is made of.
  if (request.method === "GET" && url.pathname === "/api/broadcast/challenge") {
    const broadcast = url.searchParams.get("broadcast") ?? "";
    if (!isNodeId(broadcast)) return Response.json({ error: "bad broadcast name" }, { status: 400 });
    try {
      const r = await fetch(`${brokerBase(env)}/cdn/challenge?broadcast=${encodeURIComponent(broadcast)}`);
      if (!r.ok) return Response.json({ error: "no challenge available" }, { status: 502 });
      const d = (await r.json().catch(() => null)) as { challenge?: string } | null;
      if (!d?.challenge) return Response.json({ error: "no challenge available" }, { status: 502 });
      return Response.json({ challenge: d.challenge });
    } catch {
      return Response.json({ error: "no challenge available" }, { status: 502 });
    }
  }

  // POST /api/broadcast/start — admission, ownership, placement, and the route tag, in that order.
  if (request.method === "POST" && url.pathname === "/api/broadcast/start") {
    const body = (await request.json().catch(() => null)) as {
      broadcast?: string;
      challenge?: string;
      sig?: string;
      code?: string;
      tag?: string;
    } | null;

    const broadcast = body?.broadcast ?? "";
    if (!isNodeId(broadcast)) return Response.json({ error: "bad broadcast name" }, { status: 400 });

    // Admission BEFORE anything else: no relay is asked for, no row is written, and no work is
    // done on behalf of someone who may not publish at all.
    const admission = await admissionVerdict(env, body?.code?.trim());
    if (!admission.ok) {
      return Response.json({ error: admission.reason, need_code: true }, { status: 403 });
    }

    if (await streamIsKilled(env, broadcast)) {
      return Response.json({ error: "This stream has been terminated." }, { status: 410 });
    }

    if (!body?.challenge || !body?.sig || !(await claimIsValid(broadcast, body.challenge, body.sig))) {
      return Response.json({ error: "could not verify this broadcast name is yours" }, { status: 403 });
    }

    const assigned = await brokerAssign(env, {
      broadcast,
      role: "publish",
      challenge: body.challenge,
      sig: body.sig,
    });
    if (assigned.error) return Response.json({ error: String(assigned.error) }, { status: 502 });
    if (!assigned.relay || !assigned.origin_endpoint_id) {
      // Name what was missing. An assign failure is otherwise completely opaque from the browser,
      // and "incomplete" without the field names sent an hour down the wrong path once already.
      // Keys only — the response can carry a token.
      console.error("assign incomplete; broker returned keys:", Object.keys(assigned).join(","));
      return Response.json(
        { error: `origin assign incomplete (broker sent: ${Object.keys(assigned).join(", ") || "nothing"})` },
        { status: 502 }
      );
    }

    // One live row per session. Close any earlier one for this name first: a broadcaster who
    // reloads mid-stream would otherwise leave a stale row whose route_tag is from the OLD link,
    // and every viewer of the NEW link would be turned away by proof-of-link.
    await env.DB
      .prepare("UPDATE broadcasts SET ended_at = datetime('now') WHERE stream_id = ? AND ended_at IS NULL")
      .bind(broadcast)
      .run();
    const tag = typeof body.tag === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(body.tag) ? body.tag : null;
    await env.DB
      .prepare("INSERT INTO broadcasts (stream_id, route_tag) VALUES (?, ?)")
      .bind(broadcast, tag)
      .run();

    const ttl = Math.floor(numVar(env.PUBLISHER_TOKEN_TTL, PUBLISHER_TOKEN_TTL_DEFAULT));
    const jwt = await mintRelayToken(env, broadcast, "publish", ttl, assigned.jwt ?? null);
    return Response.json({
      relay_url: `https://${assigned.relay}/`,
      origin_endpoint_id: assigned.origin_endpoint_id,
      jwt,
      ttl,
    });
  }

  // POST /api/broadcast/end — best-effort. Only closes the row; it does not need to be trusted,
  // because a stale live row costs nothing but a superseded route tag, which the start path above
  // already handles.
  if (request.method === "POST" && url.pathname === "/api/broadcast/end") {
    const body = (await request.json().catch(() => null)) as { broadcast?: string } | null;
    if (!isNodeId(body?.broadcast)) return Response.json({ error: "bad broadcast name" }, { status: 400 });
    await env.DB
      .prepare("UPDATE broadcasts SET ended_at = datetime('now') WHERE stream_id = ? AND ended_at IS NULL")
      .bind(body!.broadcast)
      .run();
    return Response.json({ ok: true });
  }

  // POST /api/watch/start — proof of link, then placement. Also the renewal endpoint: a viewer
  // whose token is about to expire calls this again, and a terminated stream stops being reissued.
  if (request.method === "POST" && url.pathname === "/api/watch/start") {
    const body = (await request.json().catch(() => null)) as {
      broadcast?: string;
      origin?: string;
      tag?: string;
      ttl?: number;
    } | null;

    const broadcast = body?.broadcast ?? "";
    if (!isNodeId(broadcast)) return new Response("Not Found", { status: 404 });

    // 404 for every refusal below, so this endpoint never confirms that a stream exists to
    // somebody who cannot already watch it.
    if (await streamIsKilled(env, broadcast)) return new Response("Not Found", { status: 404 });

    const live = await liveRouteTag(env, broadcast);
    if (live?.tag) {
      const presented = typeof body?.tag === "string" ? body.tag : "";
      if (!constantTimeEqual(presented, live.tag)) return new Response("Not Found", { status: 404 });
    }
    // live === null (nobody is broadcasting this name) falls through to the broker, which answers
    // "not live" — the same answer a viewer who opened the link early has always got.

    const assigned = await brokerAssign(env, {
      broadcast,
      role: "watch",
      origin: body?.origin ?? "",
      xport: "iroh",
    });
    if (assigned.error) return Response.json({ error: String(assigned.error) }, { status: 502 });
    if (!assigned.relay) return Response.json({ error: "edge assign incomplete" }, { status: 502 });

    const configured = Math.floor(numVar(env.VIEWER_TOKEN_TTL, VIEWER_TOKEN_TTL_DEFAULT));
    // A test may ask for a shorter one; it may never ask for a longer one.
    const requested = Math.floor(numVar(body?.ttl as unknown as string, configured));
    const ttl = Math.max(10, Math.min(configured, requested));
    const jwt = await mintRelayToken(env, broadcast, "watch", ttl, assigned.jwt ?? null);
    return Response.json({ relay_url: `https://${assigned.relay}/`, jwt, ttl });
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * GET /api/stream/<id>/status?tag=… — "should I still be showing this?"
 *
 * Polled by both pages. Gated on the same proof of link as placement, so it cannot be used to
 * enumerate which names are live. Answers 404 rather than {live:false} for an unknown name, for
 * the same reason.
 */
async function handleStreamStatus(request: Request, env: Env, url: URL): Promise<Response> {
  const m = url.pathname.match(/^\/api\/stream\/([a-z2-7]+)\/status$/);
  if (request.method !== "GET" || !m || !isNodeId(m[1])) {
    return new Response("Not Found", { status: 404 });
  }
  const streamId = m[1];
  const killed = await streamIsKilled(env, streamId);
  if (killed) return Response.json({ killed: true, live: false });

  const live = await liveRouteTag(env, streamId);
  if (live?.tag && !constantTimeEqual(url.searchParams.get("tag") ?? "", live.tag)) {
    return new Response("Not Found", { status: 404 });
  }
  return Response.json({ killed: false, live: !!live });
}

/* ═════════════════════════ Abuse reports ═════════════════════════ */
// The counterpart to the kill switch. The lever came first and had no sensor: because we cannot
// decrypt a stream, every abuse signal must come from someone who holds a key, which means a
// viewer. Without this endpoint we learn about a problem only from outside complaints.

const REPORT_CATEGORIES = new Set([
  "sexual-content-involving-minors",
  "violence-or-threats",
  "non-consensual-content",
  "harassment",
  "other",
]);
const REPORT_NOTE_MAX = 500;
/** One hostile invitee must not be able to manufacture a pile of reports about one stream. */
const REPORT_PER_STREAM_PER_HOUR = 10;
/** Backstop against someone filling the table with reports about ids that never existed. */
const REPORT_GLOBAL_PER_HOUR = 300;

async function handleReportRoutes(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  // GET /api/report/config — what the dialog should offer. Read at open time so the evidence-link
  // option can be turned off by unsetting a secret rather than by shipping new client code.
  if (request.method === "GET" && url.pathname === "/api/report/config") {
    return Response.json({ categories: [...REPORT_CATEGORIES], evidence: !!env.REPORT_WEBHOOK });
  }
  if (request.method !== "POST" || url.pathname !== "/api/report") {
    return new Response("Not Found", { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as {
    stream_id?: string;
    category?: string;
    note?: string;
    evidence_url?: string;
  } | null;

  const streamId = body?.stream_id?.trim();
  if (!streamId || streamId.length > 64) {
    return Response.json({ error: "stream_id required" }, { status: 400 });
  }
  const category = body?.category && REPORT_CATEGORIES.has(body.category) ? body.category : "other";
  const note = (body?.note ?? "").slice(0, REPORT_NOTE_MAX).trim() || null;

  // Deliberately NOT checked: whether this stream id exists. Rejecting unknown ids would turn the
  // endpoint into an oracle for probing which broadcasts are real. Junk reports are the cheaper
  // problem, and the caps below bound them.
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM reports WHERE stream_id = ? AND created_at > datetime('now','-1 hour')")
    .bind(streamId)
    .first<{ n: number }>();
  const total = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM reports WHERE created_at > datetime('now','-1 hour')")
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= REPORT_PER_STREAM_PER_HOUR || (total?.n ?? 0) >= REPORT_GLOBAL_PER_HOUR) {
    // 202, not 429: telling a reporter they have been rate-limited invites them to work around it,
    // and a report already filed is genuinely enough.
    return Response.json({ ok: true, recorded: false }, { status: 202 });
  }

  await env.DB
    .prepare("INSERT INTO reports (stream_id, category, note) VALUES (?, ?, ?)")
    .bind(streamId, category, note)
    .run();

  // The evidence link — the viewer's own share link, fragment and all — is the ONE thing that
  // could let us verify an accusation, because it is the only way we can decrypt anything. It is
  // forwarded to the operator and never persisted: writing it to D1 would mean this database
  // finally did contain a way to decrypt a broadcast, which is precisely the property the whole
  // design is built to keep true. A viewer must tick a box to send it at all.
  const evidenceUrl =
    typeof body?.evidence_url === "string" && body.evidence_url.length <= 2048 ? body.evidence_url : undefined;

  if (env.REPORT_WEBHOOK) {
    ctx.waitUntil(
      fetch(env.REPORT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `earthseed report: ${streamId} — ${category}${note ? `\n${note}` : ""}${
            evidenceUrl ? `\nviewer supplied a link: ${evidenceUrl}` : "\n(no link supplied — cannot verify)"
          }`,
          stream_id: streamId,
          category,
          note,
          evidence_url: evidenceUrl ?? null,
          kill: `POST /api/admin/kill {"stream_id":"${streamId}"}`,
        }),
      }).catch((e) => console.error("report webhook failed:", e))
    );
  }

  return Response.json({ ok: true, recorded: true });
}

/* ═════════════════════════ Admin ═════════════════════════ */

async function handleAdminRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // From the ADMIN_PASSWORD secret. Never hardcoded; unset means admin fails closed.
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) return Response.json({ error: "admin disabled" }, { status: 503 });

  const authHeader = request.headers.get("Authorization");
  const authed = !!authHeader && constantTimeEqual(authHeader, `Bearer ${adminPassword}`);

  if (method === "GET" && path === "/api/admin/verify") {
    return authed ? Response.json({ valid: true }) : Response.json({ valid: false }, { status: 401 });
  }
  if (!authed) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // POST /api/admin/kill — terminate one stream. See "The kill switch" above for exactly what
  // this binds and when. It is deliberately the most we can do: we cannot see what was streamed,
  // cannot produce it for anyone, and cannot tell a complainant what it contained.
  if (method === "POST" && path === "/api/admin/kill") {
    const body = (await request.json().catch(() => null)) as { stream_id?: string; note?: string } | null;
    if (!body?.stream_id) return Response.json({ error: "stream_id required" }, { status: 400 });
    await env.DB
      .prepare(`
        INSERT INTO stream_kill (stream_id, killed_at, note)
        VALUES (?, datetime('now'), ?)
        ON CONFLICT(stream_id) DO UPDATE SET killed_at = datetime('now'), note = excluded.note
      `)
      .bind(body.stream_id, body.note ?? null)
      .run();
    // End the live row too, so the name is not left looking live to the status poll.
    await env.DB
      .prepare("UPDATE broadcasts SET ended_at = datetime('now') WHERE stream_id = ? AND ended_at IS NULL")
      .bind(body.stream_id)
      .run();
    return Response.json({ success: true, stream_id: body.stream_id, killed: true });
  }

  // POST /api/admin/unkill — let a stream id be used again.
  if (method === "POST" && path === "/api/admin/unkill") {
    const body = (await request.json().catch(() => null)) as { stream_id?: string } | null;
    if (!body?.stream_id) return Response.json({ error: "stream_id required" }, { status: 400 });
    await env.DB.prepare("DELETE FROM stream_kill WHERE stream_id = ?").bind(body.stream_id).run();
    return Response.json({ success: true, stream_id: body.stream_id, killed: false });
  }

  // GET /api/admin/killed — what has been terminated, and why.
  if (method === "GET" && path === "/api/admin/killed") {
    const rows = await env.DB
      .prepare("SELECT stream_id, killed_at, note FROM stream_kill ORDER BY killed_at DESC")
      .all();
    return Response.json({ killed: rows.results });
  }

  // GET /api/admin/reports — the abuse queue. Unhandled first, then recent handled ones.
  //
  // This is a queue, NOT an automation. Nothing in here kills a stream; an operator reads it and
  // decides. A threshold that fired by itself would be a harassment tool, since filing a report
  // needs nothing but a share link.
  //
  // The rows carry no evidence link and never will. Where one was offered, it went to
  // REPORT_WEBHOOK at the moment of the report and was not written down.
  if (method === "GET" && path === "/api/admin/reports") {
    const rows = await env.DB
      .prepare(`
        SELECT r.id, r.stream_id, r.category, r.note, r.created_at, r.handled_at,
               (SELECT killed_at FROM stream_kill k WHERE k.stream_id = r.stream_id) AS killed_at,
               EXISTS(SELECT 1 FROM broadcasts b WHERE b.stream_id = r.stream_id AND b.ended_at IS NULL) AS live
        FROM reports r
        ORDER BY r.handled_at IS NOT NULL, r.created_at DESC
        LIMIT 200
      `)
      .all();
    return Response.json({ reports: rows.results });
  }

  // POST /api/admin/reports/ack — mark reports seen so the queue stops re-presenting them.
  if (method === "POST" && path === "/api/admin/reports/ack") {
    const body = (await request.json().catch(() => null)) as { ids?: number[]; stream_id?: string } | null;
    if (body?.stream_id) {
      await env.DB
        .prepare("UPDATE reports SET handled_at = datetime('now') WHERE stream_id = ? AND handled_at IS NULL")
        .bind(body.stream_id)
        .run();
      return Response.json({ success: true, stream_id: body.stream_id });
    }
    const ids = (body?.ids ?? []).filter((n) => Number.isInteger(n)).slice(0, 200);
    if (!ids.length) return Response.json({ error: "ids or stream_id required" }, { status: 400 });
    await env.DB
      .prepare(`UPDATE reports SET handled_at = datetime('now') WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .run();
    return Response.json({ success: true, acked: ids.length });
  }

  // POST /api/admin/revoke-batch — cut off an entire issuance cohort before its codes expire.
  // Bump PUBLISH_CODE_BATCH first if you want new requests to keep working.
  if (method === "POST" && path === "/api/admin/revoke-batch") {
    const body = (await request.json().catch(() => null)) as { batch?: number; note?: string; undo?: boolean } | null;
    if (!Number.isInteger(body?.batch)) {
      return Response.json({ error: "batch (integer) required" }, { status: 400 });
    }
    // `undo` because revocation is a blunt instrument aimed at a cohort, and a mis-typed batch
    // number would otherwise strand every broadcaster in it until their codes expired.
    if (body?.undo) {
      await env.DB.prepare("DELETE FROM revoked_batches WHERE batch = ?").bind(body.batch).run();
      return Response.json({ success: true, batch: body.batch, revoked: false });
    }
    await env.DB
      .prepare("INSERT OR REPLACE INTO revoked_batches (batch, revoked_at, note) VALUES (?, datetime('now'), ?)")
      .bind(body!.batch, body?.note ?? null)
      .run();
    return Response.json({ success: true, batch: body!.batch, revoked: true });
  }

  // POST /api/admin/revoke-code — cut off ONE code without learning whose it is.
  //
  // We store SHA-256 of the code, never the code. That is enough to reject it on presentation and
  // useless for anything else — in particular it does not become a way to start tracking who
  // broadcasts. Needing to revoke someone is not a reason to begin identifying everyone.
  if (method === "POST" && path === "/api/admin/revoke-code") {
    const body = (await request.json().catch(() => null)) as { code?: string; note?: string; undo?: boolean } | null;
    if (!body?.code) return Response.json({ error: "code required" }, { status: 400 });
    const hash = await codeHash(body.code.trim());
    if (body.undo) {
      await env.DB.prepare("DELETE FROM revoked_codes WHERE code_hash = ?").bind(hash).run();
      return Response.json({ success: true, code_hash: hash, revoked: false });
    }
    await env.DB
      .prepare("INSERT OR REPLACE INTO revoked_codes (code_hash, revoked_at, note) VALUES (?, datetime('now'), ?)")
      .bind(hash, body.note ?? null)
      .run();
    return Response.json({ success: true, code_hash: hash, revoked: true });
  }

  // POST /api/admin/mint-code — issue a code directly, bypassing the proof of work. For handing
  // one to someone out of band without making them grind through the request page.
  if (method === "POST" && path === "/api/admin/mint-code") {
    const minted = await mintPublishCode(env);
    if (!minted) return Response.json({ error: "ISSUE_KEY is not configured" }, { status: 503 });
    return Response.json({
      code: minted.code,
      active_at: new Date(minted.nbf * 1000).toISOString(),
      expires_at: new Date(minted.exp * 1000).toISOString(),
    });
  }

  return new Response("Not Found", { status: 404 });
}
