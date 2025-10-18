// components/gemini/WebcamScreenShare.tsx
"use client";
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { useGemini } from "./GeminiContext";

const IMAGE_SEND_INTERVAL_MS = 5000;

const WebcamScreenShare = forwardRef((props, ref) => {
  const { sendImageFrame, paused } = useGemini();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<number | null>(null);

  const [activeMode, setActiveMode] = useState<"none" | "webcam" | "screen">("none");
  const [videoReady, setVideoReady] = useState(false);

  // draggable
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
    get isWebcamOn() { return activeMode === "webcam"; },
    get isScreenOn() { return activeMode === "screen"; },
  }));

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setDragPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
    };
    const handleMouseUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      stopAll();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  async function startWebcam() {
    if (paused) return;
    if (activeMode === "screen") stopAll();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
      streamRef.current = s;
      await attachStream(s);
      setActiveMode("webcam");
      startPeriodicSend();
    } catch (e) { console.error("startWebcam", e); }
  }

  async function startScreenShare() {
    if (paused) return;
    if (activeMode === "webcam") stopAll();
    try {
      // @ts-ignore
      const s = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: false });
      streamRef.current = s;

      // Stop automatically if user ends screen share from browser
      const videoTrack = s.getVideoTracks()[0];
      videoTrack.onended = () => stopAll();

      await attachStream(s);
      setActiveMode("screen");
      startPeriodicSend();
    } catch (e) { console.error("startScreenShare", e); }
  }

  async function attachStream(s: MediaStream) {
    if (!videoRef.current) return;
    const video = videoRef.current;

    video.srcObject = s;
    video.muted = true;
    video.playsInline = true;
    video.style.display = "block";

    // Try to play video, fallback to loop check
    const tryPlay = async () => {
      try { await video.play(); } catch {}
      const checkVideo = () => {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          setVideoReady(true);
        } else {
          requestAnimationFrame(checkVideo);
        }
      };
      checkVideo();
    };
    tryPlay();
  }

  function stopAll() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.srcObject = null; videoRef.current.style.display = "none"; }
    setActiveMode("none");
    setVideoReady(false);
  }

  function startPeriodicSend() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    sendFrameNow();
    intervalRef.current = window.setInterval(() => sendFrameNow(), IMAGE_SEND_INTERVAL_MS);
  }

  function sendFrameNow() {
    if (!videoRef.current || !canvasRef.current || paused || !videoReady) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.7);
    sendImageFrame(dataUrl.split(",")[1], "image/jpeg");
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    dragOffset.current = { x: e.clientX - dragPos.x, y: e.clientY - dragPos.y };
  };

  return (
    <>
      <canvas ref={canvasRef} style={{ display: "none" }} />
      {activeMode !== "none" && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute w-48 h-36 border border-white/20 rounded-md overflow-hidden shadow-lg cursor-move z-50 bg-black"
          style={{ top: dragPos.y, left: dragPos.x }}
        >
          <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        </div>
      )}
    </>
  );
});

export default WebcamScreenShare;
