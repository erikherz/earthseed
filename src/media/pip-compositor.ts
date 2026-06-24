// Picture-in-picture compositor for "Screen + Camera" publishing.
//
// <moq-publish> captures from a single internal source (camera OR screen), so it can't
// overlay the camera on the screen. We do it ourselves: capture both, draw the screen
// full-frame with the camera as a draggable inset on a <canvas>, and hand the canvas's
// captureStream() video track to the element via broadcast.video.source (a video Source
// is just a MediaStreamTrack). The caller publishes it with announce=true + source=undefined
// so the element's own capture stands down.
//
// NOTE: this path is best-effort and has not been browser-verified; expect to iterate.

export interface PiPSession {
  videoTrack: MediaStreamTrack; // composited canvas video
  audioTrack: MediaStreamTrack | null; // system/tab audio if the user shared it
  canvas: HTMLCanvasElement; // interactive preview; drag the inset to move the camera
  stop: () => void;
}

export async function startPiP(opts?: { onEnded?: () => void }): Promise<PiPSession> {
  // Always request system audio best-effort; the caller decides whether to publish it.
  const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  let camera: MediaStream;
  try {
    camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (e) {
    screen.getTracks().forEach((t) => t.stop());
    throw e;
  }

  const mkVideo = (stream: MediaStream): HTMLVideoElement => {
    const v = document.createElement("video");
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    void v.play().catch(() => {});
    return v;
  };
  const screenVideo = mkVideo(new MediaStream(screen.getVideoTracks()));
  const camVideo = mkVideo(new MediaStream(camera.getVideoTracks()));

  const canvas = document.createElement("canvas");
  const settings = screen.getVideoTracks()[0].getSettings();
  canvas.width = settings.width ?? 1280;
  canvas.height = settings.height ?? 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    screen.getTracks().forEach((t) => t.stop());
    camera.getTracks().forEach((t) => t.stop());
    throw new Error("2D canvas context unavailable");
  }

  // Camera inset: ~1/4 width, default bottom-right, draggable.
  const insetW = () => Math.round(canvas.width * 0.25);
  const insetH = () => {
    const ar = camVideo.videoWidth && camVideo.videoHeight ? camVideo.videoHeight / camVideo.videoWidth : 9 / 16;
    return Math.round(insetW() * ar);
  };
  let px = 0;
  let py = 0;
  let placed = false;

  let raf = 0;
  const draw = () => {
    ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
    const w = insetW();
    const h = insetH();
    if (!placed && w && h) {
      px = canvas.width - w - 24;
      py = canvas.height - h - 24;
      placed = true;
    }
    px = Math.max(0, Math.min(px, canvas.width - w));
    py = Math.max(0, Math.min(py, canvas.height - h));
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 14;
    ctx.drawImage(camVideo, px, py, w, h);
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, w, h);
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);

  // Drag the camera inset (pointer coords -> canvas coords).
  let dragging = false;
  let dx = 0;
  let dy = 0;
  const toCanvas = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    const p = toCanvas(e);
    if (p.x >= px && p.x <= px + insetW() && p.y >= py && p.y <= py + insetH()) {
      dragging = true;
      dx = p.x - px;
      dy = p.y - py;
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const p = toCanvas(e);
    px = p.x - dx;
    py = p.y - dy;
  });
  const endDrag = (e: PointerEvent) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  const composite = canvas.captureStream(30);
  const videoTrack = composite.getVideoTracks()[0];
  const audioTrack = screen.getAudioTracks()[0] ?? null;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    screen.getTracks().forEach((t) => t.stop());
    camera.getTracks().forEach((t) => t.stop());
    composite.getTracks().forEach((t) => t.stop());
    screenVideo.srcObject = null;
    camVideo.srcObject = null;
    canvas.remove();
  };

  // If the user ends the screen share via the browser's own UI, tear down + notify.
  screen.getVideoTracks()[0].addEventListener("ended", () => {
    stop();
    opts?.onEnded?.();
  });

  return { videoTrack, audioTrack, canvas, stop };
}
