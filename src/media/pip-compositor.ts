// Screen-capture session with an optional, draggable camera picture-in-picture.
//
// <moq-publish> captures from a single internal source, so it can't overlay the camera
// on the screen. We capture the screen ONCE here and always render it to a <canvas>,
// drawing the camera as a draggable inset only while the camera is enabled. The element
// publishes the canvas's video track via broadcast.video.source (a video Source is just a
// MediaStreamTrack), with announce=true + source=undefined so its own capture stands down.
//
// Capturing the screen once (and toggling only the camera) means adding/removing the
// camera never re-prompts the screen-share dialog. Best-effort; iterate in-browser.

export interface ScreenSession {
  videoTrack: MediaStreamTrack; // canvas composite (screen, + camera inset when enabled)
  audioTrack: MediaStreamTrack | null; // system/tab audio, if shared
  canvas: HTMLCanvasElement; // interactive preview; drag the camera inset to move it
  hasCamera: () => boolean;
  enableCamera: () => Promise<void>;
  disableCamera: () => void;
  stop: () => void;
}

function mkVideo(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement("video");
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  void v.play().catch(() => {});
  return v;
}

export async function startScreen(opts?: { onEnded?: () => void }): Promise<ScreenSession> {
  const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const screenVideo = mkVideo(new MediaStream(screen.getVideoTracks()));

  const canvas = document.createElement("canvas");
  const settings = screen.getVideoTracks()[0].getSettings();
  canvas.width = settings.width ?? 1280;
  canvas.height = settings.height ?? 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    screen.getTracks().forEach((t) => t.stop());
    throw new Error("2D canvas context unavailable");
  }

  // Camera inset, added on demand. ~1/4 width, default bottom-right, draggable.
  let camera: MediaStream | null = null;
  let camVideo: HTMLVideoElement | null = null;
  let px = 0;
  let py = 0;
  let placed = false;
  const insetW = () => Math.round(canvas.width * 0.25);
  const insetH = () => {
    const ar = camVideo && camVideo.videoWidth && camVideo.videoHeight ? camVideo.videoHeight / camVideo.videoWidth : 9 / 16;
    return Math.round(insetW() * ar);
  };

  let raf = 0;
  const draw = () => {
    ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
    if (camVideo) {
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
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);

  // Drag the camera inset (no-op when the camera is off).
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
    if (!camVideo) return;
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
    camera?.getTracks().forEach((t) => t.stop());
    composite.getTracks().forEach((t) => t.stop());
    screenVideo.srcObject = null;
    if (camVideo) camVideo.srcObject = null;
    canvas.remove();
  };

  // If the user ends the screen share via the browser's own UI, tear down + notify.
  screen.getVideoTracks()[0].addEventListener("ended", () => {
    stop();
    opts?.onEnded?.();
  });

  return {
    videoTrack,
    audioTrack,
    canvas,
    hasCamera: () => !!camera,
    async enableCamera() {
      if (camera) return;
      camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      camVideo = mkVideo(new MediaStream(camera.getVideoTracks()));
      placed = false; // re-place the inset for the new camera aspect ratio
    },
    disableCamera() {
      camera?.getTracks().forEach((t) => t.stop());
      camera = null;
      if (camVideo) {
        camVideo.srcObject = null;
        camVideo = null;
      }
    },
    stop,
  };
}
