#!/bin/bash
# Switch between relay modes
# Usage: ./switch-relay.sh [luke|linode|cloudflare-hybrid] [--deploy]

set -e

MODE=${1:-}
DEPLOY=${2:-}

if [ -z "$MODE" ] || { [ "$MODE" != "luke" ] && [ "$MODE" != "linode" ] && [ "$MODE" != "cloudflare-hybrid" ]; }; then
    echo "Usage: ./switch-relay.sh [luke|linode|cloudflare-hybrid] [--deploy]"
    echo ""
    echo "Modes:"
    echo "  luke             - Pure Luke's servers (cdn.moq.dev/anon)"
    echo "                     Both Chrome and Safari use Luke's relay"
    echo "                     Luke natively supports WebSocket fallback"
    echo ""
    echo "  linode           - Pure Linode servers (us-central.earthseed.live)"
    echo "                     Both Chrome and Safari use your Linode relay"
    echo "                     Future: will race multiple Linode servers"
    echo ""
    echo "  cloudflare-hybrid - CloudFlare + Linode bridge"
    echo "                      Chrome → CloudFlare (WebTransport)"
    echo "                      Safari → Linode (WebSocket)"
    echo "                      Requires cloudflare-adapter running on Linode"
    echo ""
    echo "Options:"
    echo "  --deploy         - Also deploy to Cloudflare Workers after switching"
    echo ""
    echo "Current setting:"
    grep "const RELAY_MODE" src/main.ts | head -1
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Switching relay mode to: $MODE"

# Update RELAY_MODE in src/main.ts
# First, replace any of the three possible values with the new one
sed -i '' 's/const RELAY_MODE: "luke" | "linode" | "cloudflare-hybrid" = "luke"/const RELAY_MODE: "luke" | "linode" | "cloudflare-hybrid" = "'$MODE'"/' src/main.ts
sed -i '' 's/const RELAY_MODE: "luke" | "linode" | "cloudflare-hybrid" = "linode"/const RELAY_MODE: "luke" | "linode" | "cloudflare-hybrid" = "'$MODE'"/' src/main.ts
sed -i '' 's/const RELAY_MODE: "luke" | "linode" | "cloudflare-hybrid" = "cloudflare-hybrid"/const RELAY_MODE: "luke" | "linode" | "cloudflare-hybrid" = "'$MODE'"/' src/main.ts

echo "  Updated src/main.ts -> $MODE"

# Show what this mode does
echo ""
case $MODE in
  luke)
    echo "  Chrome: cdn.moq.dev/anon (WebTransport)"
    echo "  Safari: cdn.moq.dev/anon (WebSocket - native fallback)"
    echo "  Bridge: Not required"
    ;;
  linode)
    echo "  Chrome: us-central.earthseed.live/anon (WebTransport)"
    echo "  Safari: us-central.earthseed.live/anon (WebSocket)"
    echo "  Bridge: Not required"
    ;;
  cloudflare-hybrid)
    echo "  Chrome: relay-next.cloudflare.mediaoverquic.com (WebTransport)"
    echo "  Safari: us-central.earthseed.live/anon (WebSocket)"
    echo "  Bridge: REQUIRED - cloudflare-adapter must be running on Linode"
    ;;
esac

# Deploy if requested
if [ "$DEPLOY" = "--deploy" ]; then
    echo ""
    echo "Deploying to Cloudflare Workers..."
    npm run deploy
    echo ""
    echo "Deployed! Relay mode is now: $MODE"
else
    echo ""
    echo "Relay mode switched to: $MODE"
    echo "Run 'npm run deploy' to deploy, or use './switch-relay.sh $MODE --deploy'"
fi
