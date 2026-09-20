-- Per-stream settings: the overlay, the chat opt-in, and the sealed link watermark.
--
-- Ported from Wallflower, where these columns accumulated across its migrations 0002 (overlay),
-- 0006 (chat), 0007 (require_auth) and 0017 (link_enc). They are created together here because
-- Earthseed is getting all four at once and there is no intermediate state worth preserving.
--
-- Earthseed dropped `streams` in migration 0009 as part of the retired vite client's tables. The
-- table returns with a different owner column and a different attitude to it — see below.
--
-- ── user_id is NULLABLE, and that is the interesting part ────────────────────────────────────
--
-- Wallflower's version made user_id a NOT NULL foreign key, because OAuth was its only door.
-- Earthseed has two: a signed-in account (migration 0012) or a MAC'd publish code, which is a
-- capability held by nobody in particular and is the path that keeps a broadcaster anonymous to
-- us. Requiring a user id here would quietly force every stream that wants settings to also want
-- an account, which would make the account system load-bearing for features that have nothing to
-- do with identity.
--
-- So: NULL user_id means the stream was published with a code, and its settings belong to
-- whoever holds that code. That is a weaker ownership claim than a foreign key and it is the
-- correct one — the Worker enforces ownership by the same Ed25519 name challenge it already uses
-- for go-live (the stream id IS the public key), not by this column.
--
-- ── Columns ──────────────────────────────────────────────────────────────────────────────────
--
--   require_auth   Viewer must be signed in. Fail-CLOSED: read it as "1 unless proven 0", so a
--                  missing row or a failed lookup denies rather than admits. Wallflower shipped
--                  this check twice in a form that could not fail, which is the reason the
--                  default is written down here rather than left to the caller.
--
--   overlay_html   Broadcaster-supplied HTML rendered over the player ("Extras"). Stored raw and
--                  sanitised on the way OUT, in the client, by src/overlay-sanitize.ts. Storing
--                  the sanitised form instead would look safer and be worse: it would bake one
--                  version of the sanitiser's judgement into the database permanently, so a
--                  later fix to the sanitiser could not reach rows already written.
--
--   chat_enabled   Live chat opt-in. Messages flow through the ChatRoom Durable Object, which
--                  this Worker has had bound since 0006 with no client attached to it.
--
--   link_enc       The Link watermark: a URL the broadcaster puts on screen as a QR code, stored
--                  SEALED and never as a URL. The client encrypts it under a key derived from the
--                  `#k=` fragment, so this column holds an opaque `<nonce>.<ciphertext>` that
--                  this service cannot read. The QR drawn into the video is already private by
--                  construction; a plaintext column here would have been the single place the
--                  destination leaked. The `_enc` suffix exists so nothing downstream ever treats
--                  it as a URL. Nothing indexes or queries it — it is read back whole, and only a
--                  viewer holding the fragment can make sense of it.
CREATE TABLE IF NOT EXISTS streams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id     TEXT UNIQUE NOT NULL,
  user_id       INTEGER,
  require_auth  INTEGER DEFAULT 0,
  overlay_html  TEXT DEFAULT '',
  chat_enabled  INTEGER DEFAULT 0,
  link_enc      TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_streams_stream_id ON streams (stream_id);

-- Nothing may follow this statement — see the note at the end of 0011.
CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams (user_id);
