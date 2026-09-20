-- The shape of earthseed-db, as it actually is.
--
-- This file is DOCUMENTATION. Nothing reads it — the database is built by the numbered files in
-- migrations/, applied in order, and that directory is the authority. This is here so somebody
-- can see the whole thing at once without replaying fourteen migrations in their head.
--
-- It was wrong for a month. Until this rewrite it described the retired vite client's tables —
-- `users` with Microsoft and Discord columns, `broadcast_events` with six geolocation fields and
-- a `content_key`, a geo-carrying `watch_events` — every one of which migration 0009 had already
-- DROPPED. A schema file that describes a stored decryption key this service does not have is
-- worse than no schema file, because the next person to read it believes it. If you change
-- migrations/, change this in the same commit.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS DATABASE DELIBERATELY DOES NOT HOLD
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
--   • No content key, and no input from which one could be derived. Media keys come from the
--     `#k=` link fragment, which browsers never transmit. This Worker cannot decrypt a broadcast.
--   • No IP address, and no hash of one.
--   • No geolocation, on either side of a stream.
--   • No stable per-viewer identifier of any kind. See `watch_events`.
--
-- The one place plaintext broadcast content lands is `reports.frame`, a single still the reporter
-- chose to attach and saw before sending. Migration 0010 explains why that exception is worth it.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────


-- ══ CONTROL PLANE (migrations 0009, 0010) ════════════════════════════════════════════════════

-- Live broadcasts and the proof a viewer holds the link.
--
-- route_tag is HKDF(link fragment key, salt="es-route|<id>", info="earthseed-route-auth-v1"). The
-- broadcaster registers it on go-live; a viewer must present it to be placed on a relay. It uses
-- a different salt AND a different info string than the media key, so holding every tag ever
-- registered decrypts nothing — it only proves the holder was given a link.
CREATE TABLE IF NOT EXISTS broadcasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id   TEXT NOT NULL,
  route_tag   TEXT,
  started_at  TEXT DEFAULT (datetime('now')),
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS broadcasts_live ON broadcasts (stream_id, ended_at, id DESC);

-- Abuse reports. Filed by a viewer, who is the only party who can see anything. No reporter
-- identity is recorded, so this is a queue of "someone with a link says this stream is a problem"
-- and nothing more.
--
--   frame               One still, bare base64, JPEG bytes checked on intake. Nulled by the cron
--                       after REPORT_FRAME_RETENTION_DAYS (default 30) while the row survives.
--   preserve_until      Set on intake for the CSAM category; re-based when a CyberTipline
--                       submission is recorded. The reaper and both operator removal levers
--                       refuse to act while it is in the future. 18 U.S.C. 2258A(h), as amended
--                       by the REPORT Act, is the source of the one-year figure.
--   ncmec_reported_at   When an operator recorded a submission. Nothing automated writes here.
--   hold_released_at    A deliberate, recorded lift of a preservation hold, with a reason. It
--   hold_release_reason refuses once ncmec_reported_at is set.
CREATE TABLE IF NOT EXISTS reports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id           TEXT NOT NULL,
  category            TEXT NOT NULL,
  note                TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  handled_at          TEXT,
  frame               TEXT,
  preserve_until      TEXT,
  ncmec_reported_at   TEXT,
  hold_released_at    TEXT,
  hold_release_reason TEXT
);
CREATE INDEX IF NOT EXISTS reports_queue ON reports (handled_at, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_stream ON reports (stream_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_preserve ON reports (preserve_until);

-- Publish-code revocation. Codes are stateless MAC'd capabilities and are never written down;
-- these two tables are the only exception, and both are identity-free by construction — a cohort
-- number, or the hash of a code someone presented.
CREATE TABLE IF NOT EXISTS revoked_batches (
  batch       INTEGER PRIMARY KEY,
  revoked_at  TEXT DEFAULT (datetime('now')),
  note        TEXT
);
CREATE TABLE IF NOT EXISTS revoked_codes (
  code_hash   TEXT PRIMARY KEY,
  revoked_at  TEXT DEFAULT (datetime('now')),
  note        TEXT
);

-- The kill switch. One row per terminated stream; presence of killed_at is the whole state. The
-- Worker then refuses to place a relay or mint a token for that id, and tells every browser still
-- holding one to stop.
CREATE TABLE IF NOT EXISTS stream_kill (
  stream_id   TEXT PRIMARY KEY,
  killed_at   TEXT,
  note        TEXT
);


-- ══ AUDIENCE (migration 0011) ════════════════════════════════════════════════════════════════

-- One row per viewing SESSION, never per person.
--
-- Nothing here is stable across sessions — no IP, no IP hash, no cookie, no fingerprint, no
-- account id. Two rows cannot be shown to be the same human, on one stream or across streams, by
-- us or by anyone who later holds this database. Audience SIZE and DURATION are answerable here;
-- audience IDENTITY is not, and adding any column that would make it answerable is the one change
-- this table must never take.
CREATE TABLE IF NOT EXISTS watch_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id     TEXT NOT NULL,
  started_at    TEXT DEFAULT (datetime('now')),
  ended_at      TEXT,
  last_seen_at  TEXT,   -- heartbeat watermark; the reaper closes AT this value
  session_hash  TEXT,   -- SHA-256 of a page-memory-only token; authorises end/heartbeat
  end_reason    TEXT    -- 'client' | 'reaped'
);
CREATE INDEX IF NOT EXISTS idx_watch_events_open ON watch_events (ended_at, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_watch_events_stream_ended ON watch_events (stream_id, ended_at);


-- ══ ACCOUNTS (migration 0012) ════════════════════════════════════════════════════════════════

-- Google OAuth sign-in, which gates PUBLISHING only. Watching needs no account and creates no
-- row anywhere. Sessions are stateless HMAC cookies — there is deliberately no sessions table.
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

-- Default-DENY. Signing in is necessary and not sufficient: publishing also needs a row here with
-- status='allowed'.
CREATE TABLE IF NOT EXISTS broadcaster_access (
  email       TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'allowed',   -- 'allowed' | 'suspended'
  note        TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);


-- ══ PER-STREAM SETTINGS (migration 0013) ═════════════════════════════════════════════════════

-- user_id is NULLABLE on purpose: a stream published with a MAC'd publish code has no account
-- behind it. Ownership is enforced by the Ed25519 name challenge (the stream id IS the public
-- key), not by this column.
CREATE TABLE IF NOT EXISTS streams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id     TEXT UNIQUE NOT NULL,
  user_id       INTEGER,
  require_auth  INTEGER DEFAULT 0,
  -- NOT HTML, despite the name (a fossil from Wallflower's column). A JSON list of typed blocks
  -- the client turns into DOM with createElement/textContent. This origin serves
  -- `trusted-types 'none'`, so no string can become DOM here by any route — an HTML column would
  -- be one nothing could render. See migration 0013 and simple/overlay.js.
  overlay_html  TEXT DEFAULT '',
  chat_enabled  INTEGER DEFAULT 0,
  link_enc      TEXT,              -- SEALED watermark URL, `<nonce>.<ciphertext>`; unreadable here
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_streams_stream_id ON streams (stream_id);
CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams (user_id);


-- ══ SEEDS — DEMO ONLY, NO MONEY MOVES (migration 0014) ═══════════════════════════════════════

-- The first persistent per-person rows in this database, and the one place the unlinkability
-- promise is traded away — knowingly, opt-in, and only for streams attached to a vault. Read
-- migration 0014 before changing anything here; the four-pool split is load-bearing legally, not
-- just structurally.
CREATE TABLE IF NOT EXISTS seed_vaults (
  pubkey        TEXT PRIMARY KEY,
  secret_hash   TEXT NOT NULL,
  label         TEXT,
  free_micro    INTEGER NOT NULL DEFAULT 0,   -- granted; burn only
  gifted_micro  INTEGER NOT NULL DEFAULT 0,   -- from another creator; burn only
  paid_micro    INTEGER NOT NULL DEFAULT 0,   -- purchased; plant on others, or burn
  earned_micro  INTEGER NOT NULL DEFAULT 0,   -- planted on you; the ONLY cashable pool
  burned_micro  INTEGER NOT NULL DEFAULT 0,
  debt_micro    INTEGER NOT NULL DEFAULT 0,
  granted       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Decisions, not consumption: burn accrues in 30-second slices and is summed onto
-- seed_vaults.burned_micro rather than written here.
CREATE TABLE IF NOT EXISTS seed_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  kind        TEXT NOT NULL,   -- 'grant' | 'buy' | 'plant' | 'gift' | 'cashout'
  from_key    TEXT,
  to_key      TEXT,
  seeds_micro INTEGER NOT NULL DEFAULT 0,
  fee_micro   INTEGER NOT NULL DEFAULT 0,   -- non-zero only on 'buy' and 'cashout'
  stream_id   TEXT,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_seed_ledger_at ON seed_ledger (at DESC);
CREATE INDEX IF NOT EXISTS idx_seed_ledger_to ON seed_ledger (to_key, at DESC);

CREATE TABLE IF NOT EXISTS seed_streams (
  stream_id   TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  attached_at TEXT NOT NULL DEFAULT (datetime('now'))
);
