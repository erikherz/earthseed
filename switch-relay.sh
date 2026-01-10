#!/bin/bash
# Switch between Luke's relay and Cloudflare relay
# Usage: ./switch-relay.sh [luke|cloudflare] [--deploy]

set -e

RELAY=${1:-}
DEPLOY=${2:-}

if [ -z "$RELAY" ] || { [ "$RELAY" != "luke" ] && [ "$RELAY" != "cloudflare" ]; }; then
    echo "Usage: ./switch-relay.sh [luke|cloudflare] [--deploy]"
    echo ""
    echo "Options:"
    echo "  luke       - Use Luke's relay (cdn.moq.dev/anon) with WebSocket fallback"
    echo "  cloudflare - Use Cloudflare relay (relay-next.cloudflare-moq.com) WebTransport only"
    echo "  --deploy   - Also deploy to Cloudflare Workers after switching"
    echo ""
    echo "Current setting:"
    grep "const RELAY_SERVER" src/main.ts | head -1
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Switching relay to: $RELAY"

# 1. Update RELAY_SERVER in src/main.ts
if [ "$RELAY" = "luke" ]; then
    sed -i '' 's/const RELAY_SERVER: "luke" | "cloudflare" = "cloudflare"/const RELAY_SERVER: "luke" | "cloudflare" = "luke"/' src/main.ts
    echo "  Updated src/main.ts -> luke"
else
    sed -i '' 's/const RELAY_SERVER: "luke" | "cloudflare" = "luke"/const RELAY_SERVER: "luke" | "cloudflare" = "cloudflare"/' src/main.ts
    echo "  Updated src/main.ts -> cloudflare"
fi

# 2. Copy the appropriate patch file
PATCH_FILE="patches/@kixelated+moq+0.9.4.patch"
cp "${PATCH_FILE}.${RELAY}" "$PATCH_FILE"
echo "  Copied patch file for $RELAY"

# 3. Remove node_modules/@kixelated/moq to force patch reapplication
rm -rf node_modules/@kixelated/moq
echo "  Cleared @kixelated/moq for fresh patch"

# 4. Run npm install to apply patch
echo "  Running npm install..."
npm install

# 5. Deploy if requested
if [ "$DEPLOY" = "--deploy" ]; then
    echo "  Deploying to Cloudflare Workers..."
    npm run deploy
    echo ""
    echo "Deployed! Relay is now: $RELAY"
else
    echo ""
    echo "Relay switched to: $RELAY"
    echo "Run 'npm run deploy' to deploy, or use './switch-relay.sh $RELAY --deploy'"
fi
