console.log("[Earthseed] Version: 2026-01-22-v2 (Canvas cover fix)");

// Safari WebSocket fallback - MUST install before hang components load
// Using our patched version that handles requireUnreliable gracefully
import { install as installWebTransportPolyfill } from "./webtransport-polyfill";
// WebCodecs polyfill for Opus audio encoding on Safari
import { install as installWebCodecsPolyfill } from "./webcodecs-polyfill";

// Relay configuration - toggle between relay modes:
// - "luke": Pure Luke's servers (cdn.moq.dev/anon) - both browsers use Luke's relay
//           Luke natively supports WebSocket fallback for Safari
// - "linode": Pure Linode servers (us-central.earthseed.live) - both browsers use Linode
//             Future: will race multiple Linode servers for lowest latency
// - "cloudflare-hybrid": CloudFlare for Chrome + Linode for Safari
//                        Requires cloudflare-adapter bridge running on Linode
const RELAY_MODE: "luke" | "linode" | "cloudflare-hybrid" = "linode";

// Detect Safari - even Safari 17+ with WebTransport has compatibility issues with some relays
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Check if we need the polyfill: either no WebTransport or Safari (which has issues)
const needsPolyfill = typeof WebTransport === "undefined" || isSafari;
if (needsPolyfill) {
  const reason = typeof WebTransport === "undefined"
    ? "WebTransport not supported"
    : "Safari detected (using WebSocket for better compatibility)";
  console.log(`${reason}, installing WebSocket polyfill`);
  // Install polyfill - use force=true for Safari since it has native WebTransport
  // but with compatibility issues that require using WebSocket instead
  installWebTransportPolyfill(isSafari);
}

// Safari audio track fix - Safari doesn't return channelCount in getSettings()
// which causes the hang library to fail with "expected number" error
if (isSafari) {
  const originalGetSettings = MediaStreamTrack.prototype.getSettings;
  MediaStreamTrack.prototype.getSettings = function () {
    const settings = originalGetSettings.call(this);
    // Add default channelCount for audio tracks if missing
    if (this.kind === "audio" && settings.channelCount === undefined) {
      settings.channelCount = 1; // Mono default, Safari typically captures mono
    }
    return settings;
  };
  console.log("Safari: Patched MediaStreamTrack.getSettings for channelCount");
}

// Theme toggle functionality
function initTheme() {
  const savedTheme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  // Use saved theme, or system preference, default to dark
  if (savedTheme === "light" || (!savedTheme && !prefersDark)) {
    document.documentElement.classList.add("light");
  }

  // Set up toggle button when DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => {
        document.documentElement.classList.toggle("light");
        const isLight = document.documentElement.classList.contains("light");
        localStorage.setItem("theme", isLight ? "light" : "dark");
      });
    }
  });
}
initTheme();

// Flip device button appearance: selected=dim, available=bright
// The hang component sets inline opacity (selected=1, unselected=0.5)
// We invert this by adding CSS classes based on the opacity value
function initDeviceButtonFlipper() {
  document.addEventListener("DOMContentLoaded", () => {
    // Add CSS to invert the visual appearance
    const style = document.createElement("style");
    style.textContent = `
      /* Hide the Microphone toggle button (keep audio-only-btn) */
      hang-publish button[title="Microphone"] { display: none !important; }

      /* Reorder buttons: Audio, Video, Screen, None */
      hang-publish button.audio-only-btn { order: 1 !important; }
      hang-publish button[title="Camera"] { order: 2 !important; }
      hang-publish button[title="Screen"] { order: 3 !important; }
      hang-publish button[title="Nothing"] { order: 4 !important; }

      /* Replace camera emoji with video camera emoji */
      hang-publish button[title="Camera"] {
        font-size: 0 !important;
      }
      hang-publish button[title="Camera"]::after {
        content: "📹";
        font-size: 1.25rem;
      }

      /* Selected device = dim (already chosen, de-emphasized) */
      hang-publish button[title].device-selected {
        filter: grayscale(50%) brightness(0.7) !important;
        opacity: 1 !important;
      }
      /* Available device = bright with glow (click me!) */
      hang-publish button[title].device-available {
        filter: brightness(1.1) !important;
        opacity: 1 !important;
        box-shadow: 0 0 8px rgba(59, 130, 246, 0.5);
      }

      /* Status indicator: move to left of device buttons, show only ball */
      hang-publish > div {
        flex-wrap: nowrap !important;
      }
      hang-publish > div > div:first-child {
        order: 1 !important;
        display: flex !important;
        align-items: center !important;
      }
      hang-publish > div > div:last-child {
        order: 0 !important;
        position: relative;
        cursor: default;
      }
      /* Status indicator tooltip styling */
      hang-publish > div > div:last-child.status-indicator-styled {
        font-size: 1.25rem;
        line-height: 1;
      }
      hang-publish > div > div:last-child.status-indicator-styled::after {
        content: attr(data-status-text);
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.75rem;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease;
        margin-bottom: 4px;
      }
      hang-publish > div > div:last-child.status-indicator-styled:hover::after {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);

    const updateButtonClasses = () => {
      const hangPublish = document.querySelector("hang-publish");
      if (!hangPublish) return;

      const buttons = hangPublish.querySelectorAll('button[title]');
      buttons.forEach((btn) => {
        const button = btn as HTMLButtonElement;
        const opacity = parseFloat(button.style.opacity);

        // hang sets opacity: 1 = selected/active, 0.5 = available
        // User wants INVERTED: selected = dim, available = bright
        if (opacity >= 0.9 || isNaN(opacity)) {
          // hang's selected (opacity 1) → make it DIM
          button.classList.remove("device-available");
          button.classList.add("device-selected");
        } else {
          // hang's available (opacity 0.5) → make it BRIGHT
          button.classList.remove("device-selected");
          button.classList.add("device-available");
        }
      });

      // Style the status indicator: show only emoji, text as hover tooltip
      const controlsContainer = hangPublish.querySelector(":scope > div");
      if (controlsContainer) {
        const statusDiv = controlsContainer.querySelector(":scope > div:last-child") as HTMLElement;
        if (statusDiv && statusDiv.textContent) {
          const fullText = statusDiv.textContent.trim();
          // Only process if there's text after the emoji (not already processed)
          // Check if it has more than just an emoji (emojis are ~2 chars in length)
          if (fullText.length > 2) {
            // Extract emoji (first character or emoji sequence) and text
            const emojiMatch = fullText.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}])/u);
            if (emojiMatch) {
              const emoji = emojiMatch[1];
              const text = fullText.slice(emoji.length).replace(/^\s+/, ''); // Remove leading space/nbsp
              if (text) {
                statusDiv.textContent = emoji;
                statusDiv.setAttribute("data-status-text", text);
                statusDiv.classList.add("status-indicator-styled");
              }
            }
          }
        }
      }
    };

    // Use MutationObserver to watch for style changes on buttons
    const setupObserver = () => {
      const hangPublish = document.querySelector("hang-publish");
      if (!hangPublish) {
        setTimeout(setupObserver, 100);
        return;
      }

      const observer = new MutationObserver(() => {
        updateButtonClasses();
      });

      observer.observe(hangPublish, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
        childList: true,
        characterData: true,
      });

      // Initial update after component renders
      setTimeout(updateButtonClasses, 100);
      setTimeout(updateButtonClasses, 300);
      setTimeout(updateButtonClasses, 500);
    };

    setupObserver();
  });
}
initDeviceButtonFlipper();

// Linode relay servers for racing (used in linode mode)
const LINODE_RELAYS = [
  "us-central.earthseed.live",
  "eu-central.earthseed.live",
  "ap-south.earthseed.live",
];

// Server status tracking
interface RelayResult {
  domain: string;
  latency: number | null; // null if failed
  error?: string;
}

interface ServerStatus {
  mode: "websocket" | "webtransport";
  selectedServer: string;
  connected: boolean;
  raceResults: RelayResult[];
}

const serverStatus: ServerStatus = {
  mode: needsPolyfill ? "websocket" : "webtransport",
  selectedServer: (() => {
    switch (RELAY_MODE) {
      case "luke": return "cdn.moq.dev/anon";
      case "linode": return "us-central.earthseed.live/anon";
      case "cloudflare-hybrid": return isSafari ? "us-central.earthseed.live/anon" : "relay-next.cloudflare.mediaoverquic.com";
    }
  })(),
  connected: false,
  raceResults: [],
};

// Browser support tracking
interface CodecSupport {
  software: boolean;
  hardware?: boolean; // undefined means unknown (Firefox)
}

interface BrowserSupport {
  browser: string;
  isFirefox: boolean;
  isSafari: boolean;
  supported: boolean;
  features: {
    webTransport: boolean;
    mediaDevices: boolean;
    audio: {
      capture: boolean;
      render: boolean;
      encoding?: { aac: boolean; opus: boolean };
      decoding?: { aac: boolean; opus: boolean };
    };
    video: {
      capture: "full" | "partial" | "none";
      render: boolean;
      encoding?: { h264: CodecSupport; h265: CodecSupport; vp8: CodecSupport; vp9: CodecSupport; av1: CodecSupport };
      decoding?: { h264: CodecSupport; h265: CodecSupport; vp8: CodecSupport; vp9: CodecSupport; av1: CodecSupport };
    };
  };
}

const CODECS: Record<string, string> = {
  aac: "mp4a.40.2",
  opus: "opus",
  av1: "av01.0.08M.08",
  h264: "avc1.640028",
  h265: "hev1.1.6.L93.B0",
  vp9: "vp09.00.10.08",
  vp8: "vp8",
};

async function checkAudioEncoder(codec: string): Promise<boolean> {
  try {
    const res = await AudioEncoder.isConfigSupported({
      codec: CODECS[codec],
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return res.supported === true;
  } catch { return false; }
}

async function checkAudioDecoder(codec: string): Promise<boolean> {
  try {
    const res = await AudioDecoder.isConfigSupported({
      codec: CODECS[codec],
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return res.supported === true;
  } catch { return false; }
}

async function checkVideoEncoder(codec: string, isFirefox: boolean): Promise<CodecSupport> {
  try {
    const software = await VideoEncoder.isConfigSupported({
      codec: CODECS[codec],
      width: 1280,
      height: 720,
      hardwareAcceleration: "prefer-software",
    });
    const hardware = await VideoEncoder.isConfigSupported({
      codec: CODECS[codec],
      width: 1280,
      height: 720,
      hardwareAcceleration: "prefer-hardware",
    });
    const unknownHw = isFirefox || hardware.config?.hardwareAcceleration !== "prefer-hardware";
    return {
      software: software.supported === true,
      hardware: unknownHw ? undefined : hardware.supported === true,
    };
  } catch { return { software: false }; }
}

async function checkVideoDecoder(codec: string, isFirefox: boolean): Promise<CodecSupport> {
  try {
    const software = await VideoDecoder.isConfigSupported({
      codec: CODECS[codec],
      hardwareAcceleration: "prefer-software",
    });
    const hardware = await VideoDecoder.isConfigSupported({
      codec: CODECS[codec],
      hardwareAcceleration: "prefer-hardware",
    });
    const unknownHw = isFirefox || hardware.config?.hardwareAcceleration !== "prefer-hardware";
    return {
      software: software.supported === true,
      hardware: unknownHw ? undefined : hardware.supported === true,
    };
  } catch { return { software: false }; }
}

async function detectBrowserSupport(): Promise<BrowserSupport> {
  // Detect browser - use consistent detection with global isSafari
  const ua = navigator.userAgent;
  let browser = "Unknown";
  const isFirefox = /firefox/i.test(ua);
  if (isFirefox) {
    browser = "Firefox";
  } else if (/edg/i.test(ua)) {
    browser = "Edge";
  } else if (/chrome/i.test(ua)) {
    browser = "Chrome";
  } else if (isSafari) {
    // Use global isSafari which has proper negative lookahead for Chrome/Android
    browser = "Safari";
  }

  const webTransport = typeof WebTransport !== "undefined";
  const mediaDevices = typeof navigator.mediaDevices?.getUserMedia === "function";

  // Audio features
  const audioCapture = typeof AudioWorkletNode !== "undefined";
  const audioRender = typeof AudioContext !== "undefined" && typeof AudioBufferSourceNode !== "undefined";

  let audioEncoding: { aac: boolean; opus: boolean } | undefined;
  let audioDecoding: { aac: boolean; opus: boolean } | undefined;

  if (typeof AudioEncoder !== "undefined") {
    audioEncoding = {
      aac: await checkAudioEncoder("aac"),
      opus: await checkAudioEncoder("opus"),
    };
  }
  if (typeof AudioDecoder !== "undefined") {
    audioDecoding = {
      aac: await checkAudioDecoder("aac"),
      opus: await checkAudioDecoder("opus"),
    };
  }

  // Video features
  // @ts-expect-error MediaStreamTrackProcessor not in all TS libs
  const hasMediaStreamTrackProcessor = typeof MediaStreamTrackProcessor !== "undefined";
  const hasOffscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const videoCapture: "full" | "partial" | "none" = hasMediaStreamTrackProcessor
    ? "full"
    : hasOffscreenCanvas
      ? "partial"
      : "none";
  const videoRender = hasOffscreenCanvas && typeof CanvasRenderingContext2D !== "undefined";

  let videoEncoding: BrowserSupport["features"]["video"]["encoding"];
  let videoDecoding: BrowserSupport["features"]["video"]["decoding"];

  if (typeof VideoEncoder !== "undefined") {
    videoEncoding = {
      h264: await checkVideoEncoder("h264", isFirefox),
      h265: await checkVideoEncoder("h265", isFirefox),
      vp8: await checkVideoEncoder("vp8", isFirefox),
      vp9: await checkVideoEncoder("vp9", isFirefox),
      av1: await checkVideoEncoder("av1", isFirefox),
    };
  }
  if (typeof VideoDecoder !== "undefined") {
    videoDecoding = {
      h264: await checkVideoDecoder("h264", isFirefox),
      h265: await checkVideoDecoder("h265", isFirefox),
      vp8: await checkVideoDecoder("vp8", isFirefox),
      vp9: await checkVideoDecoder("vp9", isFirefox),
      av1: await checkVideoDecoder("av1", isFirefox),
    };
  }

  // Supported if we have WebTransport OR Safari (which uses WebSocket fallback)
  const supported = webTransport || isSafari;

  return {
    browser,
    isFirefox,
    isSafari,
    supported,
    features: {
      webTransport,
      mediaDevices,
      audio: {
        capture: audioCapture,
        render: audioRender,
        encoding: audioEncoding,
        decoding: audioDecoding,
      },
      video: {
        capture: videoCapture,
        render: videoRender,
        encoding: videoEncoding,
        decoding: videoDecoding,
      },
    },
  };
}

let browserSupport: BrowserSupport;

// Update the browser support panel UI
function updateBrowserSupportPanel() {
  const supportPanel = document.getElementById("support-panel");
  if (!supportPanel || !browserSupport) return;

  // Determine overall status - "Partial" if using polyfill, "Full" if native WebTransport
  const isPartial = needsPolyfill;
  const statusClass = browserSupport.supported ? (isPartial ? "partial" : "connected") : "disconnected";
  const statusText = browserSupport.supported ? (isPartial ? "Partial Support" : "Full Support") : "Not Supported";

  // Build details HTML
  const green = '<span class="status-dot green"></span>';
  const red = '<span class="status-dot red"></span>';
  const yellow = '<span class="status-dot yellow"></span>';

  const bool = (v: boolean) => v ? `${green} Yes` : `${red} No`;

  // WebTransport status - show "Polyfill" if we're using the fallback
  const webTransportStatus = () => {
    if (needsPolyfill) {
      return `${yellow} Polyfill`;
    }
    return browserSupport.features.webTransport ? `${green} Full` : `${red} No`;
  };

  const captureStatus = (v: "full" | "partial" | "none") => {
    if (v === "full") return `${green} Full`;
    if (v === "partial") return `${yellow} Partial`;
    return `${red} No`;
  };

  const codecStatus = (c: CodecSupport | undefined, isFirefox: boolean) => {
    if (!c || (!c.software && !c.hardware)) return `${red} No`;
    if (c.hardware === true) return `${green} Hardware`;
    if (c.hardware === undefined && isFirefox) return `${yellow} Software*`;
    if (c.software) return `${yellow} Software`;
    return `${red} No`;
  };

  const audioCodecStatus = (supported: boolean | undefined) => {
    if (supported === undefined) return `${red} No`;
    return supported ? `${green} Yes` : `${red} No`;
  };

  const f = browserSupport.features;
  const isFirefox = browserSupport.isFirefox;

  // Note for polyfill or Firefox
  let footerNote = "";
  if (needsPolyfill) {
    footerNote = `<p class="support-note">Using WebSocket polyfill for Safari compatibility.</p>`;
  }
  if (isFirefox) {
    footerNote += `<p class="support-note">*Hardware acceleration is <a href="https://github.com/nickeltin/browser-support" target="_blank">undetectable</a> on Firefox.</p>`;
  }

  const detailsContent = `
    <table class="latency-results">
      <tbody>
        <tr><td><strong>WebTransport</strong></td><td>${webTransportStatus()}</td></tr>
        <tr><td><strong>Rendering</strong></td><td>Audio</td><td>${bool(f.audio.render)}</td></tr>
        <tr><td></td><td>Video</td><td>${bool(f.video.render)}</td></tr>
        <tr><td><strong>Decoding</strong></td><td>Opus</td><td>${f.audio.decoding ? audioCodecStatus(f.audio.decoding.opus) : `${red} No`}</td></tr>
        <tr><td></td><td>AAC</td><td>${f.audio.decoding ? audioCodecStatus(f.audio.decoding.aac) : `${red} No`}</td></tr>
        <tr><td></td><td>AV1</td><td>${f.video.decoding ? codecStatus(f.video.decoding.av1, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>H.265</td><td>${f.video.decoding ? codecStatus(f.video.decoding.h265, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>H.264</td><td>${f.video.decoding ? codecStatus(f.video.decoding.h264, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>VP9</td><td>${f.video.decoding ? codecStatus(f.video.decoding.vp9, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>VP8</td><td>${f.video.decoding ? codecStatus(f.video.decoding.vp8, isFirefox) : `${red} No`}</td></tr>
      </tbody>
    </table>
    ${footerNote}
  `;

  supportPanel.innerHTML = `
    <div class="server-status-summary">
      <span class="status-indicator ${statusClass}"></span>
      <span>${statusText}: ${browserSupport.browser}</span>
      <button class="details-btn" id="support-details-btn">Details</button>
    </div>
    <div class="server-details hidden" id="support-details-content">
      <div id="playback-settings-container" class="playback-settings"></div>
      ${detailsContent}
    </div>
  `;

  // Add details toggle handler
  document.getElementById("support-details-btn")?.addEventListener("click", () => {
    const details = document.getElementById("support-details-content");
    const btn = document.getElementById("support-details-btn");
    if (details && btn) {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      btn.textContent = isHidden ? "Hide" : "Details";
    }
  });
}

// Race requests to find the lowest-latency Linode relay server
async function selectBestLinodeRelay(): Promise<string> {
  const timeout = 5000; // 5 second timeout per server

  // Track all results for the status panel
  const results: RelayResult[] = LINODE_RELAYS.map(domain => ({
    domain,
    latency: null,
  }));

  // Create a promise for each server that resolves with result
  const racePromises = LINODE_RELAYS.map(async (domain, index) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const startTime = performance.now();

    try {
      // Earthseed relays use port 443 - just test connectivity (any response is fine)
      const response = await fetch(`https://${domain}/`, {
        signal: controller.signal,
        cache: "no-store",
        method: "HEAD", // Faster than GET
      });
      clearTimeout(timeoutId);

      // Any response means the server is reachable - we just care about latency
      const latency = performance.now() - startTime;
      results[index].latency = latency;
      console.log(`Relay ${domain} responded in ${latency.toFixed(0)}ms (HTTP ${response.status})`);
      return { domain, latency };
    } catch (error) {
      clearTimeout(timeoutId);
      if (!results[index].error) {
        results[index].error = error instanceof Error ? error.message : "Failed";
      }
      console.warn(`Relay ${domain} failed:`, error);
      throw error;
    }
  });

  // Wait a bit for all results to come in (for display purposes)
  // but use Promise.any to select the winner quickly
  const winnerPromise = Promise.any(racePromises);

  // Also wait for all to settle (with a shorter timeout for UI)
  const allSettledPromise = Promise.allSettled(racePromises);

  try {
    const winner = await winnerPromise;
    console.log(`Selected relay: ${winner.domain} (${winner.latency.toFixed(0)}ms)`);

    // Wait briefly for other results to populate (for status panel)
    await Promise.race([
      allSettledPromise,
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);

    serverStatus.raceResults = results;
    serverStatus.selectedServer = `${winner.domain}/anon`;
    serverStatus.connected = true;

    return winner.domain;
  } catch {
    console.warn("All relay servers failed latency test, using default");
    serverStatus.raceResults = results;
    serverStatus.selectedServer = `${LINODE_RELAYS[0]}/anon`;
    serverStatus.connected = false;
    return LINODE_RELAYS[0];
  }
}

// Update the server status panel UI
function updateServerStatusPanel() {
  const serverPanel = document.getElementById("server-panel");
  if (!serverPanel) return;

  const statusClass = serverStatus.connected ? "connected" : "disconnected";
  const statusText = serverStatus.connected ? "Connected" : "Disconnected";
  const modeLabel = serverStatus.mode === "websocket" ? "WebSocket (Safari fallback)" : "WebTransport (native)";

  // Build details HTML
  let detailsContent = `
    <p><strong>Mode:</strong> ${modeLabel}</p>
    <p><strong>Server:</strong> ${serverStatus.selectedServer}</p>
  `;

  // Show race results if we have them (linode mode with racing)
  if (serverStatus.raceResults.length > 0) {
    detailsContent += `
      <p><strong>Latency Test Results:</strong></p>
      <table class="latency-results">
        <thead><tr><th>Server</th><th>Latency</th></tr></thead>
        <tbody>
    `;

    // Sort by latency (successful first, then failed)
    const sorted = [...serverStatus.raceResults].sort((a, b) => {
      if (a.latency === null && b.latency === null) return 0;
      if (a.latency === null) return 1;
      if (b.latency === null) return -1;
      return a.latency - b.latency;
    });

    for (const result of sorted) {
      const isSelected = serverStatus.selectedServer.includes(result.domain);
      const latencyText = result.latency !== null
        ? `${result.latency.toFixed(0)}ms`
        : `Failed: ${result.error || "timeout"}`;
      const rowClass = isSelected ? "selected" : (result.latency === null ? "failed" : "");
      detailsContent += `<tr class="${rowClass}"><td>${result.domain}</td><td>${latencyText}</td></tr>`;
    }

    detailsContent += `</tbody></table>`;
  }

  serverPanel.innerHTML = `
    <div class="server-status-summary">
      <span class="status-indicator ${statusClass}"></span>
      <span>${statusText}: ${serverStatus.selectedServer}</span>
      <button class="details-btn" id="server-details-btn">Details</button>
    </div>
    <div class="server-details hidden" id="server-details-content">
      ${detailsContent}
    </div>
  `;

  // Add details toggle handler
  document.getElementById("server-details-btn")?.addEventListener("click", () => {
    const details = document.getElementById("server-details-content");
    const btn = document.getElementById("server-details-btn");
    if (details && btn) {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      btn.textContent = isHidden ? "Hide" : "Details";
    }
  });

}

// Relay URLs for each server
const RELAY_URLS = {
  luke: "https://cdn.moq.dev/anon",
  cloudflare: "https://relay-next.cloudflare.mediaoverquic.com",
  linode: "https://us-central.earthseed.live/anon",
  // Future Linode servers for racing:
  // linodeEU: "https://eu-central.earthseed.live/anon",
  // linodeAP: "https://ap-south.earthseed.live/anon",
};

// Determine relay URL based on mode and browser
// - luke: Both browsers use Luke's relay (he supports WebSocket natively)
// - linode: Both browsers use Linode relay
// - cloudflare-hybrid: Chrome→CloudFlare, Safari→Linode (requires bridge)
function getRelayUrlForMode(): string {
  switch (RELAY_MODE) {
    case "luke":
      return RELAY_URLS.luke;
    case "linode":
      return RELAY_URLS.linode;
    case "cloudflare-hybrid":
      // Chrome uses CloudFlare (WebTransport), Safari uses Linode (WebSocket)
      return isSafari ? RELAY_URLS.linode : RELAY_URLS.cloudflare;
  }
}

let RELAY_URL = getRelayUrlForMode();
const NAMESPACE_PREFIX = "earthseed.live";

// Helper to get correct URL and name based on relay type
function getRelayConfig(streamId: string): { url: string; name: string } {
  const streamName = `${NAMESPACE_PREFIX}/${streamId}`;
  // Both relays: URL is just the relay server, namespace goes in PUBLISH_NAMESPACE/ANNOUNCE
  return {
    url: RELAY_URL,
    name: streamName,
  };
}

// Debug logging for connection issues
console.log("Earthseed config:", {
  mode: RELAY_MODE,
  relay: RELAY_URL,
  isSafari,
  namespace: NAMESPACE_PREFIX,
  userAgent: navigator.userAgent,
  hasWebTransport: typeof WebTransport !== "undefined",
  needsPolyfill,
  note: (() => {
    switch (RELAY_MODE) {
      case "luke": return "All browsers → Luke's relay (cdn.moq.dev)";
      case "linode": return "All browsers → Linode relay (us-central.earthseed.live)";
      case "cloudflare-hybrid": return isSafari
        ? "Safari → Linode relay (WebSocket, bridged)"
        : "Chrome → CloudFlare relay (WebTransport)";
    }
  })(),
});

// Wrap WebTransport to add detailed connection logging
if (typeof WebTransport !== "undefined" && !needsPolyfill) {
  const OriginalWebTransport = WebTransport;
  // @ts-expect-error - wrapping native WebTransport
  globalThis.WebTransport = class DebugWebTransport extends OriginalWebTransport {
    constructor(url: string | URL, options?: WebTransportOptions) {
      console.log("[WebTransport Debug] Creating connection:", {
        url: url.toString(),
        options: JSON.stringify(options, null, 2),
      });
      super(url, options);

      const startTime = performance.now();

      this.ready.then(() => {
        const elapsed = (performance.now() - startTime).toFixed(0);
        console.log(`[WebTransport Debug] Connection READY after ${elapsed}ms`, {
          // @ts-expect-error - accessing internal state
          protocol: this.protocol,
        });
      }).catch((err) => {
        const elapsed = (performance.now() - startTime).toFixed(0);
        console.error(`[WebTransport Debug] Connection FAILED after ${elapsed}ms:`, err);
      });

      this.closed.then((info) => {
        console.log("[WebTransport Debug] Connection CLOSED:", {
          closeCode: info.closeCode,
          reason: info.reason,
        });
      }).catch((err) => {
        console.error("[WebTransport Debug] Connection closed with error:", err);
      });

      // Log when datagrams/streams are accessed
      const originalIncoming = this.incomingBidirectionalStreams;
      console.log("[WebTransport Debug] incomingBidirectionalStreams available:", !!originalIncoming);
    }
  };
  console.log("[WebTransport Debug] Wrapped native WebTransport for debugging");
}

// Dynamic imports for hang components - MUST happen after polyfills are installed
// ES module static imports are hoisted and execute before any code runs
const loadHangComponents = async () => {
  // Install WebCodecs polyfill for Opus audio encoding (Safari)
  // This must complete before hang components try to use AudioEncoder
  await installWebCodecsPolyfill();
  await import("@moq/hang/publish/element");
  await import("@moq/hang/watch/element");
  // UI controls (device picker, etc.)
  await import("@moq/hang-ui/publish/element");
  await import("@moq/hang-ui/watch/element");
};

import {
  getCurrentUser,
  countryToFlag,
  loginWithGoogle,
  loginWithMicrosoft,
  loginWithDiscord,
  logout,
  logBroadcastStart,
  logBroadcastEnd,
  sendBroadcastHeartbeat,
  logWatchStart,
  logWatchEnd,
  checkStreamExists,
  getStreamSettings,
  updateStreamSettings,
  getLiveStats,
  getStreamViewers,
  type User,
  type Geo,
  type StreamSettings,
  type LiveBroadcast,
  type LiveViewer,
  type BroadcastOrigin,
} from "./auth";

type View = "broadcast" | "watch" | "stats" | "stats-map" | "greet" | "scroll" | "stream-stats" | "stream-stats-map" | "admin";

// Generate a random stream ID (5 lowercase alphanumeric characters)
function generateRandomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Generate a unique stream ID, checking for collisions
async function generateStreamId(): Promise<string> {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateRandomId();
    const exists = await checkStreamExists(id);
    if (!exists) {
      return id;
    }
    console.log(`Stream ID ${id} already in use, generating new one...`);
  }
  // Fallback: return a random ID even if we couldn't verify uniqueness
  return generateRandomId();
}

// Check if a string is a valid stream ID (5 lowercase alphanumeric)
function isValidStreamId(str: string): boolean {
  return /^[a-z0-9]{5}$/.test(str);
}

// Determine current view and stream ID from URL
async function getRouteInfo(): Promise<{ view: View; streamId: string }> {
  const path = window.location.pathname;

  // Stats map view: /stats/map
  if (path === "/stats/map") {
    return { view: "stats-map", streamId: "" };
  }

  // Greet view: /greet (broadcasters map)
  if (path === "/greet") {
    return { view: "greet", streamId: "" };
  }

  // Scroll view: /scroll (TikTok-style viewer)
  if (path === "/scroll") {
    return { view: "scroll", streamId: "" };
  }

  // Admin view: /cleardata
  if (path === "/cleardata") {
    return { view: "admin", streamId: "" };
  }

  // Stats view: /stats
  if (path === "/stats") {
    return { view: "stats", streamId: "" };
  }

  // Stream-specific stats map view: /{streamId}/stats/map
  const streamStatsMapMatch = path.match(/^\/([a-z0-9]{5})\/stats\/map$/);
  if (streamStatsMapMatch) {
    return { view: "stream-stats-map", streamId: streamStatsMapMatch[1] };
  }

  // Stream-specific stats view: /{streamId}/stats
  const streamStatsMatch = path.match(/^\/([a-z0-9]{5})\/stats$/);
  if (streamStatsMatch) {
    return { view: "stream-stats", streamId: streamStatsMatch[1] };
  }

  // Watch view: /{streamId} (5 char alphanumeric)
  const potentialStreamId = path.slice(1); // Remove leading /
  if (isValidStreamId(potentialStreamId)) {
    return { view: "watch", streamId: potentialStreamId };
  }

  // Broadcast view: / or /?stream=xxx
  const params = new URLSearchParams(window.location.search);
  let streamId = params.get("stream");

  if (!streamId) {
    streamId = await generateStreamId();
    // Update URL without reload
    const newUrl = `${window.location.pathname}?stream=${streamId}`;
    window.history.replaceState({}, "", newUrl);
  }

  return { view: "broadcast", streamId };
}

// Update the auth UI based on login state
function updateAuthUI(user: User | null, geo: Geo | null) {
  const authContainer = document.getElementById("auth-container");
  const newStreamBtn = document.getElementById("new-stream-btn");

  // Hide header buttons when not logged in (login overlay will show instead)
  if (!user) {
    if (authContainer) authContainer.innerHTML = "";
    if (newStreamBtn) newStreamBtn.classList.add("hidden");
    return;
  }

  // Show New Stream button for logged in users
  if (newStreamBtn) newStreamBtn.classList.remove("hidden");

  if (!authContainer) return;

  // Show logged-in user info
  const avatarHtml = user.avatar_url
    ? `<img src="${user.avatar_url}" alt="${user.name}" class="avatar">`
    : `<div class="avatar avatar-placeholder">${user.name.charAt(0).toUpperCase()}</div>`;

  const flag = countryToFlag(geo?.country ?? null);
  const hasCoords = geo?.latitude && geo?.longitude;

  // Build location tooltip content
  const locationParts: string[] = [];
  if (geo?.city) locationParts.push(geo.city);
  if (geo?.region) locationParts.push(geo.region);
  if (geo?.postalCode) locationParts.push(geo.postalCode);
  if (geo?.country) locationParts.push(geo.country);

  let flagHtml = "";
  if (flag) {
    const clickable = hasCoords ? "clickable" : "";
    flagHtml = `<span class="user-flag ${clickable}" id="user-flag">${flag}</span>`;
  }

  authContainer.innerHTML = `
    <div class="user-info">
      ${avatarHtml}
      <span class="user-name">${user.name}</span>${flagHtml}
      <button id="logout-btn" class="btn btn-icon" title="Sign Out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    </div>
    ${flag ? `<div class="geo-tooltip" id="geo-tooltip">
      <div class="geo-tooltip-content">
        ${geo?.city ? `<div class="geo-row"><span class="geo-label">City</span><span class="geo-value">${geo.city}</span></div>` : ""}
        ${geo?.region ? `<div class="geo-row"><span class="geo-label">Region</span><span class="geo-value">${geo.region}</span></div>` : ""}
        ${geo?.postalCode ? `<div class="geo-row"><span class="geo-label">Postal</span><span class="geo-value">${geo.postalCode}</span></div>` : ""}
        ${geo?.country ? `<div class="geo-row"><span class="geo-label">Country</span><span class="geo-value">${geo.country}</span></div>` : ""}
        ${geo?.continent ? `<div class="geo-row"><span class="geo-label">Continent</span><span class="geo-value">${geo.continent}</span></div>` : ""}
        ${geo?.timezone ? `<div class="geo-row"><span class="geo-label">Timezone</span><span class="geo-value">${geo.timezone}</span></div>` : ""}
        ${hasCoords ? `<div class="geo-row"><span class="geo-label">Coords</span><span class="geo-value">${geo.latitude}, ${geo.longitude}</span></div>` : ""}
        ${hasCoords ? `<div class="geo-action">Click flag to open in Google Maps</div>` : ""}
      </div>
    </div>` : ""}
  `;

  document.getElementById("logout-btn")?.addEventListener("click", logout);

  // Flag hover and click handlers
  const flagEl = document.getElementById("user-flag");
  const tooltipEl = document.getElementById("geo-tooltip");

  if (flagEl && tooltipEl) {
    flagEl.addEventListener("mouseenter", () => {
      tooltipEl.classList.add("visible");
    });
    flagEl.addEventListener("mouseleave", () => {
      tooltipEl.classList.remove("visible");
    });

    if (hasCoords) {
      flagEl.addEventListener("click", () => {
        const mapsUrl = `https://www.google.com/maps/place/${geo.latitude},${geo.longitude}/@${geo.latitude},${geo.longitude},3z`;
        window.open(mapsUrl, "_blank");
      });
    }
  }
}

// Show login required overlay for broadcast
function showLoginRequired() {
  const broadcastView = document.getElementById("broadcast-view");
  if (!broadcastView) return;

  const overlay = document.createElement("div");
  overlay.id = "login-overlay";
  overlay.innerHTML = `
    <div class="login-required">
      <div class="watch-stream-section">
        <h2>Enter Stream ID to Watch</h2>
        <div class="watch-stream-input-row">
          <input type="text" id="watch-stream-id-input" maxlength="5" placeholder="xxxxx" autocomplete="off" spellcheck="false">
          <button id="watch-stream-go-btn" type="button" title="Go to stream">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 16 16 12 12 8"/>
              <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="login-divider"><span>or</span></div>
      <h2>Sign in to Broadcast</h2>
      <p>Please sign in with one of the following to start broadcasting:</p>
      <div class="auth-buttons">
        <button id="overlay-login-google" class="btn btn-google">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google
        </button>
        <button id="overlay-login-microsoft" class="btn btn-microsoft">
          <svg viewBox="0 0 21 21" width="18" height="18">
            <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
          </svg>
          Microsoft
        </button>
        <button id="overlay-login-discord" class="btn btn-discord">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
          Discord
        </button>
      </div>
    </div>
  `;

  broadcastView.appendChild(overlay);
  document.getElementById("overlay-login-google")?.addEventListener("click", loginWithGoogle);
  document.getElementById("overlay-login-microsoft")?.addEventListener("click", loginWithMicrosoft);
  document.getElementById("overlay-login-discord")?.addEventListener("click", loginWithDiscord);

  // Watch stream functionality
  const watchInput = document.getElementById("watch-stream-id-input") as HTMLInputElement;
  const watchGoBtn = document.getElementById("watch-stream-go-btn");

  const goToStream = () => {
    const streamId = watchInput.value.trim().toLowerCase();
    if (streamId.length !== 5) {
      alert("Stream IDs are five characters long");
      watchInput.focus();
      return;
    }
    window.open(`/${streamId}`, "_blank");
  };

  watchGoBtn?.addEventListener("click", goToStream);
  watchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      goToStream();
    }
  });
  // Auto-lowercase input
  watchInput?.addEventListener("input", () => {
    watchInput.value = watchInput.value.toLowerCase();
  });
}

// Initialize broadcast view
function initBroadcastView(streamId: string, user: User | null) {
  const streamName = `${NAMESPACE_PREFIX}/${streamId}`;
  const shareUrl = `${window.location.origin}/${streamId}`;

  console.log(`Earthseed.Live Broadcast - Stream: ${streamId}`);

  // Show broadcast view, hide watch view
  document.getElementById("broadcast-view")?.classList.remove("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // If not logged in, show login required overlay
  if (!user) {
    showLoginRequired();
    return;
  }

  // Update the page with stream info
  const streamDisplay = document.getElementById("stream-id");
  const copyBtn = document.getElementById("copy-btn");

  if (streamDisplay) streamDisplay.textContent = streamId;

  // Copy button functionality
  if (copyBtn) {
    const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(shareUrl);
      copyBtn.innerHTML = checkIcon;
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.innerHTML = copyIcon;
        copyBtn.classList.remove("copied");
      }, 2000);
    });
  }

  // Require auth toggle
  const requireAuthCheckbox = document.getElementById("require-auth-checkbox") as HTMLInputElement;
  if (requireAuthCheckbox) {
    // Load current setting
    getStreamSettings(streamId).then(settings => {
      requireAuthCheckbox.checked = settings.require_auth;
    });

    // Save on change - with confirmation for anonymous viewers
    requireAuthCheckbox.addEventListener("change", async () => {
      if (requireAuthCheckbox.checked) {
        // Check for anonymous viewers before enabling auth requirement
        const data = await getStreamViewers(streamId);
        const anonymousCount = data?.viewers.filter(v => !v.user_id).length ?? 0;

        if (anonymousCount > 0) {
          const plural = anonymousCount === 1 ? "viewer is" : "viewers are";
          const confirmed = confirm(
            `${anonymousCount} anonymous ${plural} currently watching.\n\nForce them to sign in now?`
          );

          if (!confirmed) {
            // Revert checkbox if not confirmed
            requireAuthCheckbox.checked = false;
            return;
          }
        }
      }

      updateStreamSettings(streamId, { require_auth: requireAuthCheckbox.checked });
    });
  }

  // Set viewers link to stream stats page
  const viewersLink = document.getElementById("viewers-link") as HTMLAnchorElement;
  if (viewersLink) {
    viewersLink.href = `/${streamId}/stats`;
    viewersLink.target = "_blank";
    // Prevent link click from toggling the checkbox
    viewersLink.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  // Set stream name on publisher
  const publisher = document.querySelector("hang-publish") as HTMLElement & { video: boolean; device: string; active?: { connection?: { status?: { peek?: () => string } } } };
  if (publisher) {
    const relayConfig = getRelayConfig(streamId);
    console.log("[Hang Debug] Setting up publisher:", {
      url: relayConfig.url,
      name: relayConfig.name,
      relayMode: RELAY_MODE,
    });
    publisher.setAttribute("url", relayConfig.url);
    publisher.setAttribute("name", relayConfig.name);

    // Monitor connection status changes
    const checkConnectionStatus = () => {
      try {
        const instance = (publisher as any).active?.peek?.();
        if (instance?.connection) {
          const status = instance.connection.status?.peek?.();
          console.log("[Hang Debug] Publisher connection status:", status);
        }
      } catch (e) {
        // Ignore errors accessing internal state
      }
    };
    // Check status periodically for debugging
    const statusInterval = setInterval(checkConnectionStatus, 2000);
    setTimeout(() => clearInterval(statusInterval), 30000); // Stop after 30s

    // Track broadcast event
    let broadcastEventId: number | null = null;
    let heartbeatInterval: number | null = null;

    // Log broadcast start when user starts streaming
    // Safari uses WebSocket to earthseed relay, Chrome uses WebTransport to CloudFlare
    const broadcastOrigin: BroadcastOrigin = isSafari ? "earthseed" : "cloudflare";
    const checkBroadcastStatus = () => {
      // Status is rendered by hang-publish-ui wrapper, not hang-publish itself
      const publisherUI = document.querySelector("hang-publish-ui") as HTMLElement | null;
      const searchRoot = publisherUI || publisher;

      // Debug: dump all text content
      const allText: string[] = [];
      searchRoot.querySelectorAll("*").forEach(el => {
        const t = (el as HTMLElement).textContent?.trim();
        if (t && t.length < 50) allText.push(t);
      });
      console.log("[Broadcast Status Debug] All text in", publisherUI ? "hang-publish-ui" : "hang-publish", ":", [...new Set(allText)]);

      // Search for status in both light DOM and shadow DOM
      let fullStatus = "";

      // Helper to recursively search elements including shadow roots
      const searchInElement = (root: Element | ShadowRoot | Document): string => {
        const elements = root.querySelectorAll("*");
        for (const el of elements) {
          // Skip style, script, and other non-visible elements
          const tagName = el.tagName?.toLowerCase();
          if (tagName === "style" || tagName === "script" || tagName === "link") {
            continue;
          }

          // Recursively check shadow roots first
          const shadowRoot = (el as HTMLElement).shadowRoot;
          if (shadowRoot) {
            const result = searchInElement(shadowRoot);
            if (result) return result;
          }

          // Check for status indicators - use innerText for visible text only
          const text = (el as HTMLElement).innerText || "";
          const dataText = (el as HTMLElement).getAttribute?.("data-status-text") || "";
          const combined = text + " " + dataText;

          // Look for status emoji indicators
          if (combined.includes("🟢") || combined.includes("🟡") || combined.includes("🔴")) {
            console.log("[Broadcast Status Debug] Found status in element:", tagName, combined.substring(0, 100));
            return combined.trim();
          }
          // Look for status text patterns
          if ((combined.includes("Live") || combined.includes("Audio Only") || combined.includes("Select Device")) &&
              !combined.includes("{") && combined.length < 200) {
            console.log("[Broadcast Status Debug] Found status text in element:", tagName, combined.substring(0, 100));
            return combined.trim();
          }
        }
        return "";
      };

      // Check if searchRoot has shadow root
      const hasShadow = !!searchRoot.shadowRoot;
      console.log("[Broadcast Status Debug] searchRoot shadowRoot:", hasShadow);

      // Search starting from shadow root if it exists, otherwise light DOM
      if (searchRoot.shadowRoot) {
        fullStatus = searchInElement(searchRoot.shadowRoot);
      }
      if (!fullStatus) {
        fullStatus = searchInElement(searchRoot);
      }

      console.log("[Broadcast Status Check] Status:", fullStatus, "| Event ID:", broadcastEventId);
      if (fullStatus.includes("🟢") || fullStatus.includes("Live") || fullStatus.includes("Audio Only")) {
        if (!broadcastEventId) {
          logBroadcastStart(streamId, broadcastOrigin).then(id => {
            broadcastEventId = id;
            console.log("Broadcast started, event ID:", id, "origin:", broadcastOrigin);
            // Start heartbeat to keep broadcast alive
            if (id && !heartbeatInterval) {
              heartbeatInterval = window.setInterval(() => {
                if (broadcastEventId) sendBroadcastHeartbeat(broadcastEventId);
              }, 5000);
            }
          });
        }
      } else if (broadcastEventId && fullStatus.includes("Select Device")) {
        logBroadcastEnd(broadcastEventId);
        console.log("Broadcast ended, event ID:", broadcastEventId);
        // Stop heartbeat
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        broadcastEventId = null;
      }
    };

    // Observe status changes
    const statusObserver = new MutationObserver((mutations) => {
      console.log("[Broadcast Status] Mutation detected, checking status...");
      checkBroadcastStatus();
    });
    statusObserver.observe(publisher, { childList: true, subtree: true, characterData: true, attributes: true });

    // Also check periodically in case mutations are missed
    const statusCheckInterval = setInterval(checkBroadcastStatus, 3000);
    // Initial check after component loads
    setTimeout(checkBroadcastStatus, 1000);
    setTimeout(checkBroadcastStatus, 2000);
    setTimeout(checkBroadcastStatus, 5000);

    // Log end on page unload
    window.addEventListener("beforeunload", () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      if (broadcastEventId) {
        logBroadcastEnd(broadcastEventId);
      }
    });

    // Inject audio-only button into device selector
    const injectAudioButton = () => {
      // Find the device selector container (div with flex layout containing buttons)
      const deviceContainer = publisher.querySelector(":scope > div > div");
      if (!deviceContainer || deviceContainer.querySelector(".audio-only-btn")) return;

      const audioBtn = document.createElement("button");
      audioBtn.type = "button";
      audioBtn.title = "Audio Only";
      audioBtn.className = "audio-only-btn";
      audioBtn.textContent = "🎤";
      audioBtn.style.cursor = "pointer";
      audioBtn.style.opacity = "0.5";

      audioBtn.addEventListener("click", () => {
        const isActive = audioBtn.style.opacity === "1";
        if (isActive) {
          // Turn off audio-only mode
          publisher.video = true;
          audioBtn.style.opacity = "0.5";
        } else {
          // Turn on audio-only mode
          publisher.video = false;
          publisher.device = "camera";
          audioBtn.style.opacity = "1";
        }
      });

      // Deselect audio-only button when other device buttons are clicked
      const otherButtons = deviceContainer.querySelectorAll("button:not(.audio-only-btn)");
      otherButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          // Deselect audio-only when another device is selected
          if (audioBtn.style.opacity === "1") {
            publisher.video = true;
            audioBtn.style.opacity = "0.5";
          }
        });
      });

      // Insert after the first button (camera icon)
      const buttons = deviceContainer.querySelectorAll("button");
      if (buttons.length >= 1) {
        buttons[0].after(audioBtn);
      } else {
        deviceContainer.appendChild(audioBtn);
      }
    };

    // Try after component renders and observe for changes
    const observer = new MutationObserver(() => injectAudioButton());
    observer.observe(publisher, { childList: true, subtree: true });
    setTimeout(injectAudioButton, 100);
    setTimeout(injectAudioButton, 500);

    // Inject HTML overlay button into device selector
    // Note: With @moq/hang-ui, device buttons are in hang-publish-ui's Shadow DOM
    const injectHtmlOverlayButton = () => {
      const publisherUI = document.querySelector("hang-publish-ui");
      const shadowRoot = publisherUI?.shadowRoot;
      const deviceContainer = shadowRoot?.querySelector(".publishSourceSelectorContainer");
      if (!deviceContainer || deviceContainer.querySelector(".html-overlay-btn")) return;

      const htmlBtn = document.createElement("button");
      htmlBtn.type = "button";
      htmlBtn.title = "HTML Overlay";
      htmlBtn.className = "html-overlay-btn";
      htmlBtn.textContent = "</>";
      htmlBtn.style.cursor = "pointer";
      htmlBtn.style.opacity = "0.5";
      htmlBtn.style.fontFamily = "monospace";
      htmlBtn.style.fontWeight = "bold";
      htmlBtn.style.fontSize = "0.9rem";

      // Create the overlay input container
      const overlayContainer = document.createElement("div");
      overlayContainer.className = "html-overlay-container";
      overlayContainer.innerHTML = `
        <div class="html-overlay-input" contenteditable="true"></div>
        <div class="html-overlay-hint">HTML content will be displayed below the video for all viewers</div>
      `;

      // Insert container after the section
      const section = document.querySelector("#broadcast-view section");
      if (section && section.parentNode) {
        section.parentNode.insertBefore(overlayContainer, section.nextSibling);
      }

      const overlayInput = overlayContainer.querySelector(".html-overlay-input") as HTMLDivElement;
      let saveTimeout: number | null = null;

      // Load existing overlay content
      getStreamSettings(streamId).then(settings => {
        if (settings.overlay_html) {
          overlayInput.textContent = settings.overlay_html;
          htmlBtn.style.opacity = "1";
        }
      });

      // Save overlay content with debounce
      overlayInput.addEventListener("input", () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = window.setTimeout(() => {
          const content = overlayInput.textContent || "";
          updateStreamSettings(streamId, { overlay_html: content });
          htmlBtn.style.opacity = content.trim() ? "1" : "0.5";
        }, 500);
      });

      // Toggle overlay input visibility
      htmlBtn.addEventListener("click", () => {
        overlayContainer.classList.toggle("visible");
        if (overlayContainer.classList.contains("visible")) {
          overlayInput.focus();
        }
      });

      // Append to device container
      deviceContainer.appendChild(htmlBtn);
    };

    // Restyle status indicator: move to left, show only ball with tooltip
    const restyleStatusIndicator = () => {
      const publisherUI = document.querySelector("hang-publish-ui");
      const shadowRoot = publisherUI?.shadowRoot;
      if (!shadowRoot) return;

      const deviceContainer = shadowRoot.querySelector(".publishSourceSelectorContainer");
      const statusOutput = shadowRoot.querySelector("output");
      if (!deviceContainer || !statusOutput) return;

      // Skip if already restyled
      if (statusOutput.classList.contains("status-restyled")) return;
      statusOutput.classList.add("status-restyled");

      // Hide "Source:" text by wrapping device buttons only
      const sourceText = deviceContainer.firstChild;
      if (sourceText?.nodeType === Node.TEXT_NODE && sourceText.textContent?.includes("Source")) {
        sourceText.textContent = "";
      }

      // Move status indicator to be first in device container
      deviceContainer.insertBefore(statusOutput, deviceContainer.firstChild);

      // Style the status indicator
      statusOutput.style.cssText = `
        cursor: default;
        position: relative;
        font-size: 1.25rem;
        line-height: 1;
        margin-right: 8px;
      `;

      // Update tooltip on status changes
      let isUpdating = false;
      const updateTooltip = () => {
        if (isUpdating) return;
        const fullText = statusOutput.textContent || "";
        // Only process if there's text after the emoji (not already processed)
        if (fullText.length <= 2) return;

        // Extract emoji (first character) and text (rest)
        const match = fullText.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{1F7E0}-\u{1F7FF}])/u);
        if (match) {
          const emoji = match[1];
          const text = fullText.slice(emoji.length).trim();
          if (text) {
            isUpdating = true;
            statusOutput.textContent = emoji;
            statusOutput.title = text;
            isUpdating = false;
          }
        }
      };

      // Initial update
      updateTooltip();

      // Watch for status text changes
      const statusObserver = new MutationObserver(updateTooltip);
      statusObserver.observe(statusOutput, { childList: true, characterData: true, subtree: true });
    };

    // Inject HTML overlay button after component renders
    // Use MutationObserver to catch when hang-publish-ui renders its controls in Shadow DOM
    const publisherUI = document.querySelector("hang-publish-ui");
    if (publisherUI?.shadowRoot) {
      const uiObserver = new MutationObserver(() => {
        injectHtmlOverlayButton();
        restyleStatusIndicator();
      });
      uiObserver.observe(publisherUI.shadowRoot, { childList: true, subtree: true });
    }
    setTimeout(injectHtmlOverlayButton, 200);
    setTimeout(injectHtmlOverlayButton, 600);
    setTimeout(injectHtmlOverlayButton, 1000);
    setTimeout(restyleStatusIndicator, 200);
    setTimeout(restyleStatusIndicator, 600);
    setTimeout(restyleStatusIndicator, 1000);
  }

  // New stream button
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) {
    newStreamBtn.addEventListener("click", async () => {
      const newStream = await generateStreamId();
      window.location.href = `/?stream=${newStream}`;
    });
  }
}

// Show login required overlay for watch
function showWatchLoginRequired() {
  const watchView = document.getElementById("watch-view");
  if (!watchView) return;

  const section = watchView.querySelector("section");
  if (!section) return;

  section.innerHTML = `
    <div class="login-required">
      <h2>Sign in Required</h2>
      <p>The broadcaster requires viewers to sign in to watch this stream.</p>
      <div class="auth-buttons">
        <button id="watch-login-google" class="btn btn-google">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google
        </button>
        <button id="watch-login-microsoft" class="btn btn-microsoft">
          <svg viewBox="0 0 21 21" width="18" height="18">
            <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
          </svg>
          Microsoft
        </button>
        <button id="watch-login-discord" class="btn btn-discord">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
          Discord
        </button>
      </div>
    </div>
  `;

  document.getElementById("watch-login-google")?.addEventListener("click", loginWithGoogle);
  document.getElementById("watch-login-microsoft")?.addEventListener("click", loginWithMicrosoft);
  document.getElementById("watch-login-discord")?.addEventListener("click", loginWithDiscord);
}

// Initialize watch view
async function initWatchView(streamId: string, user: User | null) {
  const streamName = `${NAMESPACE_PREFIX}/${streamId}`;

  console.log(`Earthseed.Live Watch - Stream: ${streamId}`);

  // Show watch view, hide broadcast view
  document.getElementById("watch-view")?.classList.remove("hidden");
  document.getElementById("broadcast-view")?.classList.add("hidden");

  // Hide the New Stream button on watch page
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) {
    newStreamBtn.classList.add("hidden");
  }

  // Check if stream requires auth
  const settings = await getStreamSettings(streamId);
  if (settings.require_auth && !user) {
    showWatchLoginRequired();
    return;
  }

  // Set stream name on watcher
  const watcher = document.querySelector("hang-watch");
  if (watcher) {
    const relayConfig = getRelayConfig(streamId);
    console.log("[Hang Debug] Setting up watcher:", {
      url: relayConfig.url,
      name: relayConfig.name,
      relayMode: RELAY_MODE,
    });
    watcher.setAttribute("url", relayConfig.url);
    watcher.setAttribute("name", relayConfig.name);

    // Monitor connection status changes
    const checkConnectionStatus = () => {
      try {
        const instance = (watcher as any).active?.peek?.();
        if (instance?.connection) {
          const status = instance.connection.status?.peek?.();
          console.log("[Hang Debug] Watcher connection status:", status);
        }
      } catch (e) {
        // Ignore errors accessing internal state
      }
    };
    // Check status periodically for debugging
    const statusInterval = setInterval(checkConnectionStatus, 2000);
    setTimeout(() => clearInterval(statusInterval), 30000); // Stop after 30s

    // Log watch event
    let watchEventId: number | null = null;

    // Start logging when page loads
    logWatchStart(streamId).then(id => {
      watchEventId = id;
      console.log("Watch started, event ID:", id);
    });

    // Log end on page unload
    window.addEventListener("beforeunload", () => {
      if (watchEventId) {
        logWatchEnd(watchEventId);
      }
    });

    // Create HTML overlay display div
    const watchSection = document.querySelector("#watch-view section");
    let overlayDiv = document.querySelector(".viewer-html-overlay") as HTMLDivElement;
    if (!overlayDiv && watchSection) {
      overlayDiv = document.createElement("div");
      overlayDiv.className = "viewer-html-overlay";
      watchSection.parentNode?.insertBefore(overlayDiv, watchSection.nextSibling);
    }

    // Function to update overlay content
    const updateOverlay = (overlayHtml: string) => {
      if (overlayDiv) {
        if (overlayHtml.trim()) {
          overlayDiv.innerHTML = overlayHtml;
        } else {
          overlayDiv.innerHTML = "";
        }
      }
    };

    // Load initial overlay content
    if (settings.overlay_html) {
      updateOverlay(settings.overlay_html);
    }

    // Poll for setting changes (auth and overlay)
    const settingsCheckInterval = setInterval(async () => {
      const currentSettings = await getStreamSettings(streamId);

      // Check auth requirement (anonymous viewers only)
      if (!user && currentSettings.require_auth) {
        clearInterval(settingsCheckInterval);
        if (watchEventId) {
          logWatchEnd(watchEventId);
          watchEventId = null;
        }
        showWatchLoginRequired();
        return;
      }

      // Update overlay content
      updateOverlay(currentSettings.overlay_html);
    }, 5000); // Check every 5 seconds

    // Cleanup interval on page unload
    window.addEventListener("beforeunload", () => {
      clearInterval(settingsCheckInterval);
    });

    // Move latency/quality controls from hang-watch-ui Shadow DOM to Browser Support panel
    const movePlaybackControls = () => {
      const watchUI = document.querySelector("hang-watch-ui");
      const shadowRoot = watchUI?.shadowRoot;
      const targetContainer = document.getElementById("playback-settings-container");

      if (!shadowRoot || !targetContainer) return;

      const latencyContainer = shadowRoot.querySelector(".latencySliderContainer");
      const qualityContainer = shadowRoot.querySelector(".qualitySelectorContainer");

      if (latencyContainer && !targetContainer.contains(latencyContainer)) {
        targetContainer.appendChild(latencyContainer);
      }
      if (qualityContainer && !targetContainer.contains(qualityContainer)) {
        targetContainer.appendChild(qualityContainer);
      }
    };

    // Try to move controls after hang-watch-ui renders
    const watchUI = document.querySelector("hang-watch-ui");
    if (watchUI?.shadowRoot) {
      const uiObserver = new MutationObserver(() => movePlaybackControls());
      uiObserver.observe(watchUI.shadowRoot, { childList: true, subtree: true });
    }
    setTimeout(movePlaybackControls, 500);
    setTimeout(movePlaybackControls, 1000);
    setTimeout(movePlaybackControls, 2000);
  }
}

// Scroll view state
interface ScrollBroadcast {
  stream_id: string;
  user_name: string;
  started_at: string;
  geo_city: string | null;
  geo_country: string | null;
  geo_region: string | null;
  viewer_count: number;
}

// 5-slot deck positions for QUIC zapping
type DeckPosition = "far_prev" | "prev" | "current" | "next" | "far_next";

// Position configuration: outer ring = audio only, inner ring + current = video + audio
const DECK_CONFIG: Record<DeckPosition, { videoEnabled: boolean; visible: boolean }> = {
  far_prev: { videoEnabled: false, visible: false },  // Outer ring: audio only
  prev:     { videoEnabled: true,  visible: false },  // Inner ring: video ready
  current:  { videoEnabled: true,  visible: true  },  // Center: visible
  next:     { videoEnabled: true,  visible: false },  // Inner ring: video ready
  far_next: { videoEnabled: false, visible: false },  // Outer ring: audio only
};

// Initialize scroll view (TikTok-style) with 5-slot QUIC zapping
async function initScrollView() {
  console.log("Earthseed.Live Scroll View - QUIC Zapping enabled");

  // Wait for hang-watch custom element to be defined
  await customElements.whenDefined("hang-watch");
  console.log("[Scroll] hang-watch custom element is ready");

  // Hide all other views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");
  document.getElementById("scroll-view")?.classList.remove("hidden");

  // Hide header and footer for immersive experience
  const header = document.querySelector("header");
  const footer = document.querySelector("footer");
  if (header) header.classList.add("hidden");
  if (footer) footer.classList.add("hidden");

  // State management
  let upcomingStreams: ScrollBroadcast[] = [];
  let historyStreams: ScrollBroadcast[] = [];
  let currentStream: ScrollBroadcast | null = null;
  let watchEventId: number | null = null;
  const MAX_HISTORY = 10;

  // 5-slot deck for QUIC zapping
  interface DeckSlot {
    element: HTMLElement | null;
    stream: ScrollBroadcast | null;
    videoEnabled: boolean;
  }

  const deck: Record<DeckPosition, DeckSlot> = {
    far_prev: { element: null, stream: null, videoEnabled: false },
    prev:     { element: null, stream: null, videoEnabled: true },
    current:  { element: null, stream: null, videoEnabled: true },
    next:     { element: null, stream: null, videoEnabled: true },
    far_next: { element: null, stream: null, videoEnabled: false },
  };

  // DOM elements - verify they exist
  const scrollView = document.getElementById("scroll-view");
  if (!scrollView) {
    console.error("[Scroll] scroll-view element not found");
    return;
  }
  const videoWrapper = scrollView.querySelector(".scroll-video-wrapper") as HTMLElement;
  const streamIdEl = scrollView.querySelector(".scroll-stream-id") as HTMLElement;
  const broadcasterEl = scrollView.querySelector(".scroll-broadcaster") as HTMLElement;
  const noStreamsEl = scrollView.querySelector(".scroll-no-streams") as HTMLElement;
  const hintEl = scrollView.querySelector(".scroll-hint") as HTMLElement;

  // TikTok UI elements
  const viewerCountEl = scrollView.querySelector(".viewer-number") as HTMLElement;
  const locationEl = scrollView.querySelector(".scroll-location") as HTMLElement;
  const avatarPlaceholder = scrollView.querySelector(".scroll-avatar-placeholder") as HTMLElement;
  const closeBtn = scrollView.querySelector(".scroll-close-btn") as HTMLElement;
  const likeBtn = scrollView.querySelector(".scroll-like-btn") as HTMLElement;
  const likeCountEl = scrollView.querySelector(".scroll-like-count") as HTMLElement;

  // Floating hearts container (add dynamically if not present)
  let floatingHeartsEl = scrollView.querySelector(".scroll-floating-hearts") as HTMLElement;
  if (!floatingHeartsEl) {
    floatingHeartsEl = document.createElement("div");
    floatingHeartsEl.className = "scroll-floating-hearts";
    scrollView.querySelector(".scroll-overlay")?.appendChild(floatingHeartsEl);
  }

  if (!videoWrapper) {
    console.error("[Scroll] video-wrapper element not found");
    return;
  }

  // Wire up close button
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      window.location.href = "/";
    });
  }

  // Like count state (mock for now since likes aren't stored in DB)
  let likeCount = 0;

  // Wire up like button with floating heart animation
  if (likeBtn) {
    likeBtn.addEventListener("click", () => {
      likeCount++;
      if (likeCountEl) likeCountEl.textContent = formatCount(likeCount);
      likeBtn.classList.add("liked");
      spawnFloatingHeart();
    });
  }

  // Spawn floating heart animation
  function spawnFloatingHeart(): void {
    if (!floatingHeartsEl) return;
    const heart = document.createElement("div");
    heart.className = "scroll-floating-heart";
    heart.innerHTML = "❤️";
    // Random horizontal drift
    heart.style.setProperty("--drift", `${(Math.random() - 0.5) * 30}px`);
    floatingHeartsEl.appendChild(heart);
    // Remove after animation completes
    setTimeout(() => heart.remove(), 2000);
  }

  // Format count for display (e.g., 1234 -> "1.2K")
  function formatCount(count: number): string {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + "M";
    if (count >= 1000) return (count / 1000).toFixed(1) + "K";
    return count.toString();
  }

  // Get country flag emoji from country code
  function countryToFlag(countryCode: string | null): string {
    if (!countryCode || countryCode.length !== 2) return "🌍";
    const codePoints = countryCode
      .toUpperCase()
      .split("")
      .map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
  }

  // Update TikTok UI with stream data
  function updateStreamUI(stream: ScrollBroadcast | null): void {
    if (!stream) return;

    // Update broadcaster name with @ prefix
    if (broadcasterEl) {
      broadcasterEl.textContent = `@${stream.user_name}`;
    }

    // Update stream ID
    if (streamIdEl) {
      streamIdEl.textContent = stream.stream_id;
    }

    // Update location with flag
    if (locationEl) {
      const parts = [stream.geo_city, stream.geo_country].filter(Boolean);
      if (parts.length > 0) {
        const flag = countryToFlag(stream.geo_country);
        locationEl.textContent = `${flag} ${parts.join(", ")}`;
      } else {
        locationEl.textContent = "";
      }
    }

    // Update avatar placeholder with first letter of name
    if (avatarPlaceholder) {
      avatarPlaceholder.textContent = stream.user_name.charAt(0).toUpperCase();
    }

    // Update viewer count from initial data
    if (viewerCountEl) {
      // Add 1 for the current viewer (us)
      const count = stream.viewer_count + 1;
      viewerCountEl.textContent = formatCount(count);
    }

    // Reset like count for new stream
    likeCount = 0;
    if (likeCountEl) likeCountEl.textContent = "0";
    likeBtn?.classList.remove("liked");
  }

  // Periodically refresh viewer count
  let viewerCountInterval: number | null = null;
  function startViewerCountRefresh(streamId: string): void {
    // Clear any existing interval
    if (viewerCountInterval) {
      clearInterval(viewerCountInterval);
    }
    // Refresh every 10 seconds
    viewerCountInterval = window.setInterval(async () => {
      const count = await fetchViewerCount(streamId);
      if (viewerCountEl) {
        viewerCountEl.textContent = formatCount(count);
      }
    }, 10000);
  }

  // Remove the static hang-watch from HTML, we'll create them dynamically
  const staticWatcher = document.getElementById("scroll-watcher");
  if (staticWatcher) staticWatcher.remove();

  // Wait for hang-watch broadcast object to be available
  function waitForBroadcast(element: HTMLElement): Promise<any> {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 100; // 5 seconds max
      const check = () => {
        const broadcast = (element as any).broadcast;
        if (broadcast?.video?.enabled) {
          resolve(broadcast);
        } else if (attempts < maxAttempts) {
          attempts++;
          setTimeout(check, 50);
        } else {
          console.warn("[Scroll] Timeout waiting for broadcast object");
          resolve(null);
        }
      };
      check();
    });
  }

  // Create a hang-watch element for a stream with appropriate video state
  async function createWatcher(stream: ScrollBroadcast, position: DeckPosition): Promise<HTMLElement | null> {
    try {
      const relayConfig = getRelayConfig(stream.stream_id);
      const config = DECK_CONFIG[position];

      const watcher = document.createElement("hang-watch");
      watcher.className = `scroll-deck-${position}`;
      watcher.setAttribute("muted", "");
      watcher.setAttribute("url", relayConfig.url);
      watcher.setAttribute("name", relayConfig.name);

      const canvas = document.createElement("canvas");
      watcher.appendChild(canvas);

      // Set up cover-style sizing for the canvas (fill viewport, maintain aspect ratio, crop overflow)
      // Start with full viewport coverage immediately (may stretch until we know aspect ratio)
      canvas.style.width = '100vw';
      canvas.style.height = '100vh';

      let lastVideoWidth = 0;
      let lastVideoHeight = 0;
      let hasDimensions = false;

      function updateCanvasCover() {
        // Try to get dimensions from: lastVideoWidth/Height, canvas buffer, or default to square
        const videoWidth = lastVideoWidth || canvas.width || 1;
        const videoHeight = lastVideoHeight || canvas.height || 1;

        // Skip if we still have no real dimensions (both are default/0)
        if (lastVideoWidth === 0 && canvas.width <= 1) return;

        const videoAspect = videoWidth / videoHeight;
        const viewportAspect = window.innerWidth / window.innerHeight;

        if (videoAspect > viewportAspect) {
          // Video is wider than viewport - fit to height, overflow width
          canvas.style.height = '100vh';
          canvas.style.width = `${100 * videoAspect / viewportAspect}vh`;
        } else {
          // Video is taller than viewport - fit to width, overflow height
          canvas.style.width = '100vw';
          canvas.style.height = `${100 * viewportAspect / videoAspect}vw`;
        }
        hasDimensions = true;
      }

      // Subscribe to video display dimensions from broadcast
      waitForBroadcast(watcher).then((broadcast) => {
        if (broadcast?.video?.source?.display) {
          const checkDisplay = () => {
            const display = broadcast.video.source.display.peek?.() || broadcast.video.source.display;
            if (display?.width && display?.height) {
              lastVideoWidth = display.width;
              lastVideoHeight = display.height;
              updateCanvasCover();
            } else if (canvas.width > 1 && canvas.height > 1) {
              // Fallback: use canvas buffer dimensions if display signal not ready
              updateCanvasCover();
            }
          };

          // Poll frequently at first (every 50ms for 2 seconds), then slower
          let pollCount = 0;
          const fastPoll = setInterval(() => {
            checkDisplay();
            pollCount++;
            if (pollCount >= 40 || hasDimensions) { // 40 * 50ms = 2 seconds
              clearInterval(fastPoll);
              // Switch to slower polling for ongoing updates
              const slowPoll = setInterval(checkDisplay, 1000);
              watcher.addEventListener('disconnected', () => clearInterval(slowPoll), { once: true });
            }
          }, 50);

          watcher.addEventListener('disconnected', () => clearInterval(fastPoll), { once: true });
        }
      });

      // Update on window resize
      const resizeHandler = () => updateCanvasCover();
      window.addEventListener('resize', resizeHandler);
      watcher.addEventListener('disconnected', () => window.removeEventListener('resize', resizeHandler), { once: true });

      // For outer ring positions, disable video after broadcast initializes
      if (!config.videoEnabled) {
        waitForBroadcast(watcher).then((broadcast) => {
          if (broadcast) {
            broadcast.video.enabled.set(false);
            console.log(`[Scroll] ${position}: ${stream.stream_id} - video DISABLED (audio-only)`);
          }
        });
      } else {
        console.log(`[Scroll] ${position}: ${stream.stream_id} - video ENABLED`);
      }

      return watcher;
    } catch (err) {
      console.error(`[Scroll] Failed to create watcher for ${stream.stream_id}:`, err);
      return null;
    }
  }

  // Promote a slot: enable video (outer → inner ring)
  async function promoteSlot(slot: DeckSlot): Promise<void> {
    if (!slot.element || slot.videoEnabled) return;

    const broadcast = await waitForBroadcast(slot.element);
    if (broadcast) {
      broadcast.video.enabled.set(true);
      slot.videoEnabled = true;
      console.log(`[Scroll] PROMOTED ${slot.stream?.stream_id}: video ENABLED`);
    }
  }

  // Demote a slot: disable video (inner → outer ring)
  async function demoteSlot(slot: DeckSlot): Promise<void> {
    if (!slot.element || !slot.videoEnabled) return;

    const broadcast = await waitForBroadcast(slot.element);
    if (broadcast) {
      broadcast.video.enabled.set(false);
      slot.videoEnabled = false;
      console.log(`[Scroll] DEMOTED ${slot.stream?.stream_id}: video DISABLED`);
    }
  }

  // Fetch live broadcasts
  async function fetchLiveBroadcasts(): Promise<ScrollBroadcast[]> {
    try {
      const response = await fetch("/api/stats/greet");
      if (!response.ok) return [];
      const data = await response.json();
      return (data.broadcasts || []).map((b: any) => ({
        stream_id: b.stream_id,
        user_name: b.user_name || "Anonymous",
        started_at: b.started_at,
        geo_city: b.geo_city || null,
        geo_country: b.geo_country || null,
        geo_region: b.geo_region || null,
        viewer_count: b.viewer_count || 0,
      }));
    } catch (err) {
      console.error("Failed to fetch broadcasts:", err);
      return [];
    }
  }

  // Fetch current viewer count for a stream
  async function fetchViewerCount(streamId: string): Promise<number> {
    try {
      const response = await fetch(`/api/stats/stream/${streamId}/viewers`);
      if (!response.ok) return 0;
      const data = await response.json();
      return data.viewers?.length || 0;
    } catch (err) {
      console.error("Failed to fetch viewer count:", err);
      return 0;
    }
  }

  // Update a specific deck slot
  async function updateSlot(
    position: DeckPosition,
    stream: ScrollBroadcast | null
  ): Promise<void> {
    const slot = deck[position];

    // If same stream, nothing to do
    if (slot.stream?.stream_id === stream?.stream_id) {
      console.log(`[Scroll] updateSlot(${position}): no change, already ${stream?.stream_id || 'empty'}`);
      return;
    }

    console.log(`[Scroll] updateSlot(${position}): REPLACING ${slot.stream?.stream_id || 'empty'} with ${stream?.stream_id || 'empty'}`);

    // Remove old element
    if (slot.element) {
      slot.element.remove();
    }

    // Create new element or clear slot
    if (stream) {
      slot.stream = stream;
      slot.element = await createWatcher(stream, position);
      slot.videoEnabled = DECK_CONFIG[position].videoEnabled;
      if (slot.element) {
        videoWrapper.appendChild(slot.element);
      }
    } else {
      slot.stream = null;
      slot.element = null;
      slot.videoEnabled = false;
    }
  }

  // Update the entire deck based on current state
  async function updateDeck(): Promise<void> {
    // far_next: upcomingStreams[2] if exists
    const farNextStream = upcomingStreams.length > 2 ? upcomingStreams[2] : null;
    await updateSlot("far_next", farNextStream);

    // next: upcomingStreams[1] if exists
    const nextStream = upcomingStreams.length > 1 ? upcomingStreams[1] : null;
    await updateSlot("next", nextStream);

    // far_prev: historyStreams[length-2] if exists (second to last)
    const farPrevStream = historyStreams.length > 1 ? historyStreams[historyStreams.length - 2] : null;
    await updateSlot("far_prev", farPrevStream);

    // prev: historyStreams[length-1] if exists (last = most recent)
    const prevStream = historyStreams.length > 0 ? historyStreams[historyStreams.length - 1] : null;
    await updateSlot("prev", prevStream);

    updateHints();
    updatePositionIndicator();

    // Log deck state
    console.log("[Scroll] Deck state:", {
      far_prev: deck.far_prev.stream?.stream_id || "(empty)",
      prev: deck.prev.stream?.stream_id || "(empty)",
      current: deck.current.stream?.stream_id || "(empty)",
      next: deck.next.stream?.stream_id || "(empty)",
      far_next: deck.far_next.stream?.stream_id || "(empty)",
    });
  }

  // Load initial current stream
  async function loadCurrentStream(stream: ScrollBroadcast): Promise<void> {
    try {
      currentStream = stream;

      console.log(`[Scroll] Loading current: ${stream.stream_id}`);

      // Log watch start for this stream
      logWatchStart(stream.stream_id).then(id => {
        watchEventId = id;
        console.log(`[Scroll] Watch started for ${stream.stream_id}, event ID:`, id);
      });

      // Remove old current element
      if (deck.current.element) {
        deck.current.element.remove();
      }

      // Create new current element
      deck.current.stream = stream;
      const watcher = await createWatcher(stream, "current");
      if (!watcher) {
        console.error(`[Scroll] Failed to create watcher for ${stream.stream_id}`);
        showNoStreams();
        return;
      }
      deck.current.element = watcher;
      deck.current.videoEnabled = true;
      videoWrapper.appendChild(watcher);

      // Update TikTok UI
      updateStreamUI(stream);
      if (noStreamsEl) noStreamsEl.classList.add("hidden");

      // Start periodic viewer count refresh
      startViewerCountRefresh(stream.stream_id);

      // Preload adjacent streams
      await updateDeck();
    } catch (err) {
      console.error("[Scroll] Error loading current stream:", err);
      showNoStreams();
    }
  }

  // Update navigation hints
  function updateHints(): void {
    const hintUp = scrollView.querySelector(".scroll-hint-up") as HTMLElement;
    const hintDown = scrollView.querySelector(".scroll-hint-down") as HTMLElement;

    const canGoNext = upcomingStreams.length > 1 || deck.next.stream !== null;
    const canGoBack = historyStreams.length > 0 || deck.prev.stream !== null;

    if (hintUp) hintUp.style.display = canGoNext ? "block" : "none";
    if (hintDown) hintDown.style.display = canGoBack ? "block" : "none";
  }

  // Show no streams available
  function showNoStreams(): void {
    currentStream = null;
    streamIdEl.textContent = "";
    broadcasterEl.textContent = "";
    noStreamsEl.classList.remove("hidden");
    hintEl.style.opacity = "0";
  }

  // Update position indicator dots
  function updatePositionIndicator(): void {
    let indicator = scrollView.querySelector(".scroll-position-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "scroll-position-indicator";
      videoWrapper.appendChild(indicator);
    }

    const historyToShow = historyStreams.slice(-5);
    const upcomingToShow = upcomingStreams.slice(0, 5);

    let dotsHtml = "";

    historyToShow.forEach(() => {
      dotsHtml += `<div class="scroll-position-dot history" title="Previous stream"></div>`;
    });

    upcomingToShow.forEach((stream, i) => {
      const isActive = i === 0;
      dotsHtml += `<div class="scroll-position-dot ${isActive ? "active" : ""}" title="${stream.stream_id}"></div>`;
    });

    indicator.innerHTML = dotsHtml;
  }

  // Navigate to next stream (swipe up) - INSTANT because inner ring has video ready
  async function goToNextStream(): Promise<boolean> {
    // Check if we have a next stream
    if (!deck.next.stream && upcomingStreams.length <= 1) {
      // Try to fetch more streams
      const newStreams = await fetchLiveBroadcasts();
      if (newStreams.length > 0) {
        const existingIds = new Set([
          ...upcomingStreams.map(s => s.stream_id),
          ...historyStreams.map(s => s.stream_id),
        ]);
        const trulyNew = newStreams.filter(s => !existingIds.has(s.stream_id));
        upcomingStreams.push(...trulyNew);
        await updateDeck();
      }

      if (!deck.next.stream) {
        console.log("[Scroll] No more streams available");
        return false;
      }
    }

    // End watch for current stream, start watch for next
    if (watchEventId) {
      logWatchEnd(watchEventId);
      console.log(`[Scroll] Watch ended for ${currentStream?.stream_id}, event ID:`, watchEventId);
    }
    if (deck.next.stream) {
      logWatchStart(deck.next.stream.stream_id).then(id => {
        watchEventId = id;
        console.log(`[Scroll] Watch started for ${deck.next.stream?.stream_id}, event ID:`, id);
      });
    }

    // Move current to history
    if (currentStream) {
      historyStreams.push(currentStream);
      if (historyStreams.length > MAX_HISTORY) {
        historyStreams.shift();
      }
    }

    // === ROTATE DECK LEFT ===
    // 1. Remove far_prev
    if (deck.far_prev.element) {
      deck.far_prev.element.remove();
      console.log(`[Scroll] Removed far_prev: ${deck.far_prev.stream?.stream_id}`);
    }

    // 2. Demote prev → far_prev (disable video)
    deck.far_prev.element = deck.prev.element;
    deck.far_prev.stream = deck.prev.stream;
    deck.far_prev.videoEnabled = deck.prev.videoEnabled;
    if (deck.far_prev.element) {
      deck.far_prev.element.className = "scroll-deck-far_prev";
      demoteSlot(deck.far_prev); // Async, don't await
    }

    // 3. Shift current → prev (keep video, just hide)
    deck.prev.element = deck.current.element;
    deck.prev.stream = deck.current.stream;
    deck.prev.videoEnabled = deck.current.videoEnabled;
    if (deck.prev.element) {
      deck.prev.element.className = "scroll-deck-prev";
    }

    // 4. Shift next → current (already has video, instant!)
    deck.current.element = deck.next.element;
    deck.current.stream = deck.next.stream;
    deck.current.videoEnabled = deck.next.videoEnabled;
    if (deck.current.element) {
      deck.current.element.className = "scroll-deck-current";
    }

    // 5. Promote far_next → next (enable video)
    deck.next.element = deck.far_next.element;
    deck.next.stream = deck.far_next.stream;
    deck.next.videoEnabled = deck.far_next.videoEnabled;
    if (deck.next.element) {
      deck.next.element.className = "scroll-deck-next";
      promoteSlot(deck.next); // Async, don't await - video will enable in background
    }

    // 6. Clear far_next (will be populated by updateDeck)
    deck.far_next.element = null;
    deck.far_next.stream = null;
    deck.far_next.videoEnabled = false;

    // Update state
    upcomingStreams.shift();
    currentStream = deck.current.stream;

    // Update TikTok UI
    updateStreamUI(currentStream);
    if (currentStream) {
      startViewerCountRefresh(currentStream.stream_id);
    }

    // Populate new far_next
    await updateDeck();

    return true;
  }

  // Navigate to previous stream (swipe down) - INSTANT because inner ring has video ready
  async function goToPreviousStream(): Promise<boolean> {
    console.log("[Scroll] goToPreviousStream called", {
      "deck.prev.stream": deck.prev.stream?.stream_id,
      "deck.prev.element": !!deck.prev.element,
      "deck.far_prev.stream": deck.far_prev.stream?.stream_id,
      "historyStreams": historyStreams.map(s => s.stream_id),
      "upcomingStreams": upcomingStreams.map(s => s.stream_id).slice(0, 5),
    });

    if (!deck.prev.stream && historyStreams.length === 0) {
      console.log("[Scroll] No history to go back to");
      return false;
    }

    // CRITICAL: If deck.prev is empty but we have history, we need to load from history
    if (!deck.prev.stream && historyStreams.length > 0) {
      console.log("[Scroll] deck.prev is empty but history exists - rebuilding prev slot");
      const prevStream = historyStreams[historyStreams.length - 1];
      deck.prev.stream = prevStream;
      deck.prev.element = await createWatcher(prevStream, "prev");
      deck.prev.videoEnabled = true;
      if (deck.prev.element) {
        videoWrapper.appendChild(deck.prev.element);
        await promoteSlot(deck.prev);
      }
    }

    // End watch for current stream, start watch for previous
    if (watchEventId) {
      logWatchEnd(watchEventId);
      console.log(`[Scroll] Watch ended for ${currentStream?.stream_id}, event ID:`, watchEventId);
    }
    if (deck.prev.stream) {
      logWatchStart(deck.prev.stream.stream_id).then(id => {
        watchEventId = id;
        console.log(`[Scroll] Watch started for ${deck.prev.stream?.stream_id}, event ID:`, id);
      });
    }

    // Put current back at front of upcoming (if not already there)
    if (currentStream && upcomingStreams[0]?.stream_id !== currentStream.stream_id) {
      upcomingStreams.unshift(currentStream);
      console.log(`[Scroll] Added ${currentStream.stream_id} back to upcomingStreams`);
    } else {
      console.log(`[Scroll] ${currentStream?.stream_id} already in upcomingStreams, skipping unshift`);
    }

    // === ROTATE DECK RIGHT ===
    // 1. Remove far_next
    if (deck.far_next.element) {
      deck.far_next.element.remove();
      console.log(`[Scroll] Removed far_next: ${deck.far_next.stream?.stream_id}`);
    }

    // 2. Demote next → far_next (disable video)
    deck.far_next.element = deck.next.element;
    deck.far_next.stream = deck.next.stream;
    deck.far_next.videoEnabled = deck.next.videoEnabled;
    if (deck.far_next.element) {
      deck.far_next.element.className = "scroll-deck-far_next";
      demoteSlot(deck.far_next); // Async, don't await
    }

    // 3. Shift current → next (keep video, just hide)
    deck.next.element = deck.current.element;
    deck.next.stream = deck.current.stream;
    deck.next.videoEnabled = deck.current.videoEnabled;
    if (deck.next.element) {
      deck.next.element.className = "scroll-deck-next";
    }

    // 4. Shift prev → current (already has video, instant!)
    deck.current.element = deck.prev.element;
    deck.current.stream = deck.prev.stream;
    deck.current.videoEnabled = deck.prev.videoEnabled;
    if (deck.current.element) {
      deck.current.element.className = "scroll-deck-current";
    }

    // 5. Promote far_prev → prev (enable video)
    deck.prev.element = deck.far_prev.element;
    deck.prev.stream = deck.far_prev.stream;
    deck.prev.videoEnabled = deck.far_prev.videoEnabled;
    if (deck.prev.element) {
      deck.prev.element.className = "scroll-deck-prev";
      promoteSlot(deck.prev); // Async, don't await
    }

    // 6. Clear far_prev (will be populated by updateDeck)
    deck.far_prev.element = null;
    deck.far_prev.stream = null;
    deck.far_prev.videoEnabled = false;

    // Pop from history - this should match what's now in deck.current
    const previous = historyStreams.pop();
    if (!previous) {
      console.error("[Scroll] historyStreams was empty when trying to pop!");
      currentStream = deck.current.stream;
    } else if (previous.stream_id !== deck.current.stream?.stream_id) {
      console.warn(`[Scroll] Mismatch! historyStreams.pop()=${previous.stream_id} but deck.current=${deck.current.stream?.stream_id}`);
      // Use deck.current as source of truth
      currentStream = deck.current.stream;
    } else {
      currentStream = previous;
    }

    // Update TikTok UI
    updateStreamUI(currentStream);
    if (currentStream) {
      startViewerCountRefresh(currentStream.stream_id);
    }

    console.log("[Scroll] After goToPreviousStream rotation:", {
      currentStream: currentStream?.stream_id,
      "deck.current": deck.current.stream?.stream_id,
      "deck.prev": deck.prev.stream?.stream_id,
      "deck.far_prev": deck.far_prev.stream?.stream_id,
      historyStreams: historyStreams.map(s => s.stream_id),
    });

    // Populate new far_prev
    await updateDeck();

    console.log("[Scroll] After updateDeck:", {
      "deck.far_prev": deck.far_prev.stream?.stream_id,
      "deck.prev": deck.prev.stream?.stream_id,
    });

    return true;
  }

  // Touch/swipe handling
  let touchStartY = 0;
  let touchStartTime = 0;
  let isSwiping = false;

  videoWrapper.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
    isSwiping = true;
    videoWrapper.classList.remove("swiping-up", "swiping-down");
  }, { passive: true });

  videoWrapper.addEventListener("touchmove", (e) => {
    if (!isSwiping) return;

    const deltaY = touchStartY - e.touches[0].clientY;
    const threshold = 30;

    if (deltaY > threshold) {
      videoWrapper.classList.add("swiping-up");
      videoWrapper.classList.remove("swiping-down");
    } else if (deltaY < -threshold) {
      videoWrapper.classList.add("swiping-down");
      videoWrapper.classList.remove("swiping-up");
    } else {
      videoWrapper.classList.remove("swiping-up", "swiping-down");
    }
  }, { passive: true });

  videoWrapper.addEventListener("touchend", async (e) => {
    if (!isSwiping) return;
    isSwiping = false;

    const deltaY = touchStartY - (e.changedTouches[0]?.clientY || touchStartY);
    const deltaTime = Date.now() - touchStartTime;
    const velocity = Math.abs(deltaY) / deltaTime;

    // Swipe threshold: either distance > 100px or velocity > 0.5px/ms
    const isSwipe = Math.abs(deltaY) > 100 || velocity > 0.5;

    if (isSwipe) {
      if (deltaY > 0) {
        // Swipe up - go to next stream
        videoWrapper.classList.add("exiting-up");
        const success = await goToNextStream();
        if (success) {
          setTimeout(() => {
            videoWrapper.classList.remove("exiting-up");
            videoWrapper.classList.add("entering-from-bottom");
            requestAnimationFrame(() => {
              videoWrapper.classList.remove("entering-from-bottom");
            });
          }, 300);
        } else {
          videoWrapper.classList.remove("exiting-up");
        }
      } else {
        // Swipe down - go to previous stream
        videoWrapper.classList.add("exiting-down");
        const success = goToPreviousStream();
        if (success) {
          setTimeout(() => {
            videoWrapper.classList.remove("exiting-down");
            videoWrapper.classList.add("entering-from-top");
            requestAnimationFrame(() => {
              videoWrapper.classList.remove("entering-from-top");
            });
          }, 300);
        } else {
          videoWrapper.classList.remove("exiting-down");
        }
      }
    }

    videoWrapper.classList.remove("swiping-up", "swiping-down");
  });

  // Keyboard navigation (for desktop)
  document.addEventListener("keydown", async (e) => {
    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      videoWrapper.classList.add("exiting-up");
      const success = await goToNextStream();
      setTimeout(() => {
        videoWrapper.classList.remove("exiting-up");
      }, 300);
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      videoWrapper.classList.add("exiting-down");
      goToPreviousStream();
      setTimeout(() => {
        videoWrapper.classList.remove("exiting-down");
      }, 300);
    }
  });

  // Mouse wheel navigation
  let wheelTimeout: number | null = null;
  videoWrapper.addEventListener("wheel", async (e) => {
    e.preventDefault();

    // Debounce wheel events
    if (wheelTimeout) return;
    wheelTimeout = window.setTimeout(() => {
      wheelTimeout = null;
    }, 500);

    if (e.deltaY > 0) {
      // Scroll down = swipe up = next stream
      await goToNextStream();
    } else if (e.deltaY < 0) {
      // Scroll up = swipe down = previous stream
      goToPreviousStream();
    }
  }, { passive: false });

  // Log watch end on page unload
  window.addEventListener("beforeunload", () => {
    if (watchEventId) {
      logWatchEnd(watchEventId);
    }
  });

  // Initial load
  const broadcasts = await fetchLiveBroadcasts();

  if (broadcasts.length === 0) {
    showNoStreams();
  } else {
    // Sort by started_at descending (most recent first)
    broadcasts.sort((a, b) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    );
    upcomingStreams = broadcasts;
    await loadCurrentStream(upcomingStreams[0]);
  }

  // Periodic refresh of stream list
  const refreshInterval = setInterval(async () => {
    const newBroadcasts = await fetchLiveBroadcasts();
    if (newBroadcasts.length > 0) {
      // Add new streams that aren't already in our lists
      const existingIds = new Set([
        ...upcomingStreams.map(s => s.stream_id),
        ...historyStreams.map(s => s.stream_id),
        currentStream?.stream_id,
      ].filter(Boolean));

      const trulyNew = newBroadcasts.filter(s => !existingIds.has(s.stream_id));
      if (trulyNew.length > 0) {
        console.log(`[Scroll] Found ${trulyNew.length} new streams`);
        // Sort new streams by started_at (most recent first)
        trulyNew.sort((a, b) =>
          new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
        );
        // Add at position 1 (after current) to be next in queue
        upcomingStreams.splice(1, 0, ...trulyNew);
        updateDeck(); // Update preloaded streams
      }

      // If we had no streams before, load the first one
      if (!currentStream && newBroadcasts.length > 0) {
        newBroadcasts.sort((a, b) =>
          new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
        );
        upcomingStreams = newBroadcasts;
        await loadCurrentStream(upcomingStreams[0]);
      }
    }
  }, 15000); // Check every 15 seconds

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    clearInterval(refreshInterval);
  });
}

// Initialize stats view
async function initStatsView(user: User | null) {
  console.log("Earthseed.Live Stats");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create stats view container
  const container = document.querySelector(".container");
  if (!container) return;

  const statsView = document.createElement("div");
  statsView.id = "stats-view";
  statsView.className = "stats-view";

  // Check if logged in
  if (!user) {
    statsView.innerHTML = `
      <div class="stats-login-required">
        <h2>Sign in Required</h2>
        <p>Please sign in to view live statistics.</p>
        <div class="auth-buttons">
          <button id="stats-login-google" class="btn btn-google">Google</button>
          <button id="stats-login-microsoft" class="btn btn-microsoft">Microsoft</button>
          <button id="stats-login-discord" class="btn btn-discord">Discord</button>
        </div>
      </div>
    `;
    container.appendChild(statsView);
    document.getElementById("stats-login-google")?.addEventListener("click", loginWithGoogle);
    document.getElementById("stats-login-microsoft")?.addEventListener("click", loginWithMicrosoft);
    document.getElementById("stats-login-discord")?.addEventListener("click", loginWithDiscord);
    return;
  }

  // Show loading state
  statsView.innerHTML = `<p>Loading stats...</p>`;
  container.appendChild(statsView);

  // Fetch and display stats
  const renderStats = async () => {
    const stats = await getLiveStats();
    if (!stats) {
      statsView.innerHTML = `<p class="error">Failed to load stats</p>`;
      return;
    }

    const formatTime = (dateStr: string) => {
      const date = new Date(dateStr + "Z");
      return date.toLocaleTimeString();
    };

    const formatDuration = (dateStr: string) => {
      const start = new Date(dateStr + "Z");
      const now = new Date();
      const seconds = Math.floor((now.getTime() - start.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    };

    const renderGeoFlag = (geo: { geo_country: string | null; geo_city: string | null; geo_region: string | null; geo_latitude: string | null; geo_longitude: string | null; geo_timezone: string | null }, id: string) => {
      const flag = countryToFlag(geo.geo_country);
      if (!flag) return "";
      const hasCoords = geo.geo_latitude && geo.geo_longitude;
      const mapsUrl = hasCoords ? `https://www.google.com/maps/place/${geo.geo_latitude},${geo.geo_longitude}/@${geo.geo_latitude},${geo.geo_longitude},3z` : null;
      const tooltip = [
        geo.geo_city,
        geo.geo_region,
        geo.geo_country,
        geo.geo_timezone,
        hasCoords ? `${geo.geo_latitude}, ${geo.geo_longitude}` : null
      ].filter(Boolean).join(" | ");
      return `<span class="stats-flag ${hasCoords ? 'clickable' : ''}" data-id="${id}" data-url="${mapsUrl || ''}" title="${tooltip}">${flag}</span>`;
    };

    const broadcastRows = stats.broadcasts.length === 0
      ? `<tr><td colspan="5" class="empty">No active broadcasts</td></tr>`
      : stats.broadcasts.map((b: LiveBroadcast) => `
          <tr>
            <td><a href="/${b.stream_id}" target="_blank">${b.stream_id}</a></td>
            <td>
              ${b.avatar_url ? `<img src="${b.avatar_url}" class="avatar-small">` : ""}
              ${b.user_name || b.user_email}
            </td>
            <td>${renderGeoFlag(b, `b-${b.id}`)}</td>
            <td>${formatDuration(b.started_at)}</td>
            <td>${stats.viewers.filter((v: LiveViewer) => v.stream_id === b.stream_id).length}</td>
          </tr>
        `).join("");

    const viewerRows = stats.viewers.length === 0
      ? `<tr><td colspan="4" class="empty">No active viewers</td></tr>`
      : stats.viewers.map((v: LiveViewer) => `
          <tr>
            <td><a href="/${v.stream_id}" target="_blank">${v.stream_id}</a></td>
            <td>
              ${v.avatar_url ? `<img src="${v.avatar_url}" class="avatar-small">` : ""}
              ${v.user_name || v.user_email || "Anonymous"}
            </td>
            <td>${renderGeoFlag(v, `v-${v.id}`)}</td>
            <td>${formatDuration(v.started_at)}</td>
          </tr>
        `).join("");

    statsView.innerHTML = `
      <h2>Live Statistics</h2>
      <div class="stats-grid">
        <section class="stats-section">
          <h3>Active Broadcasts (${stats.broadcasts.length})</h3>
          <table class="stats-table">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Broadcaster</th>
                <th>Location</th>
                <th>Duration</th>
                <th>Viewers</th>
              </tr>
            </thead>
            <tbody>${broadcastRows}</tbody>
          </table>
        </section>
        <section class="stats-section">
          <h3>Active Viewers (${stats.viewers.length})</h3>
          <table class="stats-table">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Viewer</th>
                <th>Location</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>${viewerRows}</tbody>
          </table>
        </section>
      </div>
      <button id="refresh-stats" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
    `;

    // Add click handlers for flags
    statsView.querySelectorAll(".stats-flag.clickable").forEach((el) => {
      el.addEventListener("click", () => {
        const url = (el as HTMLElement).dataset.url;
        if (url) window.open(url, "_blank");
      });
    });

    document.getElementById("refresh-stats")?.addEventListener("click", renderStats);
  };

  await renderStats();
}

// Initialize stream-specific stats view (viewers only)
async function initStreamStatsView(streamId: string) {
  console.log(`Earthseed.Live Stream Stats - Stream: ${streamId}`);

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create stats view container
  const container = document.querySelector(".container");
  if (!container) return;

  const statsView = document.createElement("div");
  statsView.id = "stream-stats-view";
  statsView.className = "stats-view";

  // Show loading state
  statsView.innerHTML = `<p>Loading viewers...</p>`;
  container.appendChild(statsView);

  // Fetch and display viewers
  const renderViewers = async () => {
    const data = await getStreamViewers(streamId);
    if (!data) {
      statsView.innerHTML = `<p class="error">Failed to load viewers</p>`;
      return;
    }

    const formatDuration = (dateStr: string) => {
      const start = new Date(dateStr + "Z");
      const now = new Date();
      const seconds = Math.floor((now.getTime() - start.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    };

    const renderGeoFlag = (geo: { geo_country: string | null; geo_city: string | null; geo_region: string | null; geo_latitude: string | null; geo_longitude: string | null; geo_timezone: string | null }, id: string) => {
      const flag = countryToFlag(geo.geo_country);
      if (!flag) return "";
      const hasCoords = geo.geo_latitude && geo.geo_longitude;
      const mapsUrl = hasCoords ? `https://www.google.com/maps/place/${geo.geo_latitude},${geo.geo_longitude}/@${geo.geo_latitude},${geo.geo_longitude},3z` : null;
      const tooltip = [
        geo.geo_city,
        geo.geo_region,
        geo.geo_country,
        geo.geo_timezone,
        hasCoords ? `${geo.geo_latitude}, ${geo.geo_longitude}` : null
      ].filter(Boolean).join(" | ");
      return `<span class="stats-flag ${hasCoords ? 'clickable' : ''}" data-id="${id}" data-url="${mapsUrl || ''}" title="${tooltip}">${flag}</span>`;
    };

    const viewerRows = data.viewers.length === 0
      ? `<tr><td colspan="3" class="empty">No active viewers</td></tr>`
      : data.viewers.map((v: LiveViewer) => `
          <tr>
            <td>
              ${v.avatar_url ? `<img src="${v.avatar_url}" class="avatar-small">` : ""}
              ${v.user_name || v.user_email || "Anonymous"}
            </td>
            <td>${renderGeoFlag(v, `v-${v.id}`)}</td>
            <td>${formatDuration(v.started_at)}</td>
          </tr>
        `).join("");

    statsView.innerHTML = `
      <h2>Viewers for <a href="/${streamId}" class="stream-link">${streamId}</a></h2>
      <p><a href="/${streamId}/stats/map" class="view-toggle" title="View Map">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
          <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
          <line x1="8" y1="2" x2="8" y2="18"/>
          <line x1="16" y1="6" x2="16" y2="22"/>
        </svg>
      </a></p>
      <section class="stats-section">
        <h3>Active Viewers (${data.viewers.length})</h3>
        <table class="stats-table">
          <thead>
            <tr>
              <th>Viewer</th>
              <th>Location</th>
              <th>Watching for</th>
            </tr>
          </thead>
          <tbody>${viewerRows}</tbody>
        </table>
      </section>
      <button id="refresh-stream-stats" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
    `;

    // Add click handlers for flags
    statsView.querySelectorAll(".stats-flag.clickable").forEach((el) => {
      el.addEventListener("click", () => {
        const url = (el as HTMLElement).dataset.url;
        if (url) window.open(url, "_blank");
      });
    });

    document.getElementById("refresh-stream-stats")?.addEventListener("click", renderViewers);
  };

  await renderViewers();
}

// Initialize stats map view (all viewers on a map)
async function initStatsMapView(user: User | null) {
  console.log("Earthseed.Live Stats Map");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create map view container
  const container = document.querySelector(".container");
  if (!container) return;

  const mapView = document.createElement("div");
  mapView.id = "stats-map-view";
  mapView.className = "stats-view";

  // Check if logged in
  if (!user) {
    mapView.innerHTML = `
      <div class="stats-login-required">
        <h2>Sign in Required</h2>
        <p>Please sign in to view the live map.</p>
        <div class="auth-buttons">
          <button id="map-login-google" class="btn btn-google">Google</button>
          <button id="map-login-microsoft" class="btn btn-microsoft">Microsoft</button>
          <button id="map-login-discord" class="btn btn-discord">Discord</button>
        </div>
      </div>
    `;
    container.appendChild(mapView);
    document.getElementById("map-login-google")?.addEventListener("click", loginWithGoogle);
    document.getElementById("map-login-microsoft")?.addEventListener("click", loginWithMicrosoft);
    document.getElementById("map-login-discord")?.addEventListener("click", loginWithDiscord);
    return;
  }

  mapView.innerHTML = `
    <h2>Live Viewer Map</h2>
    <p><a href="/stats" class="view-toggle" title="View Table">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </a></p>
    <div id="leaflet-map" style="height: 500px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-map" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(mapView);

  const renderMap = async () => {
    const stats = await getLiveStats();
    if (!stats) return;

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Clear existing map
    mapEl.innerHTML = "";

    // @ts-expect-error Leaflet loaded from CDN
    const map = L.map("leaflet-map").setView([20, 0], 2);

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri'
    }).addTo(map);

    // Add viewer markers (blue)
    stats.viewers.forEach((v: LiveViewer) => {
      if (v.geo_latitude && v.geo_longitude) {
        const lat = parseFloat(v.geo_latitude);
        const lng = parseFloat(v.geo_longitude);
        const name = v.user_name || v.user_email || "Anonymous";
        const location = [v.geo_city, v.geo_region, v.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "viewer-marker",
            html: `<div style="background: #3b82f6; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong><br>Watching: ${v.stream_id}<br>${location}`);
      }
    });

    // Add broadcaster markers (red)
    stats.broadcasts.forEach((b: LiveBroadcast) => {
      if (b.geo_latitude && b.geo_longitude) {
        const lat = parseFloat(b.geo_latitude);
        const lng = parseFloat(b.geo_longitude);
        const name = b.user_name || b.user_email;
        const location = [b.geo_city, b.geo_region, b.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "broadcaster-marker",
            html: `<div style="background: #ef4444; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong> (Broadcaster)<br>Stream: ${b.stream_id}<br>${location}`);
      }
    });
  };

  await renderMap();
  document.getElementById("refresh-map")?.addEventListener("click", renderMap);
}

// Initialize stream-specific stats map view (viewers for one stream on a map)
async function initStreamStatsMapView(streamId: string) {
  console.log(`Earthseed.Live Stream Stats Map - Stream: ${streamId}`);

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create map view container
  const container = document.querySelector(".container");
  if (!container) return;

  const mapView = document.createElement("div");
  mapView.id = "stream-stats-map-view";
  mapView.className = "stats-view";

  mapView.innerHTML = `
    <h2>Viewer Map for <a href="/${streamId}" class="stream-link">${streamId}</a></h2>
    <p><a href="/${streamId}/stats" class="view-toggle" title="View Table">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </a></p>
    <div id="leaflet-map" style="height: 500px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-stream-map" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(mapView);

  const renderMap = async () => {
    const data = await getStreamViewers(streamId);
    if (!data) return;

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Clear existing map
    mapEl.innerHTML = "";

    // @ts-expect-error Leaflet loaded from CDN
    const map = L.map("leaflet-map").setView([20, 0], 2);

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri'
    }).addTo(map);

    // Add viewer markers
    data.viewers.forEach((v: LiveViewer) => {
      if (v.geo_latitude && v.geo_longitude) {
        const lat = parseFloat(v.geo_latitude);
        const lng = parseFloat(v.geo_longitude);
        const name = v.user_name || v.user_email || "Anonymous";
        const location = [v.geo_city, v.geo_region, v.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "viewer-marker",
            html: `<div style="background: #3b82f6; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong><br>${location}`);
      }
    });

    // Fit bounds if there are markers
    const viewersWithGeo = data.viewers.filter((v: LiveViewer) => v.geo_latitude && v.geo_longitude);
    if (viewersWithGeo.length > 0) {
      // @ts-expect-error Leaflet loaded from CDN
      const bounds = L.latLngBounds(
        viewersWithGeo.map((v: LiveViewer) => [parseFloat(v.geo_latitude!), parseFloat(v.geo_longitude!)])
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 4 });
    }
  };

  await renderMap();
  document.getElementById("refresh-stream-map")?.addEventListener("click", renderMap);
}

// Initialize greet view (broadcasters only map - public)
async function initGreetView() {
  console.log("Earthseed.Live Greet - Live Broadcasters");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create greet view container
  const container = document.querySelector(".container");
  if (!container) return;

  const greetView = document.createElement("div");
  greetView.id = "greet-view";
  greetView.className = "stats-view";

  greetView.innerHTML = `
    <h2>Live Broadcasts</h2>
    <p class="greet-subtitle">Click a marker to watch</p>
    <div id="leaflet-map" style="height: 600px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-greet" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(greetView);

  interface GreetBroadcast {
    id: number;
    stream_id: string;
    started_at: string;
    user_name: string;
    geo_country: string | null;
    geo_city: string | null;
    geo_region: string | null;
    geo_latitude: string | null;
    geo_longitude: string | null;
    viewer_count: number;
  }

  // Track map instance for proper cleanup on refresh
  // @ts-expect-error Leaflet types
  let greetMap: L.Map | null = null;

  const renderMap = async () => {
    // Fetch broadcasts from public greet endpoint
    const response = await fetch("/api/stats/greet");
    if (!response.ok) {
      const mapEl = document.getElementById("leaflet-map");
      if (mapEl) {
        mapEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #737373;">Failed to load broadcasts</div>`;
      }
      return;
    }
    const data = await response.json() as { broadcasts: GreetBroadcast[] };

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Properly destroy existing map before creating new one
    if (greetMap) {
      greetMap.remove();
      greetMap = null;
    }

    // @ts-expect-error Leaflet loaded from CDN
    greetMap = L.map("leaflet-map").setView([20, 0], 2);
    const map = greetMap;

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
    }).addTo(map);

    // Add broadcaster markers (red) with viewer count
    data.broadcasts.forEach((b: GreetBroadcast) => {
      if (b.geo_latitude && b.geo_longitude) {
        const lat = parseFloat(b.geo_latitude);
        const lng = parseFloat(b.geo_longitude);
        const name = b.user_name || "Broadcaster";
        const location = [b.geo_city, b.geo_region, b.geo_country].filter(Boolean).join(", ");
        const viewers = b.viewer_count || 0;

        // @ts-expect-error Leaflet loaded from CDN
        const marker = L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "broadcaster-marker",
            html: `<div style="background: #ef4444; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.4); cursor: pointer;"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
          })
        }).addTo(map);

        // Tooltip on hover showing viewer count
        marker.bindTooltip(`<strong>${name}</strong><br>${location}<br><span style="color: #3b82f6;">${viewers} viewer${viewers !== 1 ? 's' : ''}</span>`, {
          direction: 'top',
          offset: [0, -10]
        });

        // Click to open watch page in new tab
        marker.on('click', () => {
          window.open(`/${b.stream_id}`, '_blank');
        });
      }
    });

    // If no broadcasters with geo, show message
    const broadcastersWithGeo = data.broadcasts.filter((b: GreetBroadcast) => b.geo_latitude && b.geo_longitude);
    if (broadcastersWithGeo.length === 0) {
      mapEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #737373;">No live broadcasts at the moment</div>`;
    }
  };

  await renderMap();
  document.getElementById("refresh-greet")?.addEventListener("click", renderMap);
}

// Initialize admin view
function initAdminView() {
  console.log("Earthseed.Live Admin Panel");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create admin view container
  const container = document.querySelector(".container");
  if (!container) return;

  const adminView = document.createElement("div");
  adminView.id = "admin-view";
  adminView.className = "stats-view";

  adminView.innerHTML = `
    <h2>Admin Panel</h2>
    <div id="admin-login" class="stats-section" style="max-width: 400px; margin: 2rem auto;">
      <h3>Password Required</h3>
      <div style="display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem;">
        <input type="password" id="admin-password" placeholder="Enter admin password"
          style="background: #262626; border: 1px solid #404040; border-radius: 6px; padding: 0.75rem; color: #e5e5e5; font-size: 1rem;">
        <button id="admin-login-btn" class="btn btn-primary">Login</button>
        <p id="admin-error" style="color: #ef4444; display: none; text-align: center;"></p>
      </div>
    </div>
    <div id="admin-panel" class="stats-section" style="max-width: 600px; margin: 2rem auto; display: none;">
      <h3>Data Management</h3>
      <p style="color: #a3a3a3; margin-bottom: 1.5rem;">Warning: These actions are irreversible.</p>
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <button id="clear-broadcasts-btn" class="btn" style="background: #7f1d1d; border-color: #991b1b;">
          Clear All Broadcaster Data
        </button>
        <button id="clear-viewers-btn" class="btn" style="background: #7f1d1d; border-color: #991b1b;">
          Clear All Viewer Data
        </button>
      </div>
      <div id="admin-status" style="margin-top: 1rem; padding: 0.75rem; border-radius: 6px; display: none;"></div>
    </div>
  `;
  container.appendChild(adminView);

  let adminPassword = "";

  const showStatus = (message: string, isError: boolean) => {
    const statusEl = document.getElementById("admin-status");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.style.display = "block";
      statusEl.style.background = isError ? "#7f1d1d" : "#14532d";
      statusEl.style.color = "#e5e5e5";
    }
  };

  // Login handler
  document.getElementById("admin-login-btn")?.addEventListener("click", async () => {
    const passwordInput = document.getElementById("admin-password") as HTMLInputElement;
    const errorEl = document.getElementById("admin-error");
    adminPassword = passwordInput?.value || "";

    // Verify the password
    try {
      const response = await fetch("/api/admin/verify", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      // If we get 401, password is wrong
      if (response.status === 401) {
        if (errorEl) {
          errorEl.textContent = "Invalid password";
          errorEl.style.display = "block";
        }
        return;
      }

      // Password is correct, show the admin panel
      document.getElementById("admin-login")!.style.display = "none";
      document.getElementById("admin-panel")!.style.display = "block";
    } catch {
      if (errorEl) {
        errorEl.textContent = "Connection error";
        errorEl.style.display = "block";
      }
    }
  });

  // Clear broadcasts handler
  document.getElementById("clear-broadcasts-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to clear ALL broadcaster data? This cannot be undone.")) {
      return;
    }

    try {
      const response = await fetch("/api/admin/broadcasts", {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      if (response.ok) {
        showStatus("All broadcaster data has been cleared.", false);
      } else {
        const data = await response.json();
        showStatus(data.error || "Failed to clear data", true);
      }
    } catch {
      showStatus("Connection error", true);
    }
  });

  // Clear viewers handler
  document.getElementById("clear-viewers-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to clear ALL viewer data? This cannot be undone.")) {
      return;
    }

    try {
      const response = await fetch("/api/admin/viewers", {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      if (response.ok) {
        showStatus("All viewer data has been cleared.", false);
      } else {
        const data = await response.json();
        showStatus(data.error || "Failed to clear data", true);
      }
    } catch {
      showStatus("Connection error", true);
    }
  });

  // Handle enter key on password input
  document.getElementById("admin-password")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      document.getElementById("admin-login-btn")?.click();
    }
  });
}

// Initialize the app
async function init() {
  // Detect browser support (async for codec checks)
  browserSupport = await detectBrowserSupport();

  // For linode mode, race to find the best relay server
  if (RELAY_MODE === "linode") {
    const bestRelay = await selectBestLinodeRelay();
    RELAY_URL = `https://${bestRelay}/anon`;
  } else {
    // Luke and cloudflare-hybrid modes use fixed servers
    serverStatus.connected = true;
  }

  // Update status panels
  updateBrowserSupportPanel();
  updateServerStatusPanel();

  // Load hang components dynamically AFTER polyfill is installed
  await loadHangComponents();

  const { view, streamId } = await getRouteInfo();

  // Get user first (needed for broadcast auth check)
  const { user, geo } = await getCurrentUser();
  updateAuthUI(user, geo);

  if (view === "broadcast") {
    initBroadcastView(streamId, user);
  } else if (view === "stats") {
    await initStatsView(user);
  } else if (view === "stats-map") {
    await initStatsMapView(user);
  } else if (view === "greet") {
    await initGreetView();
  } else if (view === "scroll") {
    await initScrollView();
  } else if (view === "stream-stats") {
    await initStreamStatsView(streamId);
  } else if (view === "stream-stats-map") {
    await initStreamStatsMapView(streamId);
  } else if (view === "admin") {
    initAdminView();
  } else {
    await initWatchView(streamId, user);
  }

  // Browser support toggle
  const supportLink = document.getElementById("support-link");
  const supportPanel = document.getElementById("support-panel");
  if (supportLink && supportPanel) {
    supportLink.addEventListener("click", (e) => {
      e.preventDefault();
      supportPanel.classList.toggle("hidden");
    });
  }

  // Server status toggle
  const serverLink = document.getElementById("server-link");
  const serverPanel = document.getElementById("server-panel");
  if (serverLink && serverPanel) {
    serverLink.addEventListener("click", (e) => {
      e.preventDefault();
      serverPanel.classList.toggle("hidden");
    });
  }
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
