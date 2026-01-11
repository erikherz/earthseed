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
    echo "  luke       - Use Luke's relay (cdn.moq.dev/anon)"
    echo "  cloudflare - Use Cloudflare relay (relay-next.cloudflare.mediaoverquic.com)"
    echo "  --deploy   - Also deploy to Cloudflare Workers after switching"
    echo ""
    echo "Current setting:"
    grep "const RELAY_SERVER" src/main.ts | head -1
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Switching relay to: $RELAY"

# Update RELAY_SERVER in src/main.ts
if [ "$RELAY" = "luke" ]; then
    sed -i '' 's/const RELAY_SERVER: "luke" | "cloudflare" = "cloudflare"/const RELAY_SERVER: "luke" | "cloudflare" = "luke"/' src/main.ts
    echo "  Updated src/main.ts -> luke"
else
    sed -i '' 's/const RELAY_SERVER: "luke" | "cloudflare" = "luke"/const RELAY_SERVER: "luke" | "cloudflare" = "cloudflare"/' src/main.ts
    echo "  Updated src/main.ts -> cloudflare"
fi

# Deploy if requested
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
