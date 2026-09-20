# Trust & flows — what a reviewer sees

This document states exactly what each party can and cannot see, the cryptography, and the honest
limits. The interactive version of this map is on the home page (https://earthseed.live).

## What changed, and what this used to say

Two sentences in the older version of this document are no longer true, and they are corrected here
rather than quietly dropped:

1. **"It's one readable file; read it."** The client is now thirteen files and about 7,500 lines.
   Still unminified, still no build step, still no runtime dependency of our own — but "small
   enough that you will actually read it" was a real property and it has been spent. What replaces
   it is `INTEGRITY.md`: a SHA-256 for every file, committed to git so the record sits somewhere
   other than the site being checked, and `npm run verify` to compare the live site against it.
   That is weaker, and saying so is the point of this section.

2. **"The relays are unikernels, not containers."** They were: a fleet we ran ourselves, one
   single-tenant Hermit unikernel per stream, no shell and no persistent disk. Production now
   routes through **moq.pro**, a CDN we do not operate, and none of that argument applies to it.
   The section making it has been removed. What did not change is the part that protects your
   media: a relay only ever carries ciphertext, so whose machine it is was never the thing keeping
   your video private.

There is also a third correction, on the front page rather than here: **there is an accounts tier
in this repository and it is switched off.** `curl -s https://earthseed.live/api/config` reports
`"accounts": false`. See [Who can see what](#who-can-see-what).

## The parties

| Party | Role | Runs our code? |
|---|---|---|
| **Broadcaster browser** | Captures, composites, encodes, **encrypts**, publishes | Yes — `simple/` |
| **Viewer browser** | Subscribes, **decrypts**, decodes, plays | Yes — `simple/` |
| **Our Worker** (`earthseed.live`) | Admits publishers, mints CDN tokens, holds settings, relays sealed chat, can refuse | Ours, server-side |
| **CDN** (`cdn.moq.pro`) | Moves media between browsers over QUIC | No — a third party |

## The values exchanged

| Value | Secret? | What it is |
|---|---|---|
| `publish key` | Sort of | Admits a broadcaster. A capability carrying its own `nbf`/`exp`/batch under a MAC only our Worker can produce, so the expiry can ride inside the credential instead of in a table — and nothing about who requested it is written down. **Can't decrypt.** |
| `route tag` | No | Proof a viewer holds the link: `HKDF(#k=, salt="es-route\|<id>", info="earthseed-route-auth-v1")`. A *different* salt **and** a different info string than `CK`, so the two are cryptographically independent — every tag ever registered decrypts nothing. Registered by the broadcaster at go-live, presented by each viewer to be placed. |
| `node id` | No | An Ed25519 public key (base32). The broadcast identity, the relay track name, and what a settings write is signed against. |
| `salts` + `epoch` | No | Public HKDF inputs: a global (operator kill-switch) salt ‖ a per-stream salt. Rotating one re-keys the stream. |
| `JWT` | Short-lived | A per-broadcast CDN token authorizing the **connection** (publish or subscribe scope), signed `EdDSA` by our Worker over one account root and one broadcast path. Not a content key. |
| `link_enc` | Opaque | A sealed blob a broadcaster may store against their own stream. Encrypted under a key derived from `#k=`, so it is meaningless to us and to anyone without the link. |
| `#k=` → `CK` | **YES** | 32 random bytes in the link fragment → the `AES-256-GCM` key via HKDF. Held only by the two browsers. |
| `passcode` | **YES** | Optional. 8 characters, **never in the link and never sent anywhere** — spoken or texted to the viewer, typed into the watch page, stretched into the same `CK`. |

## The cryptography

```
CK = HKDF-SHA256(
       IKM  = fragmentKey [‖ PW],          // the 32 bytes in the #k= link fragment
       salt = globalSalt ‖ streamSalt,     // public; carried in band on the catalog track
       info = "earthseed-media-v1|" + nodeId + "|" + epoch )

with a passcode (opt-in per broadcast), PW joins the IKM and the version becomes v2:
       PW = PBKDF2-SHA256(passcode, "earthseed-pc-v1|" + nodeId, 5,000,000 iterations)
       CK = HKDF-SHA256(fragmentKey ‖ PW, globalSalt ‖ streamSalt,
                        "earthseed-media-v2|" + nodeId + "|" + epoch )

per encoded chunk (audio and video):
       wire = [varint timestamp][12-byte random nonce][AES-256-GCM ciphertext + 16-byte tag]
```

- The **timestamp stays in the clear** (the decoder needs it) and is bound as GCM
  additional-authenticated-data, so a tampering or injecting relay fails decryption.
- Only the codec **payload** is encrypted. The **catalog** (codec, resolution) is sent in the
  clear on a separate track by design — it leaks format metadata, never content.
- A **fresh random 96-bit nonce per chunk**; the publisher is the sole encryptor (the relay fans
  out identical ciphertext to every viewer), so nonce uniqueness is a single-writer problem.
- **Rotation / kill-switch:** the per-stream salt is minted fresh at every go-live, and the operator
  can rotate the global salt to re-key every stream at once. Either changes `epoch`, and a viewer
  re-derives when it does. Both take effect at the next go-live — nothing rotates mid-broadcast, so
  a viewer's key is fixed for the session it joined.
- **The salts reach a viewer from the broadcaster, not from us.** They travel on the same cleartext
  catalog track that carries the codec description, so **a viewer never asks us for anything after
  being placed.** They are public HKDF inputs and decrypt nothing alone.

### Chat is sealed under a sibling key

```
chatKey = HKDF-SHA256(
            IKM  = fragmentKey [‖ PW],       // the same inputs as CK
            salt = globalSalt ‖ streamSalt,  // the same salts as CK
            info = "earthseed-chat-v1|" + nodeId + "|" + epoch )   // v2 with a passcode

each message:  <base64url nonce>.<base64url AES-256-GCM ciphertext+tag>
```

Same key material, **different `info` string**, so the chat key and the media key are
cryptographically independent: neither can be derived from the other, and a compromise of one
reveals nothing about the other. That is what HKDF's `info` parameter is for, and it is the only
reason chat can ride on the same link without weakening the video.

The display name is sealed **inside the same envelope** as the text, not sent alongside it. The
Durable Object that relays chat stores `{id, ct, ts}` and nothing else — it has no `name` field and
no `text` field to hold. Two consequences, and the second is not a feature:

- The relay cannot read a message, and neither can we.
- **There is no server-side moderation of chat**, because there is nothing there to moderate.

## The overlay, and why it is blocks and not HTML

A broadcaster can put a panel under the video — headings, text, lists, links, images, and a
cross-origin embed. That is **content from one person rendered in another person's document**, and
that document holds the media key derived from the `#k=` fragment. It is the only place in this
client where that happens, so it gets its own rules.

It is **not** markup. The broadcaster sends a list of typed blocks and the viewer's page builds DOM
with `createElement` and `textContent`. Nothing is ever parsed, so the class of bug a sanitiser
exists to prevent is not reachable, rather than being defended against. A `<script>` somebody types
is eleven characters on screen.

That is not merely a preference. These pages serve
`require-trusted-types-for 'script'; trusted-types 'none'`, which means there is no route from a
string to DOM in this origin at all — `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`document.write` and `DOMParser.parseFromString` all throw. A sanitiser was tried here and removed
the same day: under that policy it returned **empty output for every input** while catching its own
violation, so every "no script survived" test passed on nothing having been rendered.

Embeds are the one real trade, and the rule that makes them survivable is that the frame must not be
**our** origin. A cross-origin frame cannot touch `window.parent`, so a poll or a map can run
whatever script it likes and never reach the key. Same-host and non-`https` sources are refused,
`srcdoc` cannot be expressed at all, and we — not the author — set `sandbox` (without
`allow-top-navigation`), `allow` (so an embed cannot ask for the viewer's camera) and
`referrerpolicy` (so the share link is not sent to a third party). The Worker serves
`frame-ancestors 'none'` from the other side, so no earthseed.live page can be framed either way.

## The burn-ins, which point the other way

Three things can be drawn **into** the picture rather than over it: a handle watermark, a QR code
for a link, and a location and time stamp. Being picture means they survive a screen recording and
a re-encode, and that they travel inside the media encryption like every other pixel — only people
holding the link ever see them.

All three are off unless a broadcaster switches them on, and the location stamp is the reason:

- It puts your coordinates in the frame, for everyone with the link. That is the opposite of what
  the rest of this page is for.
- **It is not proof.** Geolocation is a number the browser hands us and this page cannot attest to
  it; a determined faker overrides it from devtools or runs a VPN and settles for the coarse
  answer. It raises the cost of a casual lie, and nothing more.
- A device fix and a network guess are **never rendered alike** — `±12m` with six decimals versus
  `~city` with four — because a city centroid dressed as a GPS fix would manufacture exactly the
  false confidence the feature exists to prevent. A stale fix counts as no fix.
- The time is **our edge's**, not your computer's, so a viewer can compare it with their own clock
  and read the delay off the screen. Best-of-N samples against `/api/whereami`, anchored to a
  monotonic timebase so an NTP step mid-broadcast cannot corrupt it, corrections slewed at 1% so
  the burned-in clock never runs backwards. `/api/whereami` echoes the caller's own `request.cf`
  back to that caller: not logged, not stored, not forwarded.

The QR is encoded **in your browser** (`simple/qr.js`, written out rather than pulled in), so no
third party is told which link you are putting on screen — and no external script is loaded into a
page holding your content key.

## The passcode (optional second lock)

A share link is stable on purpose — the same `node=`, `o=` and `#k=` come back after a reload, so a
link you hand out keeps working. The consequence is that **anyone who ever receives a link can watch
every later broadcast from that browser profile.** Rotating salts does not change this: salts are
public and any viewer re-fetches them.

Turning on "Require a passcode to watch" adds a second secret that is deliberately **kept out of the
link**. You read it to your viewer over a different channel — a phone call, a text, in person — so
the link and the passcode never travel together.

**Nothing in the middle is ever told the passcode.** It is not stored on a server, not sent to one,
and not checked by one. No hash or verifier of it is published anywhere. It is stretched with
PBKDF2 and mixed into `CK`, so a wrong passcode simply produces a wrong AES key and the GCM tag
fails **in the viewer's own browser**. Our view of the world is byte-for-byte identical whether
the passcode typed was right or wrong — including whether a stream has one at all, which is why the
watch page discovers it by trying rather than by asking.

- **Why PBKDF2, and why 5,000,000 iterations.** The attacker this defends against is someone who
  *already has your link* — so they hold the fragment key and can fetch the public salts, and the
  passcode is their only unknown. They can grind guesses offline with nothing to rate-limit them.
  Stretching makes each guess cost ~0.4s of work instead of microseconds. Your viewer pays that
  once, on connect.
- **Revocation — the point of the feature.** *Regenerate* locks out everyone holding the old
  passcode **without changing your link and without burning your node identity**. It takes effect
  the **next time you go live**: the key is not re-derived mid-broadcast, so nobody currently
  watching is cut off. To revoke someone now: regenerate, stop, go live again.
- **Revoking the link itself.** *New link* mints a fresh `#k=` fragment key, so **every link you
  have already shared stops decrypting** — use it when a link has gone somewhere it shouldn't. Same
  timing rule: it applies at your next go-live. A revoked viewer cannot be told apart from one who
  is missing a passcode — both simply hold the wrong key — so the watch page says the link *may* be
  out of date **or** a passcode *may* be needed, rather than guessing.
- **Revoking your identity.** *New link* leaves your `node id` unchanged, and that is not a
  detail: the id is in every link you ever sent, and asking to watch a broadcast requires no proof
  of anything. So **someone holding an old link can still tell when you are live**, indefinitely,
  even though they can no longer see or hear it. *New ID* is the answer to that — it mints a new
  keypair, so old links name an identity that never publishes again and reveal nothing at all.
  It cannot be undone (the private key is non-extractable and is discarded), it clears this
  stream's fragment key, passcode and rotate secret with it, and everyone you still want watching
  needs the new link.

  | Control | Old links can watch | Old links can see you're live |
  |---|---|---|
  | Regenerate passcode | no | **yes** |
  | New link | no | **yes** |
  | New ID | no | no |

  What *New ID* does not do is hide you from us: a new id appearing from the same address at the
  same hour is trivially linkable by whoever places you. It breaks the link between you and the
  people you handed links to — not between you and the infrastructure.
- **Opt-in, and nothing else changes.** With the toggle off, derivation is byte-identical to what it
  was before the feature existed, so **no existing link breaks.**

## Who can see what

- **Our Worker** is the party that grew. It sees:
  - **that a broadcast started and ended**, its `node id`, and its `route tag`. This is new as of
    August 2026 and it is a real cost: we now know *that* you broadcast. It is the price of being
    able to stop a stream at all, and it buys nothing toward decrypting one.
  - **viewing sessions** — a count and a duration per broadcast, keyed by a salted hash with no
    identity in it and reaped by a cron. Enough to answer "is anyone there?", not enough to follow
    anybody between broadcasts.
  - **your stream's settings** — the overlay blocks, the chat flag, the sealed `link_enc` blob.
    These are public by necessity: a viewer holds a link and nothing else, and has to be able to
    render the page. What that discloses is exactly what the broadcaster chose to put on screen in
    front of strangers.
  - **chat ciphertext**, in a Durable Object that holds `{id, ct, ts}` and has no field for a name
    or a message.
  - **seed vaults**, if the demo is used — see below, and note it is the one persistent per-person
    row in this database.

  It **never** sees `#k=`, `CK`, the chat key, your `passcode`, your media, your messages, or
  anything that identifies you. There is no account, and the publish key that admitted you is not
  stored.

- **Accounts exist in the code and are switched off.** `src/worker/auth/` holds Google OAuth, a
  `users` table and a `broadcaster_access` allow list. While `ACCOUNTS` is `"off"`, `/api/auth/*`
  refuses everything and nothing can be written to `users`; publishing is admitted by a publish key
  alone. `curl -s https://earthseed.live/api/config` reports `"accounts"` so the claim is
  checkable rather than merely asserted. **If it is ever turned on, a signed-in allowed address can
  publish without a key and we then know who broadcast** — which would make a different product,
  and this page would have to say so.

- **The CDN** (`cdn.moq.pro`) sees: a connection `JWT`, ciphertext frames, the cleartext catalog,
  and your IP. It **never** sees `#k=`, `CK`, your `passcode`, or your media — nor whether a
  broadcast has a passcode at all. **It cannot mint tokens for your broadcast**: it holds only the
  *public* half of the Ed25519 signing key, so it can verify a token and cannot forge one.
  **A viewer contacts us exactly once**, to be placed. After that a viewer talks only to the CDN,
  and the CDN only ever carries ciphertext.

- **Someone with the link** can watch and read the chat — the link carries `#k=`. Share it
  carefully. If you set a passcode they need that too, from your other channel. They still
  **cannot publish as you, rewrite your settings, or rotate your key**: your `node id` *is* an
  Ed25519 public key, and each of those requires a signature — over a challenge our Worker just
  issued and MAC'd with the issue time inside it — from the matching private key, which never
  leaves your browser.

- **Your identity key cannot be copied out of your browser.** It is generated non-extractable and
  stored as a key *object* in IndexedDB, never as bytes — so there is no exportable copy for a
  malicious script or extension to steal and reuse later. The trade is that an identity cannot be
  backed up or moved between browsers: lose the browser profile and you mint a new one (and a new
  share link). See the limits below for what this does *not* cover.

- **Someone without the link** gets at most opaque ciphertext — plus the cleartext catalog
  (codec/resolution) and traffic size/timing. Never anything decryptable.

## Seeds, and the row it adds

The seeds demo is a tipping and prepaid-bandwidth economy: four pools per vault, a ledger, and
per-stream accrual. **Nothing in it moves money** — there is no payment processor, "buying" credits
a vault directly, and a cash-out records an intent and stops.

A vault is addressed by a public id derived from a 256-word recovery phrase:
`PBKDF2-SHA256(phrase, "earthseed-vault-v1", 210,000)` → 512 bits, split into a **public id** and a
**write secret** that never leaves the browser. Only the SHA-256 of that secret is stored, so the
column leaking does not let anyone spend anyone's seeds. (A real build would verify an Ed25519
signature over a challenge instead — same identity model, no shared secret at all. That is the
first thing to replace if this stops being a demo.)

Two things to be straight about:

- **It is the first persistent per-person row in this database.** Every other table here is
  deliberately unable to link two things to the same human. A vault is not: it accumulates, and it
  is meant to. Migration `0014_seeds.sql` says so at length.
- **Cash-out is an unresolved legal question**, not an engineering one, and it has to be answered
  before any of this touches a payment processor.

## Where the media goes now

Production routes through **[moq.pro](https://moq.pro)**, a CDN we do not operate. Our Worker mints
a per-broadcast **Ed25519 (`EdDSA`) JWT** naming an account root and exactly one broadcast path
beneath it, with an expiry; moq.pro verifies it against the public half. **The private key never
leaves the token issuer, so the CDN can check a token and cannot forge one.**

This replaced a fleet of single-tenant [Hermit unikernels](https://github.com/erikherz/hermit-moq)
that we ran ourselves — no shell, no persistent disk, one relay per stream, KVM isolation rather
than namespaces on a shared kernel. That was a genuinely stronger story about the machines, and it
is no longer the truth, so the argument for it has been deleted rather than left standing next to
infrastructure it does not describe. Anyone self-hosting can still take that path: the fleet code is
in `src/worker/` and `docs/` records how it worked.

Two honest consequences of the move:

- **Broadcasts are no longer isolated by a machine boundary.** One relay per stream is gone; a CDN
  is shared infrastructure. What still scopes a compromise is **token scope** — a token names one
  broadcast path and nothing else — and, much more importantly, the fact that a relay only ever
  holds ciphertext. The machine boundary was defence in depth, not the defence.
- **We have less to tell you about the operator.** We ran the old relays and could describe them
  precisely. We do not run this one.

What did not change at all: the CDN cannot decode a frame, cannot mint a token, and never receives
`#k=`.

## The trusted computing base (what you must trust)

1. **The client** — thirteen unminified files in `simple/`, about 7,500 lines, no build step and
   no runtime dependency of our own. This used to read "it's one readable file; read it", and that
   was a real property that has been spent: it was 1,657 lines in August 2026. What is left in its
   place is `INTEGRITY.md` — a SHA-256 for every file, committed to git so the record lives under a
   different party than the site being checked — and `npm run verify`, which compares the live site
   against it. Weaker, and named as weaker.
2. **`@moq/net`** — the transport (version `0.1.5`), **vendored**: built once from the published
   package at exact dependency versions and served from our own origin, not a CDN. It is
   unminified, so you can read it; `simple/vendor/README.md` has the build command and the SHA-256
   so you can reproduce it byte-for-byte and confirm we didn't change anything.
3. **The browser** — WebCrypto, WebCodecs, WebTransport.
4. **However you host the pages** — whoever serves `earthseed.js` could serve different code. If
   that's a concern, host it yourself — though a full self-host now means running the Worker in
   `src/worker/` too, because the client asks its own origin for placement rather than a broker
   directly. `npm run bundle` packages the client; `INTEGRITY.md` is how you check ours.

You do **not** have to trust our Worker or the CDN with your content — that's the point. You *do*
have to trust our Worker to be **available**, and to gate publishing honestly; see the honest
limits below.

## Honest limits

- **Any relay you connect to sees your IP** (true of any website). It isn't stored, but if you
  need to hide it, put a **VPN or Tor** in front — encryption and discovery are unchanged.
- **A share link is only as private as how you share it.** The `#k=` never reaches a server, but
  whoever you send it to — and your own browser history — has it. A passcode is what keeps a leaked
  link from being enough on its own; it only helps if you send it by a *different* route.
- **A passcode gates decryption, not connection.** Someone with your link can still get a subscribe
  token and pull ciphertext, then attack the passcode offline. Closing that would mean our Worker
  verifying passcode knowledge — which would hand it an offline-guessing oracle and destroy the
  property the passcode exists for. We take the trade: the slow KDF is what makes it safe.
- **A passcode expires long before it breaks.** Eight characters is 40 bits: years of GPU time for
  one attacker, but only weeks-to-months for a well-funded one grinding offline. It is not built to
  hold forever — it is built to outlast itself. Regenerate periodically and the window never
  closes; leave one in place for a year and it is a weaker claim.
- **Not DRM.** An authorized viewer can still capture decoded frames. E2E protects the content
  *in transit and from the infrastructure*, not from the people you invite.
- **"Read exactly what runs" is a goal, not a proof.** The client ships unminified and unbundled
  so it's readable, but verifying the *hosted* bytes against this repo is on you (or self-host).
- **Hostile code on the page beats all of this.** If someone can run script in your tab — a
  compromised host, a malicious extension — they can read the content key straight out of the URL
  fragment and the passcode straight out of its input box, and they can ask your identity key to
  sign things while the page is open. A non-extractable key means they cannot *walk away with* your
  identity and keep publishing as you afterwards, and vendoring the transport removes the
  third-party host that could have injected such code. Neither makes the page itself safe to lose.
  This is why the browser and the host are in the trusted computing base above, and it is the real
  reason to prefer a browser profile you control.
- **The script policy is enforced, and it is not a complete answer.** The pages ship a
  `Content-Security-Policy` that permits only scripts from this origin, each inline block pinned by
  SHA-256, with `require-trusted-types-for 'script'` so the DOM sinks that enable XSS throw rather
  than being absent by convention. A script injected into the page is refused rather than reported.
  What it cannot help with is the case where the *legitimate* files are the problem: if the host
  serves a modified `earthseed.js`, that file is same-origin and the policy permits it. CSP narrows
  how code gets onto the page; it does not verify what the code does. That is still the trust in
  the host described above.
- **Network destinations are deliberately unrestricted, so anyone can run a fleet.** The policy
  does **not** pin which hosts the page may connect to. That is a requirement, not an omission:
  a partner running relays on their own domain, or an enterprise relay living inside a private
  network, must work without us shipping a new client. Restricting it would have quietly meant
  "only relays we operate". It costs little, because a relay only ever receives **ciphertext and a
  broadcast-scoped token** — your content key never goes there — so the identity of the host at the
  other end is not what protects your media. Pinning destinations would only bind an attacker who
  could run script here *without* controlling our response headers, and anyone who can serve a
  modified client controls both.
- **We are a required dependency, on purpose.** Our Worker can refuse to mint a token and deny you
  service — though it still can't read your content. There is deliberately no way to route around
  it. An earlier "open-relay" mode let a page skip placement and use any public MoQ endpoint, and
  it was removed: with nothing to authorize a publisher, anyone could publish to anyone's broadcast
  name. That trade is the honest shape of this product — **availability depends on us;
  confidentiality does not.** If you need to remove that dependency, host the client yourself *and*
  run the Worker and your own relays; both are in this repository.
- **Metadata.** We learn that *some* broadcast (by node id) exists, when it ran, and roughly how
  many sessions watched it; the CDN learns traffic timing and volume, and your IP. The content
  stays encrypted throughout.
- **The client is bigger than the claim that used to carry it.** 1,657 lines in August 2026,
  about 7,500 now. No build step and no runtime dependency of our own still hold, and every file is
  hashed in `INTEGRITY.md` — but "small enough to read in an afternoon" does not, and a document
  that kept saying it would be doing the thing this page exists not to do. `docs/hard-mode.md`
  records the posture that was traded away, and how to get back to it.

## Browser support

- **Broadcast & watch:** recent Chrome/Edge, and Safari on **iOS 18+ / macOS** (needs WebTransport
  + WebCodecs). Capture avoids the Chromium-only `MediaStreamTrackProcessor` so Safari/iOS works.
- We ship no WebSocket or WASM fallback of our own, so very old browsers are out of scope. If you
  read the vendored transport you will find WebSocket code in it: `@moq/net` implements qmux over
  WebSocket and will try it alongside WebTransport.
  **When we ran the relays we could say flatly that they did not serve WebSocket, so that attempt
  could not succeed. We cannot say that about a CDN we do not operate, and have not measured it.**
  In practice a network that blocks UDP blocks this app. What is unchanged either way is that a
  WebSocket path would carry the same ciphertext under the same key — the transport is not what
  protects your media.
