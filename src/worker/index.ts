// Cloudflare Worker entry point
// Handles API routes for authentication, falls back to static assets

import {
  getGoogleAuthUrl,
  exchangeCodeForTokens as exchangeGoogleCode,
  getGoogleUserInfo,
} from "./auth/google";
import {
  getMicrosoftAuthUrl,
  exchangeMicrosoftCodeForTokens,
  getMicrosoftUserInfo,
} from "./auth/microsoft";
import {
  getDiscordAuthUrl,
  exchangeDiscordCodeForTokens,
  getDiscordUserInfo,
  getDiscordAvatarUrl,
} from "./auth/discord";
import {
  createSessionToken,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromCookie,
} from "./auth/session";
import { mintEd25519Token, mintHs256Token, publicVerifyJwk, type MoqClaims } from "./auth/moq-token";

// Per-stream live chat Durable Object (WebSocket hibernation). Re-exported so wrangler
// can bind it; see wrangler.jsonc durable_objects + migrations.
export { ChatRoom } from "./chat-room";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string; // secret (wrangler secret put) — admin API bearer; unset ⇒ admin disabled
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  // BYOK: tenant's Ed25519 PRIVATE signing key as an OKP JWK (JSON string, includes `d`).
  // When set, the Worker mints EdDSA tokens with it (only the matching public key is
  // registered with TinyMoQ). When unset, the Worker falls back to the per-stream HS256
  // key returned by /assign (managed mode). Optional so the file is tenant-agnostic.
  MOQ_AUTH_PRIVATE_JWK?: string;
  // DIRECT mode only (FLEET_MODE=direct): the provisioning bearer for a relay box's control
  // API (/assign, /release) — i.e. the box bearer. Legitimate only when you operate the box
  // yourself (operator == customer). In BROKERED mode this must NOT be set: the box bearer
  // stays with the broker; leaking it into the customer app defeats Path 2.
  TINYMOQ_PROVISION_KEY?: string;
  // BROKERED mode only (FLEET_MODE=brokered): the operator-issued CUSTOMER token presented
  // to the broker's assign URL. This is the customer's credential — NOT the box bearer
  // (which is never seen in brokered mode). Set it as a wrangler secret.
  CDN_API_TOKEN?: string;
  // TinyMoQ fleet endpoint: the base URL the Worker hits to get a relay for a broadcast.
  // Switching endpoints (or paths, see FLEET_MODE) is a config change, not a code change —
  // set it in wrangler.jsonc `vars`. Optional; falls back to the historical box when unset.
  //   - direct mode:   the relay box BASE, e.g. https://cdn.tinymoq.com (Worker appends /assign + /release)
  //   - brokered mode: the broker's full ASSIGN URL, e.g. https://tinymoq.com/cdn/assign (Worker POSTs to it)
  // The credential is mode-specific (TINYMOQ_PROVISION_KEY in direct, CDN_API_TOKEN in
  // brokered). MOQ_AUTH_PRIVATE_JWK's public half is installed as the fleet's verify_jwk —
  // BYOK is unchanged across both paths.
  FLEET_ENDPOINT?: string;
  // How the Worker gets a relay: "direct" (Path 1 — call a relay box's /assign yourself) or
  // "brokered" (Path 2 — POST {broadcast} to a CDN operator's broker, which selects the box
  // and returns {relay}). Default "direct". In brokered mode the Worker never sees box
  // topology and holds no per-box secret, so add/remove boxes needs no config change.
  FLEET_MODE?: string;
  // Mode C (Enterprise) — EARTHSEED-DRIVEN steering. When set, earthseed ITSELF (not the
  // broker, not any external resolve API) steers matching viewers to this dedicated edge
  // host (e.g. "erik.moqcdn.net"). The browser couriers its BYOK watch token to the edge's
  // /assign, which validates it against earthseed's verify_jwk (box-side "C1" — no bearer in
  // the browser). Unset => Mode C is off and the viewer route is pure brokered B/A.
  ENTERPRISE_EDGE_HOST?: string;
  // Optional ASN allow-list for ENTERPRISE_EDGE_HOST (comma-separated, e.g. "13335,7922").
  // Empty/unset => steer ALL viewers to the edge. Set to gate steering to specific networks.
  ENTERPRISE_ASNS?: string;
  // How the edge sources the broadcast: "crosspull" (default) — the edge pulls it from the
  // publisher's origin relay, so the Worker hands the browser `edgeHost` (real origin
  // host:port) + a cluster-flagged `pullToken`. "standalone" — the publisher is already on
  // the edge (edge = origin), so neither is sent and the only new piece is C1 viewer auth.
  ENTERPRISE_MODE?: string;
  // Per-stream live chat rooms (one Durable Object instance per streamId).
  CHAT_ROOMS: DurableObjectNamespace;
  // Media-key salts (KV). Holds the operator's global kill-switch salt (key
  // "salt:global") and each live broadcast's rotatable salt (key
  // "salt:stream:<id>" → {stream, epoch, ownerHash}). Salts are NOT secret: they
  // decode nothing without the #k= fragment key, so serving them publicly is safe.
  // The content key is CK = HKDF(fragmentKey, globalSalt‖streamSalt); rotating a
  // salt re-keys future media (see src/crypto/media-crypto.ts deriveMediaKey).
  SALTS: KVNamespace;
  // Optional seed for the global kill-switch salt when KV "salt:global" is unset
  // (base64url). Operators rotate the live value via KV, not this var.
  GLOBAL_MEDIA_SALT?: string;
}

interface User {
  id: number;
  google_id: string | null;
  microsoft_id: string | null;
  discord_id: string | null;
  email: string;
  name: string;
  avatar_url: string;
  created_at: string;
  updated_at: string;
}

type Provider = "google" | "microsoft" | "discord";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApiRoutes(request, env, url);
    }

    // SPA routes - serve index.html for stream ID paths, /stats, and /{stream}/stats
    // Stream IDs are 5 lowercase alphanumeric characters
    const pathWithoutSlash = url.pathname.slice(1);
    const isStreamId = /^[a-z0-9]{5}$/.test(pathWithoutSlash);
    const isStatsPage = url.pathname === "/stats";
    const isStatsMapPage = url.pathname === "/stats/map";
    const isGreetPage = url.pathname === "/greet";
    const isStreamStatsPage = /^\/[a-z0-9]{5}\/stats$/.test(url.pathname);
    const isStreamStatsMapPage = /^\/[a-z0-9]{5}\/stats\/map$/.test(url.pathname);
    const isClearDataPage = url.pathname === "/cleardata";
    // Tier-2: html_handling="none" disables the automatic "/" → index.html mapping, so
    // serve the landing page for the root explicitly here. (/send.html + /view.html
    // serve literally as static assets; only "/" needs this.)
    const isRoot = url.pathname === "/";

    if (isRoot || isStreamId || isStatsPage || isStatsMapPage || isGreetPage || isStreamStatsPage || isStreamStatsMapPage || isClearDataPage) {
      const indexUrl = new URL("/index.html", url.origin);
      return env.ASSETS.fetch(new Request(indexUrl.toString(), {
        method: request.method,
        headers: request.headers,
      }));
    }

    // Fall through to static assets
    return env.ASSETS.fetch(request);
  },
};

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  try {
    // GET /api/pubkey — the PUBLIC verify JWK for this deployment's BYOK signing key, as
    // plain JSON, for an operator to paste into their CDN console as the verify_jwk.
    // Public material only; the private half (MOQ_AUTH_PRIVATE_JWK) is never exposed here.
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

    // Media-key salts. The content key never lives here — it is derived in the
    // browser as HKDF(#k= fragment, globalSalt ‖ streamSalt), so these values
    // decode nothing on their own and are safe to serve publicly.
    //   GET /api/salt/:streamId  → { global, stream|null, epoch }
    //   PUT /api/salt/:streamId  → set/rotate the stream salt (owner-gated), bump epoch
    const saltMatch = url.pathname.match(/^\/api\/salt\/([a-z0-9]{5}|[a-z2-7]{52})$/);
    if (saltMatch) {
      return handleSaltRoute(request, env, saltMatch[1]);
    }

    // ── Watch-by-pubkey (DHT) provisioning ──────────────────────────────────
    // The DHT (pkarr) is the DIRECTORY (pubkey→origin); these two endpoints are the only
    // server involvement, and only to keep the fleet provisioning bearer out of the browser.
    // They store NO broadcast list. Media stays relay-blind encrypted (browser #k= + salt).
    const NODE_ID_RE = /^[a-z2-7]{52}$/;
    const now = Math.floor(Date.now() / 1000);

    // POST /api/publish { node_id, publisher_cdn? } → assign an origin for this broadcaster and
    // report its iroh EndpointId, which the browser writes into its signed DHT record.
    if (request.method === "POST" && url.pathname === "/api/publish") {
      const body = (await request.json().catch(() => ({}))) as { node_id?: string; publisher_cdn?: string };
      const nodeId = body.node_id ?? "";
      if (!NODE_ID_RE.test(nodeId)) return Response.json({ error: "bad node_id" }, { status: 400 });
      const cdn = body.publisher_cdn && isFleetHost(env, body.publisher_cdn) ? body.publisher_cdn : undefined;
      const relay = await assignRelay(env, nodeId, cdn, undefined, env.TINYMOQ_PROVISION_KEY, undefined, undefined, request);
      if (!relay) return Response.json({ error: "origin assign failed" }, { status: 502 });
      const eid = await fetchOriginEndpointId(relay.host, relay.port);
      if (!eid) return Response.json({ error: "origin endpoint id unavailable" }, { status: 502 });
      // Publisher token scoped to the BARE nodeId — the exact moq media track this path
      // publishes under (NOT broadcastName()'s .hang form). The fleet is token-gated, so a
      // token-less publish is rejected; a null mint (no BYOK key) fails the publish connect closed.
      const pubJwt = await tryMintMoqToken(env, {
        put: [nodeId],
        get: [nodeId],
        exp: now + PUBLISHER_TOKEN_TTL,
      }, relay.key);
      return Response.json({
        relay_url: `https://${relay.host}:${relay.port}/`,
        origin_endpoint_id: eid,
        broadcast: nodeId,
        jwt: pubJwt,
      });
    }

    // POST /api/edge { node_id, origin } → assign an edge on the viewer's nearest fleet that
    // pulls from the origin over iroh (origin = the EndpointId the browser resolved off the DHT).
    if (request.method === "POST" && url.pathname === "/api/edge") {
      const body = (await request.json().catch(() => ({}))) as { node_id?: string; origin?: string };
      const nodeId = body.node_id ?? "";
      const origin = body.origin ?? "";
      if (!NODE_ID_RE.test(nodeId)) return Response.json({ error: "bad node_id" }, { status: 400 });
      if (!/^[0-9a-f]{64}$/i.test(origin)) return Response.json({ error: "bad origin endpoint id" }, { status: 400 });
      // ONE subscribe-only token scoped to the bare nodeId: serves BOTH the browser's viewer
      // ?jwt= AND the pull pass the broker forwards to the edge's iroh cluster-connect.
      const token = await tryMintMoqToken(env, {
        put: [],
        get: [nodeId],
        exp: now + VIEWER_TOKEN_TTL,
      });
      // Brokered: hand the broker the EID origin + pull token + xport and let it place the
      // viewer (edge or origin). Direct mode assigns a local edge with the same token as the pull pass.
      const relay = fleetMode(env) === "brokered"
        ? await assignViaBroker(env, nodeId, request, { origin, pull: token, xport: "iroh" })
        : await assignRelay(env, nodeId, undefined, origin, env.TINYMOQ_PROVISION_KEY, token, "iroh", request);
      if (!relay) return Response.json({ error: "edge assign failed" }, { status: 502 });
      return Response.json({ relay_url: `https://${relay.host}:${relay.port}/`, broadcast: nodeId, jwt: token });
    }

    // Provider-specific routes
    if (url.pathname.startsWith("/api/auth/google/")) {
      return handleProviderAuth(request, env, url, "google");
    }
    if (url.pathname.startsWith("/api/auth/microsoft/")) {
      return handleProviderAuth(request, env, url, "microsoft");
    }
    if (url.pathname.startsWith("/api/auth/discord/")) {
      return handleProviderAuth(request, env, url, "discord");
    }

    // Stream settings routes
    if (url.pathname.startsWith("/api/streams")) {
      return handleStreamRoutes(request, env, url);
    }

    // Admin routes
    if (url.pathname.startsWith("/api/admin/")) {
      return handleAdminRoutes(request, env, url);
    }

    // Stats routes
    if (url.pathname.startsWith("/api/stats/")) {
      return handleStatsRoutes(request, env, url);
    }

    // Legacy routes (backwards compatibility - default to Google)
    switch (url.pathname) {
      case "/api/auth/login":
        return handleLogin(env, url, "google");
      case "/api/auth/callback":
        return handleCallback(request, env, url, "google");
      case "/api/auth/logout":
        return handleLogout(url);
      case "/api/auth/me":
        return handleMe(request, env);
      default:
        return new Response("Not Found", { status: 404 });
    }
  } catch (error) {
    console.error("API error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function handleProviderAuth(
  request: Request,
  env: Env,
  url: URL,
  provider: Provider
): Promise<Response> {
  const action = url.pathname.split("/").pop();

  if (action === "login") {
    return Promise.resolve(handleLogin(env, url, provider));
  }
  if (action === "callback") {
    return handleCallback(request, env, url, provider);
  }

  return Promise.resolve(new Response("Not Found", { status: 404 }));
}

// GET /api/auth/{provider}/login - Redirect to OAuth provider
function handleLogin(env: Env, url: URL, provider: Provider): Response {
  const state = `${provider}:${crypto.randomUUID()}`;
  const redirectUri = `${url.origin}/api/auth/${provider}/callback`;

  let authUrl: string;

  switch (provider) {
    case "google":
      authUrl = getGoogleAuthUrl(env.GOOGLE_CLIENT_ID, redirectUri, state);
      break;
    case "microsoft":
      authUrl = getMicrosoftAuthUrl(env.MICROSOFT_CLIENT_ID, redirectUri, state);
      break;
    case "discord":
      authUrl = getDiscordAuthUrl(env.DISCORD_CLIENT_ID, redirectUri, state);
      break;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}

// GET /api/auth/{provider}/callback - Handle OAuth callback
async function handleCallback(
  request: Request,
  env: Env,
  url: URL,
  provider: Provider
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return Response.redirect(`${url.origin}/?error=oauth_denied`, 302);
  }

  if (!code || !state) {
    return Response.redirect(`${url.origin}/?error=invalid_request`, 302);
  }

  // Verify state (CSRF protection)
  const cookieHeader = request.headers.get("Cookie");
  const storedState = cookieHeader?.match(/oauth_state=([^;]*)/)?.[1];

  if (state !== storedState) {
    return Response.redirect(`${url.origin}/?error=invalid_state`, 302);
  }

  try {
    const redirectUri = `${url.origin}/api/auth/${provider}/callback`;
    let userInput: UserInput;

    switch (provider) {
      case "google": {
        const tokens = await exchangeGoogleCode(
          code,
          env.GOOGLE_CLIENT_ID,
          env.GOOGLE_CLIENT_SECRET,
          redirectUri
        );
        const googleUser = await getGoogleUserInfo(tokens.access_token);
        userInput = {
          provider: "google",
          provider_id: googleUser.id,
          email: googleUser.email,
          name: googleUser.name,
          avatar_url: googleUser.picture,
        };
        break;
      }
      case "microsoft": {
        const tokens = await exchangeMicrosoftCodeForTokens(
          code,
          env.MICROSOFT_CLIENT_ID,
          env.MICROSOFT_CLIENT_SECRET,
          redirectUri
        );
        const msUser = await getMicrosoftUserInfo(tokens.access_token);
        userInput = {
          provider: "microsoft",
          provider_id: msUser.id,
          email: msUser.mail || msUser.userPrincipalName,
          name: msUser.displayName,
          avatar_url: "", // Microsoft Graph doesn't return avatar URL directly
        };
        break;
      }
      case "discord": {
        const tokens = await exchangeDiscordCodeForTokens(
          code,
          env.DISCORD_CLIENT_ID,
          env.DISCORD_CLIENT_SECRET,
          redirectUri
        );
        const discordUser = await getDiscordUserInfo(tokens.access_token);
        userInput = {
          provider: "discord",
          provider_id: discordUser.id,
          email: discordUser.email || `${discordUser.id}@discord.user`,
          name: discordUser.global_name || discordUser.username,
          avatar_url: getDiscordAvatarUrl(discordUser.id, discordUser.avatar),
        };
        break;
      }
    }

    // Upsert user in D1
    const user = await upsertUser(env.DB, userInput);

    // Create session token
    const sessionToken = await createSessionToken(user.id, env.SESSION_SECRET);
    const isProduction = url.hostname !== "localhost";

    // Clear oauth_state cookie and set session cookie
    return new Response(null, {
      status: 302,
      headers: [
        ["Location", url.origin],
        ["Set-Cookie", setSessionCookie(sessionToken, isProduction)],
        ["Set-Cookie", "oauth_state=; Path=/; HttpOnly; Max-Age=0"],
      ],
    });
  } catch (err) {
    console.error("OAuth callback error:", err);
    return Response.redirect(`${url.origin}/?error=auth_failed`, 302);
  }
}

// GET /api/auth/logout - Clear session and redirect
function handleLogout(url: URL): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.origin,
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

// GET /api/auth/me - Return current user
async function handleMe(request: Request, env: Env): Promise<Response> {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = getSessionFromCookie(cookieHeader);

  // Get geolocation from Cloudflare request.cf object
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  const geo = {
    country: cf?.country || null,
    city: cf?.city || null,
    region: cf?.region || null,
    postalCode: cf?.postalCode || null,
    latitude: cf?.latitude?.toString() || null,
    longitude: cf?.longitude?.toString() || null,
    timezone: cf?.timezone || null,
    continent: cf?.continent || null,
  };

  if (!sessionToken) {
    return Response.json({ user: null, geo });
  }

  const session = await verifySessionToken(sessionToken, env.SESSION_SECRET);

  if (!session) {
    return Response.json({ user: null, geo });
  }

  const user = await getUserById(env.DB, session.userId);

  return Response.json({
    user: user
      ? {
          id: user.id,
          email: user.email,
          name: user.name,
          avatar_url: user.avatar_url,
        }
      : null,
    geo,
  });
}

// Database operations

interface UserInput {
  provider: Provider;
  provider_id: string;
  email: string;
  name: string;
  avatar_url: string;
}

async function upsertUser(db: D1Database, input: UserInput): Promise<User> {
  const providerColumn = `${input.provider}_id`;

  // Try to find existing user by provider ID
  const existing = await db
    .prepare(`SELECT * FROM users WHERE ${providerColumn} = ?`)
    .bind(input.provider_id)
    .first<User>();

  if (existing) {
    // Update existing user
    await db
      .prepare(
        `UPDATE users
         SET email = ?, name = ?, avatar_url = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(input.email, input.name, input.avatar_url, existing.id)
      .run();

    return { ...existing, email: input.email, name: input.name, avatar_url: input.avatar_url };
  }

  // Check if user exists with same email (link accounts)
  const existingByEmail = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(input.email)
    .first<User>();

  if (existingByEmail) {
    // Link new provider to existing account
    await db
      .prepare(
        `UPDATE users
         SET ${providerColumn} = ?, name = ?, avatar_url = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(input.provider_id, input.name, input.avatar_url, existingByEmail.id)
      .run();

    return {
      ...existingByEmail,
      [providerColumn]: input.provider_id,
      name: input.name,
      avatar_url: input.avatar_url
    };
  }

  // Insert new user
  const result = await db
    .prepare(
      `INSERT INTO users (${providerColumn}, email, name, avatar_url)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    .bind(input.provider_id, input.email, input.name, input.avatar_url)
    .first<User>();

  return result!;
}

async function getUserById(db: D1Database, id: number): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

// Stream settings routes handler
async function handleStreamRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/streams/:stream_id/chat - Live chat WebSocket (forwarded to the per-stream
  // Durable Object). Only for chat-enabled streams; everyone (broadcaster + viewers) can
  // connect. WS handshakes are GET requests.
  const chatMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/chat$/);
  if (chatMatch) {
    const streamId = chatMatch[1];
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const s = await env.DB
      .prepare("SELECT chat_enabled FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ chat_enabled: number }>();
    if (s?.chat_enabled !== 1) {
      return new Response("chat disabled", { status: 403 });
    }
    const id = env.CHAT_ROOMS.idFromName(streamId);
    return env.CHAT_ROOMS.get(id).fetch(request);
  }

  // GET /api/streams/:stream_id - Get stream settings (public)
  const streamIdMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})$/);
  if (method === "GET" && streamIdMatch) {
    const streamId = streamIdMatch[1];
    const stream = await env.DB
      .prepare("SELECT require_auth, overlay_html, encrypted, chat_enabled FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ require_auth: number; overlay_html: string | null; encrypted: number; chat_enabled: number }>();

    return Response.json({
      stream_id: streamId,
      require_auth: stream?.require_auth === 1,
      overlay_html: stream?.overlay_html || "",
      encrypted: true, // mandatory for every stream; the column is retained but no longer authoritative
      chat_enabled: stream?.chat_enabled === 1,
    });
  }

  // GET /api/streams/:stream_id/exists - Check if stream ID is in use (has active broadcast)
  const streamExistsMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/exists$/);
  if (method === "GET" && streamExistsMatch) {
    const streamId = streamExistsMatch[1];
    const activeBroadcast = await env.DB
      .prepare("SELECT id FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL LIMIT 1")
      .bind(streamId)
      .first<{ id: number }>();

    return Response.json({
      stream_id: streamId,
      exists: activeBroadcast !== null,
    });
  }

  // GET /api/streams/:stream_id/route - Relay hosting the live broadcast (public).
  // 404 = no live broadcast. Viewers use this to co-locate on the publisher's relay.
  //
  // IMPORTANT: relay ports are dynamic and can change DURING a live broadcast
  // (reap/respawn), so the stored D1 port goes stale. We therefore re-query the
  // autoscaler (/assign is sticky + idempotent → the broadcast's CURRENT relay)
  // and use D1 only to confirm the stream is live and which CDN cluster the
  // publisher is on. D1 is synced when the port has changed (for /admin + stats).
  //
  // Optional ?viewer-cdn=cdn-02.tinymoq.com pulls from a different CDN cluster
  // (push-to-one/pull-from-two), with origin = the publisher's CURRENT relay.
  const streamRouteMatch = path.match(/^\/api\/streams\/([a-z0-9]{5})\/route$/);
  if (method === "GET" && streamRouteMatch) {
    const streamId = streamRouteMatch[1];
    const row = await env.DB
      .prepare(
        "SELECT relay_host, relay_port FROM broadcast_events WHERE stream_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .bind(streamId)
      .first<{ relay_host: string | null; relay_port: number | null }>();

    if (!row?.relay_host) {
      return new Response("offline", { status: 404 });
    }
    const publisherCluster = row.relay_host; // cluster host, e.g. cdn.tinymoq.com / cdn-01.tinymoq.com

    // Authoritative current relay for this broadcast (sticky per name).
    const current = await assignRelay(env, streamId, publisherCluster, undefined, env.TINYMOQ_PROVISION_KEY);
    if (!current) {
      return new Response("offline", { status: 404 });
    }

    // Keep D1 in sync if the relay moved (reap/respawn) so admin/stats stay accurate.
    if (current.host !== publisherCluster || current.port !== row.relay_port) {
      await env.DB
        .prepare("UPDATE broadcast_events SET relay_host = ?, relay_port = ? WHERE stream_id = ? AND ended_at IS NULL")
        .bind(current.host, current.port, streamId)
        .run();
    }

    // Access control: the token IS the grant. For auth-required streams, only mint a
    // viewer token for a caller with a valid session — otherwise 401. Public streams
    // (require_auth = 0) mint for anyone. Future policies (allow-list, paid, geo) are
    // just additional "decide whether to mint" checks here; the relay has no ACL.
    const streamCfg = await env.DB
      .prepare("SELECT require_auth FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ require_auth: number }>();
    if (streamCfg?.require_auth === 1) {
      const user = await getAuthenticatedUser(request, env);
      if (!user) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
    }

    // ── Mode C (Enterprise) ────────────────────────────────────────────────
    // If this viewer's network (Cloudflare-provided ASN) has a PRIVATE on-net relay,
    // hand the browser the local relay address + the two tokens it needs and let IT
    // connect — no server can reach that relay. Runs BEFORE today's B/A logic. The
    // player sets ?noEnterprise=1 after a failed enterprise attempt to force B/A, and
    // any resolve failure simply falls through, so the viewer always gets the stream.
    const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
    const asn = cf?.asn ?? 0;
    const asOrg = cf?.asOrganization ?? "";
    const skipEnterprise = url.searchParams.get("noEnterprise") === "1";
    if (!skipEnterprise) {
      const ent = enterpriseEdge(env, asn, current);
      if (ent) {
        // crosspull (default): the edge pulls the broadcast from the publisher's origin, so we
        // hand the browser `edgeHost` (real origin host:port) + a cluster-flagged pullToken.
        // standalone: publisher is already on the edge — no origin/pull, just C1 viewer auth.
        const crossPull = (env.ENTERPRISE_MODE || "crosspull").trim().toLowerCase() !== "standalone";
        const now = Math.floor(Date.now() / 1000);
        // watchToken authorizes the browser to subscribe to THIS broadcast on the edge; the
        // edge validates it against earthseed's PUBLIC verify_jwk (BYOK EdDSA). pullToken is
        // the edge's cluster-flagged pass to pull from the origin (root get:[''] scope, matching
        // the working cross-CDN edge pull; short-lived as it's browser-couriered). If BYOK isn't
        // configured we can't mint → fall through to B/A.
        const watchToken = await tryMintMoqToken(env, {
          put: [],
          get: [broadcastName(streamId)],
          exp: now + VIEWER_TOKEN_TTL,
        });
        const pullToken = crossPull
          ? await tryMintMoqToken(env, { put: [], get: [""], cluster: true, exp: now + ENTERPRISE_PULL_TOKEN_TTL })
          : null;
        if (watchToken && (!crossPull || pullToken)) {
          console.log(
            `[route] mode=C enterprise(${crossPull ? "crosspull" : "standalone"}) asn=${asn} ` +
            `org=${JSON.stringify(asOrg)} relay=${ent.localRelayHost}` +
            (crossPull ? ` edge=${ent.edgeHost}` : ``) + ` stream=${streamId}`
          );
          return Response.json({
            mode: "enterprise",
            relay: ent.localRelayHost,
            broadcast: broadcastName(streamId),
            watchToken,
            // A/B-compatible alias so any older player still finds jwt.
            jwt: watchToken,
            // cross-pull legs (omitted in standalone): origin to pull from + the pull pass.
            ...(crossPull ? { edgeHost: ent.edgeHost, pullToken } : {}),
            // Media is always relay-blind encrypted; the content key is derived in
            // the browser from the #k= fragment + salts, never handed out here.
            encrypted: true,
          });
        }
        console.warn("[route] enterprise matched but BYOK token mint unavailable; falling back to B/A");
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Resolve the relay the viewer will actually connect to. For a cross-cluster viewer
    // that's a fresh edge (with its OWN per-stream key); otherwise the publisher's relay.
    // The viewer token must be signed with THAT relay's key (managed mode).
    let relay = current;
    const viewerCdn = url.searchParams.get("viewer-cdn");
    if (viewerCdn && viewerCdn !== current.host) {
      // Cross-cluster: assign an edge on the viewer's cluster that pulls from the
      // publisher's CURRENT relay. Explicit ?origin= test override wins.
      const forcedOrigin = url.searchParams.get("origin");
      const origin = forcedOrigin ?? `${current.host}:${current.port}`;
      // Subscribe-scoped, cluster-flagged token so the edge can authenticate its pull
      // from the origin. Signed with OUR key via the SAME signer used for viewer tokens
      // (BYOK EdDSA when configured) — the autoscaler can't mint this, and a different
      // signer would produce tokens the deployed relay rejects. Broad get:[''] (root)
      // scope so the edge can pull whatever subtree the origin advertises for the pull.
      const pullToken = await tryMintMoqToken(env, {
        put: [],
        get: [""],
        cluster: true,
        exp: Math.floor(Date.now() / 1000) + PULL_TOKEN_TTL,
      });
      const edge = await assignRelay(env, streamId, viewerCdn, origin, env.TINYMOQ_PROVISION_KEY, pullToken);
      if (!edge) return new Response("offline", { status: 404 });
      relay = edge;
    }

    // Viewer token: subscribe-only to THIS broadcast (put:[] => cannot publish/hijack).
    const viewerJwt = await tryMintMoqToken(env, {
      put: [],
      get: [broadcastName(streamId)],
      exp: Math.floor(Date.now() / 1000) + VIEWER_TOKEN_TTL,
    }, relay.key);

    // Which mode resolved: B = cross-cluster edge, A = publisher origin relay.
    const mode = relay === current ? "A" : "B";
    console.log(`[route] mode=${mode} ${mode === "B" ? "edge" : "origin"} asn=${asn} stream=${streamId} relay=${relay.host}:${relay.port}`);

    return Response.json({
      relay: `${relay.host}:${relay.port}`,
      jwt: viewerJwt,
      // Media is always relay-blind encrypted; the content key is derived in the
      // browser from the #k= fragment + salts, never handed out here.
      encrypted: true,
    });
  }

  // POST /api/streams - Create or update stream settings (requires auth)
  if (method === "POST" && path === "/api/streams") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json() as { stream_id: string; require_auth?: boolean; overlay_html?: string; encrypted?: boolean; chat_enabled?: boolean };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    // Get current settings first
    const current = await env.DB
      .prepare("SELECT require_auth, overlay_html, encrypted, chat_enabled FROM streams WHERE stream_id = ?")
      .bind(body.stream_id)
      .first<{ require_auth: number; overlay_html: string | null; encrypted: number; chat_enabled: number }>();

    const requireAuth = body.require_auth !== undefined ? body.require_auth : (current?.require_auth === 1);
    const overlayHtml = body.overlay_html !== undefined ? body.overlay_html : (current?.overlay_html || "");
    const isEncrypted = body.encrypted !== undefined ? body.encrypted : (current?.encrypted === 1);
    const chatEnabled = body.chat_enabled !== undefined ? body.chat_enabled : (current?.chat_enabled === 1);

    // Upsert stream settings
    await env.DB
      .prepare(`
        INSERT INTO streams (stream_id, user_id, require_auth, overlay_html, encrypted, chat_enabled)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          require_auth = excluded.require_auth,
          overlay_html = excluded.overlay_html,
          encrypted = excluded.encrypted,
          chat_enabled = excluded.chat_enabled,
          updated_at = datetime('now')
      `)
      .bind(body.stream_id, user.id, requireAuth ? 1 : 0, overlayHtml, isEncrypted ? 1 : 0, chatEnabled ? 1 : 0)
      .run();

    return Response.json({
      stream_id: body.stream_id,
      require_auth: requireAuth,
      overlay_html: overlayHtml,
      encrypted: isEncrypted,
      chat_enabled: chatEnabled,
    });
  }

  return new Response("Not Found", { status: 404 });
}

// Stats routes handler
// --- tinymoq broadcast→relay routing -------------------------------------
// The autoscaler exposes a sticky, idempotent assignment API keyed by the full
// broadcast name. The key MUST match what the client publishes/subscribes.
// --- TinyMoQ fleet broadcast→relay routing -------------------------------
// "Get a relay" has TWO configurable paths (FLEET_MODE); both return a host:port the
// browser connects to, and both keep BYOK token signing (only the endpoint + credential
// differ, so switching paths is config, not code):
//   - direct (Path 1):   the Worker calls a relay box's /assign itself (GET, keyed by the
//                         full broadcast name), authed by the provisioning bearer.
//   - brokered (Path 2): the Worker POSTs {broadcast} to a CDN operator's broker (the
//                         FLEET_ENDPOINT assign URL), which selects a box and returns
//                         {relay}. It never sees box topology and holds NO box bearer — it
//                         authenticates with the operator-issued CUSTOMER token
//                         (env.CDN_API_TOKEN). The box bearer (TINYMOQ_PROVISION_KEY) stays
//                         with the broker and must never be set on a brokered deployment.
// Endpoint = env.FLEET_ENDPOINT; credential = TINYMOQ_PROVISION_KEY (direct) / CDN_API_TOKEN (brokered).
//
// NOTE: there is no static relay fallback. The autoscaler endpoint is a control API (TCP),
// not a MoQ relay — UDP/443 has no media listener. Every media connection must use a
// dynamic host:port from /assign or /route.
const FALLBACK_FLEET_ENDPOINT = "https://gpc-01.tinymoq.com";

// The fleet base URL for this deployment (no trailing slash).
function fleetEndpoint(env: Env): string {
  return (env.FLEET_ENDPOINT || FALLBACK_FLEET_ENDPOINT).replace(/\/+$/, "");
}

// Which "get a relay" path this deployment uses (see FLEET_MODE). Default direct.
function fleetMode(env: Env): "direct" | "brokered" | "static" {
  const m = (env.FLEET_MODE || "").trim().toLowerCase();
  if (m === "brokered") return "brokered";
  // "static": FLEET_ENDPOINT IS an open MoQ relay the browser connects to directly — no
  // autoscaler /assign, no per-broadcast token (e.g. Cloudflare's draft-14 interop relay).
  // Used for the cf-draft-14 experiment; stream (media) encryption is unchanged.
  if (m === "static") return "static";
  return "direct";
}

// The configured fleet's autoscaler hostname (e.g. gpc-01.tinymoq.com).
function fleetHost(env: Env): string {
  try {
    return new URL(fleetEndpoint(env)).hostname.toLowerCase();
  } catch {
    return new URL(FALLBACK_FLEET_ENDPOINT).hostname;
  }
}

// SSRF guard for user-supplied hosts (publisher-cdn / viewer-cdn / cross-cluster origin):
// allow only the configured fleet host and sibling boxes under its registrable domain
// (e.g. gpc-01.<fleet-domain>), so multi-box fleets work without a code change while a
// stray/hostile value can't redirect the Worker's /assign fetch off-fleet.
function isFleetHost(env: Env, host: string): boolean {
  const h = host.toLowerCase();
  const fh = fleetHost(env);
  if (h === fh) return true;
  const parent = fh.split(".").slice(-2).join("."); // e.g. tinymoq.com
  return parent.includes(".") && (h === parent || h.endsWith("." + parent));
}

function broadcastName(streamId: string): string {
  // Node/DHT path: the bare 52-char ed25519 pubkey IS the moq track name (it matches the
  // DHT record `name`, the token scope, and what the browser publishes/subscribes). It must
  // therefore also be the broker's sticky key, so /api/publish (origin) and /api/edge (viewer)
  // resolve to the SAME relay — otherwise a single-box fleet co-locates them under different
  // keys and the viewer lands on an empty relay (RESET_STREAM on the catalog). Only legacy
  // 5-char stream ids get the historical .hang-wrapped name.
  if (/^[a-z2-7]{52}$/.test(streamId)) return streamId;
  return `earthseed.live/${streamId}.hang`;
}

// Mode C (Enterprise) — EARTHSEED-DRIVEN steering rule. Earthseed decides locally (from its
// own config, NOT the broker or an external resolve API) whether to steer this viewer to a
// dedicated edge. When ENTERPRISE_EDGE_HOST is set, matching viewers are steered there; the
// browser couriers the BYOK watch token to that edge's /assign (validated against earthseed's
// verify_jwk — box-side C1), and the edge cluster-pulls the broadcast from `edgeHost` (the
// publisher's CURRENT relay, which we already resolved) using the BYOK pull token. The match
// rule is: feature on (host set) AND (no ASN allow-list, or this viewer's ASN is in it).
// Returns null = no steering (fall through to brokered B/A); never hard-fails a viewer.
function enterpriseEdge(
  env: Env,
  asn: number,
  origin: { host: string; port: number }
): { localRelayHost: string; edgeHost: string; name: string } | null {
  const host = (env.ENTERPRISE_EDGE_HOST || "").trim();
  if (!host) return null; // feature off
  const asnList = (env.ENTERPRISE_ASNS || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (asnList.length > 0 && !asnList.includes(asn)) return null; // gated, not this network
  return { localRelayHost: host, edgeHost: `${origin.host}:${origin.port}`, name: host };
}

// --- Media-key salts ---------------------------------------------------------
// The content key is derived entirely in the browser (HKDF of the #k= fragment
// with these salts); the Worker never sees it. The salts alone decode nothing,
// so this endpoint is intentionally public. Storage is KV (ephemeral: stream
// salts carry a TTL and are never written to D1).

const GLOBAL_SALT_KV_KEY = "salt:global";
// Fallback global salt used until an operator seeds a real one (KV or GLOBAL_MEDIA_SALT).
// Non-secret by design; rotating the LIVE value (KV) is the kill switch.
const DEFAULT_GLOBAL_SALT = "ZWFydGhzZWVkLWRlZmF1bHQtZ2xvYmFs"; // "earthseed-default-global"
const STREAM_SALT_TTL = 86400; // 24h; a broadcaster's page re-PUTs on go-live/reset

interface StreamSaltRecord {
  stream: string; // base64url salt bytes
  epoch: number; // monotonic; bumped on each rotation so viewers re-derive
  ownerHash: string; // sha256(rotateSecret) — only the creator may rotate (TOFU, pre-auth)
}

function streamSaltKey(streamId: string): string {
  return `salt:stream:${streamId}`;
}

async function sha256b64url(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGlobalSalt(env: Env): Promise<string> {
  const fromKv = await env.SALTS.get(GLOBAL_SALT_KV_KEY);
  return fromKv || env.GLOBAL_MEDIA_SALT || DEFAULT_GLOBAL_SALT;
}

// GET → hand out the current salts so a browser can derive CK. PUT → the
// broadcaster sets/rotates the per-stream salt (gated by a rotate secret held
// only in their browser), bumping the epoch so live viewers re-derive.
async function handleSaltRoute(request: Request, env: Env, streamId: string): Promise<Response> {
  const global = await getGlobalSalt(env);

  if (request.method === "GET") {
    const rec = await env.SALTS.get<StreamSaltRecord>(streamSaltKey(streamId), "json");
    return Response.json({ global, stream: rec?.stream ?? null, epoch: rec?.epoch ?? 0 });
  }

  if (request.method === "PUT") {
    let body: { stream?: string; secret?: string };
    try {
      body = (await request.json()) as { stream?: string; secret?: string };
    } catch {
      return new Response("bad json", { status: 400 });
    }
    // Validate the salt is base64url of a sane length (16 bytes → ~22 chars).
    if (!body.stream || !/^[A-Za-z0-9_-]{16,64}$/.test(body.stream) || !body.secret) {
      return new Response("stream (base64url) and secret required", { status: 400 });
    }
    const ownerHash = await sha256b64url(body.secret);
    const existing = await env.SALTS.get<StreamSaltRecord>(streamSaltKey(streamId), "json");
    if (existing && existing.ownerHash !== ownerHash) {
      // Someone else owns this stream id's salt — refuse (prevents salt hijack/DoS).
      return new Response("not the salt owner", { status: 403 });
    }
    const epoch = existing ? existing.epoch + 1 : 1;
    const rec: StreamSaltRecord = { stream: body.stream, epoch, ownerHash };
    await env.SALTS.put(streamSaltKey(streamId), JSON.stringify(rec), {
      expirationTtl: STREAM_SALT_TTL,
    });
    return Response.json({ global, stream: rec.stream, epoch });
  }

  return new Response("method not allowed", { status: 405 });
}

// Resolve the autoscaler base URL, honoring an optional per-request CDN override
// (a specific box within the fleet). Only hosts on the configured fleet's domain are
// allowed — this guards the Worker's fetch against SSRF via user input.
function autoscalerBase(env: Env, cdnHost?: string | null): string {
  if (cdnHost && isFleetHost(env, cdnHost)) {
    return `https://${cdnHost}`;
  }
  return fleetEndpoint(env);
}

// A fleet relay origin "host:port" (the publisher's relay), for cross-cluster pulls.
// The host must be on the configured fleet's domain.
function isValidOrigin(env: Env, origin: string): boolean {
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(origin);
  return !!m && isFleetHost(env, m[1]);
}

// Ask the autoscaler for the relay hosting this broadcast (spawns/sticks as needed).
// When the viewer's cluster differs from the publisher's, pass `origin` (the
// publisher's relay host:port) so the assigned edge relay pulls the stream across
// clusters. Returns null if /assign is unavailable — there is NO static fallback.
// The /assign response is dual-mode (cutover-safe):
//   bare text  "host:port"                         -> sign tokens with the tenant key
//   JSON  {"relay":"host:port","key":<b64url|null>,"byok":<bool>}
//     - managed:  key is the per-stream HMAC secret -> sign THIS broadcast with `key`
//     - BYOK:     key is null + byok true            -> Worker signs its own EdDSA token
// /assign is sticky; in managed mode a reap/respawn yields a new key, so do NOT cache
// the key — sign on demand with whatever this call returned.
// Read the origin relay's iroh EndpointId from its fleet box (watch-by-pubkey path). The box
// serves GET https://<host>/iroh?port=<relay-port> → the 64-hex EndpointId of the relay on that
// UDP port. Fetched Worker-side (not the browser) so it needs no CORS on the box. Returns null
// on any failure so callers can surface a clean "unavailable" rather than a hang.
async function fetchOriginEndpointId(host: string, port: number): Promise<string | null> {
  try {
    const res = await fetch(`https://${host}/iroh?port=${port}`);
    if (!res.ok) return null;
    const eid = (await res.text()).trim();
    return /^[0-9a-f]{64}$/i.test(eid) ? eid : null;
  } catch {
    return null;
  }
}

// Additive broker hints derived from the incoming browser request — today just the viewer's
// Cloudflare geo. The broker routes to the geo-nearest healthy fleet, but on a Worker->Worker
// subrequest it can't see the viewer; only WE can, from request.cf. Send geo ONLY when lat/lon
// are present and finite. Purely additive: the broker falls back to its own edge geo if missing.
function brokerHints(req?: Request): Record<string, unknown> | undefined {
  const cf = (req as (Request & { cf?: IncomingRequestCfProperties }) | undefined)?.cf;
  if (!cf) return undefined;
  const rawLat = cf.latitude;
  const rawLon = cf.longitude;
  if (rawLat == null || rawLon == null || rawLat === "" || rawLon === "") return undefined;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { geo: { lat, lon, country: cf.country, colo: cf.colo } };
}

async function assignRelay(
  env: Env,
  streamId: string,
  cdnHost?: string | null,
  origin?: string | null,
  provisionKey?: string | null,
  pull?: string | null,
  xport?: string | null,
  req?: Request
): Promise<{ host: string; port: number; key?: string } | null> {
  const name = broadcastName(streamId);
  // Static (open relay, e.g. Cloudflare draft-14): the browser connects DIRECTLY to the
  // configured relay; there is no autoscaler /assign and no per-broadcast token. Just hand
  // back the fixed relay host:port (443). Publisher and viewer rendezvous on the broadcast
  // `name` over the open relay. Stream encryption is untouched.
  if (fleetMode(env) === "static") {
    return { host: fleetHost(env), port: 443 };
  }
  // Path 2 (brokered): hand the broadcast to the operator and let it pick the box. The
  // cdnHost/origin/pull overrides are direct-mode concerns; the operator owns topology. We DO
  // forward the viewer's geo (from req.cf) so the broker can pick the geo-nearest fleet.
  // (The node/DHT edge path calls assignViaBroker DIRECTLY with origin/pull/xport opts.)
  if (fleetMode(env) === "brokered") {
    return assignViaBroker(env, name, req);
  }
  const base = autoscalerBase(env, cdnHost);
  let query = `broadcast=${encodeURIComponent(name)}`;
  // An origin can be a fleet host:port (cross-cluster QUIC pull) OR — when xport=iroh — a
  // 64-hex iroh EndpointId the edge dials by key (watch-by-pubkey). The EID form is not a URL
  // and the Worker never fetches it (the box dials it over iroh), so it needs no SSRF gate; a
  // strict 64-hex shape check is the whole validation.
  const isEidOrigin = !!origin && xport === "iroh" && /^[0-9a-f]{64}$/i.test(origin);
  if (origin && (isValidOrigin(env, origin) || isEidOrigin)) {
    query += `&origin=${encodeURIComponent(origin)}`;
    // Both origin flavors' pull legs are token-gated: a cross-cluster host:port pull uses a
    // cluster-flagged subscribe token; a gated iroh EID origin needs a subscribe token on its
    // pull-listener too. Forward whatever the caller minted.
    if (pull) query += `&pull=${encodeURIComponent(pull)}`;
  }
  // Transport hint forwarded verbatim: xport=iroh makes the edge pull from the origin over
  // iroh/DHT; absent/other = host:port. Pure hint (no token/auth change).
  if (xport) query += `&xport=${encodeURIComponent(xport)}`;
  try {
    const res = await fetch(`${base}/assign?${query}`, { headers: provisionHeaders(provisionKey) });
    if (res.ok) {
      const text = (await res.text()).trim();
      let relayStr = text; // e.g. "cdn.tinymoq.com:8000"
      let key: string | undefined;
      // Per-stream / BYOK mode returns JSON; shared mode returns a bare "host:port".
      if (text.startsWith("{")) {
        try {
          const obj = JSON.parse(text) as { relay?: string; key?: string | null };
          if (obj.relay) relayStr = String(obj.relay).trim();
          if (obj.key) key = String(obj.key); // null in BYOK mode — left undefined
        } catch {
          console.warn("assignRelay: /assign returned non-JSON starting with '{'");
        }
      }
      const [host, portStr] = relayStr.split(":");
      const port = parseInt(portStr, 10);
      if (host && Number.isFinite(port)) {
        return { host, port, key };
      }
    }
    console.warn("assignRelay: unexpected /assign response", res.status);
  } catch (e) {
    console.warn("assignRelay: /assign failed", e);
  }
  return null;
}

// Path 2 (brokered): POST {broadcast} to the operator's broker; it selects a box and
// returns {relay:"host:port"}. No per-stream key (BYOK — the Worker signs the
// viewer/publisher token itself), no topology and no cdnHost/origin overrides (the operator
// owns box selection). The credential is the operator-issued customer token, sent as a bearer.
async function assignViaBroker(
  env: Env,
  broadcast: string,
  req?: Request,
  // Watch-by-pubkey edge placement (node path): the broker accepts a bare iroh EID `origin`
  // + a `pull` token + `xport`, geo-picks the viewer's nearest box, and — if that box isn't
  // the origin's — inserts the edge->origin iroh pull itself. Omitted for the plain fleet
  // assign (origin placement), where the broker chooses freely.
  opts?: { origin?: string | null; pull?: string | null; xport?: string | null }
): Promise<{ host: string; port: number; key?: string } | null> {
  // FLEET_ENDPOINT IS the broker's full assign URL in brokered mode. Credential is the
  // operator-issued CUSTOMER token (CDN_API_TOKEN) — never the box bearer.
  const assignUrl = fleetEndpoint(env);
  const hints = brokerHints(req);
  const body: Record<string, unknown> = { broadcast };
  if (opts?.origin) body.origin = opts.origin; // bare iroh EID the edge pulls from
  if (opts?.pull) body.pull = opts.pull; // subscribe token the broker forwards to the edge
  if (opts?.xport) body.xport = opts.xport; // e.g. "iroh" — origin->edge transport
  if (hints) body.hints = hints; // additive: viewer geo for geo-nearest fleet routing
  try {
    const res = await fetch(assignUrl, {
      method: "POST",
      headers: { ...provisionHeaders(env.CDN_API_TOKEN), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let data: { relay?: string; box?: string; reason?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    // Redact the pull token (a bearer JWT) from the log so it never lands in the tail.
    const logBody = body.pull ? { ...body, pull: "<token>" } : body;
    console.log(
      `[broker] assign ${res.status} req=${JSON.stringify(logBody)} resp=${JSON.stringify({
        relay: data.relay,
        box: data.box,
        reason: data.reason,
      })}`
    );
    if (res.ok) {
      const [host, portStr] = String(data.relay ?? "").split(":");
      const port = parseInt(portStr, 10);
      if (host && Number.isFinite(port)) return { host, port };
    }
    console.warn("assignViaBroker: unexpected broker response", res.status);
  } catch (e) {
    console.warn("assignViaBroker: broker assign failed", e);
  }
  return null;
}

// Free the relay route when a broadcast ends so the node can be scaled down. Direct mode
// releases the box it assigned (the stored relay_host); brokered mode tells the operator,
// which owns the box lifecycle.
async function releaseRelay(env: Env, streamId: string, cdnHost?: string | null, provisionKey?: string | null): Promise<void> {
  const name = broadcastName(streamId);
  // Static/open relay: nothing to release — the relay manages its own lifecycle and we
  // never reserved anything via /assign.
  if (fleetMode(env) === "static") return;
  if (fleetMode(env) === "brokered") {
    // Derive the release URL from the assign URL (…/assign → …/release). If FLEET_ENDPOINT
    // doesn't end in /assign we can't derive it — skip and let the operator reap the box.
    const assignUrl = fleetEndpoint(env);
    if (!/assign\/?$/.test(assignUrl)) return;
    const releaseUrl = assignUrl.replace(/assign(\/?)$/, "release$1");
    try {
      await fetch(releaseUrl, {
        method: "POST",
        headers: { ...provisionHeaders(env.CDN_API_TOKEN), "content-type": "application/json" },
        body: JSON.stringify({ broadcast: name }),
      });
    } catch (e) {
      console.warn("releaseRelay(brokered): broker release failed", e);
    }
    return;
  }
  const base = autoscalerBase(env, cdnHost);
  try {
    await fetch(`${base}/release?broadcast=${encodeURIComponent(name)}`, { headers: provisionHeaders(provisionKey) });
  } catch (e) {
    console.warn("releaseRelay: /release failed", e);
  }
}

// Authenticate the Worker to TinyMoQ's provisioning API (/assign, /release) with an
// opaque bearer that also identifies the tenant. Omitted when the key isn't set so
// deploys are safe before the operator runs `wrangler secret put TINYMOQ_PROVISION_KEY`.
function provisionHeaders(provisionKey?: string | null): HeadersInit {
  return provisionKey ? { Authorization: `Bearer ${provisionKey}` } : {};
}

// Token lifetimes (seconds). Generous until a refresh loop exists, so long broadcasts /
// long views aren't dropped mid-stream.
const PUBLISHER_TOKEN_TTL = 12 * 60 * 60; // 12h
const VIEWER_TOKEN_TTL = 6 * 60 * 60; // 6h
// Cross-cluster pull token (edge relay -> origin). Matches the viewer TTL so a long
// broadcast's edge pull isn't dropped mid-stream (the moq-token-cli example used 1h).
// SERVER-HELD only (Mode B): never leaves the Worker/relay, so a long TTL is safe.
const PULL_TOKEN_TTL = 6 * 60 * 60; // 6h
// Mode C (Enterprise) pull token is BROWSER-HELD: the viewer's browser carries a
// root-scoped, cluster:true token to the local relay. Same broad scope as Mode B (must
// match the proven cross-cluster pull), but in an end-user's hands it could act as a
// cluster node — so containment is a TIGHT expiry, not scope. Keep it to minutes.
// NOTE (box-side, being validated): if the local relay needs the pass valid for the
// whole pull session rather than just to establish it, bump this — it's the one knob.
const ENTERPRISE_PULL_TOKEN_TTL = 5 * 60; // 5 min

// Mint a per-broadcast token, config-driven and guarded (returns null instead of throwing
// so the endpoint still works). BYOK: sign EdDSA with the tenant's private key when set.
// Managed: else sign HS256 with the per-stream `streamKey` from /assign. Neither => null.
async function tryMintMoqToken(env: Env, claims: MoqClaims, streamKey?: string | null): Promise<string | null> {
  // Static/open relay (cf-draft-14): the relay does no token auth, so mint nothing — the
  // browser connects without a `?jwt=`. Stream (media) encryption is independent of this.
  if (fleetMode(env) === "static") return null;
  try {
    if (env.MOQ_AUTH_PRIVATE_JWK) return await mintEd25519Token(env.MOQ_AUTH_PRIVATE_JWK, claims);
    if (streamKey) return await mintHs256Token(streamKey, claims);
    console.warn("[moq-token] no signing material (no BYOK key, no per-stream key); no token");
    return null;
  } catch (e) {
    console.error("[moq-token] mint failed", e);
    return null;
  }
}

async function handleStatsRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/stats/stream/:stream_id/viewers - Get viewers for a specific stream (public)
  const streamViewersMatch = path.match(/^\/api\/stats\/stream\/([a-z0-9]{5})\/viewers$/);
  if (method === "GET" && streamViewersMatch) {
    const streamId = streamViewersMatch[1];

    const viewers = await env.DB
      .prepare(`
        SELECT
          w.id, w.stream_id, w.started_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url,
          w.geo_country, w.geo_city, w.geo_region, w.geo_latitude, w.geo_longitude, w.geo_timezone
        FROM watch_events w
        LEFT JOIN users u ON w.user_id = u.id
        WHERE w.ended_at IS NULL AND w.stream_id = ?
        ORDER BY w.started_at DESC
      `)
      .bind(streamId)
      .all();

    return Response.json({
      stream_id: streamId,
      viewers: viewers.results,
    });
  }

  // GET /api/stats/greet - Get live broadcasts with viewer counts (public)
  if (method === "GET" && path === "/api/stats/greet") {
    // Get active broadcasts with viewer counts
    const broadcasts = await env.DB
      .prepare(`
        SELECT
          b.id, b.stream_id, b.started_at,
          u.name as user_name,
          b.geo_country, b.geo_city, b.geo_region, b.geo_latitude, b.geo_longitude,
          (SELECT COUNT(*) FROM watch_events w WHERE w.stream_id = b.stream_id AND w.ended_at IS NULL) as viewer_count
        FROM broadcast_events b
        JOIN users u ON b.user_id = u.id
        WHERE b.ended_at IS NULL
        ORDER BY b.started_at DESC
      `)
      .all();

    return Response.json({ broadcasts: broadcasts.results });
  }

  // GET /api/stats/live - Get live broadcasts and viewers (requires auth)
  if (method === "GET" && path === "/api/stats/live") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    // Get active broadcasts (started but not ended)
    const broadcasts = await env.DB
      .prepare(`
        SELECT
          b.id, b.stream_id, b.started_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url,
          b.geo_country, b.geo_city, b.geo_region, b.geo_latitude, b.geo_longitude, b.geo_timezone
        FROM broadcast_events b
        JOIN users u ON b.user_id = u.id
        WHERE b.ended_at IS NULL
        ORDER BY b.started_at DESC
      `)
      .all();

    // Get active viewers (started but not ended)
    const viewers = await env.DB
      .prepare(`
        SELECT
          w.id, w.stream_id, w.started_at,
          u.id as user_id, u.name as user_name, u.email as user_email, u.avatar_url,
          w.geo_country, w.geo_city, w.geo_region, w.geo_latitude, w.geo_longitude, w.geo_timezone
        FROM watch_events w
        LEFT JOIN users u ON w.user_id = u.id
        WHERE w.ended_at IS NULL
        ORDER BY w.started_at DESC
      `)
      .all();

    return Response.json({
      broadcasts: broadcasts.results,
      viewers: viewers.results,
    });
  }

  // POST /api/stats/broadcast - Start a broadcast (requires auth)
  if (method === "POST" && path === "/api/stats/broadcast") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    // Default-deny broadcaster allow list: only explicitly-allowed emails may publish.
    // Gating the token mint here means an unapproved account never gets a publisher JWT.
    if (!(await canBroadcast(env.DB, user.email))) {
      return Response.json(
        { error: "Your account is not approved to broadcast." },
        { status: 403 }
      );
    }

    const body = await request.json() as { stream_id: string; publisher_cdn?: string };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    const geo = getGeoFromRequest(request);
    console.log("Broadcast geo data:", JSON.stringify(geo));

    // Ask the tinymoq autoscaler which relay to publish to (sticky per broadcast
    // name). Optional publisher_cdn picks which CDN destination to assign on (testing).
    // No static fallback: if /assign is down, relay is null and the client retries.
    const assigned = await assignRelay(env, body.stream_id, body.publisher_cdn, undefined, env.TINYMOQ_PROVISION_KEY);
    const relayHost = assigned?.host ?? null;
    const relayPort = assigned?.port ?? null;

    // Relay-blind E2E media encryption is MANDATORY for every stream — the guarantee we
    // sell is that the relay/server only ever move ciphertext. The content key is NO LONGER
    // minted or stored server-side: the broadcaster's browser mints it, keeps it in the
    // #k= share-link fragment, and both sides derive CK = HKDF(fragmentKey, salts). So even
    // Cloudflare/this Worker cannot decode. We only record that the stream is encrypted.
    const encrypted = true;

    const result = await env.DB
      .prepare(`
        INSERT INTO broadcast_events (user_id, stream_id, geo_country, geo_city, geo_region, geo_latitude, geo_longitude, geo_timezone, relay_host, relay_port)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .bind(user.id, body.stream_id, geo.country, geo.city, geo.region, geo.latitude, geo.longitude, geo.timezone, relayHost, relayPort)
      .first<{ id: number }>();

    // Mint a publisher token scoped to THIS broadcast (publish + read acks on its own
    // path only). Owner/auth already enforced above; the relay enforces the scope.
    // Signed with the relay's per-stream key when /assign returned one (managed mode),
    // else with the tenant's BYOK Ed25519 key.
    const publisherJwt = assigned
      ? await tryMintMoqToken(env, {
          put: [broadcastName(body.stream_id)],
          get: [broadcastName(body.stream_id)],
          exp: Math.floor(Date.now() / 1000) + PUBLISHER_TOKEN_TTL,
        }, assigned.key)
      : null;

    return Response.json({
      id: result?.id,
      stream_id: body.stream_id,
      geo,
      relay: assigned ? `${relayHost}:${relayPort}` : null,
      jwt: publisherJwt,
      encrypted,
    });
  }

  // POST /api/stats/broadcast/:id/end - End a broadcast
  const broadcastEndMatch = path.match(/^\/api\/stats\/broadcast\/(\d+)\/end$/);
  if (method === "POST" && broadcastEndMatch) {
    const eventId = parseInt(broadcastEndMatch[1]);

    // Look up the stream (and the CDN it was assigned on) to free the assignment.
    const row = await env.DB
      .prepare("SELECT stream_id, relay_host FROM broadcast_events WHERE id = ?")
      .bind(eventId)
      .first<{ stream_id: string; relay_host: string | null }>();

    await env.DB
      .prepare("UPDATE broadcast_events SET ended_at = datetime('now') WHERE id = ?")
      .bind(eventId)
      .run();

    if (row?.stream_id) {
      await releaseRelay(env, row.stream_id, row.relay_host, env.TINYMOQ_PROVISION_KEY);
    }

    return Response.json({ success: true });
  }

  // POST /api/stats/watch - Start watching (auth optional)
  if (method === "POST" && path === "/api/stats/watch") {
    const user = await getAuthenticatedUser(request, env);

    const body = await request.json() as { stream_id: string };
    if (!body.stream_id) {
      return Response.json({ error: "stream_id required" }, { status: 400 });
    }

    const geo = getGeoFromRequest(request);
    const result = await env.DB
      .prepare(`
        INSERT INTO watch_events (user_id, stream_id, geo_country, geo_city, geo_region, geo_latitude, geo_longitude, geo_timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .bind(user?.id ?? null, body.stream_id, geo.country, geo.city, geo.region, geo.latitude, geo.longitude, geo.timezone)
      .first<{ id: number }>();

    return Response.json({ id: result?.id, stream_id: body.stream_id });
  }

  // POST /api/stats/watch/:id/end - End watching
  const watchEndMatch = path.match(/^\/api\/stats\/watch\/(\d+)\/end$/);
  if (method === "POST" && watchEndMatch) {
    const eventId = parseInt(watchEndMatch[1]);
    await env.DB
      .prepare("UPDATE watch_events SET ended_at = datetime('now') WHERE id = ?")
      .bind(eventId)
      .run();

    return Response.json({ success: true });
  }

  return new Response("Not Found", { status: 404 });
}

// Helper to get authenticated user from request
async function getAuthenticatedUser(request: Request, env: Env): Promise<User | null> {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = getSessionFromCookie(cookieHeader);

  if (!sessionToken) return null;

  const session = await verifySessionToken(sessionToken, env.SESSION_SECRET);
  if (!session) return null;

  return getUserById(env.DB, session.userId);
}

// Broadcaster allow list check (default-deny): true ONLY if there is an explicit
// row for this email with status='allowed'. No row or 'suspended' => blocked.
async function canBroadcast(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT status FROM broadcaster_access WHERE email = ?")
    .bind(email)
    .first<{ status: string }>();
  return row?.status === "allowed";
}

// Helper to extract geolocation from Cloudflare request
interface GeoData {
  country: string | null;
  city: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
}

function getGeoFromRequest(request: Request): GeoData {
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  return {
    country: cf?.country || null,
    city: cf?.city || null,
    region: cf?.region || null,
    latitude: cf?.latitude?.toString() || null,
    longitude: cf?.longitude?.toString() || null,
    timezone: cf?.timezone || null,
  };
}

// Handle admin routes
async function handleAdminRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // Admin password comes from the ADMIN_PASSWORD secret (wrangler secret put).
  // Never hardcoded. If unset, admin fails closed (locked).
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return Response.json({ error: "admin disabled" }, { status: 503 });
  }

  // GET /api/admin/verify - Verify password (no auth required for this check)
  if (method === "GET" && path === "/api/admin/verify") {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${adminPassword}`) {
      return Response.json({ valid: false }, { status: 401 });
    }
    return Response.json({ valid: true });
  }

  // Verify admin password from Authorization header
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${adminPassword}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // DELETE /api/admin/broadcasts - Clear all broadcast data
  if (method === "DELETE" && path === "/api/admin/broadcasts") {
    await env.DB.prepare("DELETE FROM broadcast_events").run();
    return Response.json({ success: true, message: "All broadcaster data cleared" });
  }

  // DELETE /api/admin/viewers - Clear all viewer data
  if (method === "DELETE" && path === "/api/admin/viewers") {
    await env.DB.prepare("DELETE FROM watch_events").run();
    return Response.json({ success: true, message: "All viewer data cleared" });
  }

  // GET /api/admin/broadcasters - List signed-in users + allow-list status, plus
  // any pre-authorized emails that have never signed in.
  if (method === "GET" && path === "/api/admin/broadcasters") {
    // Signed-in users joined with their allow-list status (default 'none' = blocked).
    const users = await env.DB
      .prepare(`
        SELECT u.email, u.name, u.avatar_url,
               COALESCE(a.status, 'none') AS status,
               (SELECT MAX(started_at) FROM broadcast_events b WHERE b.user_id = u.id) AS last_broadcast
        FROM users u
        LEFT JOIN broadcaster_access a ON a.email = u.email
        ORDER BY u.name COLLATE NOCASE
      `)
      .all<{ email: string; name: string | null; avatar_url: string | null; status: string; last_broadcast: string | null }>();

    // Allow-list emails that have never signed in (pre-authorized / suspended-by-email).
    const orphans = await env.DB
      .prepare(`
        SELECT a.email, a.status
        FROM broadcaster_access a
        LEFT JOIN users u ON u.email = a.email
        WHERE u.id IS NULL
        ORDER BY a.email COLLATE NOCASE
      `)
      .all<{ email: string; status: string }>();

    const list = [
      ...(users.results ?? []),
      ...(orphans.results ?? []).map((o) => ({
        email: o.email,
        name: null,
        avatar_url: null,
        status: o.status,
        last_broadcast: null,
        never_signed_in: true,
      })),
    ];

    return Response.json({ broadcasters: list });
  }

  // POST /api/admin/broadcasters - Allow or suspend an email (default-deny allow list).
  if (method === "POST" && path === "/api/admin/broadcasters") {
    const body = await request.json().catch(() => null) as { email?: string; status?: string } | null;
    const email = body?.email?.trim().toLowerCase();
    const status = body?.status;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return Response.json({ error: "Valid email required" }, { status: 400 });
    }
    if (status !== "allowed" && status !== "suspended") {
      return Response.json({ error: "status must be 'allowed' or 'suspended'" }, { status: 400 });
    }

    await env.DB
      .prepare(`
        INSERT INTO broadcaster_access (email, status, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(email) DO UPDATE SET
          status = excluded.status,
          updated_at = datetime('now')
      `)
      .bind(email, status)
      .run();

    return Response.json({ success: true, email, status });
  }

  // DELETE /api/admin/broadcasters?email=... - Remove an email (reverts to default-deny).
  if (method === "DELETE" && path === "/api/admin/broadcasters") {
    const email = url.searchParams.get("email")?.trim().toLowerCase();
    if (!email) {
      return Response.json({ error: "email required" }, { status: 400 });
    }
    await env.DB.prepare("DELETE FROM broadcaster_access WHERE email = ?").bind(email).run();
    return Response.json({ success: true, email });
  }

  return new Response("Not Found", { status: 404 });
}
