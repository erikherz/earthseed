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

import {
  publicVerifyJwk,
  mintEd25519Token,
  mintMoqProToken,
  mintMoqProTokenEd25519,
  type MoqClaims,
} from "./auth/moq-token";
import { getGoogleAuthUrl, exchangeCodeForTokens, getGoogleUserInfo } from "./auth/google";
import {
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from "./auth/session";
import { upsertGoogleUser, currentUser, canBroadcast } from "./auth/users";

// The seeds demo. Three imports and two dispatch lines below are its entire attachment to this
// Worker, which is the point: removing it is deleting a file. NO MONEY MOVES — there is no
// payment processor anywhere in it, and the cash-out path is a legal question that has not been
// answered. See src/worker/seeds.ts and migration 0014.
import { handleSeedRoutes, handleSeedAdminRoutes, burnForStream } from "./seeds";

// Per-stream live chat Durable Object. Bound in wrangler.jsonc; removing it needs a deletion
// migration. Nothing in the shipped client uses it yet.
export { ChatRoom } from "./chat-room";

export interface Env {
  ASSETS: Fetcher;

  // ── Relay tokens (BYOK). The tenant's Ed25519 PRIVATE signing key as an OKP JWK. Only its
  // public half is exposed, via /api/pubkey, for an operator to install as the fleet's verify_jwk.
  MOQ_AUTH_PRIVATE_JWK?: string;

  // ── moq.pro (Luke Curley's hosted CDN) — Mode A, and the relay backend when set.
  //
  // MOQ_PRO_JWK is the PRIVATE half of an Ed25519 keypair whose public half was uploaded through
  // moq.pro's "Import Asymmetric". MOQ_PRO_K is the older symmetric key. Set either and
  // moqProAssign() answers first, so every broadcast goes through cdn.moq.pro with a
  // per-broadcast token this Worker mints, and the tinymoq broker below is never reached.
  //
  // That makes moving between the two relay backends A SECRET CHANGE, not a deploy. It also
  // means the BROKER_* / FLEET_* vars in wrangler.jsonc prove nothing about where traffic is
  // actually going: they stay populated on purpose. `wrangler secret list` is the only honest
  // answer to "which CDN is this on".
  MOQ_PRO_JWK?: string;
  /** Legacy symmetric key. Preferred only in that unsetting the JWK falls back here rather than
   *  breaking — moq.pro holds this one, so it can mint any token we could. */
  MOQ_PRO_K?: string;
  /** Account root: the path namespace under cdn.moq.pro. Defaults to "erik", the same namespace
   *  vivoh.earth and wallflower.tv publish into. See wrangler.jsonc for why sharing it is an
   *  accepted risk here and not an oversight. */
  MOQ_PRO_ROOT?: string;

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
  // How many days a reported still frame survives before the cron nulls it. The report row
  // outlives the picture on purpose: the record that a complaint was made is administrative,
  // the frame is someone's living room. Default 30. Set to 0 to keep frames indefinitely,
  // which is a decision worth making deliberately rather than by leaving a variable unset.
  REPORT_FRAME_RETENTION_DAYS?: string;
  // How many days of viewing-session rows to keep. Unset ⇒ keep everything, because the point of
  // the table is to be reportable. The opposite default from REPORT_FRAME_RETENTION_DAYS above,
  // and deliberately: a session row is a timestamp against a stream id, a reported frame is a
  // photograph. Setting this is still worth considering — the safest audience record is the one
  // that is no longer there to be compelled.
  STATS_RETENTION_DAYS?: string;

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

  // ── Temporary broadcast shutter. "1" or "true" ⇒ nobody may go live and the client says so.
  // Anything else, including unset, means normal operation: the relays being reachable is the
  // usual state, so an absent or fat-fingered var must not silently take broadcasting down. That
  // is the opposite default from the retention vars above, and deliberately — this one is a
  // notice, not a safety control, and the CDN is the thing that actually enforces its absence.
  BROADCAST_OFFLINE?: string;
  /** Overrides the notice text. Unset ⇒ OFFLINE_DEFAULT_MESSAGE. */
  OFFLINE_MESSAGE?: string;
  PUBLISHER_TOKEN_TTL?: string;

  // ── Accounts. "on"/"1"/"true" switches on Google sign-in AND makes the broadcaster allow list
  // a real second door to publishing. Anything else, including unset, leaves the whole surface
  // dormant — which is the default, and matches what Wallflower actually ships. See
  // accountsEnabled() for why this is a var and not "are the OAuth secrets present".
  ACCOUNTS?: string;

  // ── Google sign-in. All three must be set for the account path to exist at all; with any of
  // them missing /api/auth/google/login returns 503, /api/auth/me answers `{user: null}`, and
  // nothing else in this Worker changes. That is the fail-closed direction and it is also the
  // migration path: this deployment ran without accounts for a month and must keep working
  // unchanged for anyone who never sets these.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** HMAC key for the stateless session cookie. Rotating it signs everyone out at once — the
   *  only revocation lever there is, because sessions are not stored. See auth/session.ts. */
  SESSION_SECRET?: string;

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

  // Forget reported frames once their retention window passes.
  //
  // This Worker had no scheduled handler at all before migration 0010, which was fine while
  // the reports table held only metadata — a category and a timestamp need no reaper. A frame
  // does. Retention that exists only as a comment in a migration is not retention, so the
  // cron arrives in the same change as the column.
  //
  // Scheduled rather than opportunistic: a frame's clock must run whether or not anybody
  // happens to file another report. See wrangler.jsonc `triggers` for the interval.
  // Two schedules now, doing different work on different clocks (see wrangler.jsonc):
  //
  //   * * * * *   close viewing sessions whose heartbeat stopped
  //   0 * * * *   forget reported frames past their retention window
  //
  // Splitting them is the point. A frame's clock is measured in days and running it every
  // minute would be sixty pointless UPDATEs an hour; a session's is measured in seconds, and
  // an hourly reaper would leave finished sessions sitting open for up to an hour. The live
  // viewer count does not depend on this — it is computed from the heartbeat watermark and is
  // correct whether or not the reaper has run — but the recorded DURATION of a session does.
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === "0 * * * *") {
      const frames = await expireReportFrames(env);
      if (frames) console.log(`[reaper] report frames expired=${frames}`);
      return;
    }

    const { closed, purged } = await reapSessions(env);
    if (closed || purged) console.log(`[reaper] sessions closed=${closed} purged=${purged}`);
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

/* ═════════════════════════ The broadcast shutter ═════════════════════════ */
// A temporary "we are not carrying broadcasts right now" state, for periods when the relay fleet
// is deliberately not running. It is a VAR rather than a secret so that the live answer is visible
// in git and cannot drift: flipping it is an edit here plus `npm run deploy`, and the file always
// says what production is doing.
//
// Two layers, and only one of them is load-bearing. The Worker refuses to place a broadcast, which
// binds every client including a patched one; the modal in the browser exists so that a person
// gets a sentence instead of a 502 from a broker that is not there. If the two ever disagree, the
// Worker is right.
//
// Watching is deliberately NOT gated. A viewer holding a link for a stream that is not live
// already gets "offline", and shuttering the watch path would break playback the moment the
// relays come back but before this var is flipped.
const OFFLINE_DEFAULT_MESSAGE = "Temporarily offline. Please contact erik@vivoh.com for a demo.";

/** The notice to show, or null when broadcasting is open. */
function broadcastShutter(env: Env): string | null {
  const raw = (env.BROADCAST_OFFLINE ?? "").trim().toLowerCase();
  // Strict allow-list rather than truthiness: "0" and "false" are the values someone reaches for
  // to turn this OFF, and both are truthy strings in JavaScript.
  if (raw !== "1" && raw !== "true") return null;
  return (env.OFFLINE_MESSAGE ?? "").trim() || OFFLINE_DEFAULT_MESSAGE;
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

    // GET /api/config — the handful of facts the client needs before it offers to do anything.
    // Public and unauthenticated: it says only whether this deployment is currently carrying
    // broadcasts, which is what a visitor is about to find out anyway by clicking the button.
    //
    // Not cached. The whole point is that flipping the var is visible on the next page load, and
    // a cached "we're open" would send someone through a camera prompt to a dead end.
    if (request.method === "GET" && url.pathname === "/api/config") {
      const shutter = broadcastShutter(env);
      return Response.json(
        { broadcast_offline: shutter !== null, offline_message: shutter },
        { headers: { "Cache-Control": "no-store" } }
      );
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

    if (url.pathname.startsWith("/api/auth/")) {
      return handleAuthRoutes(request, env, url);
    }
    if (url.pathname.startsWith("/api/stats/")) {
      return handleStatsRoutes(request, env, url);
    }
    if (url.pathname.startsWith("/api/seeds/")) {
      return handleSeedRoutes(request, env, url);
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

/* ═════════════════════════ Accounts ═════════════════════════ */
//
// Google sign-in. Ported from Wallflower, where the whole block sat commented out behind an
// OAUTH-DISABLED marker and `/api/auth/me` returned a hardcoded anonymous user. It is live here,
// and the difference between "live" and "configured" is the thing to understand before reading
// on: with GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or SESSION_SECRET unset, every route below
// declines and the rest of the Worker behaves exactly as it did before accounts existed.
//
// ── What signing in is FOR ───────────────────────────────────────────────────────────────────
//
// Publishing, and only publishing. There is no viewer sign-in, no cookie that outlives a viewing
// session, and `watch_events` still holds nothing that links two sessions to one person. A viewer
// cannot tell this feature shipped.
//
// It is also not the only publishing door. The MAC'd publish code is untouched and remains the
// path that keeps a broadcaster anonymous to this service. An account is the alternative for
// someone who would rather manage a stream from any device than carry a code around.
//
// ── What it does NOT reach ───────────────────────────────────────────────────────────────────
//
// The media. The content key is derived in the two browsers from the `#k=` fragment, which
// browsers never transmit. Being signed in changes who may ask this Worker for a relay; it moves
// no key and brings the server not one step closer to decrypting anything.
//
// ── Two checks, kept apart on purpose ────────────────────────────────────────────────────────
//
//   currentUser()   who is this?        a signed cookie
//   canBroadcast()  may they publish?   the allow list, default-DENY
//
// Signing in is necessary and not sufficient. Collapsing these into one function is how an auth
// check becomes one that cannot fail, which has happened twice in this codebase's lineage.

/**
 * Are accounts in use on this deployment?
 *
 * DORMANT BY DEFAULT, and deliberately a VAR rather than "are the secrets present".
 *
 * Wallflower ships its OAuth block commented out behind OAUTH-DISABLED markers, with
 * getAuthenticatedUser() returning an anonymous stand-in and canBroadcast() returning true.
 * Publishing there is gated by publish codes, exactly as it is here. Earthseed is the
 * open-source replication of Wallflower, so matching that state is the faithful thing to do.
 *
 * Keying it on the secrets would have been the obvious shortcut and it is the wrong one: this
 * Worker already carried GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET as leftovers
 * from the retired vite client, so "secrets are set" silently meant "sign-in is live" without
 * anybody choosing it. A capability should be on because someone turned it on.
 *
 * Only "on"/"1"/"true" enable it. Anything else, including unset, leaves accounts off — the
 * opposite default from the relay vars, and correct here: an absent var must not quietly add an
 * identity system to a service whose front page says it has none.
 */
function accountsEnabled(env: Env): boolean {
  const v = (env.ACCOUNTS ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

/** All three secrets, or nothing. Returned as a tuple so the callers cannot use a partial set. */
function oauthConfig(env: Env): { clientId: string; clientSecret: string; sessionSecret: string } | null {
  if (!accountsEnabled(env)) return null;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET,
  };
}

async function handleAuthRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  // GET /api/auth/me — who am I, and may I publish?
  //
  // Answers `{user: null, can_broadcast: false}` rather than 401 when nobody is signed in. A
  // signed-out visitor is the ordinary case on this site, not an error, and the client renders
  // the same page either way — it only needs to know which buttons to offer.
  if (request.method === "GET" && path === "/api/auth/me") {
    // Accounts off is the default and the ordinary answer. Reported as a fact about the
    // DEPLOYMENT rather than about the caller, so a client can tell "you are signed out" from
    // "there is no such thing as signing in here" — those need different interfaces.
    if (!accountsEnabled(env)) {
      return Response.json(
        { accounts_enabled: false, user: null },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const user = await currentUser(request, env);
    if (!user) {
      return Response.json(
        { accounts_enabled: true, user: null, sign_in_available: oauthConfig(env) !== null },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    return Response.json(
      {
        accounts_enabled: true,
        user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
        // Load-bearing: admissionVerdict() consults the same allow list on the publish path, so
        // this field reports a real capability rather than describing one. See the note there
        // about what happens when it does not.
        can_broadcast: await canBroadcast(env.DB, user.email),
        sign_in_available: true,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  // GET /api/auth/logout — drop the cookie and go home.
  //
  // Works whether or not OAuth is configured, and whether or not a cookie was presented. A logout
  // that can fail is a logout somebody is left half inside.
  if (path === "/api/auth/logout") {
    return new Response(null, {
      status: 302,
      headers: { Location: url.origin, "Set-Cookie": clearSessionCookie() },
    });
  }

  const cfg = oauthConfig(env);

  // GET /api/auth/google/login — hand the browser to Google.
  //
  // `state` is a random value echoed back by Google and also set as a short-lived cookie; the
  // callback admits nothing unless the two match. Without it, anyone could feed a victim's
  // browser a callback URL carrying their OWN authorization code and silently sign that browser
  // into the attacker's account — which sounds harmless until you remember the victim then
  // broadcasts from it.
  if (request.method === "GET" && path === "/api/auth/google/login") {
    if (!cfg) return new Response("sign-in is not configured on this deployment", { status: 503 });

    const state = crypto.randomUUID();
    return new Response(null, {
      status: 302,
      headers: {
        Location: getGoogleAuthUrl(cfg.clientId, `${url.origin}/api/auth/google/callback`, state),
        "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
      },
    });
  }

  // GET /api/auth/google/callback — where Google sends them back.
  //
  // Every failure path redirects to the origin with an `?error=` rather than rendering a message.
  // Google's own error text names our misconfiguration (a redirect URI that does not match, most
  // often) and belongs in the log, not on a stranger's screen.
  if (request.method === "GET" && path === "/api/auth/google/callback") {
    if (!cfg) return new Response("sign-in is not configured on this deployment", { status: 503 });

    if (url.searchParams.get("error")) {
      return Response.redirect(`${url.origin}/?error=oauth_denied`, 302);
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return Response.redirect(`${url.origin}/?error=invalid_request`, 302);

    const storedState = request.headers.get("Cookie")?.match(/(?:^|;\s*)oauth_state=([^;]*)/)?.[1];
    if (!storedState || !constantTimeEqual(state, storedState)) {
      return Response.redirect(`${url.origin}/?error=invalid_state`, 302);
    }

    try {
      const tokens = await exchangeCodeForTokens(
        code,
        cfg.clientId,
        cfg.clientSecret,
        `${url.origin}/api/auth/google/callback`
      );
      const profile = await getGoogleUserInfo(tokens.access_token);

      const user = await upsertGoogleUser(env.DB, {
        provider_id: profile.id,
        email: profile.email,
        name: profile.name,
        avatar_url: profile.picture,
      });

      // A session is issued to anyone who completes sign-in, including someone not on the allow
      // list. They are signed in and cannot broadcast, which is the honest state to be in — the
      // alternative is refusing the session and leaving them unable to tell whether sign-in is
      // broken or they simply have not been admitted.
      const session = await createSessionToken(user.id, cfg.sessionSecret);

      return new Response(null, {
        status: 302,
        headers: [
          ["Location", url.origin],
          ["Set-Cookie", setSessionCookie(session, url.hostname !== "localhost")],
          ["Set-Cookie", "oauth_state=; Path=/; HttpOnly; Max-Age=0"],
        ],
      });
    } catch (e) {
      console.error("oauth callback:", e);
      return Response.redirect(`${url.origin}/?error=auth_failed`, 302);
    }
  }

  return new Response("Not Found", { status: 404 });
}

/* ═════════════════════════ Viewing sessions ═════════════════════════ */
//
// How many people are watching, and for how long. Ported from Wallflower's migration-0014 work.
//
// ── The thing this is not ────────────────────────────────────────────────────────────────────
//
// It is not an audience register, and the distinction is the whole design. A row in watch_events
// is a SESSION. Nothing on it is stable across sessions — no IP, no IP hash, no cookie, no
// fingerprint, and no account id even though this Worker now has accounts. Two rows cannot be
// shown to be the same human, on one stream or across streams, by us or by anyone who later
// holds this database or compels a copy of it.
//
// "How many, and for how long" is answerable without any of that. "Which of these is the same
// person" is not, and must stay unanswerable. Migration 0011 says the same thing at the schema
// level; it is repeated here because this is where a future column would actually get added.
//
// What DID change the day this shipped: audience size became visible to an operator, which it
// was not before. That is a real change and it is named in the README rather than left to be
// discovered.
//
// ── Why a heartbeat ─────────────────────────────────────────────────────────────────────────
//
// The obvious design — open a row on page load, close it in `beforeunload` — does not work.
// beforeunload does not fire on iOS backgrounding, tab crashes, force-quit or network loss, so
// rows accumulate open for ever and every number computed from them is wrong in the same
// direction. The client pings while it is alive and the cron closes what has gone quiet, AT the
// last heartbeat: a viewer whose battery died is credited with what was observed, not with the
// hours until the next tick.

/** How often a watching client says "still here". */
const SESSION_HEARTBEAT_SECONDS = 30;

// Silence after which a session is treated as over. Deliberately several missed beats: browsers
// throttle background timers to roughly one a minute, so a tighter window would reap a viewer
// who merely switched tabs, and under-reporting real viewing is the worse error here.
const SESSION_STALE_SECONDS = 150;

/**
 * "Currently watching", computed WITHOUT trusting the reaper to have run recently.
 *
 * This is why the live count is correct on a cron that has not fired, and why it would still be
 * correct if the cron were deleted tomorrow. The reaper exists for the recorded duration of a
 * finished session, not for this number.
 */
const liveSessionSql = (t = "") =>
  `${t}ended_at IS NULL AND COALESCE(${t}last_seen_at, ${t}started_at) > datetime('now', '-${SESSION_STALE_SECONDS} seconds')`;

/** base64url SHA-256 of an arbitrary string. The session token is only ever stored like this. */
async function sha256b64url(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToB64url(new Uint8Array(d));
}

/**
 * Parse a JSON body that may have arrived via sendBeacon.
 *
 * sendBeacon sends a Blob, and the only content type it can send without turning the request
 * into a CORS preflight is text/plain — so the page-close path cannot use request.json().
 * Tolerant on purpose: a body we cannot parse is a request we answer, not one we 500 on.
 */
async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Advance a session's heartbeat. False when it does not exist, is closed, or the token is wrong. */
async function touchSession(env: Env, id: number, token: string): Promise<boolean> {
  if (!Number.isFinite(id) || !token) return false;

  const row = await env.DB
    .prepare("SELECT session_hash FROM watch_events WHERE id = ? AND ended_at IS NULL")
    .bind(id)
    .first<{ session_hash: string | null }>();
  if (!row?.session_hash) return false;
  if (!constantTimeEqual(await sha256b64url(token), row.session_hash)) return false;

  await env.DB
    .prepare("UPDATE watch_events SET last_seen_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return true;
}

/**
 * Close sessions whose heartbeat stopped, and optionally forget old ones.
 *
 * Every row carries last_seen_at from the moment it is inserted, so `end_reason` here is only
 * ever 'reaped' — there is no legacy backlog of heartbeat-less rows, because this table was
 * created new in migration 0011 rather than restored. Wallflower needed a third 'unmeasured'
 * state for exactly that backlog; carrying it across would have been importing the scar without
 * the wound.
 *
 * Retention is opt-in via STATS_RETENTION_DAYS, and unset means keep everything — the point of
 * the table is to be reportable. Setting it is still worth considering: these rows are
 * timestamps against stream ids, and the safest audience record is the one that is no longer
 * there to be compelled.
 */
async function reapSessions(env: Env): Promise<{ closed: number; purged: number }> {
  const closed = await env.DB
    .prepare(
      `UPDATE watch_events
          SET ended_at = COALESCE(last_seen_at, started_at),
              end_reason = 'reaped'
        WHERE ended_at IS NULL
          AND COALESCE(last_seen_at, started_at) <= datetime('now', '-${SESSION_STALE_SECONDS} seconds')`
    )
    .run();

  let purged = 0;
  const days = parseInt(env.STATS_RETENTION_DAYS ?? "", 10);
  if (Number.isFinite(days) && days > 0) {
    const res = await env.DB
      .prepare(`DELETE FROM watch_events WHERE started_at < datetime('now', '-${days} days')`)
      .run();
    purged = res.meta?.changes ?? 0;
  }

  return { closed: closed.meta?.changes ?? 0, purged };
}

async function handleStatsRoutes(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // POST /api/stats/watch — open a viewing session.
  //
  // Gated on the same proof-of-link tag as /api/watch/start, and for the same reason. Without
  // it this is an unauthenticated INSERT that accepts any stream id: anyone could manufacture
  // an audience for a broadcast they had never been given, inflating somebody's viewer badge
  // and burning unbounded D1 writes for free. The tag makes it a capability — you can only open
  // a session on a broadcast whose link you already hold.
  //
  // Enforced only once a live broadcast has registered a tag, matching the placement path
  // exactly. An attacker cannot choose whether the row carries one; only the broadcaster can.
  if (method === "POST" && path === "/api/stats/watch") {
    const body = await readJsonBody<{ broadcast?: string; tag?: string }>(request);
    const broadcast = body?.broadcast ?? "";
    if (!isNodeId(broadcast)) return new Response("offline", { status: 404 });

    // 404 for every refusal, so a stranger sweeping ids cannot use this endpoint to learn which
    // ones are live. Same reasoning as /api/watch/start.
    if (await streamIsKilled(env, broadcast)) return new Response("offline", { status: 404 });

    const live = await liveRouteTag(env, broadcast);
    if (!live) return new Response("offline", { status: 404 });
    if (live.tag && !constantTimeEqual(body?.tag ?? "", live.tag)) {
      return new Response("offline", { status: 404 });
    }

    // The session token. Held in the viewer's page memory only, never persisted in the browser
    // and never reused across streams — it authorises heartbeat and end for THIS session, and
    // is not an identifier for the person holding it. Persisting it, or reusing one, would
    // rebuild precisely the cross-session identifier this whole table is shaped to avoid.
    const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));

    const result = await env.DB
      .prepare(
        `INSERT INTO watch_events (stream_id, last_seen_at, session_hash)
         VALUES (?, datetime('now'), ?) RETURNING id`
      )
      .bind(broadcast, await sha256b64url(token))
      .first<{ id: number }>();

    return Response.json({
      id: result?.id,
      token,
      heartbeat_seconds: SESSION_HEARTBEAT_SECONDS,
    });
  }

  // POST /api/stats/watch/:id/heartbeat — "still watching".
  //
  // This is what makes a duration measured rather than assumed. Answers `ok: false` instead of
  // an error status when the session is gone — reaped after a long backgrounding, say — so the
  // client can simply open a fresh one. A viewer who comes back is watching again, and stitching
  // that into the old row would credit them for the gap.
  const beat = path.match(/^\/api\/stats\/watch\/(\d+)\/heartbeat$/);
  if (method === "POST" && beat) {
    const id = parseInt(beat[1], 10);
    const body = await readJsonBody<{ token?: string }>(request);
    const ok = await touchSession(env, id, body?.token ?? "");

    // SEEDS DEMO: one heartbeat is 30 viewer-seconds of delivery, charged to whichever vault
    // this stream is attached to. The stream id is read back from the session ROW rather than
    // taken from the request, so a viewer cannot choose whose seeds they spend.
    //
    // Costs one SELECT per heartbeat and returns immediately for any stream with no vault —
    // which is every ordinary broadcast on this site, so nothing outside the demo is affected.
    if (ok) {
      const row = await env.DB
        .prepare("SELECT stream_id FROM watch_events WHERE id = ?")
        .bind(id)
        .first<{ stream_id: string }>();
      if (row?.stream_id) await burnForStream(env, row.stream_id);
    }

    return Response.json(ok ? { ok: true } : { ok: false, reason: "unknown" });
  }

  // POST /api/stats/watch/:id/end — close a viewing session.
  //
  // Token-checked because ids are sequential integers: unauthenticated, this lets anyone walk the
  // range and close sessions they had no part in, zeroing out every stream's audience. Idempotent,
  // because it is called from pagehide and may race the reaper.
  const end = path.match(/^\/api\/stats\/watch\/(\d+)\/end$/);
  if (method === "POST" && end) {
    const id = parseInt(end[1], 10);
    const body = await readJsonBody<{ token?: string }>(request);

    const row = await env.DB
      .prepare("SELECT session_hash FROM watch_events WHERE id = ?")
      .bind(id)
      .first<{ session_hash: string | null }>();

    // Already purged, or a row with no hash to check against: nothing to close, and saying so is
    // not an error. The reaper handles anything this cannot.
    if (!row?.session_hash) return Response.json({ ok: true });

    if (!constantTimeEqual(await sha256b64url(body?.token ?? ""), row.session_hash)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    await env.DB
      .prepare(
        `UPDATE watch_events SET ended_at = datetime('now'), end_reason = 'client'
          WHERE id = ? AND ended_at IS NULL`
      )
      .bind(id)
      .run();

    return Response.json({ ok: true });
  }

  // GET /api/stats/stream/:broadcast/viewers?tag=… — how many are watching right now.
  //
  // Gated on the proof-of-link tag as well. Audience size is metadata ABOUT a broadcaster —
  // "how many people are watching this right now" is worth knowing to anyone deciding whether
  // a stream matters — and ungated it would be readable by anyone who guessed an id. The
  // broadcaster derives the tag from the same link secret its viewers use, so it can still read
  // its own badge.
  //
  // Returns a COUNT and not a list. Wallflower returned rows here, joined to users; there is
  // nothing to join to and nothing per-viewer worth sending, and an endpoint that emits one
  // object per watcher is an endpoint somebody will eventually try to correlate.
  const viewers = path.match(/^\/api\/stats\/stream\/([a-z2-7]+)\/viewers$/);
  if (method === "GET" && viewers) {
    const broadcast = viewers[1];
    if (!isNodeId(broadcast)) return new Response("Not Found", { status: 404 });

    // Only gate once a live broadcast has registered a tag. Nothing to protect before then: with
    // no live row there is no audience, and the badge must still render 0 while a broadcaster is
    // setting up.
    const live = await liveRouteTag(env, broadcast);
    if (live?.tag) {
      if (!constantTimeEqual(url.searchParams.get("tag") ?? "", live.tag)) {
        return Response.json({ viewers: 0 }, { status: 404 });
      }
    }

    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM watch_events WHERE stream_id = ? AND ${liveSessionSql()}`)
      .bind(broadcast)
      .first<{ n: number }>();

    return Response.json(
      { viewers: row?.n ?? 0, heartbeat_seconds: SESSION_HEARTBEAT_SECONDS },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return new Response("Not Found", { status: 404 });
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
/**
 * May this request publish?
 *
 * TWO DOORS, and the second one only exists when accounts are switched on:
 *
 *   1. a MAC'd publish code (or PUBLISH_SECRET) — the anonymous door, always open
 *   2. a signed-in user on the broadcaster allow list — only when ACCOUNTS=on
 *
 * ── Why the account door is wired in HERE rather than left for later ────────────────────────
 *
 * Because "later" is how this exact bug happens. Commit ca59e58 (12 Aug 2026) deleted an earlier
 * accounts surface and recorded why:
 *
 *   "/api/auth/google/login still 302'd to Google with a real client id, and the session it
 *    minted gated exactly one route the shipped client never calls, which meant the broadcaster
 *    allow list everyone believed was gating publishing was gating nothing."
 *
 * That was reproduced on 20 Sep 2026 when the accounts surface came back: `canBroadcast()` was
 * called from `/api/auth/me` and nowhere else, so a default-DENY allow list sat in front of a
 * publish path that never consulted it. A gate that cannot refuse is worse than no gate, because
 * people believe it. This function is the only place that can refuse, so the check belongs here.
 *
 * Note the doors are OR, not AND. Turning accounts on must not silently break every broadcaster
 * holding a publish code — and the anonymous door is the one that keeps a broadcaster anonymous
 * to this service, which is a property worth more than tidiness.
 */
async function admissionVerdict(
  env: Env,
  credential: string | undefined,
  request?: Request
): Promise<{ ok: boolean; reason: string }> {
  if (!env.PUBLISH_SECRET && !env.ISSUE_KEY) {
    return { ok: false, reason: "publisher authorization is not configured" };
  }

  // Door 2, tried first only because it needs no credential in the body.
  if (request && accountsEnabled(env)) {
    const user = await currentUser(request, env);
    if (user && (await canBroadcast(env.DB, user.email))) {
      return { ok: true, reason: "account" };
    }
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

/* ── moq.pro assignment (Mode A) ──────────────────────────────────────────────────────────────
 *
 * The same hosted CDN vivoh.earth and wallflower.tv publish through, joined here on 20 Sep 2026.
 *
 * There is no /assign call and no broker in the path. The relay is always cdn.moq.pro, the
 * broadcast lives at `<root>/<broadcast>`, and this Worker mints a short-lived token scoped to
 * THAT ONE NAME. A publisher gets put+get; a viewer gets get only, so a token handed to an
 * audience cannot be turned round and published with.
 *
 * ── What this does NOT change ────────────────────────────────────────────────────────────────
 *
 * The content key. It is derived in the two browsers from the `#k=` fragment, which browsers
 * never transmit, so cdn.moq.pro carries ciphertext it cannot read — exactly as the tinymoq
 * fleet did. Moving CDN moves who fans out the bytes, not who can decode them. Worth stating
 * plainly because "we moved to somebody else's CDN" sounds like it should weaken the claim on
 * the front page, and it does not touch it.
 *
 * ── The shared root ──────────────────────────────────────────────────────────────────────────
 *
 * MOQ_PRO_ROOT defaults to "erik", the namespace the other two products already use. That is an
 * accepted risk rather than an oversight, and it is cheaper here than it is for them: earthseed
 * broadcast names are 52-character base32 Ed25519 PUBLIC KEYS, not five random characters, so a
 * cross-product collision is not improbable — it is a key collision, which is to say impossible.
 * A name is also unforgeable: taking one would mean holding its private half.
 *
 * Returns null when no moq.pro secret is set, and callers fall through to the broker.
 */
const MOQ_PRO_RELAY = "cdn.moq.pro";

/**
 * Mark this broadcast live, superseding any earlier row for the same name.
 *
 * One live row per session. Closing the previous one first matters more than it looks: a
 * broadcaster who reloads mid-stream would otherwise leave a stale row carrying the route tag of
 * the OLD link, and every viewer holding the NEW link would be refused by proof-of-link.
 *
 * Extracted when moq.pro arrived, so that the two placement backends cannot drift in how they
 * record a broadcast — the row is the thing viewers are gated against, and a difference between
 * the paths would show up as "watching works on one CDN and not the other".
 */
async function openBroadcastRow(env: Env, broadcast: string, tag: string | null): Promise<void> {
  await env.DB
    .prepare("UPDATE broadcasts SET ended_at = datetime('now') WHERE stream_id = ? AND ended_at IS NULL")
    .bind(broadcast)
    .run();
  await env.DB
    .prepare("INSERT INTO broadcasts (stream_id, route_tag) VALUES (?, ?)")
    .bind(broadcast, tag)
    .run();
}

async function moqProAssign(
  env: Env,
  broadcast: string,
  role: "publish" | "watch",
  ttlSeconds: number
): Promise<{ relay: string; path: string; jwt: string } | null> {
  // Prefer the asymmetric key: moq.pro holds only its public half, so it can verify our tokens
  // and cannot mint one. MOQ_PRO_K is the legacy symmetric secret moq.pro also holds, kept so
  // that unsetting the JWK restores previous behaviour rather than breaking.
  const jwk = env.MOQ_PRO_JWK;
  const k = env.MOQ_PRO_K;
  if (!jwk && !k) return null;

  const root = env.MOQ_PRO_ROOT || "erik";

  // No ".hang" suffix, unlike vivoh.earth and wallflower.tv. Theirs is real: those clients
  // publish the @moq/hang catalog format and the suffix tells a watcher how to parse it. This
  // client publishes its OWN catalog track (see simple/earthseed.js §4), so the suffix here
  // would be a claim about a format that is not being used. moq.pro matches the name as a
  // string and has no opinion about it either way.
  const sub = broadcast;

  const claims = {
    root,
    put: role === "publish" ? [sub] : [],
    get: [sub],
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const jwt = jwk
    ? await mintMoqProTokenEd25519(jwk, claims)
    : await mintMoqProToken(k as string, claims);

  return { relay: MOQ_PRO_RELAY, path: `${root}/${sub}`, jwt };
}

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
  // The shutter, before anything else on the publish side. Placed here rather than inside each
  // handler so that a route added later cannot quietly miss it — /api/broadcast/challenge already
  // reaches out to the broker, and with the fleet down that is a hung fetch and a 502 rather than
  // an answer anyone can act on.
  //
  // 503 with Retry-After is the honest status: the service exists and is expected back, which is
  // exactly what the notice says. `offline: true` is what the client keys off; the message is sent
  // so the wording lives in ONE place (the var) instead of being duplicated in the client.
  const shutter = broadcastShutter(env);
  if (shutter && (url.pathname === "/api/broadcast/start" || url.pathname === "/api/broadcast/challenge")) {
    return Response.json(
      { error: shutter, offline: true },
      { status: 503, headers: { "Retry-After": "3600", "Cache-Control": "no-store" } }
    );
  }

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
    const admission = await admissionVerdict(env, body?.code?.trim(), request);
    if (!admission.ok) {
      return Response.json({ error: admission.reason, need_code: true }, { status: 403 });
    }

    if (await streamIsKilled(env, broadcast)) {
      return Response.json({ error: "This stream has been terminated." }, { status: 410 });
    }

    if (!body?.challenge || !body?.sig || !(await claimIsValid(broadcast, body.challenge, body.sig))) {
      return Response.json({ error: "could not verify this broadcast name is yours" }, { status: 403 });
    }

    const tag = typeof body.tag === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(body.tag) ? body.tag : null;
    const ttl = Math.floor(numVar(env.PUBLISHER_TOKEN_TTL, PUBLISHER_TOKEN_TTL_DEFAULT));

    // ── moq.pro (Mode A) ────────────────────────────────────────────────────────────────────
    //
    // Answers first when a MOQ_PRO_* secret is set, and there is nothing to ask anyone for: the
    // relay is fixed and the token is minted here. The broker path below is then unreachable,
    // which is what makes switching CDN a secret change rather than a deploy.
    //
    // `origin_endpoint_id` is deliberately absent from this response. It is an iroh EndpointId
    // for a fleet box to pull from, and on moq.pro there is no second box — `path` takes its
    // place, and its presence is how the client tells the two backends apart.
    const mp = await moqProAssign(env, broadcast, "publish", ttl);
    if (mp) {
      await openBroadcastRow(env, broadcast, tag);
      return Response.json({
        relay_url: `https://${mp.relay}/`,
        path: mp.path,
        jwt: mp.jwt,
        ttl,
      });
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

    await openBroadcastRow(env, broadcast, tag);

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

    const configured = Math.floor(numVar(env.VIEWER_TOKEN_TTL, VIEWER_TOKEN_TTL_DEFAULT));
    // A test may ask for a shorter one; it may never ask for a longer one.
    const requested = Math.floor(numVar(body?.ttl as unknown as string, configured));
    const ttl = Math.max(10, Math.min(configured, requested));

    // ── moq.pro (Mode A) ────────────────────────────────────────────────────────────────────
    //
    // `get` only, never `put`. A viewer token that could publish would let anyone holding a
    // share link overwrite the broadcast they were invited to watch, and an audience cannot
    // tell a presenter's camera from a fabrication published under the presenter's own name.
    // The role argument is what enforces that; see moqProAssign.
    //
    // There is no edge/origin distinction to make here. moq.pro fans out from one name, so the
    // `origin` field a viewer sends for the fleet path is simply unused — not ignored by
    // oversight, but because there is no second relay for it to address.
    const mp = await moqProAssign(env, broadcast, "watch", ttl);
    if (mp) {
      return Response.json({ relay_url: `https://${mp.relay}/`, path: mp.path, jwt: mp.jwt, ttl });
    }

    const assigned = await brokerAssign(env, {
      broadcast,
      role: "watch",
      origin: body?.origin ?? "",
      xport: "iroh",
    });
    if (assigned.error) return Response.json({ error: String(assigned.error) }, { status: 502 });
    if (!assigned.relay) return Response.json({ error: "edge assign incomplete" }, { status: 502 });

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
/* ── Per-stream settings ────────────────────────────────────────────────────────────────────
 *
 * The overlay, the chat opt-in, the viewer-auth flag and the sealed link watermark. Ported from
 * Wallflower; the storage is migration 0013 and the reasoning for each column lives there.
 *
 * ── Who may write them ─────────────────────────────────────────────────────────────────────
 *
 * Whoever holds the private half of the key the stream id is MADE of. The id is a 52-character
 * base32 Ed25519 public key, so ownership needs no account, no row and no allow list: sign a
 * challenge, and the name proves itself.
 *
 * The challenge is minted HERE rather than relayed from the broker, and that is the one place
 * this departs from the go-live path. Go-live hands its signature on to the broker, which checks
 * freshness; a settings write has no broker in the path, so relaying a broker challenge would
 * mean accepting a signature nothing had ever checked the age of — and a captured signature could
 * then rewrite someone's overlay for as long as their stream id existed. Minting our own, MAC'd
 * against ISSUE_KEY with the issue time inside it, is the same idiom already used for the
 * publish-code proof-of-work and it makes the signature expire.
 *
 * ── Reading them is open, and has to be ────────────────────────────────────────────────────
 *
 * A viewer needs the overlay and the chat flag to render the page, and a viewer holds a link and
 * nothing else. So GET is ungated. What that discloses is exactly what the broadcaster chose to
 * put on screen in front of strangers, plus two booleans. `link_enc` is returned too and is
 * meaningless without the fragment key — it is a sealed blob this service cannot read.
 */

const SETTINGS_CONTEXT = "earthseed-settings-v1";
const SETTINGS_CHALLENGE_TTL_SECONDS = 300;

/** Length bound on the sealed watermark. Opaque to us, so a bound is the only check available —
 *  and it is the one that matters: without it this column is a free blob store. A sealed URL runs
 *  to a few hundred bytes. */
const LINK_ENC_MAX = 2048;
/** Bound on the overlay. Sanitised in the client, not here; this only stops the column being used
 *  as storage. */
const OVERLAY_MAX = 64 * 1024;

async function mintSettingsChallenge(env: Env): Promise<string | null> {
  if (!env.ISSUE_KEY) return null;
  const issued = Math.floor(Date.now() / 1000).toString();
  return `${issued}.${await hmac(env.ISSUE_KEY, `${SETTINGS_CONTEXT}|${issued}`)}`;
}

async function settingsChallengeIsValid(env: Env, challenge: string): Promise<boolean> {
  if (!env.ISSUE_KEY) return false;
  const [issued, mac] = challenge.split(".");
  if (!issued || !mac) return false;
  const age = Math.floor(Date.now() / 1000) - Number(issued);
  if (!Number.isFinite(age) || age < -5 || age > SETTINGS_CHALLENGE_TTL_SECONDS) return false;
  return constantTimeEqual(mac, await hmac(env.ISSUE_KEY, `${SETTINGS_CONTEXT}|${issued}`));
}

type StreamSettings = {
  require_auth: number;
  overlay_html: string | null;
  chat_enabled: number;
  link_enc: string | null;
};

async function handleStreamSettings(
  request: Request,
  env: Env,
  url: URL,
  streamId: string
): Promise<Response> {
  // GET — what a viewer needs to render the page.
  if (request.method === "GET") {
    const row = await env.DB
      .prepare("SELECT require_auth, overlay_html, chat_enabled, link_enc FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<StreamSettings>();

    return Response.json(
      {
        require_auth: row?.require_auth === 1,
        overlay_html: row?.overlay_html ?? "",
        chat_enabled: row?.chat_enabled === 1,
        link_enc: row?.link_enc ?? "",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const body = (await request.json().catch(() => null)) as {
    challenge?: string;
    signature?: string;
    require_auth?: boolean;
    overlay_html?: string;
    chat_enabled?: boolean;
    link_enc?: string;
  } | null;

  if (!body?.challenge || !body?.signature) {
    return Response.json({ error: "signed claim required" }, { status: 400 });
  }
  if (!(await settingsChallengeIsValid(env, body.challenge))) {
    return Response.json({ error: "challenge expired or invalid" }, { status: 403 });
  }
  if (!(await claimIsValid(streamId, body.challenge, body.signature))) {
    return Response.json({ error: "claim signature does not verify" }, { status: 403 });
  }

  // Read-then-write, so a caller can send one field without clearing the others. Anything absent
  // keeps its current value rather than reverting to a default — a settings POST that silently
  // wiped the overlay because it only meant to toggle chat would be a bad surprise.
  const current = await env.DB
    .prepare("SELECT require_auth, overlay_html, chat_enabled, link_enc FROM streams WHERE stream_id = ?")
    .bind(streamId)
    .first<StreamSettings>();

  const requireAuth = body.require_auth ?? current?.require_auth === 1;
  const chatEnabled = body.chat_enabled ?? current?.chat_enabled === 1;
  const overlayHtml = body.overlay_html ?? current?.overlay_html ?? "";
  const linkEnc = body.link_enc ?? current?.link_enc ?? "";

  if (typeof overlayHtml !== "string" || overlayHtml.length > OVERLAY_MAX) {
    return Response.json({ error: "overlay_html too large" }, { status: 400 });
  }
  if (typeof linkEnc !== "string" || linkEnc.length > LINK_ENC_MAX) {
    return Response.json({ error: "link_enc too large" }, { status: 400 });
  }

  await env.DB
    .prepare(
      `INSERT INTO streams (stream_id, require_auth, overlay_html, chat_enabled, link_enc)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET
         require_auth = excluded.require_auth,
         overlay_html = excluded.overlay_html,
         chat_enabled = excluded.chat_enabled,
         link_enc     = excluded.link_enc,
         updated_at   = datetime('now')`
    )
    .bind(streamId, requireAuth ? 1 : 0, overlayHtml, chatEnabled ? 1 : 0, linkEnc)
    .run();

  return Response.json({
    require_auth: requireAuth,
    overlay_html: overlayHtml,
    chat_enabled: chatEnabled,
    link_enc: linkEnc,
  });
}

async function handleStreamStatus(request: Request, env: Env, url: URL): Promise<Response> {
  // GET /api/stream/challenge — a nonce for a broadcaster to sign before writing settings.
  // Public: it grants nothing on its own and is useless without the private half of the key the
  // stream id is made of.
  if (request.method === "GET" && url.pathname === "/api/stream/challenge") {
    const challenge = await mintSettingsChallenge(env);
    if (!challenge) return Response.json({ error: "ISSUE_KEY is not configured" }, { status: 503 });
    return Response.json({ challenge, expires_in: SETTINGS_CHALLENGE_TTL_SECONDS });
  }

  const s = url.pathname.match(/^\/api\/stream\/([a-z2-7]+)\/settings$/);
  if (s && isNodeId(s[1])) return handleStreamSettings(request, env, url, s[1]);

  // GET /api/stream/:broadcast/chat — the live chat WebSocket, forwarded to the per-stream
  // ChatRoom Durable Object.
  //
  // GATED ON PROOF-OF-LINK, like /api/watch/start and the viewer count. Without it, anyone who
  // guessed a broadcast name could join its chat — and while the Durable Object cannot read the
  // messages, an uninvited socket still learns how many people are talking and when, and can
  // fill the room with sealed junk that every real participant has to download.
  //
  // The tag rides in the query string rather than a header because the WebSocket constructor
  // cannot set headers. It is a capability, not a secret to hide: everyone with the link derives
  // the same value, and it is cryptographically independent of the key that opens the messages.
  const c = url.pathname.match(/^\/api\/stream\/([a-z2-7]+)\/chat$/);
  if (c && isNodeId(c[1])) {
    const broadcast = c[1];
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // 404 for every refusal, so this never confirms a stream exists to somebody who cannot
    // already watch it — the same reasoning as every other gate on this id.
    if (await streamIsKilled(env, broadcast)) return new Response("Not Found", { status: 404 });

    const live = await liveRouteTag(env, broadcast);
    if (!live) return new Response("Not Found", { status: 404 });
    if (live.tag && !constantTimeEqual(url.searchParams.get("tag") ?? "", live.tag)) {
      return new Response("Not Found", { status: 404 });
    }

    const id = env.CHAT_ROOMS.idFromName(broadcast);
    return env.CHAT_ROOMS.get(id).fetch(request);
  }

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

/**
 * What a viewer can report, grouped the way the dialog presents it.
 *
 * TWO KINDS OF THING LIVE IN THIS LIST and they are not equivalent. One category carries a
 * federal reporting duty and a preservation clock — see REPORT_CSAM_CATEGORY below and
 * migration 0010. The rest are policy: we decide what to do about them, and on what timescale.
 *
 * The four `adult-*` categories are the OBSERVABLE FORM of Stripe's Prohibited Businesses
 * bullets. Stripe writes that list for merchant underwriting, so it names business types —
 * "adult video stores", "gentleman's clubs" — which nobody holding a share link can report,
 * because they are looking at a broadcast rather than at a company. The mapping lives here, in
 * one place, rather than pasted into anything a user reads: Stripe revises that list without
 * notice, and a copy of it in our UI would be a stale statement of somebody else's rule.
 *
 * Mapping, against the list as read on 3 Sep 2026:
 *
 *   adult-sexual-content   <- "Pornography and other mature audience content (including
 *                              literature, imagery, and other media) designed for the purpose
 *                              of sexual gratification"
 *   adult-services         <- "Adult services, including prostitution, escorts, sexual
 *                              massages, fetish services, mail-order brides"
 *   adult-paid-performance <- the rest of that same bullet — "pay-per-view ... adult live-chat
 *                              features" — plus "Gentleman's clubs, topless bars, and strip
 *                              clubs", all of which reach a viewer as a paid performance
 *   adult-ai-generated     <- "Any artificial-intelligence generated content that meets the
 *                              above criteria"
 *
 * "Adult video stores" is deliberately unrepresented: it has no live-broadcast form, and a
 * stored catalogue is not a thing this product can host.
 *
 * VALUES ARE PERMANENT. `sexual-content-involving-minors` keeps its original spelling even
 * though the grouping around it changed, because rows written before this list existed still
 * carry it — and a rename would orphan precisely the records that must not be orphaned.
 */
const REPORT_GROUPS: ReadonlyArray<{ label: string; ids: readonly string[] }> = [
  { label: "Most serious", ids: ["sexual-content-involving-minors"] },
  {
    label: "Sexual content",
    ids: ["adult-sexual-content", "adult-services", "adult-paid-performance", "adult-ai-generated"],
  },
  {
    label: "Other harm",
    ids: ["violence-or-threats", "non-consensual-content", "harassment", "other"],
  },
];

const REPORT_CATEGORIES = new Set(REPORT_GROUPS.flatMap((g) => [...g.ids]));

/**
 * The one category that differs in kind rather than in degree.
 *
 * A report filed under this heading gives us actual knowledge for the purposes of 18 U.S.C.
 * 2258A — which is the whole reason a report path exists on an encrypted platform. We do not
 * monitor, and 2258A(f) says plainly that no provider is required to, so a viewer pressing
 * this button is the only way knowledge ever arrives here. From that moment the frame attached
 * to it is evidence, and nothing automated may throw it away.
 */
const REPORT_CSAM_CATEGORY = "sexual-content-involving-minors";

/**
 * How long a preserved report is held, in days.
 *
 * 18 U.S.C. 2258A(h) required 90 days until the REPORT Act (signed 7 May 2024) struck that and
 * inserted "1 year". 366 rather than 365 so a leap year cannot leave us a day short — it costs
 * nothing and removes a class of argument nobody wants to have.
 */
const REPORT_PRESERVE_DAYS = 366;

/**
 * SQL predicate: this row is NOT under a preservation hold.
 *
 * ONE shared string rather than three hand-written copies, because it has to guard the three
 * separate ways a frame can be destroyed — the retention cron, the operator's "remove this
 * frame" button, and the heavier "delete this report" lever. Three independently-maintained
 * WHERE clauses would drift, and the way anyone would find out which one had drifted is by
 * discovering that evidence was gone.
 *
 * The stored value and datetime('now') share SQLite's "YYYY-MM-DD HH:MM:SS" shape, so the
 * string comparison is also the chronological one.
 */
const REPORT_NOT_PRESERVED = "(preserve_until IS NULL OR preserve_until <= datetime('now'))";

const REPORT_NOTE_MAX = 500;
/** One hostile invitee must not be able to manufacture a pile of reports about one stream. */
const REPORT_PER_STREAM_PER_HOUR = 10;
/** Backstop against someone filling the table with reports about ids that never existed. */
const REPORT_GLOBAL_PER_HOUR = 300;

/**
 * Ceiling on an attached frame, in base64 characters (~3/4 of that in bytes).
 *
 * Sized against the global cap rather than against what looks like a reasonable picture:
 * 300 reports an hour at 96 KB each is about 28 MB an hour of database growth in the worst
 * case, which retention then claws back. The client aims well under this — 512px on the long
 * edge with a quality ladder — so hitting the ceiling means something is wrong, not that
 * someone had a detailed frame.
 */
const REPORT_FRAME_MAX_B64 = 96_000;

/** How long a frame outlives the report it came with, when nothing overrides it. */
const REPORT_FRAME_RETENTION_DAYS_DEFAULT = 30;

/**
 * Accept a viewer-attached frame, or nothing at all.
 *
 * Strict on purpose, and strict about the RIGHT thing. The danger here is not a malformed
 * image — it is that this value ends up in an `<img src>` on the one page that holds the
 * admin password. So the client is never allowed to say what the bytes are: it sends bare
 * base64, we check the decoded prefix is a real JPEG SOI marker, and the console hardcodes
 * image/jpeg on the way out. A `data:image/svg+xml` — which executes script — cannot survive
 * that, because it does not start with FF D8 FF whatever its label claims.
 *
 * Returns null for anything it does not like. A bad frame silently drops the frame and keeps
 * the report: someone reporting child abuse must not have their report rejected because their
 * browser produced an image we could not parse.
 */
function sanitiseReportFrame(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Tolerate a data URL prefix from a caller who built one by hand, but keep only the payload.
  const b64 = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  if (b64.length < 64 || b64.length > REPORT_FRAME_MAX_B64) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  // base64 of FF D8 FF — the JPEG start-of-image marker. Every JPEG begins "/9j/"; no SVG,
  // HTML, PNG or script payload does.
  if (!b64.startsWith("/9j/")) return null;
  return b64;
}

/**
 * Forget the picture, keep the complaint.
 *
 * Run from the scheduled handler. Retention here is ON by default: a reported frame is a
 * photograph of someone's room taken from a broadcast we are otherwise unable to see, and
 * defaults should favour whichever way round is harder to regret. An operator who wants to
 * keep frames indefinitely can say so with REPORT_FRAME_RETENTION_DAYS=0.
 *
 * The row survives. Nulling the column leaves the report, its category and its timestamp in
 * the queue, so the administrative record of a complaint outlives its contents — which is
 * also what makes this safe to run on a short clock.
 *
 * PRESERVED ROWS ARE EXEMPT. A report carrying a `preserve_until` in the future is evidence
 * under a statutory hold and this cron must not touch it. The clause is in SQL rather than in
 * TypeScript so that no future caller can reach the same UPDATE by another route and skip it.
 */
async function expireReportFrames(env: Env): Promise<number> {
  const raw = env.REPORT_FRAME_RETENTION_DAYS ?? "";
  // An explicit 0 means "never expire". An unset or unparseable value means the default, not
  // "keep forever": a typo in a dashboard should not quietly turn retention off.
  const parsed = parseInt(raw, 10);
  const days = raw.trim() === "0" ? 0 : (Number.isFinite(parsed) && parsed > 0 ? parsed : REPORT_FRAME_RETENTION_DAYS_DEFAULT);
  if (days === 0) return 0;

  const res = await env.DB
    .prepare(
      `UPDATE reports SET frame = NULL
        WHERE frame IS NOT NULL
          AND created_at < datetime('now', '-${days} days')
          AND ${REPORT_NOT_PRESERVED}`
    )
    .run();
  return res.meta?.changes ?? 0;
}

async function handleReportRoutes(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  // GET /api/report/config — what the dialog should offer. Read at open time so the evidence-link
  // option can be turned off by unsetting a secret rather than by shipping new client code.
  if (request.method === "GET" && url.pathname === "/api/report/config") {
    return Response.json({
      // Flat list kept for older clients still in a browser's cache, which read `categories`
      // and know nothing about groups. Removing it would empty their dropdown.
      categories: [...REPORT_CATEGORIES],
      // The same set with the headings the dialog draws. Sent as structure rather than guessed
      // at by the client so that adding a category is a Worker deploy, not a Worker deploy plus
      // a client everyone has to re-download before it appears.
      groups: REPORT_GROUPS.map((g) => ({ label: g.label, ids: [...g.ids] })),
      note_max: REPORT_NOTE_MAX,
      evidence: !!env.REPORT_WEBHOOK,
      // Unlike the evidence link, a frame needs no webhook: it goes in the row. The client
      // reads this to size its compression, so raising the ceiling here widens what phones
      // send without shipping new client code.
      frame_max_b64: REPORT_FRAME_MAX_B64,
      frame_retention_days:
        parseInt(env.REPORT_FRAME_RETENTION_DAYS ?? "", 10) || REPORT_FRAME_RETENTION_DAYS_DEFAULT,
    });
  }
  if (request.method !== "POST" || url.pathname !== "/api/report") {
    return new Response("Not Found", { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as {
    stream_id?: string;
    category?: string;
    note?: string;
    evidence_url?: string;
    frame?: string;
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

  // A still from the reporter's own player, captured the moment they pressed the button. This is
  // the first plaintext broadcast content this database has ever held — see migration 0010 for
  // why that trade is worth making, and for the four things that bound it. It is stored only on
  // the path where the report is actually recorded: a rate-limited pile-on returns above this
  // line, so flooding the endpoint cannot flood the table with pictures either.
  const frame = sanitiseReportFrame(body?.frame);

  // The preservation clock starts HERE, at intake, for the one category that carries a duty.
  //
  // Set at intake rather than when an operator files to NCMEC, even though 2258A(h) measures
  // its year from the submission. The statute's clock cannot start until somebody files, and
  // between arrival and filing sits a queue that a human reads at human speed — during which
  // the ordinary 30-day reaper would happily delete the evidence. So this is a floor, not the
  // statutory window: it keeps the frame alive while it waits, and recording a submission
  // re-bases it to a full year from the date that actually counts.
  //
  // Written as a literal datetime rather than a rule the reaper evaluates, so that changing
  // REPORT_PRESERVE_DAYS later cannot retroactively shorten a window already promised on a
  // report we have taken in.
  const preserveUntil =
    category === REPORT_CSAM_CATEGORY
      ? new Date(Date.now() + REPORT_PRESERVE_DAYS * 86_400_000).toISOString().replace("T", " ").slice(0, 19)
      : null;

  await env.DB
    .prepare("INSERT INTO reports (stream_id, category, note, frame, preserve_until) VALUES (?, ?, ?, ?, ?)")
    .bind(streamId, category, note, frame, preserveUntil)
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
          // The severe category leads with what it is and what it obliges, because this text is
          // the only part of the payload a phone notification will show. An operator glancing at
          // a lock screen must be able to tell this apart from a harassment report without
          // opening anything.
          text: `${
            category === REPORT_CSAM_CATEGORY
              ? `⚠ EARTHSEED — CSAM REPORT: ${streamId}\n` +
                "Actual knowledge under 18 U.S.C. 2258A. Report to the NCMEC CyberTipline as " +
                "soon as reasonably possible, then record the submission in /reports. The frame " +
                "is preserved and cannot be deleted until the window expires."
              : `earthseed report: ${streamId} — ${category}`
          }${note ? `\n${note}` : ""}${
            evidenceUrl ? `\nviewer supplied a link: ${evidenceUrl}` : "\n(no link supplied — cannot verify)"
          }${frame ? "\na frame from the moment of the report is attached — see /reports" : "\n(no frame attached)"}`,
          stream_id: streamId,
          category,
          severe: category === REPORT_CSAM_CATEGORY,
          preserve_until: preserveUntil,
          note,
          evidence_url: evidenceUrl ?? null,
          // A data URL, assembled here rather than stored as one: the type is ours to assert,
          // never the reporter's to declare. Receivers that only read `text` ignore it; the
          // console renders the same bytes straight from the row.
          frame: frame ? `data:image/jpeg;base64,${frame}` : null,
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

  // The seeds demo's operator surface — read the vaults, credit one, reset the lot. Dispatched
  // here, AFTER the password check above, so it inherits the same gate as everything else
  // rather than carrying its own. A demo that can mint balances needs the strongest door in the
  // building, not a second one somebody has to remember to lock.
  //
  // It answers null for a path it does not own, so an unknown /api/admin/seeds/* falls through
  // to the 404 at the bottom of this function rather than being swallowed here.
  if (path.startsWith("/api/admin/seeds")) {
    const handled = await handleSeedAdminRoutes(request, env, url);
    if (handled) return handled;
  }

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
  //
  // A frame, where one was attached, IS in the row — but it is not in this response. Two hundred
  // rows carrying a picture each would be tens of megabytes over D1's per-query response ceiling,
  // so the list answers only WHETHER there is one and the console fetches the bytes it decides
  // to show.
  //
  // SORT ORDER CARRIES THE DUTY. A report under a preservation hold that has not yet been filed
  // to NCMEC sorts above everything, ahead even of unhandled ordinary reports, because it is the
  // only row in this table with a statutory clock running on it. Everything below it can wait
  // until tomorrow; that one cannot, and a queue that buries it under thirty harassment
  // complaints is a queue that will eventually bury it past the point of mattering.
  if (method === "GET" && path === "/api/admin/reports") {
    const rows = await env.DB
      .prepare(`
        SELECT r.id, r.stream_id, r.category, r.note, r.created_at, r.handled_at,
               r.preserve_until, r.ncmec_reported_at, r.hold_released_at, r.hold_release_reason,
               r.frame IS NOT NULL AS has_frame,
               (r.preserve_until IS NOT NULL AND r.ncmec_reported_at IS NULL) AS ncmec_pending,
               (SELECT killed_at FROM stream_kill k WHERE k.stream_id = r.stream_id) AS killed_at,
               EXISTS(SELECT 1 FROM broadcasts b WHERE b.stream_id = r.stream_id AND b.ended_at IS NULL) AS live
        FROM reports r
        ORDER BY ncmec_pending DESC, r.handled_at IS NOT NULL, r.created_at DESC
        LIMIT 200
      `)
      .all();
    return Response.json({ reports: rows.results });
  }

  // GET /api/admin/reports/frame?id= — one reported still, as an image.
  //
  // Served as image/jpeg with a type this side asserts, never one the reporter supplied; the
  // bytes were already checked for a JPEG marker on the way in (see sanitiseReportFrame).
  // Content-Disposition: inline with nosniff, so a browser that disagrees with us about what
  // these bytes are still refuses to go looking for something executable in them.
  if (method === "GET" && path === "/api/admin/reports/frame") {
    const id = parseInt(url.searchParams.get("id") ?? "", 10);
    if (!Number.isInteger(id)) return Response.json({ error: "id required" }, { status: 400 });
    const row = await env.DB
      .prepare("SELECT frame FROM reports WHERE id = ?")
      .bind(id)
      .first<{ frame: string | null }>();
    if (!row?.frame) return new Response("No frame", { status: 404 });
    const bytes = Uint8Array.from(atob(row.frame), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        // Never a shared cache: this is broadcast content behind an operator password.
        "Cache-Control": "private, no-store",
      },
    });
  }

  // POST /api/admin/reports/ncmec — record that a CyberTipline submission was made.
  //
  // RECORDS, does not send. Filing to NCMEC needs credentials this Worker does not hold and a
  // judgement it has no business making; an endpoint that filed by itself would be a machine
  // making an accusation. What this does is capture the date the statutory year actually runs
  // from, so the queue can show what has been filed and what has not, and so preservation is
  // measured from the event 2258A(h) measures it from rather than from our conservative intake
  // floor.
  //
  // Re-basing EXTENDS but never shortens: taking the later of the existing window and a fresh
  // year means recording a filing can only ever make us hold evidence for longer.
  if (method === "POST" && path === "/api/admin/reports/ncmec") {
    const body = (await request.json().catch(() => null)) as { id?: number } | null;
    if (!Number.isInteger(body?.id)) return Response.json({ error: "id required" }, { status: 400 });
    const fresh = new Date(Date.now() + REPORT_PRESERVE_DAYS * 86_400_000)
      .toISOString().replace("T", " ").slice(0, 19);
    const res = await env.DB
      .prepare(
        `UPDATE reports
            SET ncmec_reported_at = COALESCE(ncmec_reported_at, datetime('now')),
                preserve_until = MAX(COALESCE(preserve_until, ''), ?)
          WHERE id = ?`
      )
      .bind(fresh, body!.id)
      .run();
    if (!(res.meta?.changes ?? 0)) return Response.json({ error: "no such report" }, { status: 404 });
    const row = await env.DB
      .prepare("SELECT ncmec_reported_at, preserve_until FROM reports WHERE id = ?")
      .bind(body!.id)
      .first<{ ncmec_reported_at: string; preserve_until: string }>();
    return Response.json({ success: true, ...row });
  }

  // POST /api/admin/reports/release-hold — this one is not what it was filed as.
  //
  // The counterweight to preservation, and it has to exist. Filing a report costs a viewer
  // nothing but a share link, and the severe category sits one click from the ordinary ones, so
  // a hold with no release lets any hostile invitee pin a still of somebody's living room in
  // this database forever under the worst accusation available. The broadcaster would have no
  // recourse and the operator no way to clean up after a misfire.
  //
  // The duty attaches to APPARENT child sexual abuse material. An operator who has looked and
  // found something that plainly is not that never had a duty, and so has nothing to preserve.
  //
  // Three things make this different from the delete button. A reason is REQUIRED and stored, so
  // the release is auditable rather than a shrug. The hold is dropped but the row is kept, frame
  // and all, so releasing is not a covert delete — the ordinary reaper takes the picture on its
  // own schedule and the record of the complaint survives. And it refuses once a CyberTipline
  // submission is recorded, because at that point a real filing exists and no judgement made
  // here can call it back.
  if (method === "POST" && path === "/api/admin/reports/release-hold") {
    const body = (await request.json().catch(() => null)) as { id?: number; reason?: string } | null;
    if (!Number.isInteger(body?.id)) return Response.json({ error: "id required" }, { status: 400 });
    const reason = (body?.reason ?? "").trim().slice(0, REPORT_NOTE_MAX);
    if (reason.length < 8) {
      return Response.json(
        { error: "reason required", detail: "Say why this is not what it was reported as." },
        { status: 400 }
      );
    }
    const row = await env.DB
      .prepare("SELECT preserve_until, ncmec_reported_at FROM reports WHERE id = ?")
      .bind(body!.id)
      .first<{ preserve_until: string | null; ncmec_reported_at: string | null }>();
    if (!row) return Response.json({ error: "no such report" }, { status: 404 });
    if (row.ncmec_reported_at) {
      return Response.json(
        {
          error: "already filed",
          detail:
            "This was reported to NCMEC on " + row.ncmec_reported_at + ". The preservation " +
            "window runs from that filing and cannot be released here.",
        },
        { status: 409 }
      );
    }
    if (!row.preserve_until) return Response.json({ success: true, released: 0 });
    await env.DB
      .prepare(
        `UPDATE reports
            SET preserve_until = NULL, hold_released_at = datetime('now'), hold_release_reason = ?
          WHERE id = ?`
      )
      .bind(reason, body!.id)
      .run();
    return Response.json({ success: true, released: 1 });
  }

  // POST /api/admin/reports/drop-frame — forget the picture, keep the complaint.
  //
  // Retention does this on a 30-day clock; this is the same act on demand, and it is the one an
  // operator reaches for most. A frame that should not be held — the wrong stream, a misfiled
  // report, somebody's living room attached to an accusation that turned out to be nothing —
  // should not require waiting a month or opening a SQL console.
  //
  // Separate from deleting the report BECAUSE they are different acts. The row is an
  // administrative record of a complaint; the frame is content. Nulling one column keeps the
  // queue honest about what was reported while removing what nobody needs to keep looking at.
  //
  // PRESERVED ROWS REFUSE. An operator clearing a queue at speed must not be able to delete
  // evidence under a statutory hold by clicking the same button they click all day, so the
  // predicate is in the WHERE clause and the response says how many rows declined. Reporting the
  // refusal matters as much as making it: a silent no-op looks exactly like success, and the
  // operator would carry on believing the frame was gone.
  if (method === "POST" && path === "/api/admin/reports/drop-frame") {
    const body = (await request.json().catch(() => null)) as { id?: number; stream_id?: string } | null;
    if (body?.stream_id) {
      const res = await env.DB
        .prepare(`UPDATE reports SET frame = NULL
                   WHERE stream_id = ? AND frame IS NOT NULL AND ${REPORT_NOT_PRESERVED}`)
        .bind(body.stream_id)
        .run();
      const held = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM reports
                   WHERE stream_id = ? AND frame IS NOT NULL AND NOT ${REPORT_NOT_PRESERVED}`)
        .bind(body.stream_id)
        .first<{ n: number }>();
      return Response.json({ success: true, dropped: res.meta?.changes ?? 0, preserved: held?.n ?? 0 });
    }
    if (!Number.isInteger(body?.id)) return Response.json({ error: "id or stream_id required" }, { status: 400 });
    const res = await env.DB
      .prepare(`UPDATE reports SET frame = NULL WHERE id = ? AND ${REPORT_NOT_PRESERVED}`)
      .bind(body!.id)
      .run();
    const dropped = res.meta?.changes ?? 0;
    if (!dropped) {
      // Nothing changed for one of two reasons and the operator needs to know which: either
      // there was no such row, or there was and it is under a hold. Answering "success, 0" for
      // both would mean a preserved frame reads as an already-clean one.
      const row = await env.DB
        .prepare("SELECT preserve_until FROM reports WHERE id = ?")
        .bind(body!.id)
        .first<{ preserve_until: string | null }>();
      if (row?.preserve_until) {
        return Response.json(
          {
            error: "preserved",
            detail:
              "This report is held as evidence and its frame cannot be removed until the " +
              "preservation window ends.",
            preserve_until: row.preserve_until,
          },
          { status: 409 }
        );
      }
    }
    return Response.json({ success: true, dropped });
  }

  // POST /api/admin/reports/delete — remove the report itself, frame and all.
  //
  // The heavier lever, and deliberately the second one offered. Most of the time an operator
  // wants the picture gone, not the record — deleting the row loses the fact that anyone ever
  // complained, which is the thing you want when a pattern emerges later.
  //
  // WHAT THIS DOES NOT DO, and the console says so out loud: Cloudflare keeps roughly thirty
  // days of D1 Time Travel history, and a deleted row stays recoverable from it by anyone with
  // account access. There is no API to scrub one row from that history; it ages out. Deleted
  // here is not the same as unrecoverable, and an operator acting on someone's behalf needs to
  // know which of the two they just did.
  //
  // PRESERVED ROWS REFUSE, for the same reason drop-frame refuses and more so: this lever
  // destroys the record of the complaint as well as its contents, which is exactly what a
  // preservation duty forbids. Deleting a whole stream's reports skips the held ones and says
  // how many it skipped, rather than failing the batch.
  if (method === "POST" && path === "/api/admin/reports/delete") {
    const body = (await request.json().catch(() => null)) as { id?: number; stream_id?: string } | null;
    if (body?.stream_id) {
      const res = await env.DB
        .prepare(`DELETE FROM reports WHERE stream_id = ? AND ${REPORT_NOT_PRESERVED}`)
        .bind(body.stream_id)
        .run();
      const held = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM reports WHERE stream_id = ? AND NOT ${REPORT_NOT_PRESERVED}`)
        .bind(body.stream_id)
        .first<{ n: number }>();
      return Response.json({
        success: true,
        deleted: res.meta?.changes ?? 0,
        preserved: held?.n ?? 0,
        time_travel_retains: true,
      });
    }
    if (!Number.isInteger(body?.id)) return Response.json({ error: "id or stream_id required" }, { status: 400 });
    const res = await env.DB
      .prepare(`DELETE FROM reports WHERE id = ? AND ${REPORT_NOT_PRESERVED}`)
      .bind(body!.id)
      .run();
    const deleted = res.meta?.changes ?? 0;
    if (!deleted) {
      const row = await env.DB
        .prepare("SELECT preserve_until FROM reports WHERE id = ?")
        .bind(body!.id)
        .first<{ preserve_until: string | null }>();
      if (row?.preserve_until) {
        return Response.json(
          {
            error: "preserved",
            detail:
              "This report is held as evidence and cannot be deleted until the preservation " +
              "window ends.",
            preserve_until: row.preserve_until,
          },
          { status: 409 }
        );
      }
    }
    return Response.json({ success: true, deleted, time_travel_retains: true });
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
