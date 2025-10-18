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
  const { sendImageFrame, paused } = useGemini();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<number | null>(null);

  const [activeMode, setActiveMode] = useState<"none" | "webcam" | "screen">(
    "none"
  );
  const [videoReady, setVideoReady] = useState(false);

  // draggable overlay
  const [dragPos, setDragPos] = useState({ x: 20, y: 20 });
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

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

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setDragPos({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      });
    };
    const handleMouseUp = () => {
      dragging.current = false;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      stopAll();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startWebcam() {
    if (paused) return;
    if (activeMode === "screen") stopAll();

    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      streamRef.current = s;
      setActiveMode("webcam");

      await new Promise<void>((res) => setTimeout(res, 100));
      await attachStream(s);
      startPeriodicSend();
    } catch (e) {
      console.error("startWebcam", e);
    }
  }

  async function startScreenShare() {
    if (paused) return;
    if (activeMode === "webcam") stopAll();

    try {
      // @ts-ignore - Some browsers don't have proper type for getDisplayMedia
      const s: MediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      streamRef.current = s;

      const track = s.getVideoTracks()[0];
      track.onended = () => stopAll();

      setActiveMode("screen");
      await new Promise<void>((res) => setTimeout(res, 100));
      await attachStream(s);
      startPeriodicSend();
    } catch (e) {
      console.error("startScreenShare", e);
    }
  }

  async function attachStream(s: MediaStream) {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = s;
    v.muted = true;
    v.playsInline = true;

    try {
      await v.play();
    } catch (e) {
      console.warn("video play blocked:", e);
    }

    const waitForVideo = () => {
      if (v.readyState >= 2 && v.videoWidth > 0) {
        setVideoReady(true);
      } else {
        requestAnimationFrame(waitForVideo);
      }
    };
    waitForVideo();
  }

  function stopAll() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    const v = videoRef.current;
    if (v) {
      v.pause();
      v.srcObject = null;
    }

    setActiveMode("none");
    setVideoReady(false);
  }

  function startPeriodicSend() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    sendFrameNow();
    intervalRef.current = window.setInterval(sendFrameNow, IMAGE_SEND_INTERVAL_MS);
  }

  function sendFrameNow() {
    if (!videoRef.current || !canvasRef.current || paused || !videoReady) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    c.width = v.videoWidth;
    c.height = v.videoHeight;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.7);
    sendImageFrame(dataUrl.split(",")[1], "image/jpeg");
  }

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
          activeMode === "none" ? "opacity-0 pointer-events-none" : "opacity-100"
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
