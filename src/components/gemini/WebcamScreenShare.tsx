// components/gemini/WebcamScreenShare.tsx
"use client";
import React, {
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useGemini } from "./GeminiContext";

const IMAGE_SEND_INTERVAL_MS = 5000;

export interface WebcamScreenShareHandle {
  toggleWebcam: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  readonly isWebcamOn: boolean;
  readonly isScreenOn: boolean;
}

const WebcamScreenShare = forwardRef<WebcamScreenShareHandle>((_props, ref) => {
  const { sendImageFrame, paused, isSetupComplete, isConnected } = useGemini();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<number | null>(null);

  const [activeMode, setActiveMode] = useState<"none" | "webcam" | "screen">("none");
  const [videoReady, setVideoReady] = useState(false);
  const [dragPos, setDragPos] = useState({ x: 20, y: 20 });
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // ---------- public control API ----------
  useImperativeHandle(ref, () => ({
    toggleWebcam: async () => {
      if (activeMode === "webcam") stopAll();
      else await startWebcam();
    },
    toggleScreen: async () => {
      if (activeMode === "screen") stopAll();
      else await startScreenShare();
    },
    get isWebcamOn() {
      return activeMode === "webcam";
    },
    get isScreenOn() {
      return activeMode === "screen";
    },
  }));

  // ---------- lifecycle cleanup ----------
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setDragPos({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      });
    };
    const handleMouseUp = () => (dragging.current = false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      stopAll();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // ---------- start webcam ----------
  async function startWebcam() {
    if (paused || !isSetupComplete || !isConnected) return;
    stopAll();

    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      streamRef.current = s;
      await attachStream(s);
      setActiveMode("webcam");
      startPeriodicSend();
      console.log("🎥 Webcam started");
    } catch (e) {
      console.error("startWebcam error", e);
    }
  }

  // ---------- start screen share ----------
  async function startScreenShare() {
    if (paused || !isSetupComplete || !isConnected) return;
    stopAll();

    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const track = s.getVideoTracks()[0];
      track.onended = stopAll;
      streamRef.current = s;
      await attachStream(s);
      setActiveMode("screen");
      startPeriodicSend();
      console.log("🖥️ Screen share started");
    } catch (e) {
      console.error("startScreenShare error", e);
    }
  }

  // ---------- attach to video element ----------
  async function attachStream(s: MediaStream) {
    const v = videoRef.current;
    if (!v) return;

    v.srcObject = s;
    v.muted = true;
    v.playsInline = true;

    try {
      await v.play();
    } catch {
      console.warn("video play may require user interaction");
    }

    const waitReady = () => {
      if (v.readyState >= 2 && v.videoWidth > 0) setVideoReady(true);
      else requestAnimationFrame(waitReady);
    };
    waitReady();
  }

  // ---------- stop everything ----------
  function stopAll() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    const v = videoRef.current;
    if (v) {
      v.pause();
      v.srcObject = null;
    }

    setActiveMode("none");
    setVideoReady(false);
  }

  // ---------- periodic frame send ----------
  function startPeriodicSend() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    sendFrameNow();
    intervalRef.current = window.setInterval(sendFrameNow, IMAGE_SEND_INTERVAL_MS);
  }

  function sendFrameNow() {
    if (
      !videoRef.current ||
      !canvasRef.current ||
      !isSetupComplete ||
      !isConnected ||
      paused ||
      !videoReady
    )
      return;

    const v = videoRef.current;
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const w = Math.min(320, v.videoWidth);
    const h = Math.min(240, v.videoHeight);
    c.width = w;
    c.height = h;

    ctx.drawImage(v, 0, 0, w, h);
    const dataUrl = c.toDataURL("image/jpeg", 0.6);
    const base64 = dataUrl.split(",")[1];
    sendImageFrame(base64, "image/jpeg");
    console.debug("📤 Sent frame", { w, h });
  }

  // ---------- draggable overlay ----------
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    dragging.current = true;
    dragOffset.current = { x: e.clientX - dragPos.x, y: e.clientY - dragPos.y };
  };

  return (
    <>
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <div
        onMouseDown={handleMouseDown}
        className={`fixed w-48 h-36 border border-white/20 rounded-md overflow-hidden shadow-lg cursor-move z-50 bg-black transition-opacity ${
          activeMode === "none"
            ? "opacity-0 pointer-events-none"
            : "opacity-100"
        }`}
        style={{ top: dragPos.y, left: dragPos.x }}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          autoPlay
          muted
          playsInline
        />
      </div>
    </>
  );
});

WebcamScreenShare.displayName = "WebcamScreenShare";
export default WebcamScreenShare;
