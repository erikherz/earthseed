# MoQ Library Patches

This document lists all deviations from the `@kixelated/moq` library required to support different relay servers.

## Luke's Relay (`cdn.moq.dev/anon`)

**Protocol**: moq-lite (version `0xff0dad01`)

### Patches Required: None

The `@kixelated/moq` library works out-of-the-box with Luke's relay. The library was designed for this server.

### Configuration Notes

- **URL format**: Namespace is included in the URL path
  ```
  https://cdn.moq.dev/anon/earthseed.live/streamId
  ```
- **Version negotiation**: Server accepts both `LITE_01` and `DRAFT_14`, returns `LITE_01`
- **WebSocket fallback**: Supported via polyfill for Safari

---

## Cloudflare's Relay (`relay-next.cloudflare.mediaoverquic.com`)

**Protocol**: moq-ietf draft-14 (version `0xff00000e`)

**Implementation**: [cloudflare/moq-rs](https://github.com/cloudflare/moq-rs)

### Patches Required: 6

---

### 1. Setup Message Length Encoding

**File**: `src/patched-moq/connect.js`

**Issue**: Cloudflare uses u16 (16-bit big-endian) for setup message lengths, not varint.

**Library behavior**:
```javascript
// Uses varint for message length
await writer.u53(messageLength);
```

**Patch**:
```javascript
// Use u16 for Cloudflare
await writer.u16(messageLength);
```

---

### 2. Setup Parameter Encoding (Key Parity)

**File**: `src/patched-moq/connect.js`

**Issue**: Cloudflare uses key parity to determine parameter value type.

| Key Parity | Value Type | Encoding |
|------------|------------|----------|
| Even (0, 2, 4...) | Integer | `key (varint) + value (varint)` |
| Odd (1, 3, 5...) | Bytes | `key (varint) + length (varint) + bytes` |

**Library behavior**: Assumes all parameters are bytes with length prefix.

**Patch**:
```javascript
// Check key parity for value type
if (paramId % 2n === 0n) {
    // Even key = integer value (no length prefix)
    const intValue = await reader.u53();
} else {
    // Odd key = bytes value (with length prefix)
    const length = await reader.u53();
    const bytes = await reader.read(length);
}
```

---

### 3. MaxRequestId Control Message

**File**: `src/patched-moq/connection.js`

**Issue**: moq-rs doesn't support `MAX_REQUEST_ID` (0x15) as a control message. It uses setup parameter `id=2` instead.

**Library behavior**: Sends MaxRequestId message after handshake.

**Patch**:
```javascript
// Skip MaxRequestId for Cloudflare
console.log("[MOQ CF] Skipping MaxRequestId message (not supported by moq-rs)");
// Don't send: await this.#control.write(new MaxRequestId(...));
```

---

### 4. Subscribe Filter Types

**File**: `src/patched-moq/subscribe.js`

**Issue**: Cloudflare sends filter type 2 (LatestObject), but library only accepts type 1 (LatestGroup).

| Filter Type | Name | Support |
|-------------|------|---------|
| 0x01 | LatestGroup | Library + Cloudflare |
| 0x02 | LatestObject | Cloudflare only |

**Library behavior**:
```javascript
if (filterType !== 0x01) {
    throw new Error(`unsupported filter type: ${filterType}`);
}
```

**Patch**:
```javascript
// Accept both filter types
if (filterType !== 0x01 && filterType !== 0x02) {
    throw new Error(`unsupported filter type: ${filterType}`);
}
```

---

### 5. URL vs Namespace Separation

**File**: `src/main.ts`

**Issue**: Cloudflare expects namespace only in `PUBLISH_NAMESPACE` message, not in the WebTransport URL.

**Library behavior**: Namespace appended to URL path.

**Luke's relay**:
```
URL: https://cdn.moq.dev/anon/earthseed.live/streamId
PUBLISH_NAMESPACE: earthseed.live/streamId
```

**Cloudflare relay** (patched):
```
URL: https://relay-next.cloudflare.mediaoverquic.com/
PUBLISH_NAMESPACE: earthseed.live/streamId
```

**Patch**:
```javascript
function getRelayConfig(streamId) {
    if (RELAY_SERVER === "cloudflare") {
        return {
            url: RELAY_URL,  // No namespace in URL
            name: `${NAMESPACE_PREFIX}/${streamId}`,
        };
    }
    // Luke: namespace in URL
    return {
        url: `${RELAY_URL}/${NAMESPACE_PREFIX}/${streamId}`,
        name: `${NAMESPACE_PREFIX}/${streamId}`,
    };
}
```

---

### 6. Object Stream Subgroup ID

**File**: `src/patched-moq/object.js`

**Issue**: For `OBJECT_WITH_SUBGROUP_OBJECT` streams (id 0x14-0x17), Cloudflare always includes Subgroup ID in the GROUP header, even when the `hasSubgroup` bit (0x02) is not set.

**Library behavior**:
```javascript
// Only reads Subgroup ID when hasSubgroup bit is set
if (flags.hasSubgroup) {
    const subgroupId = await r.u53();
}
```

**Patch**:
```javascript
// Read Subgroup ID when EITHER bit is set
if (flags.hasSubgroup || flags.hasSubgroupObject) {
    const subgroupId = await r.u53();
}
```

**Explanation**: The `hasSubgroupObject` bit (0x04) changes the object format to use Subgroup Object IDs, and this format always requires a Subgroup ID in the GROUP header to identify which subgroup the objects belong to.

---

## Patched Files Summary

| File | Purpose |
|------|---------|
| `src/patched-moq/connect.js` | Dual relay handshake (patches 1, 2) |
| `src/patched-moq/connection.js` | Skip MaxRequestId (patch 3) |
| `src/patched-moq/control.js` | Import patched Subscribe class |
| `src/patched-moq/subscribe.js` | Accept filter types 1 and 2 (patch 4) |
| `src/patched-moq/subscriber.js` | Use patched object.js |
| `src/patched-moq/object.js` | Subgroup ID parsing (patch 6) |
| `src/main.ts` | URL/namespace config (patch 5) |
| `vite.config.ts` | Redirect imports to patched files |

---

## Testing

Set `RELAY_SERVER` in `src/main.ts`:

```typescript
const RELAY_SERVER: "luke" | "cloudflare" = "luke";  // or "cloudflare"
```

**Luke's relay** (no patches active for protocol):
```
[MOQ] Luke relay - moq-lite session established
```

**Cloudflare relay** (all patches active):
```
[MOQ] Cloudflare relay - moq-ietf/draft-14 session established
```
