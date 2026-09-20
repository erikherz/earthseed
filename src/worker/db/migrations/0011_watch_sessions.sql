-- Measured viewing sessions. Ported from Wallflower's migration 0014.
--
-- Earthseed dropped `watch_events` in migration 0009, along with every other table the retired
-- vite client owned. This does not restore that table — it builds the one Wallflower arrived at
-- after learning why the original was wrong, which is a different shape with a different set of
-- guarantees. Read 0009 first for what was removed and why.
--
-- ── What the old table got wrong ─────────────────────────────────────────────────────────────
--
-- A row was opened on page load and closed only by a `beforeunload` handler. That handler does
-- not fire on iOS backgrounding, tab crashes, force-quit or network loss, and nothing reaped the
-- survivors, so rows accumulated with `ended_at IS NULL` for ever. Any live-viewer count read
-- from it counted ghosts, and any duration computed from it was unbounded. The table was
-- therefore not a measurement of anything; it was a pile of page loads that looked like one.
--
-- The fix is a heartbeat plus a reaper. The client pings while the page is alive; the cron closes
-- anything that has gone quiet, AT the last heartbeat rather than at reap time, so a viewer whose
-- phone died is credited with what we actually observed rather than with the reaper's latency.
--
-- ── THE PRIVACY LINE ─────────────────────────────────────────────────────────────────────────
--
-- This is the constraint that shapes every column below, and it is the one that has to survive
-- contact with every future change: a row is a SESSION, never a person.
--
-- Nothing here is stable across sessions. No IP, no IP hash, no cookie, no fingerprint, no
-- account id. Two rows cannot be shown to be the same human — on one stream or across streams —
-- by us, or by anyone who later holds a copy of this database, or by anyone who compels one.
--
-- "How many, and for how long" is answerable without any of that. "Which of these rows is the
-- same person" is not, and must stay unanswerable. The moment one stable per-viewer identifier
-- lands in this table it stops being audience measurement and becomes an audience register,
-- which is precisely what this service exists to not have.
--
-- Earthseed's own README says "no server-side list of who's streaming". This table does not
-- create one — it records that a stream was watched, not by whom, and `broadcasts` already holds
-- the stream ids. But it does make audience SIZE newly visible to an operator, which was not true
-- yesterday, and that is a real change worth naming rather than discovering.
--
-- ── Columns ──────────────────────────────────────────────────────────────────────────────────
--
--   last_seen_at   Heartbeat watermark. The client pings every 30s; the reaper closes anything
--                  silent for 150s, using THIS value as the end time.
--
--   session_hash   SHA-256 of an opaque per-session token held only in the viewer's page memory.
--                  Session ids are sequential integers, so an unauthenticated end endpoint would
--                  let anyone walk the range and zero out every stream's audience. The token is
--                  the fix: you can only heartbeat or end a session you opened. The HASH is
--                  stored, never the token, so this column leaking forges nothing. It is
--                  per-session and never written to browser storage — reusing one across streams,
--                  or persisting it, would rebuild exactly the cross-session identifier the
--                  privacy line above forbids.
--
--   end_reason     'client' (a real pagehide) or 'reaped' (heartbeat lapsed). Kept because the
--                  two mean different things when reading a report: a wall of 'reaped' rows is a
--                  client bug or a flaky network, not an audience that all left at once.
--
-- No user_id column, unlike Wallflower's version of this table. Earthseed has no accounts on the
-- viewing side and this table is not the place to introduce one.
CREATE TABLE IF NOT EXISTS watch_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id     TEXT NOT NULL,
  started_at    TEXT DEFAULT (datetime('now')),
  ended_at      TEXT,
  last_seen_at  TEXT,
  session_hash  TEXT,
  end_reason    TEXT
);

-- The reaper's scan: open sessions ordered by silence.
CREATE INDEX IF NOT EXISTS idx_watch_events_open
  ON watch_events (ended_at, last_seen_at);

-- Per-stream reporting: the live count and the completed-session history both read this.
-- Nothing may follow this statement, not even a comment — D1's importer hands trailing content to
-- the parser as a leftover buffer, aborts the import, and reports success.
CREATE INDEX IF NOT EXISTS idx_watch_events_stream_ended
  ON watch_events (stream_id, ended_at);
