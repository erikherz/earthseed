/**
 * Seeds — the tipping + prepaid-bandwidth economy. DEMO ONLY.
 *
 * NO MONEY MOVES ANYWHERE IN THIS FILE. There is no Stripe client, no card, no payout.
 * "Buying" a packet credits a vault directly; a cash-out deducts the seeds, writes a ledger
 * row, and returns the numbers it would have paid. The fee arithmetic is real so the screens
 * are truthful, but nothing is charged and nothing is sent.
 *
 * The model, in four numbers:
 *   1 seed  = $1  = 1,000 viewer-minutes
 *   packets  = 10 seeds for $10.59, or 50 for $51.75 — the card fee is a visible line item
 *   cash out = 10 seeds minimum, minus one flat $0.25 payout fee
 *   free     = 1 seed per new broadcaster, after whatever gate the client puts in front
 *
 * FOUR POOLS, NOT ONE BALANCE. See migrations 0016 and 0019 for the full reasoning; the short
 * version is that the dangerous transitions are free -> someone else's cash and paid -> your
 * own cash, and separate pools make both impossible by construction rather than by a check
 * that somebody has to remember to write:
 *
 *   free    burn on your own bandwidth ONLY
 *   paid    plant on someone else, or burn on your own bandwidth. Never cashable
 *   gifted  passed to you by another creator. Burn, or pass on. Never cashable
 *   earned  burn on your own bandwidth, or cash out
 *
 * Burning is safe from any pool because it destroys value rather than moving it. Burn order
 * is free -> gifted -> paid -> earned: least optionality first, so buying a packet never
 * quietly eats the balance somebody was saving to cash out.
 *
 * VALUE IS NEVER ADDRESSED TO A PERSON. Both moves — plant and gift — target a live
 * broadcast, and there is no vault-to-vault transfer anywhere in this file. That is what
 * stops the demo being usable as a payments rail to an arbitrary identity.
 *
 * THE BUYER PAYS THE CARD FEE (0019). Seeds enter fully funded, so one seed in a vault is
 * backed by one dollar actually collected, and the only fee left to compute is the flat one
 * on the way out. The person who chose the card now bears its cost, rather than a creator who
 * had no say in it discovering a proportional deduction from their earnings.
 *
 * Everything is integer micro-units. Burn accrues in 30-second slices and floating point
 * would drift a vault away from its own ledger within an afternoon.
 *
 * Kept in its own file, reached from ONE line in handleApiRoutes, so that removing the demo
 * is deleting a file rather than unpicking a diff.
 */

// ---------------------------------------------------------------------------- units

/** 1 seed, in micro-seeds. */
export const SEED = 1_000_000;
/** 1 US dollar, in micro-dollars. */
const DOLLAR = 1_000_000;

/** A seed buys this much watching. The whole economy hangs off this one number. */
export const VIEWER_MINUTES_PER_SEED = 1000;

/** Viewers heartbeat every 30s; each beat is 30 viewer-seconds of delivery to pay for. */
const HEARTBEAT_SECONDS = 30;
/** 30s = 0.5 viewer-minutes = 500 micro-seeds. Exact, no remainder to carry. */
export const BURN_PER_HEARTBEAT_MICRO =
  (HEARTBEAT_SECONDS / 60) * (SEED / VIEWER_MINUTES_PER_SEED);

/** Stripe card-in, on any packet: 2.9% + $0.30. */
const stripeIn = (priceMicro: number): number =>
  Math.round(priceMicro * 0.029) + 0.3 * DOLLAR;

/**
 * The shelf. Two sizes only.
 *
 * The small one exists because $50 is the wrong first wall for a broadcaster who has run out
 * mid-week: 50 seeds is 833 viewer-hours, far more than they need, at a price that stops them
 * cold. The large one is better value and visibly so -- $0.59 on $10 is 5.9%, $1.75 on $50 is
 * 3.5% -- which is the same lesson about flat fees that the cash-out screen teaches, told on
 * the way in rather than on the way out.
 */
export const PACKETS: Record<string, { seeds: number; price_micro: number }> = {
  small: { seeds: 10, price_micro: 10 * DOLLAR },
  large: { seeds: 50, price_micro: 50 * DOLLAR },
};

/**
 * What a packet actually costs to buy: the seeds, plus the card fee, as two numbers.
 *
 * Kept as a function rather than folded into PACKETS so `price_micro` keeps meaning "the
 * value that lands in the vault". The seed count stays round and the fee is shown beside it;
 * pricing a packet at a round TOTAL instead would mean selling fractional seeds, which is a
 * worse trade — the unit people reason about should be the clean one.
 */
export function packetCost(size: string, packets = 1) {
  const packet = PACKETS[size === "small" ? "small" : "large"];
  const value = packets * packet.price_micro;
  const fee = packets * stripeIn(packet.price_micro);
  return { value_micro: value, fee_micro: fee, total_micro: value + fee, seeds: packets * packet.seeds };
}
/** Kept for the client, which still describes "a packet" as the headline product. */
export const PACKET_SEEDS = PACKETS.large.seeds;

/** Stripe bank-out: a flat $0.25, because a payout carries no fraud risk to price. */
const PAYOUT_FEE_MICRO = 0.25 * DOLLAR;

/**
 * Cash-out floor.
 *
 * Deliberately LOW. The flat $0.25 payout fee means a $10 cash-out costs 2.5% and a $50 one
 * costs 0.5%, and the tempting fix is to forbid the small one. But a first payout is the
 * moment a new streamer finds out this is real, and making them wait weeks for it to be
 * "efficient" is a worse product and a worse lesson. Instead the quote shows exactly what
 * impatience costs and what waiting would save, and lets them choose.
 */
export const CASHOUT_MIN_SEEDS = 10;

/** Tiers the quote compares against, to show what waiting is worth. */
const WAIT_TIERS = [25, 50, 100];

/** The free starting seed. Enough for ~5 hours in front of three viewers. */
const FREE_GRANT_MICRO = 1 * SEED;

/**
 * How far past zero a live broadcast may run.
 *
 * Cutting a stream off mid-sentence over a dollar is the kind of thing that makes someone
 * never come back, so running out is not enforced where it happens. It is enforced at the
 * START of the next broadcast, which is a moment where "top up first" reads as ordinary
 * rather than humiliating. Past this cap the burn stops accruing and we absorb the cost:
 * still no cut-off, and our exposure per broadcaster stays bounded and known.
 */
const MAX_DEBT_MICRO = 5 * SEED;

// ---------------------------------------------------------------------------- env

/**
 * Everything this file needs from the Worker, and nothing else.
 *
 * Wallflower let `Env` resolve to the global ambient type, which meant the seeds demo silently
 * had reach over every binding and secret the Worker owns. Declared structurally here instead,
 * so the blast radius of the demo is visible in one line and the promise made at the top of
 * this file — that removing it is deleting a file — is checkable rather than aspirational.
 */
export type SeedEnv = { DB: D1Database };

// ---------------------------------------------------------------------------- helpers

async function sha256b64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

type Vault = {
  pubkey: string;
  secret_hash: string;
  label: string | null;
  free_micro: number;
  paid_micro: number;
  gifted_micro: number;
  earned_micro: number;
  debt_micro: number;
  burned_micro: number;
  granted: number;
  created_at: string;
};

async function getVault(env: SeedEnv, pubkey: string): Promise<Vault | null> {
  return env.DB.prepare("SELECT * FROM seed_vaults WHERE pubkey = ?")
    .bind(pubkey)
    .first<Vault>();
}

/**
 * Authorise a write. The demo shortcut: a shared secret hashed at rest, rather than an
 * Ed25519 signature over a fresh challenge. Same identity model — the pubkey is still the
 * account — but a real build must not ship the shared secret.
 */
async function authVault(env: SeedEnv, pubkey: string, secret: string): Promise<Vault | null> {
  const vault = await getVault(env, pubkey);
  if (!vault) return null;
  return (await sha256b64(secret)) === vault.secret_hash ? vault : null;
}

/** Everything that can be burned. Cash-out looks at `earned_micro` alone. */
const spendable = (v: Vault): number =>
  v.free_micro + v.gifted_micro + v.paid_micro + v.earned_micro;

/**
 * What a creator can pass to another creator, drained least-valuable-first.
 *
 * `gifted` before `earned` for the same reason the burn order is what it is: spend the pool
 * with the fewest futures attached before the one that could have become money.
 */
const giftable = (v: Vault): number => v.gifted_micro + v.earned_micro;

function publicVault(vault: Vault) {
  const total = spendable(vault);
  return {
    pubkey: vault.pubkey,
    label: vault.label,
    // `seeds` stays the headline total, so screens that only ever wanted "how much have I
    // got" keep reading the same field.
    seeds: total / SEED,
    free: vault.free_micro / SEED,
    paid: vault.paid_micro / SEED,
    gifted: vault.gifted_micro / SEED,
    earned: vault.earned_micro / SEED,
    /** Plantable on someone else. Purchased money only — never free, never earned. */
    plantable: vault.paid_micro / SEED,
    /** Passable to another creator, arriving there as burn-only. Gifted drains before earned. */
    giftable: giftable(vault) / SEED,
    /** Redeemable for cash. Earned only. */
    cashable: vault.earned_micro / SEED,
    debt: vault.debt_micro / SEED,
    /** A broadcast that ran past zero must be settled before another one starts. */
    blocked: vault.debt_micro > 0,
    burned: vault.burned_micro / SEED,
    // No fee fields. Since 0019 the card fee is paid by the buyer at purchase time, so there
    // is nothing riding on a balance and nothing to apportion — a seed here is backed by a
    // dollar that was actually collected.
    viewer_minutes_left: Math.floor((total / SEED) * VIEWER_MINUTES_PER_SEED),
    granted: !!vault.granted,
  };
}

// ---------------------------------------------------------------------------- burn

/**
 * Charge one heartbeat of watching to whichever vault the stream is attached to.
 *
 * Called from the viewer heartbeat, so it runs once per viewer per 30 seconds — the cost
 * genuinely scales with audience, which is the entire point of the model. A stream with no
 * vault attached (every ordinary broadcast on the site) burns nothing and this returns
 * immediately.
 *
 * Read-modify-write rather than one clever UPDATE, because draining four pools in a fixed
 * order does not fit in an expression anyone could later read. The write is guarded on the
 * balances it was computed from — all four of them — so a concurrent heartbeat loses and
 * retries rather than silently overwriting: with one row per broadcaster and a beat every 30
 * seconds contention is rare, but a lost burn is free bandwidth.
 */
export async function burnForStream(env: SeedEnv, streamId: string): Promise<void> {
  const link = await env.DB
    .prepare("SELECT pubkey FROM seed_streams WHERE stream_id = ?")
    .bind(streamId)
    .first<{ pubkey: string }>();
  if (!link) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await getVault(env, link.pubkey);
    if (!v) return;

    let remaining = BURN_PER_HEARTBEAT_MICRO;

    // free -> gifted -> paid -> earned. Least optionality first: gifted can only ever be
    // burned or passed on, paid can still be planted, and earned is the only pool that can
    // become money — so it is the last thing an hour of watching is allowed to consume.
    const fromFree = Math.min(v.free_micro, remaining);
    remaining -= fromFree;
    const fromGifted = Math.min(v.gifted_micro, remaining);
    remaining -= fromGifted;
    const fromPaid = Math.min(v.paid_micro, remaining);
    remaining -= fromPaid;
    const fromEarned = Math.min(v.earned_micro, remaining);
    remaining -= fromEarned;

    // Anything still unpaid becomes debt, up to the cap. Past the cap we absorb it — the
    // alternative is cutting off a live broadcast, which this product will not do.
    const debtRoom = Math.max(0, MAX_DEBT_MICRO - v.debt_micro);
    const newDebt = Math.min(remaining, debtRoom);
    const burned = fromFree + fromGifted + fromPaid + fromEarned + newDebt;

    const res = await env.DB
      .prepare(
        `UPDATE seed_vaults
            SET free_micro   = free_micro - ?,
                gifted_micro = gifted_micro - ?,
                paid_micro   = paid_micro - ?,
                earned_micro = earned_micro - ?,
                debt_micro   = debt_micro + ?,
                burned_micro = burned_micro + ?
          WHERE pubkey = ?
            AND free_micro = ? AND gifted_micro = ? AND paid_micro = ? AND earned_micro = ?`
      )
      .bind(
        fromFree, fromGifted, fromPaid, fromEarned,
        newDebt, burned,
        link.pubkey,
        v.free_micro, v.gifted_micro, v.paid_micro, v.earned_micro
      )
      .run();

    if (res.meta.changes > 0) return;
  }
}

// ---------------------------------------------------------------------------- routes

export async function handleSeedRoutes(
  request: Request,
  env: SeedEnv,
  url: URL
): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // ---- POST /api/seeds/vault — create a vault, or read your own back.
  //
  // The pubkey and secret are both generated in the browser. Nothing is asked for and
  // nothing is verified: that is the "no account" promise, kept literally.
  if (method === "POST" && path === "/api/seeds/vault") {
    const body = await readBody<{ pubkey?: string; secret?: string; label?: string }>(request);
    if (!body?.pubkey || !body?.secret) return json({ error: "pubkey and secret required" }, 400);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(body.pubkey)) return json({ error: "bad pubkey" }, 400);

    const existing = await getVault(env, body.pubkey);
    if (existing) {
      const ok = await authVault(env, body.pubkey, body.secret);
      if (!ok) return json({ error: "vault exists with a different secret" }, 403);
      if (body.label && body.label !== existing.label) {
        await env.DB.prepare("UPDATE seed_vaults SET label = ? WHERE pubkey = ?")
          .bind(body.label.slice(0, 40), body.pubkey)
          .run();
        ok.label = body.label.slice(0, 40);
      }
      return json({ vault: publicVault(ok) });
    }

    await env.DB
      .prepare("INSERT INTO seed_vaults (pubkey, secret_hash, label) VALUES (?, ?, ?)")
      .bind(body.pubkey, await sha256b64(body.secret), body.label?.slice(0, 40) ?? null)
      .run();

    const created = await getVault(env, body.pubkey);
    return json({ vault: publicVault(created!) });
  }

  // ---- GET /api/seeds/vault?pubkey= — public balance. No secret: a fan about to plant
  // seeds on a stream needs to see the vault they are planting into.
  if (method === "GET" && path === "/api/seeds/vault") {
    const pubkey = url.searchParams.get("pubkey") ?? "";
    const vault = await getVault(env, pubkey);
    if (!vault) return json({ error: "no vault" }, 404);
    return json({ vault: publicVault(vault) });
  }

  // ---- POST /api/seeds/grant — the free starting seed, once per vault.
  //
  // Lands in `free_micro`, which can only ever be burned. That is not a nicety: a grant that
  // could be planted on another vault would let ten identities and ten trips through the
  // gate turn into somebody's payout.
  //
  // WHATEVER GATE THE CLIENT PUTS HERE IS NOT CHECKED, and saying so is the honest version
  // of shipping it: it is friction, not security. Minting a fresh vault costs nothing, so a
  // gate on this endpoint can only ever raise the price of farming, never stop it. The real
  // defence is that a farmed seed is worth $1 of bandwidth that still has to be burned in
  // front of real viewers.
  //
  // Earthseed already has a proof-of-work on /api/publish-code/request, which is the same
  // shape of answer to the same shape of problem. Reusing it here would at least make the
  // friction consistent, and is the obvious first change if farming ever actually happens.
  if (method === "POST" && path === "/api/seeds/grant") {
    const body = await readBody<{ pubkey?: string; secret?: string }>(request);
    if (!body?.pubkey || !body?.secret) return json({ error: "pubkey and secret required" }, 400);
    const vault = await authVault(env, body.pubkey, body.secret);
    if (!vault) return json({ error: "unknown vault" }, 403);
    if (vault.granted) return json({ vault: publicVault(vault), already: true });

    await env.DB
      .prepare("UPDATE seed_vaults SET free_micro = free_micro + ?, granted = 1 WHERE pubkey = ?")
      .bind(FREE_GRANT_MICRO, body.pubkey)
      .run();
    await env.DB
      .prepare("INSERT INTO seed_ledger (kind, to_key, seeds_micro, note) VALUES ('grant', ?, ?, ?)")
      .bind(body.pubkey, FREE_GRANT_MICRO, "welcome seed — burn only")
      .run();

    return json({ vault: publicVault((await getVault(env, body.pubkey))!), granted: 1 });
  }

  // ---- POST /api/seeds/buy — MOCK. Credits the vault; no card is charged.
  //
  // BUYING IS TOPPING UP. There is no separate "fund my own streaming" operation, because
  // purchased credit can already be burned on your own bandwidth — a broadcaster who has run
  // dry buys a packet and carries on. What purchased credit can never do is become cash,
  // which makes self-funding the most boring transaction in the system: prepaid credit for
  // our own service, closed loop, nothing to redeem.
  //
  // Debt is settled FIRST, and that is what unblocks the next broadcast.
  //
  // THE CARD FEE IS CHARGED HERE, on top of the packet price, and the vault receives whole
  // seeds (0019). It is returned as its own field so the interface can show it as a line
  // item rather than burying it — the buyer should be able to see that every cent above the
  // packet price went to Stripe and none of it to us.
  if (method === "POST" && path === "/api/seeds/buy") {
    const body = await readBody<{
      pubkey?: string;
      secret?: string;
      packets?: number;
      size?: string;
    }>(request);
    if (!body?.pubkey || !body?.secret) return json({ error: "pubkey and secret required" }, 400);
    const vault = await authVault(env, body.pubkey, body.secret);
    if (!vault) return json({ error: "unknown vault" }, 403);

    const size = body.size === "small" ? "small" : "large";
    const packet = PACKETS[size];
    const packets = Math.max(1, Math.min(20, Math.floor(body.packets ?? 1)));
    const cost = packetCost(size, packets);
    const bought = cost.seeds * SEED;

    // Debt comes off the top. Seeds already consumed on credit are not seeds you get again.
    const settled = Math.min(vault.debt_micro, bought);
    const credited = bought - settled;

    await env.DB
      .prepare(
        `UPDATE seed_vaults
            SET paid_micro = paid_micro + ?,
                debt_micro = debt_micro - ?
          WHERE pubkey = ?`
      )
      .bind(credited, settled, body.pubkey)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO seed_ledger (kind, to_key, seeds_micro, fee_micro, note) VALUES ('buy', ?, ?, ?, ?)"
      )
      .bind(
        body.pubkey,
        bought,
        cost.fee_micro,
        `${packets} x ${packet.seeds}-seed packet — MOCK, no card charged` +
          (settled > 0 ? `; ${settled / SEED} settled debt` : "")
      )
      .run();

    return json({
      vault: publicVault((await getVault(env, body.pubkey))!),
      // Three numbers, not one, because the interface has to be able to show the buyer that
      // the difference between them is Stripe's and not ours.
      seeds_value: cost.value_micro / DOLLAR,
      card_fee: cost.fee_micro / DOLLAR,
      charged: cost.total_micro / DOLLAR,
      // Zero, and returned explicitly rather than omitted: a buyer should be able to read
      // off the response that every cent above the packet price went to the card network.
      house_cut: 0,
      seeds: bought / SEED,
      debt_settled: settled / SEED,
      size,
      mock: true,
    });
  }

  // ---- POST /api/seeds/move — plant seeds on a live stream. Plant is the ONLY move.
  //
  // Draws from `paid_micro` ALONE. Free credit is not plantable (it would mint cash out of
  // whatever the client put in front of the grant) and earned credit is not plantable (that
  // is gifting, which is what made this a transferable balance in the first place).
  //
  // Planting on your OWN stream stays forbidden, and it is worth being precise about why now
  // that self-funding is allowed. Topping yourself up moves paid -> burn, which DESTROYS the
  // value. Planting on yourself would move paid -> earned, turning non-cashable money into
  // cashable money in a single hop. That is a laundering machine, not a top-up.
  //
  // `to_pubkey` is rejected rather than ignored. A stale client that still sends it must fail
  // loudly instead of silently doing nothing, and a hand-crafted request must not find a door
  // that the interface no longer shows.
  if (method === "POST" && path === "/api/seeds/move") {
    const body = await readBody<{
      pubkey?: string;
      secret?: string;
      seeds?: number;
      stream_id?: string;
      to_pubkey?: string;
    }>(request);
    if (!body?.pubkey || !body?.secret) return json({ error: "pubkey and secret required" }, 400);
    if (body.to_pubkey) {
      return json({ error: "seeds cannot be moved between vaults; plant them on a stream" }, 400);
    }
    if (!body.stream_id) return json({ error: "stream_id required" }, 400);

    const from = await authVault(env, body.pubkey, body.secret);
    if (!from) return json({ error: "unknown vault" }, 403);

    const amount = Math.round((body.seeds ?? 0) * SEED);
    if (amount <= 0) return json({ error: "seeds must be positive" }, 400);
    if (amount > from.paid_micro) {
      return json(
        {
          error: "not enough purchased seeds — only seeds you bought can be planted",
          plantable: from.paid_micro / SEED,
        },
        400
      );
    }

    const link = await env.DB
      .prepare("SELECT pubkey FROM seed_streams WHERE stream_id = ?")
      .bind(body.stream_id)
      .first<{ pubkey: string }>();
    if (!link) return json({ error: "that stream has no vault attached" }, 404);
    const toKey = link.pubkey;
    if (toKey === from.pubkey) return json({ error: "cannot plant on yourself" }, 400);
    if (!(await getVault(env, toKey))) return json({ error: "no such vault" }, 404);

    await env.DB.batch([
      env.DB
        .prepare("UPDATE seed_vaults SET paid_micro = paid_micro - ? WHERE pubkey = ?")
        .bind(amount, from.pubkey),
      // Arrives as EARNED: the only way a vault ever gains cashable value, and it always
      // comes from someone else choosing to spend on this broadcaster.
      env.DB
        .prepare("UPDATE seed_vaults SET earned_micro = earned_micro + ? WHERE pubkey = ?")
        .bind(amount, toKey),
      env.DB
        .prepare(
          // fee_micro is 0 on every move now: the card fee was settled at purchase time and
          // no longer rides on a balance. The column stays so historic rows keep their meaning.
          "INSERT INTO seed_ledger (kind, from_key, to_key, seeds_micro, fee_micro, stream_id) VALUES (?, ?, ?, ?, 0, ?)"
        )
        .bind("plant", from.pubkey, toKey, amount, body.stream_id),
    ]);

    return json({
      vault: publicVault((await getVault(env, from.pubkey))!),
      moved: amount / SEED,
      kind: "plant",
    });
  }

  // ---- POST /api/seeds/gift — keep another creator on the air.
  //
  // The second and last way value moves between vaults, and the safe one. A creator spends
  // their own gifted-or-earned balance and it arrives in someone else's GIFTED pool, which
  // can only ever be burned or passed on again. Cashable becomes burn-only, one way, so this
  // transition can only ever REDUCE the amount of redeemable value in the system. No chain of
  // gifts, however long, returns anything to a cashable pool — which is exactly why
  // re-gifting is allowed rather than being a hole that had to be closed.
  //
  // SOURCE ORDER is gifted before earned, matching the burn order and for the same reason:
  // spend the pool with the fewest futures attached before the one that could have been money.
  // A creator passing on help they were given never touches their own cashable balance until
  // the given help runs out.
  //
  // ADDRESSED TO A BROADCAST, not to a person — same as plant, and there is still no
  // vault-to-vault transfer anywhere in this file. `to_pubkey` is refused rather than ignored
  // so that a hand-written request cannot find a door the interface does not show. That
  // invariant is what stops this being usable as a payments rail to an arbitrary identity.
  //
  // Gifting to yourself is refused. It would only ever downgrade cashable value to burn-only,
  // so it is harmless — but a control that silently makes your balance less useful is a
  // support ticket, not a feature.
  if (method === "POST" && path === "/api/seeds/gift") {
    const body = await readBody<{
      pubkey?: string;
      secret?: string;
      seeds?: number;
      stream_id?: string;
      to_pubkey?: string;
    }>(request);
    if (!body?.pubkey || !body?.secret) return json({ error: "pubkey and secret required" }, 400);
    if (body.to_pubkey) {
      return json({ error: "seeds cannot be moved between vaults; send them to a stream" }, 400);
    }
    if (!body.stream_id) return json({ error: "stream_id required" }, 400);

    const from = await authVault(env, body.pubkey, body.secret);
    if (!from) return json({ error: "unknown vault" }, 403);

    const amount = Math.round((body.seeds ?? 0) * SEED);
    if (amount <= 0) return json({ error: "seeds must be positive" }, 400);
    if (amount > giftable(from)) {
      return json(
        {
          error: "not enough seeds to send — purchased seeds are planted, not sent",
          giftable: giftable(from) / SEED,
        },
        400
      );
    }

    const link = await env.DB
      .prepare("SELECT pubkey FROM seed_streams WHERE stream_id = ?")
      .bind(body.stream_id)
      .first<{ pubkey: string }>();
    if (!link) return json({ error: "that stream has no vault attached" }, 404);
    const toKey = link.pubkey;
    if (toKey === from.pubkey) return json({ error: "cannot send seeds to yourself" }, 400);
    if (!(await getVault(env, toKey))) return json({ error: "no such vault" }, 404);

    const fromGifted = Math.min(from.gifted_micro, amount);
    const fromEarned = amount - fromGifted;

    await env.DB.batch([
      // Guarded on both source balances: a concurrent burn must not be able to spend the same
      // seeds this gift is spending. The gift simply fails and the caller retries.
      env.DB
        .prepare(
          `UPDATE seed_vaults
              SET gifted_micro = gifted_micro - ?, earned_micro = earned_micro - ?
            WHERE pubkey = ? AND gifted_micro >= ? AND earned_micro >= ?`
        )
        .bind(fromGifted, fromEarned, from.pubkey, fromGifted, fromEarned),
      // Arrives as GIFTED whatever it was on the way out. This is the whole point: value
      // crossing between creators loses the ability to become cash, permanently.
      env.DB
        .prepare("UPDATE seed_vaults SET gifted_micro = gifted_micro + ? WHERE pubkey = ?")
        .bind(amount, toKey),
      env.DB
        .prepare(
          "INSERT INTO seed_ledger (kind, from_key, to_key, seeds_micro, fee_micro, stream_id) VALUES (?, ?, ?, ?, 0, ?)"
        )
        .bind("gift", from.pubkey, toKey, amount, body.stream_id),
    ]);

    return json({
      vault: publicVault((await getVault(env, body.pubkey))!),
      moved: amount / SEED,
      from_gifted: fromGifted / SEED,
      from_earned: fromEarned / SEED,
      viewer_minutes_given: Math.floor((amount / SEED) * VIEWER_MINUTES_PER_SEED),
      kind: "gift",
    });
  }

  // ---- POST /api/seeds/attach — point a live stream's burn at a vault.
  if (method === "POST" && path === "/api/seeds/attach") {
    const body = await readBody<{ pubkey?: string; secret?: string; stream_id?: string }>(request);
    if (!body?.pubkey || !body?.secret || !body?.stream_id) {
      return json({ error: "pubkey, secret and stream_id required" }, 400);
    }
    if (!(await authVault(env, body.pubkey, body.secret))) {
      return json({ error: "unknown vault" }, 403);
    }

    await env.DB
      .prepare(
        `INSERT INTO seed_streams (stream_id, pubkey) VALUES (?, ?)
           ON CONFLICT(stream_id) DO UPDATE SET pubkey = excluded.pubkey, attached_at = datetime('now')`
      )
      .bind(body.stream_id, body.pubkey)
      .run();
    return json({ ok: true, stream_id: body.stream_id });
  }

  // ---- GET /api/seeds/stream?id= — what a viewer needs to plant: whose vault, and how
  // much runway the stream has left. No secret, because this is public to anyone holding
  // the link.
  if (method === "GET" && path === "/api/seeds/stream") {
    const streamId = url.searchParams.get("id") ?? "";
    const link = await env.DB
      .prepare("SELECT pubkey FROM seed_streams WHERE stream_id = ?")
      .bind(streamId)
      .first<{ pubkey: string }>();
    if (!link) return json({ attached: false });
    const vault = await getVault(env, link.pubkey);
    if (!vault) return json({ attached: false });
    return json({ attached: true, vault: publicVault(vault) });
  }

  // ---- GET /api/seeds/quote?pubkey= — the cash-out screen, as line items.
  //
  // Reads `earned_micro` ALONE. Purchased and granted seeds are not redeemable and never
  // appear here — that is the difference between a prepaid balance and a wallet.
  //
  // ONE deduction since 0019: the flat payout fee. The card fee was paid by the buyer at
  // purchase time, so a seed here is worth a whole dollar and there is nothing riding on it
  // to apportion. Ten seeds now pays $9.75 rather than $9.16, and "we take nothing" reads
  // truer for having a single line under it that the streamer can trace to one bank transfer.
  if (method === "GET" && path === "/api/seeds/quote") {
    const pubkey = url.searchParams.get("pubkey") ?? "";
    const vault = await getVault(env, pubkey);
    if (!vault) return json({ error: "no vault" }, 404);

    const seeds = Math.floor(vault.earned_micro / SEED);
    const eligible = seeds >= CASHOUT_MIN_SEEDS;
    const cashSeeds = eligible ? seeds : 0;
    const gross = cashSeeds * DOLLAR;
    const outbound = eligible ? PAYOUT_FEE_MICRO : 0;

    // What taking it now costs, against taking it later. The payout fee is flat, so its bite
    // shrinks as the payout grows — which is the entire lesson this screen exists to teach,
    // and it is now the only fee there is.
    const waiting = eligible
      ? WAIT_TIERS.filter((t) => t > seeds).map((tier) => {
          // Payouts of THIS size needed to move `tier` seeds, versus one payout at `tier`.
          const payouts = Math.floor(tier / seeds);
          return {
            at_seeds: tier,
            rate_now: outbound / (seeds * DOLLAR),
            rate_then: PAYOUT_FEE_MICRO / (tier * DOLLAR),
            saved: ((payouts - 1) * PAYOUT_FEE_MICRO) / DOLLAR,
            payouts,
          };
        })
      : [];

    return json({
      eligible,
      minimum_seeds: CASHOUT_MIN_SEEDS,
      seeds_available: seeds,
      // Named so the screen can explain WHY a balance is not all redeemable, rather than
      // appearing to lose seeds somebody can plainly see they have.
      not_cashable: (vault.free_micro + vault.gifted_micro + vault.paid_micro) / SEED,
      lines: {
        gross: gross / DOLLAR,
        stripe_out: outbound / DOLLAR,
        house: 0,
        net: (gross - outbound) / DOLLAR,
      },
      waiting,
    });
  }

  // ---- POST /api/seeds/cashout — MOCK. Deducts the seeds and records intent. No payout is
  // ever sent, and no bank detail is collected: in a real build this is exactly where the
  // Stripe Connect KYC redirect would sit, and where a chargeback hold would start.
  if (method === "POST" && path === "/api/seeds/cashout") {
    const body = await readBody<{ pubkey?: string; secret?: string }>(request);
    if (!body?.pubkey || !body?.secret) return json({ error: "pubkey and secret required" }, 400);
    const vault = await authVault(env, body.pubkey, body.secret);
    if (!vault) return json({ error: "unknown vault" }, 403);

    const seeds = Math.floor(vault.earned_micro / SEED);
    if (seeds < CASHOUT_MIN_SEEDS) {
      return json({ error: `need ${CASHOUT_MIN_SEEDS} earned seeds, have ${seeds}` }, 400);
    }

    const amount = seeds * SEED;
    const net = seeds * DOLLAR - PAYOUT_FEE_MICRO;

    await env.DB.batch([
      env.DB
        .prepare("UPDATE seed_vaults SET earned_micro = earned_micro - ? WHERE pubkey = ?")
        .bind(amount, vault.pubkey),
      env.DB
        .prepare(
          "INSERT INTO seed_ledger (kind, from_key, seeds_micro, fee_micro, note) VALUES ('cashout', ?, ?, ?, ?)"
        )
        .bind(vault.pubkey, amount, PAYOUT_FEE_MICRO, "MOCK — no payout sent"),
    ]);

    return json({
      mock: true,
      seeds_redeemed: seeds,
      lines: {
        gross: seeds,
        stripe_out: PAYOUT_FEE_MICRO / DOLLAR,
        house: 0,
        net: net / DOLLAR,
      },
      vault: publicVault((await getVault(env, vault.pubkey))!),
    });
  }

  return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------- admin

/** Called from handleAdminRoutes, so the password check has already run. */
export async function handleSeedAdminRoutes(
  request: Request,
  env: SeedEnv,
  url: URL
): Promise<Response | null> {
  const method = request.method;
  const path = url.pathname;

  if (method === "GET" && path === "/api/admin/seeds") {
    const vaults = await env.DB
      .prepare(
        `SELECT v.*, (SELECT group_concat(stream_id) FROM seed_streams s WHERE s.pubkey = v.pubkey) AS streams
           FROM seed_vaults v
          ORDER BY (v.free_micro + v.paid_micro + v.earned_micro) DESC LIMIT 200`
      )
      .all<Vault & { streams: string | null }>();

    const ledger = await env.DB
      .prepare("SELECT * FROM seed_ledger ORDER BY id DESC LIMIT 200")
      .all();

    const totals = await env.DB
      .prepare(
        // `fees` is gone since 0019: no fee rides on a balance any more, so a sum of the
        // legacy columns would report a liability that no longer exists. `gifted` is broken
        // out because it answers the question the other totals cannot — how much value has
        // moved between creators and can now only ever leave as bandwidth.
        `SELECT COUNT(*) AS vaults,
                COALESCE(SUM(free_micro + gifted_micro + paid_micro + earned_micro), 0) AS outstanding,
                COALESCE(SUM(earned_micro), 0)                                          AS cashable,
                COALESCE(SUM(gifted_micro), 0)                                          AS gifted,
                COALESCE(SUM(debt_micro), 0)                                            AS debt,
                COALESCE(SUM(burned_micro), 0)                                          AS burned
           FROM seed_vaults`
      )
      .first<{
        vaults: number;
        outstanding: number;
        cashable: number;
        gifted: number;
        debt: number;
        burned: number;
      }>();

    return json({
      totals: {
        vaults: totals?.vaults ?? 0,
        seeds_outstanding: (totals?.outstanding ?? 0) / SEED,
        // The share of that liability which can leave as CASH rather than as bandwidth.
        // Worth watching separately: two very different obligations wearing the same unit.
        seeds_cashable: (totals?.cashable ?? 0) / SEED,
        // Value that has crossed between creators. It can only ever leave as bandwidth now,
        // so it is a pure delivery obligation — the cheaper half of the liability above.
        seeds_gifted: (totals?.gifted ?? 0) / SEED,
        seeds_in_debt: (totals?.debt ?? 0) / SEED,
        seeds_burned: (totals?.burned ?? 0) / SEED,
        // What those outstanding seeds will cost to honour, at 1 seed = 1,000 viewer-minutes
        // and 1 viewer-hour = 1 GB = $0.05. This is the liability side of a packet sale.
        bandwidth_owed_dollars:
          ((totals?.outstanding ?? 0) / SEED) * (VIEWER_MINUTES_PER_SEED / 60) * 0.05,
      },
      vaults: (vaults.results ?? []).map((v) => ({
        ...publicVault(v as Vault),
        streams: v.streams,
        created_at: v.created_at,
      })),
      ledger: ledger.results ?? [],
    });
  }

  // Wipes the demo economy. Every vault, every ledger row, every stream attachment. Nothing
  // else in the database is touched.
  if (method === "POST" && path === "/api/admin/seeds/reset") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM seed_ledger"),
      env.DB.prepare("DELETE FROM seed_streams"),
      env.DB.prepare("DELETE FROM seed_vaults"),
    ]);
    return json({ ok: true, reset: true });
  }

  // Hand a vault seeds, for demoing a state without waiting for it. `pool` picks which one,
  // because "give them 20 seeds" is ambiguous now — and the interesting demo states (plenty
  // of credit but nothing to cash out, or the reverse) are only reachable by saying which.
  if (method === "POST" && path === "/api/admin/seeds/credit") {
    const body = await readBody<{ pubkey?: string; seeds?: number; pool?: string }>(request);
    if (!body?.pubkey) return json({ error: "pubkey required" }, 400);
    const amount = Math.round((body.seeds ?? 0) * SEED);
    const column =
      body.pool === "free" ? "free_micro" : body.pool === "paid" ? "paid_micro" : "earned_micro";

    await env.DB
      .prepare(`UPDATE seed_vaults SET ${column} = MAX(0, ${column} + ?) WHERE pubkey = ?`)
      .bind(amount, body.pubkey)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO seed_ledger (kind, to_key, seeds_micro, note) VALUES ('grant', ?, ?, ?)"
      )
      .bind(body.pubkey, amount, `admin credit — ${column}`)
      .run();
    return json({ ok: true, pool: column });
  }

  return null;
}
