-- Control plane: abuse reports, publish codes, the kill switch, and proof-of-link.
--
-- Until now this Worker stored nothing at all — the client reached the broker directly and D1 held
-- only the retired vite client's tables. These four tables are what an operator needs to be able to
-- STOP a stream they cannot see, which is the only moderation lever the design permits.
--
-- What is deliberately absent from every table here: any content key, any IP address, any geo, any
-- identifier for the person who requested a publish code or filed a report. A publish code is a
-- MAC'd capability and is never written down; only the SHA-256 of one already issued, and only when
-- it is being revoked.

-- ── Abuse reports ────────────────────────────────────────────────────────────────────────────
-- Filed by a viewer, who is the only party who can see anything. No reporter identity is recorded,
-- so this is a queue of "someone with a link says this stream is a problem" and nothing more.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  category TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS reports_queue ON reports (handled_at, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_stream ON reports (stream_id, created_at DESC);

-- ── Publish code revocation ──────────────────────────────────────────────────────────────────
-- Codes are stateless capabilities; these two tables are the only exception, and both are
-- identity-free by construction — a cohort number, or a hash of a code someone presented.
CREATE TABLE IF NOT EXISTS revoked_batches (
  batch INTEGER PRIMARY KEY,
  revoked_at TEXT DEFAULT (datetime('now')),
  note TEXT
);
CREATE TABLE IF NOT EXISTS revoked_codes (
  code_hash TEXT PRIMARY KEY,
  revoked_at TEXT DEFAULT (datetime('now')),
  note TEXT
);

-- ── The kill switch ──────────────────────────────────────────────────────────────────────────
-- One row per terminated stream. Presence of killed_at is the whole state: the Worker then refuses
-- to place a relay or mint a token for that id, and tells every browser still holding one to stop.
CREATE TABLE IF NOT EXISTS stream_kill (
  stream_id TEXT PRIMARY KEY,
  killed_at TEXT,
  note TEXT
);

-- ── Live broadcasts, and the proof a viewer holds the link ───────────────────────────────────
-- route_tag is HKDF(link fragment key, salt="es-route|<id>", info="earthseed-route-auth-v1"). The
-- broadcaster registers it on go-live and a viewer must present it to be placed. It is derived with
-- a different salt AND a different info string than the media key, so holding every tag ever
-- registered decrypts nothing — it only proves the holder was given a link.
--
-- Separate from the retired client's broadcast_events on purpose: that table carries a user_id
-- foreign key, six geolocation columns and a content_key column, none of which this design will
-- ever write to again.
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  route_tag TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS broadcasts_live ON broadcasts (stream_id, ended_at, id DESC);

-- ── Privacy purge of the retired client's tables ─────────────────────────────────────────────
-- These belong to the vite client deleted on 12 Aug 2026 and are read by nothing. They are dropped
-- rather than left sitting: between them they hold OAuth email addresses, six geolocation columns
-- per broadcast, and a content_key column — a stored decryption key, which is exactly the thing
-- every page on this site says does not exist on our side. Leaving dead tables holding live secrets
-- is how a claim quietly becomes false.
DROP TABLE IF EXISTS watch_events;
DROP TABLE IF EXISTS broadcast_events;
DROP TABLE IF EXISTS broadcaster_access;
DROP TABLE IF EXISTS streams;
DROP TABLE IF EXISTS users;
