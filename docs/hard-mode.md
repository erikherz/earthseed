# Hard mode: the maximally-auditable Earthseed, and how to get back to it

**Status:** not the current direction. Written 20 Sep 2026, while Earthseed was being turned into
the open-source home of Wallflower, because the thing being traded away was deliberate, worked,
and is easy to lose the reasoning for once the code is gone.

This is a recovery document. Everything below is reconstructed from commits in this repository —
every claim carries a hash you can `git show`. Nothing here is from memory.

---

## 1. What hard mode was

Between **3 Aug and 12 Aug 2026** Earthseed converged on a design with one governing commitment,
stated in the commit that finished it (`ca59e58`):

> shrink what is trusted, then make what remains checkable.

The threat it answers is the one you cannot engineer away: **whoever serves `earthseed.js` can
serve a different `earthseed.js`.** CSP does not help — modified same-origin code is permitted.
You cannot prevent substitution. You can only make it *detectable*, and only if the thing a
reviewer must read is small enough that a person actually will.

Four properties fall out of that, and they only work together:

| property | why it exists | where it lives |
|---|---|---|
| **No build step** | what is in the repo is literally what the browser runs | `simple/`, `ce541ed` |
| **Zero runtime dependencies** | no tree to audit; the one exception is vendored, pinned, unminified, byte-reproducible | `simple/vendor/README.md`, `8be4bd4` |
| **Published hashes** | SHA-256 of every served file, committed to git — a *different place, under a different party* than the site being checked | `INTEGRITY.md`, `ca59e58` |
| **No server-side list** | there is nothing to compel, because nothing is written down | DHT discovery, `d42f986` |

`simple/TRUST.md` names the resulting trusted computing base in four items, and item 1 is the
whole argument in one sentence: *"`earthseed.js` — our client. It's one readable file; read it."*

---

## 2. The part you remember: discovery on the BitTorrent DHT

This is the piece that made Earthseed structurally different from everything else, and it is the
piece that is completely gone.

`src/crypto/dht.ts` (155 lines, deleted in `ca59e58` — `git show d42f986:src/crypto/dht.ts`)
implemented **pkarr / BEP44 records on the public Mainline DHT**. The contract was two halves:

```
publish   the broadcaster signs a record with its OWN browser Ed25519 key and PUTs it:
            z32(pubkey) -> "origin=<iroh EndpointId>;name=<nodeId>;access=public"

resolve   a viewer reads that record straight off the DHT, verifies the signature, and
          learns the origin relay's EndpointId
```

The design notes in that file say what it bought, in the original author's words:

> No directory server; the DHT is the entire interop surface, so **even earthseed holds no list of
> broadcasts.**

and from `src/main.ts` at genesis:

> discovery is the DHT (pkarr), so there is **no 5-char stream id and no server-side list**
>
> pubkey **IS** the stream's identity + DHT discovery handle, and (bare) the moq broadcast track
> name. No login required.
>
> There is **no directory server** — the DHT is the only surface.

### How the key trick worked

The browser mints a non-extractable Ed25519 key. pkarr needs a libsodium keypair. WebCrypto has no
"export the seed" call — so:

> an Ed25519 PKCS8 export is a 48-byte DER whose **trailing 32 bytes are exactly the seed**
> `crypto_sign_seed_keypair()` wants.

That is the hinge the whole scheme turns on, and it is worth knowing it is a real, stable fact
about the DER encoding rather than a hack that happened to work.

### The relays

`PKARR_RELAYS = ["https://relay.pkarr.org", "https://pkarr.pubky.org"]` — HTTP↔DHT gateways, *not*
storage; the record lives on Mainline itself. The file is explicit about their power and its
limit:

> They can see viewer-IP ↔ pubkey lookups but **CANNOT forge records** (Ed25519-signed) or hold
> them exclusively. TO SELF-HOST: run the open-source pkarr relay on a UDP-capable box and replace
> this list with your own URL(s) — nothing else changes.

### Lineage

`dht.ts` opens with *"Ported from wallflower/src/dht.ts (proven end-to-end)."* Wallflower had this
first and dropped it on 15 Aug 2026. Both products walked away from DHT discovery within three
days of each other, independently.

---

## 3. What killed it, and when

The DHT did not lose an argument. It was collateral.

| date | commit | what happened |
|---|---|---|
| 3 Aug | `d42f986` | genesis. Vite client, `src/main.ts` 2,771 lines, 7 runtime deps, DHT discovery, `self-contained/` bundles |
| 4 Aug | `ce541ed` | `simple/` added — *"minimal, review-friendly"*, 861 lines, one file, no build. **It never used the DHT**; it went through the broker from day one |
| **12 Aug** | `8be4bd4` | transport vendored; identity key made non-extractable |
| **12 Aug** | `5be858a` | unauthenticated `/api/publish` and `/api/edge` deleted — the provisioning endpoints the DHT path used |
| **12 Aug** | **`ca59e58`** | **vite client deleted.** Worker 1,657 → **116 lines**. Runtime deps → **0**. `INTEGRITY.md` published. `src/crypto/dht.ts` goes with it |

So: two clients coexisted for eight days, and then hard mode was finished **in a single day** —
those last three commits are all 12 August. `simple/` won on auditability grounds and the DHT died
with the client that used it.

The deletion commit is about shrinking the trusted surface; the DHT is not even mentioned in it.
That is the whole story, and it means **the DHT was never judged and found wanting** — it was
attached to the losing half. If you want it back, you are not reversing a decision; you are
finishing one that was never actually made.

`ca59e58` did make one finding worth carrying forward, because it is a live hazard for anything
built on top of this repo:

> `/api/auth/google/login` still 302'd to Google with a real client id, and the session it minted
> gated exactly one route the shipped client never calls, which meant the broadcaster allow list
> everyone believed was gating publishing **was gating nothing.**

---

## 4. What survives today — the path back is shorter than it looks

Three of the four properties are **still intact** as of this writing:

- ✅ **No build step.** `simple/earthseed.js` is still hand-written, unminified, shipped as-is.
- ✅ **Zero runtime dependencies.** `package.json` has no `dependencies` block at all. DOMPurify
  was vendored on 20 Sep and removed the same day (see `simple/vendor/README.md`).
- ✅ **Published hashes.** `INTEGRITY.md` is live and `npm run check` fails a deploy if it is
  stale. `npm run verify` checks the deployed origin against it.
- ✅ **Self-hosting.** `npm run bundle` still produces a servable copy; the README still offers it.
- ❌ **No server-side list.** This is the one that is gone, and it went in two stages: the DHT in
  Aug (`ca59e58`), and then the control plane deliberately added a `broadcasts` table in Sep
  (migration `0009`) so an operator could *stop* a stream they cannot see.

And critically, **the identity scheme survives whole.** An Earthseed broadcast name is still a
52-character base32 Ed25519 **public key** — `isNodeId()` in `src/worker/index.ts`, `loadOrMintNode()`
in `simple/earthseed.js`. That is the same `nodeId` the DHT record was keyed by. Ownership is still
proved by signing a challenge with the private half (`claimIsValid`).

So the missing piece is only **discovery**. The names are already DHT-shaped.

---

## 5. How to get back

Roughly in order of cost.

**Step 1 — restore discovery (the actual work).**
`git show d42f986:src/crypto/dht.ts > simple/dht.js` and port it from TypeScript to the no-build
client. Three real obstacles, all known:

- It imports `pkarr` and `buffer` from npm. Zero-runtime-dependencies means **vendoring pkarr**
  the way `@moq/net` is vendored — pinned, unminified, byte-reproducible, recipe and SHA-256 in
  `simple/vendor/README.md`, hash added to `INTEGRITY.md` via `scripts/client-files.mjs`.
- pkarr's internals use the Node global `Buffer` **without importing it**. The original shimmed
  `globalThis.Buffer` before use; that shim is in the file and must come with it.
- The seed extraction needs `exportKey("pkcs8", …)`, so the identity key can **no longer be
  non-extractable**. That is a straight trade against `8be4bd4` and it must be made deliberately:
  hostile page code could then walk away with the identity and keep publishing as you.

**Step 2 — give the broadcaster something to publish.**
The DHT record's payload was `origin=<iroh EndpointId>`. On the current moq.pro backend there is
no EndpointId — placement returns `{relay, path}` instead (see `moqProAssign()`). Either publish
the moq.pro path in the record, or restore a fleet backend that has origins. The tinymoq path is
still present and dormant; unsetting `MOQ_PRO_JWK` is all it takes to reach it.

**Step 3 — decide what happens to the control plane.**
This is the hard one and it is a values question, not an engineering one. The kill switch, the
abuse-report queue and the CSAM preservation clock (`0009`, `0010`) all need to *name a stream*.
Discovery with no server-side list means an operator cannot enumerate what exists. You can keep
both — kill-by-name still works if someone reports a name — but you lose the ability to answer
"what is live right now", which is also the ability to answer that question to anyone who asks
you for it. That is the feature, and it is also the liability.

**Step 4 — restate the claim.**
`simple/TRUST.md` and the README would need their "who can see what" tables rewritten. `README.md`
already says *"No accounts. No server-side list of who's streaming"* — under hard mode that is
literally true again.

---

## 6. Why it cannot simply coexist with the Wallflower direction

Not hostility between the two designs — arithmetic.

Hard mode's guarantee is *"the thing you must read is small."* Every Wallflower feature adds to
the thing you must read. Seeds alone is ~850 lines of Worker and ~1,200 of client. Chat, the
overlay editor, PiP compositing, the QR plate, viewing stats and the seeds UI together are several
times the size of the client that the auditability argument was built around.

At some size, "one readable file; read it" stops being an invitation and becomes a formality —
and a formality that *looks* like a guarantee is worse than not offering one. That is the same
failure shape as the allow list that gated nothing.

So the honest choices are: a small Earthseed that keeps the claim, or a full Earthseed that drops
it and says so plainly. **Not both.** If Wallflower's feature set is the goal — and as of 20 Sep
2026 it is — then `simple/TRUST.md` item 1 and the `INTEGRITY.md` framing need rewriting to claim
what is actually true, rather than being left to quietly decay into overstatement.

---

## 7. The one thing worth keeping either way

`INTEGRITY.md` costs almost nothing and survives any amount of feature growth. It does not require
the client to be small — only that the bytes served match the bytes published. A reviewer can
still catch silent substitution even if nobody reads 6,000 lines.

Keep `npm run check` wired into deploy. It is the cheapest part of hard mode and the last one that
should go.
