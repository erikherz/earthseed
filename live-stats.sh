#!/bin/bash
# Show live broadcast stats with viewer counts

echo "📡 Live Broadcasts"
echo "=================="
npx wrangler d1 execute earthseed-db --remote --command "
SELECT
  b.stream_id,
  u.name as broadcaster,
  b.geo_city || ', ' || b.geo_country as location,
  b.origin,
  strftime('%H:%M:%S', b.started_at) as started,
  strftime('%H:%M:%S', b.last_heartbeat) as heartbeat,
  (SELECT COUNT(*) FROM watch_events w WHERE w.stream_id = b.stream_id AND w.ended_at IS NULL) as viewers
FROM broadcast_events b
LEFT JOIN users u ON b.user_id = u.id
WHERE b.ended_at IS NULL
  AND b.last_heartbeat IS NOT NULL
  AND b.last_heartbeat > datetime('now', '-15 seconds')
ORDER BY b.started_at DESC
" --json 2>/dev/null | jq -r '
  .[0].results |
  if length == 0 then "No active broadcasts"
  else
    ["STREAM", "BROADCASTER", "LOCATION", "ORIGIN", "STARTED", "HEARTBEAT", "VIEWERS"],
    ["------", "-----------", "--------", "------", "-------", "---------", "-------"],
    (.[] | [.stream_id, .broadcaster, .location, .origin, .started, .heartbeat, .viewers]) |
    @tsv
  end
' | column -t -s $'\t'

echo ""
echo "👀 Current Viewers"
echo "=================="
npx wrangler d1 execute earthseed-db --remote --command "
SELECT
  w.stream_id,
  COALESCE(u.name, 'Anonymous') as viewer,
  w.geo_city || ', ' || w.geo_country as location,
  strftime('%H:%M:%S', w.started_at) as started
FROM watch_events w
LEFT JOIN users u ON w.user_id = u.id
WHERE w.ended_at IS NULL
ORDER BY w.stream_id, w.started_at DESC
" --json 2>/dev/null | jq -r '
  .[0].results |
  if length == 0 then "No active viewers"
  else
    ["STREAM", "VIEWER", "LOCATION", "STARTED"],
    ["------", "------", "--------", "-------"],
    (.[] | [.stream_id, .viewer, .location, .started]) |
    @tsv
  end
' | column -t -s $'\t'
