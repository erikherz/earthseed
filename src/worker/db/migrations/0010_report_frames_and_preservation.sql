-- A still frame on an abuse report, and a preservation clock for the one category that
-- carries a statutory duty.
--
-- Ported from Wallflower (its migrations 0018 and 0020, combined here because Earthseed is
-- getting both at once and there is no state between them worth separating).
--
-- Read migration 0009 first. It built the reports table as a SENSOR for an operator who
-- cannot decrypt anything: a queue of "someone with a link says this stream is a problem",
-- and nothing more. That was the whole design, and its weakness was that a report was an
-- unverifiable assertion — an operator could stop a stream on a stranger's word, or not, with
-- no way to tell which was right.
--
-- ── The frame ────────────────────────────────────────────────────────────────────────────
--
-- This is the first column in this database that holds plaintext broadcast content.
-- Everything else here is metadata: ids, times, counts, salts, kill flags. A reported frame
-- is a picture of what someone was actually watching. Said plainly rather than discovered
-- later, because it is a real change to what this service holds.
--
-- The reason it is worth it is that the alternative already in the design is far worse for
-- the broadcaster: the evidence link hands the operator the key to the entire live broadcast.
-- One frame is the smaller ask by a wide margin.
--
-- Four properties keep the cost bounded:
--
--   1. The reporter chooses. The frame is captured from their own player, shown to them
--      before it is sent, and removable with one click. Nothing is taken silently.
--   2. It is one frame. Not a clip, not a recording, and not something we can ask for again.
--   3. The client never supplies a MIME type. This column holds BARE base64 whose bytes are
--      checked to begin with a JPEG SOI marker; the operator console forces image/jpeg when
--      it renders. Storing a client-chosen type is how a report queue becomes an XSS vector
--      aimed at the one page that holds the admin password.
--   4. It expires. REPORT_FRAME_RETENTION_DAYS (default 30) nulls this column on the cron
--      while leaving the report row intact — the record of the complaint outlives the
--      content of it, which is the right way round.
--
-- Size is capped in the Worker (REPORT_FRAME_MAX_B64), not here. SQLite would happily take
-- two megabytes per row, and the global report cap means a large allowance is also a cheap
-- way to fill the database.
ALTER TABLE reports ADD COLUMN frame TEXT;

-- ── Why the CSAM category needs its own clock ────────────────────────────────────────────
--
-- 18 U.S.C. 2258A obliges a provider to report apparent child sexual abuse material to NCMEC
-- as soon as reasonably possible after obtaining ACTUAL KNOWLEDGE of it, and then to preserve
-- the contents of that report. The REPORT Act (signed 7 May 2024) amended 2258A(h) by
-- striking "90 days" and inserting "1 year".
--
-- We are end-to-end encrypted, so we never obtain actual knowledge by looking. 2258A(f) says
-- plainly that no provider is required to monitor, scan or search, so that is not a gap — it
-- is the arrangement the statute contemplates. The report queue IS our knowledge channel.
-- Which means the moment a frame arrives under this category, the preservation duty attaches
-- to it, and REPORT_FRAME_RETENTION_DAYS would have destroyed the evidence at day 30 with no
-- human involved. That is the hole this migration closes, and it closes it in the same breath
-- as opening it — the frame column above is what creates the thing worth preserving.
--
-- The duty attaches to reports actually submitted to NCMEC, not to every complaint in the
-- queue, so `preserve_until` is set at INTAKE as a conservative floor and re-based from the
-- filing date when an operator records the submission. Everything else still expires on the
-- ordinary 30-day clock, which is the right default: holding a stranger's living room for a
-- year because somebody misfiled a report is its own harm.

-- Set on intake for the CSAM category, and re-based when a submission to NCMEC is recorded.
-- The frame reaper and both operator-facing removal levers refuse to act while this is in the
-- future. NULL means the ordinary retention clock applies, which is the case for every other
-- category and for every row that existed before this migration.
ALTER TABLE reports ADD COLUMN preserve_until TEXT;

-- When an operator recorded a CyberTipline submission for this report. Nothing automated
-- writes here: filing requires credentials and a judgement this database has no business
-- making. It exists so the queue can show what has and has not been filed, and so the
-- preservation window can be measured from the event that actually starts it.
ALTER TABLE reports ADD COLUMN ncmec_reported_at TEXT;

-- ── Releasing a hold ─────────────────────────────────────────────────────────────────────
--
-- A hold that can never be lifted is the wrong shape, and noticing why is worth writing down.
-- Filing a report costs a viewer nothing but a share link, and the severe category is one
-- click away from the ordinary ones. So a hold with no release means any hostile invitee can
-- permanently pin a still of somebody's living room in this database, under the worst
-- available accusation, and no operator could ever remove it. The accused broadcaster would
-- have no recourse and we would have no way to clean up after a misfire.
--
-- The duty attaches to APPARENT child sexual abuse material. An operator who has looked and
-- found something that plainly is not that has no duty in the first place, and therefore
-- nothing to preserve. So a release exists — but it is a deliberate, recorded act with a
-- reason attached, not the ordinary delete button wearing a different label.
--
-- It refuses once ncmec_reported_at is set. After a submission the statutory year is running
-- on a real filing, and no judgement made here can stop it.
ALTER TABLE reports ADD COLUMN hold_released_at TEXT;
ALTER TABLE reports ADD COLUMN hold_release_reason TEXT;

-- The reaper filters on preserve_until, and the queue sorts unfiled severe reports first.
-- Nothing may follow this statement — not even a comment. D1's importer aborts on trailing
-- content after the final semicolon and reports success, which is how a migration silently
-- becomes a no-op.
CREATE INDEX IF NOT EXISTS idx_reports_preserve ON reports (preserve_until);
