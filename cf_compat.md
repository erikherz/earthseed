# Cloudflare MoQ Relay Compatibility

This document describes the protocol differences between Luke's relay (`cdn.moq.dev/anon`) and Cloudflare's draft-14 relay (`relay-next.cloudflare.mediaoverquic.com`), and how we handle both.

## Background

The `@kixelated/moq` library supports both:
- **moq-lite** (LITE_01 = 0xff0d0101) - Luke's relay
- **moq-ietf** (DRAFT_14 = 0xff00000e) - Cloudflare's relay

The library negotiates the version during handshake, but Cloudflare's implementation has additional encoding differences that require special handling.

**Reference**: [cloudflare/moq-rs](https://github.com/cloudflare/moq-rs) - Rust implementation targeting draft-14

## Architecture

The patched `connect.js` auto-detects the relay type from the URL and uses the appropriate handshake:

```javascript
function isCloudflareRelay(url) {
    return url.toString().toLowerCase().includes("cloudflare");
}
```

- **Luke's relay**: `lukeHandshake()` - sends both versions, uses original library decode
- **Cloudflare**: `cloudflareHandshake()` - sends DRAFT_14 only, uses custom decode

## Protocol Differences

### 1. Setup Message Types

Both use the same message types (drafts 11+):

| Message | Type |
|---------|------|
| CLIENT_SETUP | `0x20` |
| SERVER_SETUP | `0x21` |

### 2. Message Length Encoding (Setup Messages)

| Relay | Length Encoding |
|-------|-----------------|
| Luke (moq-lite) | varint via `u53()` |
| Cloudflare (draft-14) | **u16** (16-bit big-endian) |

**Note**: The library's `ietf/message.js` already uses u16, but Luke's server returns LITE_01 version which uses `lite/message.js` with varint encoding.

### 3. Version Negotiation

| Relay | Versions Sent | Version Returned |
|-------|---------------|------------------|
| Luke | `[LITE_01, DRAFT_14]` | LITE_01 (0xff0d0101) |
| Cloudflare | `[DRAFT_14]` | DRAFT_14 (0xff00000e) |

### 4. Parameter Encoding (KeyValuePairs)

**Critical difference** - Cloudflare uses **key parity** to determine value type:

| Key Parity | Value Type | Encoding |
|------------|------------|----------|
| **Even** (0, 2, 4...) | IntValue | `key (varint) + value (varint)` |
| **Odd** (1, 3, 5...) | BytesValue | `key (varint) + length (varint) + bytes` |

Luke's relay (and the library) assumes ALL parameters are bytes with length prefix.

**Source**: `moq-rs/moq-transport/src/coding/kvp.rs`

**Example**: Cloudflare sends param id=2 (MAX_REQUEST_ID) with value=100
- Cloudflare sends: `[0x02] [0x64]` (key=2, intValue=100 as varint)
- Library expected: `[0x02] [length] [bytes...]`

### 5. Parameters Observed

**Cloudflare SERVER_SETUP**:
- `id=2` (MAX_REQUEST_ID): IntValue = 100

**Luke CLIENT_SETUP** (what we send):
- `id=2`: bytes `[63]` (MAX_REQUEST_ID as byte)
- `id=5`: bytes `"earthseed"` (implementation name)

## Files Modified

### `src/patched-moq/connect.js`
Main patched file with dual relay support:
- `isCloudflareRelay(url)` - detects relay type from URL
- `lukeHandshake()` - original library behavior for Luke's relay
- `cloudflareHandshake()` - custom handshake for Cloudflare
- `encodeClientSetupCF()` - u16 length encoding for CLIENT_SETUP
- `decodeServerSetupCF()` - u16 length + int-param handling for SERVER_SETUP

### `vite.config.ts`
Custom Vite plugin to intercept module imports:
- Redirects `./connect.js` and `./connection/index.js` to patched versions
- Resolves relative imports from patched files back to moq package

### `src/main.ts`
Configuration toggle:
```typescript
const RELAY_SERVER: "luke" | "cloudflare" = "cloudflare";
```

## Current Status

**Working**:
- ✅ Luke's relay (moq-lite) - full functionality
- ✅ Cloudflare handshake (CLIENT_SETUP/SERVER_SETUP)
- ✅ Version negotiation
- ✅ Parameter decoding with int/bytes handling

**Testing (Cloudflare)**:
- ⏳ PUBLISH_NAMESPACE flow - needs testing after URL fix

### URL vs Namespace Fix

**Root cause of STOP_SENDING**: The namespace was being sent in BOTH the WebTransport URL AND the PUBLISH_NAMESPACE message.

**Reference from moq-pub**: In `moq-rs/moq-pub/src/main.rs`, URL and namespace are separate:
```rust
pub url: Url,    // Just the relay server
pub name: String, // Broadcast namespace for PUBLISH_NAMESPACE
```

**Fix applied**: `getRelayConfig()` now returns just the relay URL for both relays:
```javascript
return {
  url: RELAY_URL,      // "https://relay-next.cloudflare.mediaoverquic.com"
  name: streamName,    // "earthseed.live/streamId" → goes in PUBLISH_NAMESPACE
};
```

## Next Steps

1. Test PUBLISH_NAMESPACE with Cloudflare relay
2. Debug any remaining control message issues

## Testing

Set `RELAY_SERVER` in `src/main.ts` and deploy:

**Luke's relay**:
```
[MOQ] connect() URL: https://cdn.moq.dev/anon/... isCloudflare: false
[MOQ] Luke relay handshake - sending CLIENT_SETUP with both versions
[MOQ] Luke relay - server version: 0xff0d0101
[MOQ] Luke relay - moq-lite session established
```

**Cloudflare relay**:
```
[MOQ] connect() URL: https://relay-next.cloudflare... isCloudflare: true
[MOQ] Cloudflare relay handshake - sending CLIENT_SETUP with DRAFT_14 only
[MOQ CF] ServerSetup version: 0xff00000e
[MOQ CF] param id=2n intValue=100
[MOQ] Cloudflare relay - moq-ietf/draft-14 session established
```
