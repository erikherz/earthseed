// One A/V compositor for the broadcaster.
//
// It draws optional camera + screen video onto a <canvas> and mixes optional mic + system
// audio through a WebAudio graph. It exposes ONE video track (the canvas) and ONE audio track
// (the mix destination) for the whole session. Turning camera, screen or mic on and off
// changes only the INPUTS — the two published tracks keep their identity from go-live to
// teardown, so no viewer sees a track reset when the broadcaster changes what they are showing.
//
// It is also where the burn-ins live: the location/time stamp, the handle watermark and the
// link QR are drawn INTO the frame rather than overlaid in the DOM. That is the whole point of
// putting them here — they become picture, so they survive a screen recording, a re-encode and
// a screenshot, and they travel inside the end-to-end media encryption like every other pixel.
// Only someone holding the link (and the passcode, if there is one) ever sees them.
//
// ── WHY THIS CANVAS RESIZES, WHERE WALLFLOWER'S DOES NOT ────────────────────────────────────
//
// Ported from wallflower/src/media/pip-compositor.ts, which pins its canvas at a fixed
// 1280x720 and letterboxes or crops everything into it. That is correct THERE and would be
// wrong here, and the difference is not taste:
//
//   Wallflower publishes through <moq-publish>/<moq-watch>. Changing a captureStream track's
//   resolution mid-stream reconfigures the encoder, republishes the catalog and resets the
//   track — and <moq-watch> cannot re-subscribe after a reset, so every viewer freezes. A
//   fixed canvas is the only way to keep that from happening, and the price it pays is a hard
//   crop: a 720x1280 phone keeps only the middle ~32% of its vertical field of view.
//
//   earthseed owns its encoder and its renderer. startBroadcast() in earthseed.js already
//   re-sizes and reconfigures when the source's displayed dimensions move — that is the
//   portrait/landscape rotation path, and it has been the behaviour since 7503a51. The viewer
//   tracks displayWidth/displayHeight per frame and re-syncs on the next keyframe.
//
// So this canvas follows its base layer (the screen share if there is one, else the camera)
// and the whole frame is published. A portrait phone stays portrait. The cost is a keyframe
// whenever the size actually changes, which is why resizes are rate-limited below rather than
// tracked frame by frame.
//
// The orientation half of Wallflower's fix IS kept, because it is right everywhere: compositing
// through ctx.drawImage(video, …) renders the frame AS DISPLAYED on every browser, including
// iOS Safari, where `new VideoFrame(videoElement)` hands back un-rotated sensor pixels.
//
// ── THE EXTRA COPY, NAMED RATHER THAN HIDDEN ────────────────────────────────────────────────
//
// The composite reaches the encoder as a canvas captureStream track, which startBroadcast()
// then plays into its own <video> and draws into its own canvas. That is one full-frame
// drawImage per encoded frame more than strictly necessary. It buys keeping ONE capture path
// in earthseed.js — the one that already handles rotation, dedup by currentTime and a timer
// that survives a hidden tab — instead of a second one that would drift out of step with it.

import { encodeQr } from "./qr.js";

/** @typedef {import("./qr.js").QrMatrix} QrMatrix */

// Long edge of the published frame. A 5K display shared at native size would otherwise ask the
// encoder for a picture nobody can decode in real time on the other end.
const MAX_EDGE = 1920;
// A source that jitters by a pixel (a window being dragged, a camera settling) must not cost a
// keyframe each time. Nothing below this, and never more often than once a second.
const RESIZE_MIN_DELTA = 16;
const RESIZE_MIN_INTERVAL_MS = 1000;

/**
 * When the video frame currently on the canvas was captured, for the burn-in.
 *
 * The distinction is the whole point. drawImage() composites the frame the camera exposed some
 * time ago — camera pipeline plus delivery into the page, tens of milliseconds on a laptop and
 * more on a phone — so a timestamp taken at draw time says the picture is newer than it is, by
 * an amount that is the same order as the latency the stamp exists to measure.
 *
 * requestVideoFrameCallback reports the real thing, in the performance.now() timebase, which is
 * exactly the timebase the edge clock is anchored to. So `captureTime` converts to UTC with one
 * addition and no second measurement.
 *
 * `source` says how the instant was obtained, so the caller can be honest about it:
 *   "capture"      — the camera's own capture time. What we want.
 *   "presentation" — when the browser submitted the frame for composition. Later than capture
 *                    by the pipeline delay, so an approximation, not the answer.
 *   "draw"         — nothing available; the caller falls back to now and marks it approximate.
 *
 * @typedef {{captureTime: number|null, source: "capture"|"presentation"|"draw"}} StampFrameInfo
 */

/** Which way a camera points. The only two values getUserMedia's facingMode agrees on.
 *  @typedef {"user"|"environment"} CameraFacing */

const NO_FRAME_TIMING = /** @type {StampFrameInfo} */ ({ captureTime: null, source: "draw" });

/**
 * Subscribe to per-frame metadata for one source. Returns an unsubscribe.
 *
 * Safe on browsers without rVFC (Firefox at time of writing): the callback simply never fires,
 * `set` is never called, and the burn-in falls back to draw time and says so.
 *
 * @param {HTMLVideoElement} v
 * @param {(f: StampFrameInfo) => void} set
 * @returns {() => void}
 */
function trackFrameTiming(v, set) {
  const fv = /** @type {any} */ (v);
  if (typeof fv.requestVideoFrameCallback !== "function") return () => {};
  let handle = 0;
  let cancelled = false;
  /** @param {number} _now @param {{captureTime?:number, presentationTime?:number}} md */
  const step = (_now, md) => {
    if (cancelled) return;
    // captureTime is only populated for sources where the UA knows it (getUserMedia and
    // WebRTC). presentationTime is always there but means something weaker — see above.
    const capture = typeof md?.captureTime === "number" ? md.captureTime : null;
    const presentation = typeof md?.presentationTime === "number" ? md.presentationTime : null;
    set(
      capture != null
        ? { captureTime: capture, source: "capture" }
        : presentation != null
          ? { captureTime: presentation, source: "presentation" }
          : NO_FRAME_TIMING,
    );
    handle = fv.requestVideoFrameCallback(step);
  };
  handle = fv.requestVideoFrameCallback(step);
  return () => {
    cancelled = true;
    try {
      fv.cancelVideoFrameCallback?.(handle);
    } catch {}
  };
}

/** @param {MediaStream} stream @returns {HTMLVideoElement} */
function mkVideo(stream) {
  const v = document.createElement("video");
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  void v.play().catch(() => {});
  return v;
}

/**
 * Encode a link for the burn-in, or null when it will not fit at a size a camera can read.
 *
 * Exposed here rather than left to the caller so that the one place that knows the module-size
 * floor is the one place that decides whether a URL fits. Level M and a version cap of 10 are
 * the same pair Wallflower settled on: past version 10 a symbol needs more modules than the
 * plate can give 6 real pixels each.
 *
 * @param {string} url
 * @returns {QrMatrix|null}
 */
export function encodeLinkQr(url) {
  return encodeQr(url, { ecl: "M", maxVersion: 10 });
}

/**
 * Build a compositor. Nothing is captured until a source is enabled.
 * @returns {ReturnType<typeof build>}
 */
export function createCompositor() {
  return build();
}

function build() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // ---- Video sources (added/removed on demand) ----
  /** @type {{stream:MediaStream, video:HTMLVideoElement}|null} */ let screen = null;
  /** @type {{stream:MediaStream, video:HTMLVideoElement}|null} */ let camera = null;

  // Per-frame capture timing for each source, kept current by requestVideoFrameCallback.
  //
  // The read in draw() is race-free by spec: video frame callbacks run BEFORE animation frame
  // callbacks within the same rendering opportunity, so by the time draw() executes, these
  // describe the very frame drawImage() is about to composite.
  /** @type {StampFrameInfo|null} */ let cameraFrame = null;
  /** @type {StampFrameInfo|null} */ let screenFrame = null;
  /** @type {(()=>void)|null} */ let untrackCamera = null;
  /** @type {(()=>void)|null} */ let untrackScreen = null;

  // Remembered across an off/on cycle so a broadcaster who chose the back camera does not
  // silently get the front one back when they toggle Camera off and on again.
  /** @type {CameraFacing} */ let facing = "user";
  let facingLive = false;
  // The handlers the caller registered. switchCamera tears the camera down and builds it again,
  // and those listeners have to survive that or the second camera loses its
  // taken-away-by-the-OS detection.
  /** @type {{facing?:CameraFacing, onEnded?:()=>void, onMuteChange?:(m:boolean)=>void}|null} */
  let cameraOpts = null;

  let stopped = false;

  // ---- Frame size, following the base layer ----
  //
  // `S` scales every drawn ornament with the frame, so a 480-tall camera does not get a stamp
  // strip taller than its own chin and a 1080-tall screen share does not get an invisible one.
  // Clamped at both ends: past these the ornaments stop being proportionate and start being
  // either unreadable or the whole picture.
  const scaleOf = () => Math.max(0.6, Math.min(2, canvas.height / 720));
  let lastResize = 0;
  let sized = false; // has a real source ever driven the size, or is this still the placeholder?
  const baseVideo = () => screen?.video ?? camera?.video ?? null;

  const resizeIfNeeded = () => {
    const base = baseVideo();
    if (!base?.videoWidth || !base.videoHeight) return;
    const scale = Math.min(1, MAX_EDGE / Math.max(base.videoWidth, base.videoHeight));
    // Even dimensions: every codec here wants them, and an odd width is a silent half-pixel
    // chroma problem rather than an error.
    const w = Math.max(2, Math.round((base.videoWidth * scale) / 2) * 2);
    const h = Math.max(2, Math.round((base.videoHeight * scale) / 2) * 2);
    if (w === canvas.width && h === canvas.height) return;
    const now = performance.now();
    // The FIRST source-driven size applies immediately: the canvas is still at its placeholder
    // and nothing has been published yet, so there is no keyframe to spend. After that a change
    // has to be both worth having and not too soon after the last one, because a window being
    // dragged otherwise costs the encoder a keyframe every frame for the length of the drag.
    if (sized) {
      const big = Math.abs(w - canvas.width) >= RESIZE_MIN_DELTA || Math.abs(h - canvas.height) >= RESIZE_MIN_DELTA;
      if (!big || now - lastResize < RESIZE_MIN_INTERVAL_MS) return;
    }
    sized = true;
    lastResize = now;
    // Everything the broadcaster placed by hand is in canvas units, so carry it proportionally
    // rather than letting the layout jump when a shared window is resized.
    const fx = w / canvas.width;
    const fy = h / canvas.height;
    px *= fx;
    py *= fy;
    qrX *= fx;
    qrY *= fy;
    canvas.width = w;
    canvas.height = h;
    // The plate is rendered at whole pixels per module, so it has to be rebuilt rather than
    // scaled — see renderQrPlate.
    qrTargetPx = null;
    renderQrPlate(qrMatrix);
  };

  // Letterbox a video into the whole canvas, preserving aspect ratio (fits inside, may leave
  // bars). Used for screen shares, where cropping would hide content.
  /** @param {HTMLVideoElement} v */
  const drawContain = (v) => {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(canvas.width / vw, canvas.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(v, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  };

  // Fill the whole canvas with a video, cropping the overflow. Only reachable when the canvas
  // and the source have drifted apart — normally the camera IS the canvas's shape, so this
  // draws the full frame with nothing lost.
  /** @param {HTMLVideoElement} v */
  const drawCover = (v) => {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(canvas.width / vw, canvas.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(v, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  };

  // ---- Camera inset (only when screen + camera) ----
  //
  // Drag the middle to move it, drag an edge or a corner to resize. Default ~28% of frame
  // width, bottom-right. Resizing changes only this rect — the inset is composited content, so
  // it can be any size at any moment and no viewer notices anything but the picture moving.
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 0.75;
  let insetScale = 0.28;
  let px = 0;
  let py = 0;
  let placed = false;
  const camAspect = () => {
    const cw = camera?.video.videoWidth || 16;
    const ch = camera?.video.videoHeight || 9;
    return cw / ch;
  };
  const insetW = () => Math.round(canvas.width * insetScale);
  const insetH = () => Math.round(insetW() / camAspect());
  // The HEIGHT limit is what bites first on a portrait camera: at 3:4 a 75%-wide inset would be
  // taller than the frame. Cap by whichever constraint is tighter.
  /** @param {number} v */
  const clampScale = (v) =>
    Math.max(MIN_SCALE, Math.min(v, MAX_SCALE, (canvas.height / canvas.width) * camAspect()));

  /** @typedef {"nw"|"n"|"ne"|"e"|"se"|"s"|"sw"|"w"|"move"} Zone */
  /** @type {Zone[]} */
  const HANDLE_ZONES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const CURSOR = {
    nw: "nwse-resize", se: "nwse-resize",
    ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize",
    e: "ew-resize", w: "ew-resize",
    move: "grab",
  };
  // In canvas units, scaled with the frame: the canvas is displayed at up to ~900 CSS px, so
  // this lands near 14 real pixels — grabbable with a mouse without the edge band eating a
  // small inset's whole interior.
  const handleBand = () => 20 * scaleOf();

  // Hit-test an arbitrary rect, so the camera inset and the QR plate share one set of rules
  // rather than growing two subtly different ones.
  /** @param {{x:number,y:number}} pt @returns {Zone|null} */
  const zoneIn = (pt, x, y, w, h) => {
    const H = handleBand();
    if (pt.x < x - H || pt.x > x + w + H) return null;
    if (pt.y < y - H || pt.y > y + h + H) return null;
    const l = Math.abs(pt.x - x) <= H;
    const r = Math.abs(pt.x - (x + w)) <= H;
    const t = Math.abs(pt.y - y) <= H;
    const b = Math.abs(pt.y - (y + h)) <= H;
    if (t && l) return "nw";
    if (t && r) return "ne";
    if (b && l) return "sw";
    if (b && r) return "se";
    if (t) return "n";
    if (b) return "s";
    if (l) return "w";
    if (r) return "e";
    return pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h ? "move" : null;
  };
  /** @param {{x:number,y:number}} pt @returns {Zone|null} */
  const zoneAt = (pt) => (screen && camera ? zoneIn(pt, px, py, insetW(), insetH()) : null);

  // ---- Burn-in strip (location + time), drawn last so nothing can cover it ----
  //
  // Cost to be aware of: the millisecond field changes every frame, so this strip is
  // permanently "moving" and never inter-predicts away. It is a small fraction of the frame,
  // but it is not free at a low bitrate cap.
  /** @type {((frame: StampFrameInfo) => string)|null} */ let stampProvider = null;
  /** @param {StampFrameInfo} frame */
  const drawStamp = (frame) => {
    if (!stampProvider) return;
    let text = "";
    try {
      text = stampProvider(frame);
    } catch {
      return; // a throwing provider must not take down the whole draw loop
    }
    if (!text) return;
    const S = scaleOf();
    const h = Math.round(40 * S);
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, canvas.height - h, canvas.width, h);
    // Monospace so the digits don't shimmy as the milliseconds turn over.
    ctx.font = `600 ${Math.round(22 * S)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    // maxWidth squeezes rather than overflows if a future line grows.
    ctx.fillText(text, canvas.width / 2, canvas.height - h / 2 + 1, canvas.width - 32 * S);
    ctx.restore();
  };

  // ---- Handle watermark (upper left) ----
  //
  // Subtle on purpose: semi-transparent white with a soft dark shadow, no plate behind it. The
  // shadow is what keeps it legible over a white slide as well as a dark room — without it,
  // "subtle" becomes "invisible" on half the content people actually broadcast. Static text, so
  // it costs the encoder nothing after the first frame.
  /** @type {string|null} */ let watermark = null;
  const drawWatermark = () => {
    if (!watermark) return;
    const S = scaleOf();
    ctx.save();
    ctx.font = `600 ${Math.round(26 * S)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = 6 * S;
    ctx.shadowOffsetY = S;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillText(watermark, 28 * S, 24 * S, canvas.width * 0.6);
    ctx.restore();
  };

  // ---- Link QR (upper right) ----
  //
  // THIS ONE CANNOT BE SUBTLE, AND THAT IS THE WHOLE DESIGN CONSTRAINT.
  //
  // The watermark above is drawn at 62% white with no plate because it only has to be readable
  // by a person, who will forgive low contrast. A QR has to be readable by a camera through a
  // video codec, and both of those punish exactly what makes a watermark tasteful:
  //
  //  - Transparency is out, but not for the reason it looks like — see QR_LIGHT below, where it
  //    was measured against the alternative and lost on both axes at once.
  //  - Small is out. Below roughly four canvas pixels per module, inter-frame compression
  //    smears adjacent modules together and the symbol dies — so MODULE size, not plate size,
  //    is what gets held fixed here.
  //  - The quiet zone is not optional. The standard requires four light modules of margin;
  //    without it a scanner cannot find the symbol's edge at all.
  //
  // Rendered once to an offscreen canvas when the URL is set, then blitted per frame. Drawing
  // ~1,700 fillRects sixty times a second would be absurd for a picture that never changes.
  //
  // The sizes below are MEASURED, not chosen (wallflower, 2026-08). The test that produced them
  // renders a symbol at this geometry over textured content, scales the frame down the way a
  // viewer's window does, JPEG-compresses it as a stand-in for a bitrate-starved encoder, and
  // tries to decode the result with OpenCV. A 176px target with a 4px floor decoded perfectly
  // at full resolution and fell apart as soon as the frame was scaled — the ordinary case, not
  // an edge one, since almost nobody watches a 1280-wide video at exactly 1280 pixels. At
  // 232/6 everything tested decodes at full and three-quarter scale. Below half scale it stays
  // patchy, and that is worth stating plainly rather than tuning until a number looks good.
  //
  // The target and the cap are expressed as fractions of frame HEIGHT because this canvas
  // resizes; 232 and 460 were the pixel values on Wallflower's fixed 720-tall frame.
  const QR_TARGET_FRAC = 232 / 720;
  const QR_MAX_FRAC = 460 / 720; // past ~64% of frame height it stops being a video with a QR on it
  // The one constant that stays in ABSOLUTE pixels. It is about surviving a codec, and a codec
  // does not care what fraction of the frame a module is — six real pixels is six real pixels.
  // On a small frame that can make the floor larger than the default target, and the plate
  // comes out proportionally bigger. That is the honest answer: a smaller one would not be a
  // smaller QR, it would be a decoration no phone can read.
  const QR_MODULE_MIN_PX = 6;
  const QR_QUIET = 4; // light modules of margin, per the standard

  // The plate's two tones. NOT pure white and black, and not transparent either — this is the
  // one setting here that went through a wrong answer first, so the reasoning is worth keeping.
  //
  // The obvious way to make a watermark less obtrusive is to make it see-through, the way the
  // handle above is. Measured, that is the WORSE of the two available levers, on both axes at
  // once. Alpha lets background texture into the quiet zone, and the quiet zone is what a
  // scanner uses to find the symbol's edge — so transparency starts failing over busy content
  // at around 0.70, while only reaching a plate brightness of ~192/255. Anything gentle enough
  // to notice was already too damaged to scan.
  //
  // Muting the palette instead keeps the plate perfectly uniform, so the quiet zone stays clean
  // and the local contrast a decoder needs is untouched — both tones simply move down together.
  // 170/40 reads softer than transparency ever managed and decoded 8/8 across dark, light and
  // busy backgrounds through the full degradation. Going darker still (120/20) starts costing
  // decodes over a white slide. Re-measure before changing either.
  const QR_LIGHT = "#aaaaaa"; // 170 — the plate and its quiet zone
  const QR_DARK = "#282828";  // 40  — the modules

  /** @type {HTMLCanvasElement|null} */ let qrPlate = null;
  // Kept so a resize can re-render from the same symbol without asking the caller to encode
  // again — the caller's job is deciding whether a URL fits at all, and that answer does not
  // change when the broadcaster drags a corner or a shared window changes shape.
  /** @type {QrMatrix|null} */ let qrMatrix = null;
  // null means "whatever the default is for the current frame size"; a number is a size the
  // broadcaster chose by dragging, which survives a URL change but not a frame resize.
  /** @type {number|null} */ let qrTargetPx = null;
  let qrX = 0;
  let qrY = 0;
  let qrPlaced = false;

  // Keep the whole plate on the canvas. A half-cropped QR is not merely untidy: the quiet zone
  // is what a scanner uses to find the symbol's edge, so a clipped one stops being findable.
  const clampQr = () => {
    if (!qrPlate) return;
    qrX = Math.max(0, Math.min(qrX, canvas.width - qrPlate.width));
    qrY = Math.max(0, Math.min(qrY, canvas.height - qrPlate.height));
  };

  /** @param {{x:number,y:number}} pt @returns {Zone|null} */
  const qrZoneAt = (pt) => (qrPlate ? zoneIn(pt, qrX, qrY, qrPlate.width, qrPlate.height) : null);

  /** @param {QrMatrix|null} matrix */
  const renderQrPlate = (matrix) => {
    qrMatrix = matrix;
    if (!matrix) {
      qrPlate = null;
      return;
    }
    const total = matrix.size + QR_QUIET * 2;
    const target = qrTargetPx ?? canvas.height * QR_TARGET_FRAC;
    // Whole pixels per module at EVERY size, which is why resizing re-renders the plate rather
    // than scaling the bitmap: drawImage at a fractional scale anti-aliases modules into grey,
    // the one tone a decoder cannot classify. The visible consequence is that a corner drag
    // steps between scannable sizes instead of sliding smoothly, and that is the honest
    // behaviour — every size it stops at is one that actually scans.
    const mod = Math.max(QR_MODULE_MIN_PX, Math.floor(target / total));
    const side = total * mod;

    const plate = document.createElement("canvas");
    plate.width = side;
    plate.height = side;
    const pctx = plate.getContext("2d");
    if (!pctx) return;
    pctx.fillStyle = QR_LIGHT;
    pctx.fillRect(0, 0, side, side);
    pctx.fillStyle = QR_DARK;
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (matrix.get(x, y)) pctx.fillRect((x + QR_QUIET) * mod, (y + QR_QUIET) * mod, mod, mod);
      }
    }
    qrPlate = plate;
    if (!qrPlaced) {
      // First appearance keeps the original home, inset from the top and right edges, matching
      // the watermark's margin. After that the broadcaster's own placement survives a URL
      // change, which is the point.
      const margin = 24 * scaleOf();
      qrX = canvas.width - side - margin;
      qrY = margin;
      qrPlaced = true;
    }
    clampQr();
  };

  const drawLinkQr = () => {
    if (!qrPlate) return;
    ctx.save();
    // A soft shadow separates the plate from similarly-toned content behind it. It falls
    // outside the plate, so it never touches a module or the quiet zone. Drawn OPAQUE — see
    // QR_LIGHT for why transparency was measured and rejected.
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 12 * scaleOf();
    ctx.drawImage(qrPlate, qrX, qrY);
    ctx.restore();
  };

  // ---- The draw loop ----
  //
  // Scheduled two different ways, and which one runs depends on whether anybody can see this
  // tab. requestAnimationFrame does not fire in a hidden tab, and canvas.captureStream() only
  // produces a frame when the canvas is painted. So a broadcaster who switched to another tab —
  // to open their own share link, say — would stop sending pictures, and everyone watching
  // would freeze on the last frame with nothing erroring: still connected, status still green,
  // audio still flowing (WebAudio is not rAF-driven), only the picture stopped.
  //
  // Measured on Wallflower 2026-08-29: rAF 60/s visible, 0/s hidden. setInterval 30/s in BOTH,
  // because a page holding a live getUserMedia capture is exempt from Chrome's intensive
  // background timer throttling. So the timer is a real fallback here, not a 1fps token one.
  let raf = 0;
  const HIDDEN_FRAME_MS = 1000 / 30;
  /** @type {ReturnType<typeof setInterval>|null} */ let timer = null;

  const draw = () => {
    resizeIfNeeded();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (screen) {
      drawContain(screen.video);
      if (camera) {
        const w = insetW();
        const h = insetH();
        if (!placed && w && h) {
          const m = 24 * scaleOf();
          px = canvas.width - w - m;
          py = canvas.height - h - m;
          placed = true;
        }
        px = Math.max(0, Math.min(px, canvas.width - w));
        py = Math.max(0, Math.min(py, canvas.height - h));
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 14 * scaleOf();
        ctx.drawImage(camera.video, px, py, w, h);
        ctx.restore();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2 * scaleOf();
        ctx.strokeRect(px, py, w, h);
      }
    } else if (camera) {
      drawCover(camera.video);
    }
    // Stamp the CAMERA's capture time when a camera is on, even while it is the small inset
    // over a screen share: the camera is the source that witnesses the physical world, which is
    // what a provenance stamp is about. Screen-only stamps the screen grab. Neither present
    // (audio-only, or before the first frame) falls through to "draw".
    drawWatermark();
    drawLinkQr();
    drawStamp((camera ? cameraFrame : screen ? screenFrame : null) ?? NO_FRAME_TIMING);
    syncChrome();
  };

  const stopLoop = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  // One frame, and never a thrown one.
  //
  // The re-schedule must not live at the end of draw(): any exception anywhere in it would then
  // silently end the broadcast for good — the canvas keeps its last picture and goes on being
  // published. Nothing in draw() is expected to throw, which is exactly why it must not be able
  // to take the loop with it if it ever does.
  let drawFailed = false;
  const paint = () => {
    try {
      draw();
    } catch (e) {
      // Once, not sixty times a second. A loop that failed every frame would bury the first and
      // most useful report under thousands of copies of itself.
      if (!drawFailed) {
        drawFailed = true;
        console.error("[compositor] draw failed; the loop continues", e);
      }
    }
  };

  const startLoop = () => {
    stopLoop();
    if (stopped) return;
    if (document.hidden) {
      timer = setInterval(paint, HIDDEN_FRAME_MS);
    } else {
      const tick = () => {
        paint();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
  };

  const onVisibility = () => startLoop();
  document.addEventListener("visibilitychange", onVisibility);
  startLoop();

  // ---- Move and resize, by pointer ----
  /** @type {Zone|null} */ let mode = null;         // what the pointer grabbed, null when idle
  /** @type {"cam"|"qr"|null} */ let target = null; // WHICH object it grabbed
  /** @type {Zone|null} */ let hover = null;        // what it is merely over, for the chrome
  /** @type {"cam"|"qr"|null} */ let hoverTarget = null;
  let dx = 0;
  let dy = 0;
  let anchorX = 0; // the corner held FIXED while resizing: the box grows away from the hand
  let anchorY = 0;
  /** @param {PointerEvent} e */
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    const p = toCanvas(e);
    // The QR is drawn over the inset, so where they overlap it wins the pointer — grabbing what
    // is visibly on top is the only behaviour that is not a surprise.
    const qz = qrZoneAt(p);
    const z = qz ?? zoneAt(p);
    if (!z) return;
    target = qz ? "qr" : "cam";
    mode = z;
    hover = z;
    hoverTarget = target;
    const ox = target === "qr" ? qrX : px;
    const oy = target === "qr" ? qrY : py;
    const ow = target === "qr" ? qrPlate?.width ?? 0 : insetW();
    const oh = target === "qr" ? qrPlate?.height ?? 0 : insetH();
    if (z === "move") {
      dx = p.x - ox;
      dy = p.y - oy;
      canvas.style.cursor = "grabbing";
    } else {
      // Anchor the OPPOSITE edge/corner. Dragging the north-west handle keeps the south-east
      // corner planted, which is what every image editor does and what the hand expects.
      anchorX = z.includes("w") ? ox + ow : ox;
      anchorY = z.includes("n") ? oy + oh : oy;
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = toCanvas(e);
    if (!mode) {
      const qz = qrZoneAt(p);
      hover = qz ?? zoneAt(p);
      hoverTarget = hover ? (qz ? "qr" : "cam") : null;
      canvas.style.cursor = hover ? CURSOR[hover] : "";
      return;
    }
    if (target === "qr") {
      if (mode === "move") {
        qrX = p.x - dx;
        qrY = p.y - dy;
        clampQr();
        return;
      }
      // The plate is square, so one axis is enough and a corner follows the bolder of the two.
      // Re-render rather than scale — see renderQrPlate for why that is not optional.
      const fx = mode.includes("w") ? anchorX - p.x : p.x - anchorX;
      const fy = mode.includes("n") ? anchorY - p.y : p.y - anchorY;
      let side;
      if (mode === "n" || mode === "s") side = fy;
      else if (mode === "e" || mode === "w") side = fx;
      else side = Math.max(fx, fy);
      qrTargetPx = Math.max(0, Math.min(side, canvas.height * QR_MAX_FRAC));
      renderQrPlate(qrMatrix);
      if (qrPlate) {
        // Re-derive the origin from the anchor so the held corner does not creep as the module
        // size quantises underneath it.
        qrX = mode.includes("w") ? anchorX - qrPlate.width : anchorX;
        qrY = mode.includes("n") ? anchorY - qrPlate.height : anchorY;
        clampQr();
      }
      return;
    }
    if (mode === "move") {
      px = p.x - dx;
      py = p.y - dy;
      return;
    }
    // ASPECT IS LOCKED — "resize at scale". One axis drives and the other follows, so the
    // camera is never stretched and the published inset always matches the sensor's shape.
    const a = camAspect();
    const fromX = mode.includes("w") ? anchorX - p.x : p.x - anchorX;
    const fromY = mode.includes("n") ? anchorY - p.y : p.y - anchorY;
    let want;
    if (mode === "n" || mode === "s") want = fromY * a;   // vertical edge: height drives
    else if (mode === "e" || mode === "w") want = fromX;  // horizontal edge: width drives
    else want = Math.max(fromX, fromY * a);               // corner: follow the bolder axis
    insetScale = clampScale(want / canvas.width);
    px = mode.includes("w") ? anchorX - insetW() : anchorX;
    py = mode.includes("n") ? anchorY - insetH() : anchorY;
  });
  /** @param {PointerEvent} e */
  const endDrag = (e) => {
    mode = null;
    target = null;
    const p = toCanvas(e);
    const qz = qrZoneAt(p);
    hover = qz ?? zoneAt(p);
    hoverTarget = hover ? (qz ? "qr" : "cam") : null;
    canvas.style.cursor = hover ? CURSOR[hover] : "";
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (mode) return; // a capture is in progress; leaving the box is normal mid-drag
    hover = null;
    hoverTarget = null;
    canvas.style.cursor = "";
  });

  // ---- Move/resize chrome, drawn in the DOM and deliberately NOT into the canvas ----
  //
  // The canvas IS the published video, so every pixel ctx draws reaches every viewer. The thin
  // white outline around the inset is drawn in because it is framing — it belongs in the
  // picture. Hover handles do not: they would blink into the broadcast each time the publisher
  // moved their mouse, showing the audience an interface they cannot use.
  //
  // So the interactive chrome is a plain <div> positioned over the canvas, tracking the same
  // rect in CSS pixels. It costs nothing in the encoder and no viewer can ever see it.
  /** @typedef {{el: HTMLDivElement|null, key: string}} Chrome */
  /** @type {Chrome} */ const camChrome = { el: null, key: "" };
  /** @type {Chrome} */ const qrChrome = { el: null, key: "" };

  /** @param {Chrome} c @returns {HTMLDivElement|null} */
  const ensureChrome = (c) => {
    if (c.el) return c.el;
    const parent = canvas.parentElement;
    if (!parent) return null; // not mounted yet; try again next frame
    if (!parent.style.position) parent.style.position = "relative";
    const el = document.createElement("div");
    // pointer-events:none throughout — the canvas owns all the hit testing, and a handle that
    // swallowed the pointer would break the drag it is supposed to advertise.
    el.style.cssText =
      "position:absolute;pointer-events:none;display:none;box-sizing:border-box;z-index:5;" +
      "border:2px solid rgba(96,165,250,0.95);border-radius:4px;" +
      "box-shadow:0 0 0 1px rgba(0,0,0,0.45),0 0 12px rgba(59,130,246,0.35);";
    for (const z of HANDLE_ZONES) {
      const h = document.createElement("div");
      const vert = z.includes("n") ? "top:-6px;" : z.includes("s") ? "bottom:-6px;" : "top:calc(50% - 5px);";
      const horz = z.includes("w") ? "left:-6px;" : z.includes("e") ? "right:-6px;" : "left:calc(50% - 5px);";
      h.style.cssText =
        "position:absolute;width:10px;height:10px;box-sizing:border-box;background:#fff;" +
        "border:1px solid rgba(30,64,175,0.9);border-radius:2px;" + vert + horz;
      el.appendChild(h);
    }
    parent.appendChild(el);
    c.el = el;
    return el;
  };

  // Called once per drawn frame, but only WRITES when the rect actually changed — otherwise
  // this would touch layout 60 times a second for a box that is usually sitting still.
  /** @param {Chrome} c */
  const syncOne = (c, wanted, x, y, w, h) => {
    const el = wanted ? ensureChrome(c) : c.el;
    if (!el) return;
    if (!wanted) {
      if (el.style.display !== "none") el.style.display = "none";
      c.key = "";
      return;
    }
    const shown = canvas.clientWidth;
    if (!shown) return; // laid out at zero width (hidden tab); nothing sensible to draw
    const scale = shown / canvas.width;
    const key = `${Math.round(x)}|${Math.round(y)}|${Math.round(w)}|${Math.round(h)}|${scale.toFixed(4)}|${canvas.offsetLeft}|${canvas.offsetTop}`;
    if (key === c.key) return;
    c.key = key;
    el.style.display = "block";
    el.style.left = `${canvas.offsetLeft + x * scale}px`;
    el.style.top = `${canvas.offsetTop + y * scale}px`;
    el.style.width = `${w * scale}px`;
    el.style.height = `${h * scale}px`;
  };

  // Only ever ONE outline at a time: the object under the hand, or the one being dragged.
  // Showing both would advertise handles the pointer is not going to reach, since the QR takes
  // the pointer wherever the two overlap.
  const syncChrome = () => {
    const active = mode !== null ? target : hoverTarget;
    syncOne(camChrome, !!(screen && camera) && active === "cam", px, py, insetW(), insetH());
    syncOne(qrChrome, !!qrPlate && active === "qr", qrX, qrY, qrPlate?.width ?? 0, qrPlate?.height ?? 0);
  };

  // ---- Audio mix: one stable output track; mic + system audio are inputs ----
  const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  const ac = new AC();
  const dest = ac.createMediaStreamDestination();

  // Autoplay policy (especially Safari): an AudioContext can start or stay "suspended", and a
  // suspended context's MediaStreamDestination publishes SILENCE. That is exactly the
  // "everything looks live but there is no sound" symptom, and it is invisible from inside the
  // page. We resume on the next user gesture — a guaranteed activation, unlike a resume() called
  // after an await — and detach the listener once it is running.
  const onGesture = () => {
    ac.resume()
      .then(() => {
        if (ac.state === "running") document.removeEventListener("pointerdown", onGesture);
      })
      .catch(() => {});
  };
  document.addEventListener("pointerdown", onGesture);
  /** @type {MediaStream|null} */ let micStream = null;
  /** @type {MediaStreamAudioSourceNode|null} */ let micNode = null;
  /** @type {MediaStreamAudioSourceNode|null} */ let sysNode = null;

  // ---- The published tracks. Their identity never changes for the session. ----
  const composite = canvas.captureStream(30);
  const videoTrack = composite.getVideoTracks()[0];
  const audioTrack = dest.stream.getAudioTracks()[0];

  const api = {
    videoTrack,
    audioTrack,
    canvas,
    /** Everything startBroadcast() needs, as one stream. */
    stream: () => new MediaStream([videoTrack, audioTrack]),
    hasCamera: () => !!camera,
    hasScreen: () => !!screen,
    hasMic: () => !!micStream,

    /**
     * Resolve once a source has actually sized the frame — or after `ms`, whichever comes first.
     *
     * Worth waiting for: the encoder downstream configures itself from the first dimensions it
     * sees, so connecting while the canvas is still at its placeholder size means configuring
     * for 1280x720 and then reconfiguring (and spending a keyframe) a frame or two later, on
     * every portrait phone. The timeout is there because an answer is better than a hang: a
     * source that never reports dimensions still gets published, at the placeholder size.
     * @param {number} [ms]
     */
    async ready(ms = 3000) {
      const t0 = performance.now();
      while (!sized && !stopped && performance.now() - t0 < ms) {
        await new Promise((r) => setTimeout(r, 30));
      }
      return sized;
    },

    /**
     * Start the camera.
     *
     * `onEnded` fires when the SOURCE goes away by itself — the OS handing the camera to another
     * app, a USB camera unplugged, a driver reset. Windows does this routinely, and it is not
     * otherwise detectable: the track just stops, the video element's dimensions drop to zero,
     * and drawCover then paints nothing over the black background. So the composite turns into a
     * black rectangle while the Camera button is still lit.
     *
     * `onMuteChange(true)` fires when frames stop arriving from a track that is still live,
     * which is the other half of the same Windows behaviour. The last frame stays on the canvas
     * (a freeze rather than a blackout), so this is a warning, not a teardown.
     *
     * @param {{facing?:CameraFacing, onEnded?:()=>void, onMuteChange?:(m:boolean)=>void}} [opts]
     */
    async enableCamera(opts) {
      if (camera || stopped) return;
      cameraOpts = opts ?? cameraOpts;
      const want = opts?.facing ?? facing;
      // `ideal`, not `exact`, twice over. A laptop with one camera satisfies an ideal facingMode
      // by handing back the camera it has, where `exact` would throw OverconstrainedError and
      // turn a preference into a failure to start at all. And an ideal SIZE lets a phone hand us
      // its natural orientation rather than being forced into a landscape buffer.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: want }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      camera = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      // What we ASKED for and what we GOT are different questions, and only the second one
      // should reach a label. Chrome on a desktop reports no facingMode at all, so an absent
      // value means "unknown" and the request stands in for it.
      const got = stream.getVideoTracks()[0]?.getSettings().facingMode;
      facing = got === "user" || got === "environment" ? got : want;
      facingLive = true;
      untrackCamera = trackFrameTiming(camera.video, (f) => {
        cameraFrame = f;
      });
      placed = false; // re-place the inset for the new camera aspect ratio
      const track = stream.getVideoTracks()[0];
      track?.addEventListener("ended", () => {
        api.disableCamera();
        opts?.onEnded?.();
      });
      track?.addEventListener("mute", () => opts?.onMuteChange?.(true));
      track?.addEventListener("unmute", () => opts?.onMuteChange?.(false));
    },

    disableCamera() {
      untrackCamera?.();
      untrackCamera = null;
      cameraFrame = null; // never stamp a live frame with a dead source's capture time
      camera?.stream.getTracks().forEach((t) => t.stop());
      if (camera) camera.video.srcObject = null;
      camera = null;
      facingLive = false;
    },

    /** Which camera is live, or null when the camera is off. */
    cameraFacing: () => (facingLive ? facing : null),

    /**
     * Swap front camera for back, or back for front. Resolves to the facing that is actually
     * live afterwards — which is not necessarily the one requested, so callers should label the
     * control from the return value rather than from what they asked for.
     *
     * Resolves to null only when the camera could not be brought back at all; `onEnded` from the
     * original enableCamera fires in that case, because a broadcaster must never be left with a
     * lit Camera button over a black rectangle.
     *
     * @returns {Promise<CameraFacing|null>}
     */
    async switchCamera() {
      if (!camera || stopped) return null;
      const from = facing;
      const want = /** @type {CameraFacing} */ (from === "environment" ? "user" : "environment");
      const opts = cameraOpts ?? undefined;

      // The old camera must be released BEFORE the new one is requested. iOS will not hand out a
      // second camera while one is live, and the failure is not a clean rejection — the first
      // track goes mute and the page is left showing a frozen picture.
      api.disableCamera();
      try {
        await api.enableCamera({ ...opts, facing: want });
        return facing;
      } catch {
        // Put back what was working a moment ago. Nothing else can: the old track is stopped and
        // a stopped track cannot be restarted.
        try {
          await api.enableCamera({ ...opts, facing: from });
          return facing;
        } catch {
          // Both failed, so the camera is genuinely gone — another app took it during the gap,
          // most likely. Say so through the same channel as any other camera loss.
          opts?.onEnded?.();
          return null;
        }
      }
    },

    /** @param {{onEnded?:()=>void}} [opts] */
    async enableScreen(opts) {
      if (screen || stopped) return;
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screen = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      untrackScreen = trackFrameTiming(screen.video, (f) => {
        screenFrame = f;
      });
      placed = false;
      // Ending the share through the browser's own UI is the ordinary way out of one, so it has
      // to reach the page: otherwise the toggle stays lit over a black frame.
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        api.disableScreen();
        opts?.onEnded?.();
      });
    },

    disableScreen() {
      api.setSystemAudioEnabled(false);
      untrackScreen?.();
      untrackScreen = null;
      screenFrame = null;
      screen?.stream.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      screen = null;
      placed = false;
    },

    /** Does this share carry system audio? Only some platforms and choices offer it. */
    hasSystemAudio: () => !!screen?.stream.getAudioTracks().length,

    /**
     * Burn a line of text across the bottom of every composited frame, or null to stop. Called
     * once per drawn frame with when that frame's picture was captured, so the caller can stamp
     * the moment of capture rather than the moment of drawing.
     * @param {((frame: StampFrameInfo) => string)|null} fn
     */
    setStampProvider(fn) {
      stampProvider = stopped ? null : fn;
    },

    /**
     * A broadcaster's handle, drawn as a subtle watermark in the upper left, or null for none.
     * Static text, unlike the burn-in, so it is set rather than polled per frame.
     * @param {string|null} text
     */
    setWatermark(text) {
      watermark = stopped ? null : text;
    },

    /**
     * A QR code drawn on an opaque plate in the upper right, or null to remove it.
     *
     * Takes an already-encoded matrix rather than a URL: encoding is the caller's job, because
     * the caller is the one that has to tell a broadcaster when a URL will not fit at a
     * scannable size. By the time it reaches here the decision is made — see encodeLinkQr.
     * @param {QrMatrix|null} matrix
     */
    setLinkQr(matrix) {
      renderQrPlate(stopped ? null : matrix);
    },

    /** @param {boolean} on */
    async setMicEnabled(on) {
      if (stopped) return;
      if (on && !micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micNode = ac.createMediaStreamSource(micStream);
        micNode.connect(dest);
        // Resume AFTER wiring the graph, and await it, so we do not bind a silent (suspended)
        // destination track. If it is still not running the pointerdown fallback recovers it.
        await ac.resume().catch(() => {});
        if (ac.state !== "running") {
          console.warn(`[compositor] AudioContext is ${ac.state}; audio stays silent until a tap on the page resumes it`);
        }
      } else if (!on && micStream) {
        try {
          micNode?.disconnect();
        } catch {}
        micStream.getTracks().forEach((t) => t.stop());
        micNode = null;
        micStream = null;
      }
    },

    /** @param {boolean} on */
    setSystemAudioEnabled(on) {
      if (stopped) return;
      const sysTrack = screen?.stream.getAudioTracks()[0] ?? null;
      if (on && sysTrack && !sysNode) {
        void ac.resume().catch(() => {});
        sysNode = ac.createMediaStreamSource(new MediaStream([sysTrack]));
        sysNode.connect(dest);
      } else if (!on && sysNode) {
        try {
          sysNode.disconnect();
        } catch {}
        sysNode = null;
      }
    },

    stop() {
      if (stopped) return;
      stopped = true;
      document.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      untrackCamera?.();
      untrackScreen?.();
      stopLoop();
      screen?.stream.getTracks().forEach((t) => t.stop());
      camera?.stream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      composite.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      if (camera) camera.video.srcObject = null;
      void ac.close().catch(() => {});
      camChrome.el?.remove();
      camChrome.el = null;
      qrChrome.el?.remove();
      qrChrome.el = null;
      canvas.remove();
    },
  };

  return api;
}

/** The object createCompositor() hands back. @typedef {ReturnType<typeof build>} Compositor */
