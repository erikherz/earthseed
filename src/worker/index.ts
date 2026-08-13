// Cloudflare Worker for earthseed.live.
//
// It does two things: serve the static client in simple/, and answer two small API routes. It is
// deliberately this small.
//
// Everything else it used to carry — OAuth for three providers, sessions, a broadcaster allow
// list, per-stream records, stats, an admin API and a salt store — existed for the vite client in
// src/, which stopped being deployed when wrangler.jsonc pointed assets.directory at ./simple, and
// which was deleted on 12 Aug 2026.
//
// That surface was not merely unused, it was generating security findings for code nobody ran: an
// endpoint that minted a publisher token for any broadcast name with no authentication at all, and
// a live OAuth flow with no user interface whose session gated exactly one route the shipped client
// never calls — which also meant the broadcaster allow list everyone believed was gating publishing
// was gating nothing.
//
// The shipped client (simple/earthseed.js) reaches the tinymoq broker directly for relay placement,
// and reads its salts in-band from the broadcaster's catalog track. Apart from loading the page and
// reporting a CSP violation, it makes no request to this Worker.

import { publicVerifyJwk } from "./auth/moq-token";

// Per-stream live chat Durable Object. Kept only because wrangler.jsonc still binds the class and
// removing a Durable Object requires a deletion migration; nothing in the shipped client uses it.
export { ChatRoom } from "./chat-room";

export interface Env {
  ASSETS: Fetcher;
  // BYOK: the tenant's Ed25519 PRIVATE signing key as an OKP JWK (JSON string, includes `d`).
  // Only its public half is exposed, via /api/pubkey, for an operator to install as the fleet's
  // verify_jwk. Broadcast tokens themselves are minted by the broker, not here.
  MOQ_AUTH_PRIVATE_JWK?: string;
  // Still bound in wrangler.jsonc and still provisioned, but no longer read by this Worker. Left
  // in place rather than torn down in the same change: D1 holds the retired client's tables, KV
  // holds salts the broker now serves, and the Durable Object needs a migration to remove.
  DB: D1Database;
  SALTS: KVNamespace;
  CHAT_ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApiRoutes(request, env, url);
    }

    // Tier-2: html_handling="none" disables the automatic "/" → index.html mapping, so serve the
    // landing page for the root explicitly. Every other path is a real file in simple/ — the SPA
    // routes that used to be special-cased here (/stats, /greet, /cleardata, 5-character stream
    // ids) belonged to the retired client and now correctly 404.
    if (url.pathname === "/") {
      const indexUrl = new URL("/index.html", url.origin);
      return withSecurityHeaders(
        await env.ASSETS.fetch(
          new Request(indexUrl.toString(), { method: request.method, headers: request.headers })
        )
      );
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

// The baseline subset only, and that is enough here. These headers reach just the responses the
// Worker actually serves — in practice "/" — because with no `run_worker_first` the asset server
// answers the .html/.js paths itself; simple/_headers is where the real policy lives, including the
// enforced `script-src`/`connect-src`.
//
// "/" is index.html: no inline scripts, no script files, no fetches. A strict policy there would
// constrain nothing, and duplicating the generated hash list in TypeScript would just give it a
// second place to go stale. If the landing page ever gains script, serve it the generated policy
// rather than hand-copying one.
function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function handleApiRoutes(request: Request, env: Env, url: URL): Promise<Response> {
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

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    console.error("API error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
