# Cloudflare MoQ Relay Compatibility

This document describes the protocol changes required to make the `@kixelated/moq` library work with Cloudflare's draft-14 MoQ relay (`relay-next.cloudflare.mediaoverquic.com`) instead of Luke's relay (`cdn.moq.dev/anon`).

## Background

The `@kixelated/moq` library was designed for "moq-lite" protocol. Cloudflare's relay implements the IETF MoQ Transport draft-14 specification, which has several differences.

**Reference**: [cloudflare/moq-rs](https://github.com/cloudflare/moq-rs) - Rust implementation targeting draft-14

## Protocol Differences

### 1. Setup Message Types

| Message | moq-lite | draft-14 |
|---------|----------|----------|
| CLIENT_SETUP | varies | `0x20` |
| SERVER_SETUP | varies | `0x21` |

These message type values are used for drafts 11+.

**Source**: `moq-rs/moq-transport/src/setup/client.rs` and `server.rs`

### 2. Message Length Encoding

| Protocol | Length Encoding |
|----------|-----------------|
| moq-lite | varint |
| draft-14 | **u16** (16-bit big-endian) |

moq-rs encodes message body length as a fixed 2-byte u16, not a variable-length integer. Maximum message size is 65,535 bytes.

**Source**: `moq-rs/moq-transport/src/setup/server.rs` - `encode()` function

### 3. Version Number

```
DRAFT_14 = 0xff00000e
```

The version is sent as a varint in CLIENT_SETUP and returned in SERVER_SETUP.

### 4. Parameter Encoding (KeyValuePairs)

This is a critical difference. moq-rs uses **key parity** to determine value type:

| Key Parity | Value Type | Encoding |
|------------|------------|----------|
| **Even** (0, 2, 4...) | IntValue | `key (varint) + value (varint)` |
| **Odd** (1, 3, 5...) | BytesValue | `key (varint) + length (varint) + bytes` |

The `@kixelated/moq` library assumed ALL parameters are bytes with a length prefix, which caused decode failures when the server sent integer parameters (like `MAX_REQUEST_ID = 2`).

**Source**: `moq-rs/moq-transport/src/coding/kvp.rs`

**Example**: Server sends param id=2 (even) with value=100
- moq-rs sends: `[0x02] [0x64]` (key=2, intValue=100)
- Library expected: `[0x02] [length] [bytes...]`

### 5. Parameters Sent by Server

Observed in SERVER_SETUP:
- `id=2` (MAX_REQUEST_ID): IntValue = 100

## Files Modified

### `src/patched-moq/connect.js`
- Changed message type to `0x20` for CLIENT_SETUP
- Expects `0x21` for SERVER_SETUP
- Uses DRAFT_14 version (0xff00000e)

### `src/patched-moq/message.js`
- Changed length encoding from varint to u16
- `encode()`: writes 2-byte length prefix
- `decode()`: reads 2-byte length prefix

### `src/patched-moq/setup.js`
- Fixed parameter decoding to handle key parity:
  - Even keys: read value as varint (IntValue)
  - Odd keys: read length + bytes (BytesValue)

### `vite.config.ts`
- Custom Vite plugin to intercept and redirect module imports
- Redirects `./connect.js`, `./message.js`, `./setup.js` to patched versions

## Current Status

**Working**:
- WebTransport connection
- CLIENT_SETUP send (0x20 with draft-14 version)
- SERVER_SETUP receive and decode (0x21 with u16 length and int params)
- Handshake completes successfully

**Not Working**:
- ANNOUNCE and subsequent control messages
- Server responds with STOP_SENDING
- Control message framing likely needs similar u16 length fixes

## Next Steps

1. Investigate ANNOUNCE message format differences
2. Apply u16 length encoding to all control messages
3. Check for other message type/format differences in the control stream

## Testing

Deploy to Cloudflare Pages and test with:
```
https://earthseed.live/broadcast
```

Console should show:
```
[MOQ SETUP] ServerSetup.#decode: version = 0xff00000e
[MOQ SETUP] ServerSetup.#decode: numParams = 1
[MOQ SETUP] param id = 2n
[MOQ SETUP] param intValue = 100
[MOQ SETUP] ServerSetup.#decode: complete
[MOQ MESSAGE] decode: success
```
