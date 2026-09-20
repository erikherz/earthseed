-- Seeds: the tipping and prepaid-bandwidth economy. DEMO ONLY.
--
-- Ported from Wallflower, collapsing its migrations 0015, 0016 and 0019. Those three are a
-- history — one balance, then three pools, then four with the fee model inverted — and Earthseed
-- has no vaults to migrate, so it starts at the end state. The two columns Wallflower kept purely
-- so a worker rollback would not land on a missing column (`seeds_micro`, `fee_micro` on the
-- vault) are therefore absent here; there is no older worker to roll back to. `seed_ledger` keeps
-- both, because on the ledger they are live fields and not vestigial ones.
--
-- ── NOTHING HERE TOUCHES MONEY ───────────────────────────────────────────────────────────────
--
-- There is no Stripe integration. "Buying" a packet credits a vault directly and a cash-out
-- records an intent and stops. No card is charged and no payout is ever sent. The fee arithmetic
-- is real so the screens show true numbers, which is the point of a demo and also the trap in
-- one: every figure on those screens is correct and none of them moved a cent.
--
-- The cash-out path is the unresolved piece, and it is a legal question rather than an
-- engineering one. It is not answered by this migration and must be answered before any of this
-- is connected to a payment processor. Read that sentence as a blocker, not a to-do.
--
-- ── THE PRIVACY LINE, which this table strains ───────────────────────────────────────────────
--
-- This is the first persistent per-person row in Earthseed's database. Every other table here is
-- deliberately unable to link two things to the same human — migration 0011 says so at length and
-- simple/TRUST.md promises it in as many words.
--
-- A vault cannot be built that way. Value has to accumulate across broadcasts, so it needs an
-- identity that spans them. There is no version of this feature that does not.
--
-- The resolution is that a vault is OPT-IN and separate. The pubkey below is NOT the
-- per-broadcast node key: that one is non-extractable, dies with the broadcast, and must stay
-- that way. It is a second key a streamer creates only if they want a vault. Streams never
-- attached to a vault remain exactly as unlinkable as they are today. Streams that ARE attached
-- become linkable to each other. That is the trade, and it has to be stated on /trust before this
-- goes anywhere near production for real.
--
-- ── Why four pools ───────────────────────────────────────────────────────────────────────────
--
-- A single balance that can be planted, burned and cashed out is the shape that earns a
-- money-transmitter characterisation, because value moves person to person and then exits to
-- cash. The separation that carries the legal weight is not "can this be spent" but "can this
-- become CASH". Burning does not move value anywhere — it consumes a service and destroys it — so
-- burning is safe from any pool. Only two transitions are dangerous, and both are impossible by
-- construction here rather than by a check somebody has to remember:
--
--   free   -> someone else's cashable balance   (mint cash from a game of tic-tac-toe)
--   paid   -> your OWN cashable balance         (launder a stolen card in one hop)
--
-- Hence:
--
--   free_micro     granted by us. Burn on your own bandwidth ONLY. Never plantable, never
--                  cashable — otherwise ten identities and ten free grants mint real money.
--   gifted_micro   passed to you by another creator. Burn only, same rules as free. It gets its
--                  own column rather than sharing `free` for a reason that is not cosmetic:
--                  `free` means WE minted it, `gifted` means a human bought it and passed it
--                  along. Merging them would leave the ledger unable to answer how much value we
--                  created versus how much moved between people, which is the first question an
--                  accountant or a regulator asks.
--   paid_micro     purchased. Plant on SOMEONE ELSE, or burn on your own bandwidth. Never
--                  cashable: buying and then redeeming is buying and selling money.
--   earned_micro   planted on you by someone else. Burn, or cash out. The only pool that can ever
--                  become money, and it arrives as a revenue share for the audience you brought.
--
-- The gifting transition (earned -> someone else's gifted) only ever REDUCES the systemwide
-- cashable balance. It is a one-way ratchet toward less liquidity, and no chain of gifts returns
-- value to a cashable pool, so it cannot be composed into an exit however many hops are strung
-- together. That is why re-gifting is allowed: every hop is still a dead end for cash.
--
-- BURN ORDER IS free -> gifted -> paid -> earned. Least optionality first: it spends the least
-- valuable money first and never quietly consumes the balance someone was saving to cash out.
--
-- Value is never addressed to a PERSON. A gift targets a live broadcast, exactly as a plant does,
-- and there is no vault-to-vault transfer anywhere in the system. That invariant is worth more
-- than the convenience it costs — it is what stops this being a payments rail to an arbitrary
-- identity.
--
-- ── The fee is collected at purchase ─────────────────────────────────────────────────────────
--
-- The buyer pays the card fee as a visible line item and seeds enter fully funded: one seed in a
-- vault is backed by one dollar actually collected. Wallflower arrived here the hard way. Under
-- its earlier model a $10 packet credited a full 10 seeds while the processor took $0.59, so the
-- house fronted that fee and recovered it only if those seeds were ever cashed out. On the burn
-- path it never came back at all — $9.41 kept against 10,000 viewer-minutes, which costs about
-- $9.57 at 2.2 Mbps against a $0.058/GB ceiling. The fee model penalised burning and was neutral
-- on cashing out, which is backwards on its own terms.
--
-- Settling at purchase deletes more than it changes: fee provenance, which fee rides on which
-- pool, and the whole question of apportioning a deferred fee across four balances. Cash-out
-- deducts one flat payout fee and has nothing left to apportion.

-- One vault per identity. The pubkey IS the account: no email, no password, no signup.
--
-- Balances are in MICRO-SEEDS (1 seed = 1,000,000) and are integers throughout, because burn
-- accrues in 30-second slices and floating point would drift a vault away from its own ledger.
CREATE TABLE IF NOT EXISTS seed_vaults (
  pubkey        TEXT PRIMARY KEY,

  -- SHA-256 of a secret held only in the holder's browser. Authorises writes to this vault. The
  -- hash is stored, never the secret, so this column leaking does not let the holder spend
  -- anyone's seeds. A real build would verify an Ed25519 signature over a challenge instead —
  -- same identity model, no shared secret at all. This is the demo shortcut, and it is the first
  -- thing to replace if this ever stops being a demo.
  secret_hash   TEXT NOT NULL,

  label         TEXT,

  -- The four pools. See the commentary above for which transitions each one permits.
  free_micro    INTEGER NOT NULL DEFAULT 0,
  gifted_micro  INTEGER NOT NULL DEFAULT 0,
  paid_micro    INTEGER NOT NULL DEFAULT 0,
  earned_micro  INTEGER NOT NULL DEFAULT 0,

  -- Lifetime burned, for display. Never decreases.
  burned_micro  INTEGER NOT NULL DEFAULT 0,

  -- A small allowed overdraft, so a broadcast runs past zero rather than being cut off
  -- mid-sentence. Enforcement is at the START of the next broadcast, never in the middle of
  -- this one.
  debt_micro    INTEGER NOT NULL DEFAULT 0,

  -- The free starting seed is once per vault. Minting a new vault is free, so this alone stops
  -- nothing — the cost of farming is raised elsewhere, and weakly.
  granted       INTEGER NOT NULL DEFAULT 0,

  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every discrete seed movement.
--
-- Burn is deliberately NOT recorded here: it accrues every 30 seconds per viewer, which would
-- bury the interesting rows under thousands of dust entries. The running total lives on
-- seed_vaults.burned_micro instead, and that asymmetry is the one thing to remember when reading
-- this table — it is a record of decisions, not of consumption.
CREATE TABLE IF NOT EXISTS seed_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),

  -- 'grant' | 'buy' | 'plant' | 'gift' | 'cashout'
  kind        TEXT NOT NULL,

  from_key    TEXT,
  to_key      TEXT,
  seeds_micro INTEGER NOT NULL DEFAULT 0,

  -- Non-zero only on 'buy' (the card fee the purchaser paid) and 'cashout' (the payout fee).
  -- Zero on every move between vaults, because the fee was settled at purchase time.
  fee_micro   INTEGER NOT NULL DEFAULT 0,

  stream_id   TEXT,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_seed_ledger_at ON seed_ledger (at DESC);
CREATE INDEX IF NOT EXISTS idx_seed_ledger_to ON seed_ledger (to_key, at DESC);

-- Which vault a live stream burns from. Set when a broadcaster with the demo enabled goes live.
-- Without a row here a stream burns nothing, which is why every existing broadcast on this site
-- is completely unaffected by this table's existence.
-- Nothing may follow this statement — see the note at the end of 0011.
CREATE TABLE IF NOT EXISTS seed_streams (
  stream_id   TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  attached_at TEXT NOT NULL DEFAULT (datetime('now'))
);
