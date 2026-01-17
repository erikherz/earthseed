-- Add last_heartbeat column to broadcast_events for detecting stale streams
ALTER TABLE broadcast_events ADD COLUMN last_heartbeat TEXT;

-- Index for efficient heartbeat queries
CREATE INDEX IF NOT EXISTS idx_broadcast_events_last_heartbeat ON broadcast_events(last_heartbeat);
