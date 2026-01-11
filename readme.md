# Earthseed.Live

MoQ (Media over QUIC) streaming application supporting multiple relay servers.

## Architecture

- **Frontend**: Vite + [@moq/hang](https://github.com/moq-dev/moq/tree/main/js/hang) + [@moq/hang-ui](https://github.com/moq-dev/moq/tree/main/js/hang-ui) web components
- **Transport**: [@moq/lite](https://github.com/moq-dev/moq/tree/main/js/lite) (handles both relay protocols natively)
- **Relays**:
  - Cloudflare (`relay-next.cloudflare.mediaoverquic.com`) - IETF MoQ draft-14
  - Luke's relay (`cdn.moq.dev/anon`) - moq-lite protocol
- **Hosting**: Cloudflare Workers (static assets only)

```
┌─────────────┐         ┌──────────────────────────────┐         ┌─────────────┐
│   Browser   │ ──────▶ │  Cloudflare or Luke's Relay  │ ◀────── │   Browser   │
│ (Publisher) │  QUIC   │  (configurable)              │  QUIC   │ (Watcher)   │
│             │         │                              │         │             │
│ hang-publish│         └──────────────────────────────┘         │ hang-watch  │
└─────────────┘                                                  └─────────────┘
       │                                                                │
       └──── Static HTML/JS served from earthseed.live (CF Workers) ───┘
```

## Requirements

- **Browser**: Chrome 97+, Edge 97+, Firefox 114+, or Safari 17+ (see Safari Support below)
- **Node.js**: 20+

## Safari Support

Safari lacks full WebTransport support, so earthseed.live includes a WebSocket polyfill that transparently falls back to WebSocket-enabled relay servers.

### Architecture

```
┌─────────────┐         ┌──────────────────────────────┐         ┌──────────────────────────────┐
│   Safari    │ ──────▶ │  Linode Relay Server         │ ──────▶ │  relay.cloudflare.           │
│   Browser   │WebSocket│  (moq-relay + WebSocket)     │  QUIC   │  mediaoverquic.com           │
│             │         │                              │         │  (Cloudflare MoQ Relay)      │
└─────────────┘         └──────────────────────────────┘         └──────────────────────────────┘
```

### How It Works

1. **Detection**: The frontend detects Safari and loads the WebSocket polyfill (`webtransport-polyfill.ts`)
2. **Relay Selection**: A latency race selects the fastest Linode relay server:
   - `us-central.earthseed.live` (Dallas)
   - `eu-central.earthseed.live` (Frankfurt)
   - `ap-south.earthseed.live` (Singapore)
3. **WebSocket Connection**: Safari connects to the Linode relay via WebSocket
4. **Stream Proxy**: The relay uses the announce hostname to fetch streams from Cloudflare's relay over QUIC

### Linode Relay Servers

Each Linode server runs a patched version of [moq-relay](https://github.com/kixelated/moq-rs) with:
- WebSocket support from the `@kixelated/hang` library
- A patch that announces to and fetches from Cloudflare's relay (`relay-next.cloudflare.mediaoverquic.com`)
- This allows Safari users to watch streams published by Chrome/Firefox users via the native Cloudflare relay

## Development

```bash
npm install
npm run dev      # Start Vite dev server on localhost:3000
```

## Deploy

```bash
npm run deploy   # Build and deploy to Cloudflare
```

## Switching Relays

The app supports two MoQ relay servers. Use the switch script to change between them:

```bash
# Switch to Luke's relay (cdn.moq.dev/anon)
./switch-relay.sh luke

# Switch to Cloudflare's relay (relay-next.cloudflare.mediaoverquic.com)
./switch-relay.sh cloudflare

# Switch and deploy in one command
./switch-relay.sh luke --deploy
./switch-relay.sh cloudflare --deploy

# Check current relay setting
./switch-relay.sh
```

Both relays work with the `@moq/lite` transport - no protocol patches needed.

## Usage

### Stream-Based Sessions

Each session uses a unique 5-character stream ID for isolation:

- **Visit `earthseed.live`** → Auto-generates a stream (e.g., `https://earthseed.live/ab3x9`)
- **Share the URL** → Others open the same URL to watch
- **Click "+ New Stream"** → Creates a fresh stream

### Broadcasting

1. Open https://earthseed.live in Chrome
2. A unique 5-character stream ID is generated automatically
3. Click "Start" in the Broadcast section
4. Allow camera and microphone access
5. Share the URL with viewers (e.g., `https://earthseed.live/ab3x9`)

### Watching

1. Open the shared URL (e.g., `https://earthseed.live/ab3x9`)
2. The stream begins playing automatically
3. Click play if needed

### Stream Namespace

Streams use the format: `earthseed.live/{streamId}`

Each 5-character stream ID maps to a unique namespace on the Cloudflare relay, preventing conflicts between sessions.

## Interoperability

This project uses Luke Curley's ([@kixelated](https://github.com/kixelated)) latest packages:

| Package | Purpose |
|---------|---------|
| `@moq/lite` | Transport layer - handles both relay protocols natively |
| `@moq/hang` | Media components (publish/watch) |
| `@moq/hang-ui` | UI controls overlay |

The `@moq/lite` transport automatically handles protocol differences between:
- **Cloudflare's relay**: IETF MoQ Transport draft-14 (`0xff00000e`)
- **Luke's relay**: moq-lite protocol (`0xff0dad01`)

See [patches.md](./patches.md) for details on build workarounds required for the `@moq/hang` packages.

## Links

- [Live Site](https://earthseed.live)
- [moq-dev/moq](https://github.com/moq-dev/moq) - @moq/hang, @moq/hang-ui, @moq/lite packages
- [Cloudflare MoQ Docs](https://developers.cloudflare.com/moq/)
- [MoQ Protocol](https://moq.dev/)
