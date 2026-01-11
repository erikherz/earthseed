-- Add origin column to broadcast_events
-- Values: 'cloudflare' (Chrome/QUIC) or 'earthseed' (Safari/WebSocket)
ALTER TABLE broadcast_events ADD COLUMN origin TEXT DEFAULT 'cloudflare';
