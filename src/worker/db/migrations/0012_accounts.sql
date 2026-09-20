-- Accounts. Google OAuth sign-in for broadcasters, ported from Wallflower.
--
-- ── Read this before reading the table ───────────────────────────────────────────────────────
--
-- Earthseed's front page says, in these words, "No accounts. No server-side list of who's
-- streaming." This migration makes the first half of that sentence false, and it is the only
-- migration in this directory that takes something away rather than adding to it. That is not a
-- side effect of porting a feature; it IS the feature, and pretending otherwise by burying it in
-- a schema file would be the worst version of shipping it.
--
-- The README and simple/TRUST.md are rewritten in the same branch that lands this. If you are
-- reading this migration in a tree where those two files still promise no accounts, that is a
-- bug and the claim is the thing to fix, not this comment.
--
-- ── What an account does and does not do ─────────────────────────────────────────────────────
--
-- An account gates PUBLISHING only. Watching is untouched: no sign-in, no cookie that survives
-- the tab, and `watch_events` (migration 0011) still holds nothing that links two sessions to one
-- human. A viewer's experience of this service is exactly what it was.
--
-- It also does not reach the media. The content key is still derived in the two browsers from the
-- `#k=` fragment, which browsers never transmit. Signing in tells this Worker who is allowed to
-- ask for a relay; it does not move the key, and nothing here brings the server one step closer
-- to being able to decrypt a broadcast. That property is the whole design and it survives this
-- change intact.
--
-- What it genuinely costs: a broadcaster's stream ids become linkable to each other and to an
-- email address held by Google and by us. Before this, two broadcasts from the same person were
-- unlinkable. After it, they are linkable by anyone holding this database. Streams published with
-- a publish code and no sign-in stay as they were — the code path is not removed.
--
-- ── Sessions are not stored ──────────────────────────────────────────────────────────────────
--
-- There is deliberately no `sessions` table. A session is a stateless HMAC-SHA256 cookie carrying
-- `{userId, exp}` and its signature (see src/worker/auth/session.ts). Nothing to leak, nothing to
-- reap, and no server-side record of when somebody was logged in — which is a smaller footprint
-- than a session table for the same functionality, so it is worth stating that the absence is a
-- choice and not an omission.
--
-- ── Columns ──────────────────────────────────────────────────────────────────────────────────
--
-- Only what OAuth hands back and what the allow list needs. No last-login timestamp, no IP, no
-- login history: an account here answers "may this person publish", and a table that also
-- answered "when were they here" would be a surveillance record we have no use for.
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id   TEXT UNIQUE,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id);

-- ── The broadcaster allow list ───────────────────────────────────────────────────────────────
--
-- Default-DENY. A signed-in user may publish only if there is a row here for their email with
-- status='allowed'. No row, or status='suspended', means no. Signing in is therefore necessary
-- and not sufficient, which is the right way round: OAuth proves who someone is, and this table
-- is where the decision about them lives.
--
-- Dropped by migration 0009 along with `users`; restored here because an account system without
-- it would mean anyone with a Google address could publish, which is a weaker position than the
-- publish-code path Earthseed already has.
CREATE TABLE IF NOT EXISTS broadcaster_access (
  email       TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'allowed', -- 'allowed' | 'suspended'
  note        TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- Seed the operator so default-deny cannot lock the site owner out of their own deployment.
-- Nothing may follow this statement — see the note at the end of 0011.
INSERT OR IGNORE INTO broadcaster_access (email, status) VALUES ('erik@vivoh.com', 'allowed');
