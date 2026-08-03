// Tier-2 broker client — the static pages call tinymoq.com DIRECTLY with the
// PUBLIC publishable key (pk_). No earthseed Worker in the provisioning/salt path,
// so the broker sees the browser's own request.cf (real geo) and mints the token.
//
// This replaces the old Worker endpoints:
//   /api/publish → POST /cdn/assign {role:"publish"}  → {relay, origin_endpoint_id, jwt}
//   /api/edge    → POST /cdn/assign {role:"watch",…}  → {relay, jwt}
//   /api/salt    → GET/PUT /pub/salt/:node
import type { SaltInfo } from "./auth";

const BROKER = "https://tinymoq.com";

// The publishable key is PUBLIC by design (it ships in the page). Read it from a
// <meta name="earthseed-key" content="pk_…"> so any host can set their own key
// without a rebuild; fall back to the baked default (also public, safe).
function pubKey(): string {
  // URL override (?key=pk_…) lets a hosted page be pointed at any public key WITHOUT editing
  // the file — so you can just bookmark a link with your key instead of self-hosting. pk_ is
  // public by design, so it's safe in a URL. Precedence: ?key= → <meta> → baked default.
  const fromUrl = new URLSearchParams(location.search).get("key");
  if (fromUrl && fromUrl.startsWith("pk_")) return fromUrl.trim();
  const m = document.querySelector('meta[name="earthseed-key"]');
  const v = m?.getAttribute("content")?.trim();
  return v && v.startsWith("pk_") ? v : "pk_Am-UpPEuGCt5dsnR8xqzOFX2mEYDSCeMGrDWxXli4LU";
}

async function assign(body: Record<string, unknown>): Promise<any | { error: string }> {
  try {
    const r = await fetch(`${BROKER}/cdn/assign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pubKey()}` },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) return { error: (d && (d.error || d.reason)) || `HTTP ${r.status}` };
    return d;
  } catch (e) {
    return { error: String(e) };
  }
}

export interface PublishAssign { relay_url: string; origin_endpoint_id: string; jwt: string | null; }
// Assign an origin relay for this broadcaster; the broker reads the origin's iroh
// EndpointId server-side and mints the publish token.
export async function assignPublish(nodeId: string): Promise<PublishAssign | { error: string }> {
  const d = await assign({ broadcast: nodeId, role: "publish" });
  if ("error" in d) return d as { error: string };
  if (!d.relay || !d.origin_endpoint_id) return { error: "origin assign incomplete" };
  return { relay_url: `https://${d.relay}/`, origin_endpoint_id: d.origin_endpoint_id, jwt: d.jwt ?? null };
}

export interface WatchAssign { relay_url: string; jwt: string | null; }
// Place a viewer edge that iroh-pulls the origin (or co-locate on a single-box
// fleet); the broker mints the subscribe token.
export async function assignWatch(nodeId: string, originEid: string): Promise<WatchAssign | { error: string }> {
  const d = await assign({ broadcast: nodeId, role: "watch", origin: originEid, xport: "iroh" });
  if ("error" in d) return d as { error: string };
  if (!d.relay) return { error: "edge assign incomplete" };
  return { relay_url: `https://${d.relay}/`, jwt: d.jwt ?? null };
}

// Salts (public; decode nothing without the #k= fragment). Same shape as the old
// auth.ts helpers so call sites are unchanged.
export async function getSalt(nodeId: string): Promise<SaltInfo | null> {
  try {
    const r = await fetch(`${BROKER}/pub/salt/${nodeId}`);
    if (!r.ok) return null;
    const d = await r.json();
    return { global: d.global, stream: d.stream ?? null, epoch: d.epoch ?? 0 };
  } catch {
    return null;
  }
}

export async function putSalt(nodeId: string, stream: string, secret: string): Promise<SaltInfo | null> {
  try {
    const r = await fetch(`${BROKER}/pub/salt/${nodeId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream, secret }),
    });
    if (!r.ok) {
      console.error("putSalt failed:", r.status, await r.text());
      return null;
    }
    const d = await r.json();
    return { global: d.global, stream: d.stream ?? null, epoch: d.epoch ?? 0 };
  } catch (e) {
    console.error("putSalt error:", e);
    return null;
  }
}
