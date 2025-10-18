// components/gemini/ChatControls.tsx
"use client";
import React, { useState, useEffect, useRef } from "react";
import { Mic, Camera, Monitor, Pause, Play, PhoneOff } from "lucide-react";
import { useGemini } from "./GeminiContext";
import WebcamScreenShare, { WebcamScreenShareHandle } from "./WebcamScreenShare";
import { useRouter } from "next/navigation";

export default function ChatControls() {
  const { isConnected, isSetupComplete, startMic, stopMic, paused, setPaused, disconnect } = useGemini();
  const router = useRouter();
  const controlsDisabled = !isConnected || !isSetupComplete;

  const [micOn, setMicOn] = useState(false);
  const [webcamOn, setWebcamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);

  // ✅ Properly typed ref
  const webcamRef = useRef<WebcamScreenShareHandle | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      if (webcamRef.current) {
        setWebcamOn(webcamRef.current.isWebcamOn);
        setScreenOn(webcamRef.current.isScreenOn);
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

  async function toggleMic() {
    if (!micOn) {
      try {
        await startMic();
        setMicOn(true);
      } catch {
        /* ignore */
      }
    } else {
      stopMic();
      setMicOn(false);
    }
  }

  function handleEnd() {
    disconnect();
    router.push("/dashboard");
  }

  return (
    <div className="w-full flex flex-col items-center space-y-3">
      <div className="flex items-center gap-4">
        <button
          onClick={toggleMic}
          disabled={controlsDisabled}
          title="Mic"
          className={`p-3 rounded-full ${
            micOn ? "bg-red-500 text-white" : "bg-white/8 text-white"
          } disabled:opacity-50`}
        >
          <Mic size={18} />
        </button>

        <button
          onClick={() => webcamRef.current?.toggleWebcam()}
          disabled={controlsDisabled}
          title="Webcam"
          className={`p-3 rounded-full ${
            webcamOn ? "bg-blue-500 text-white" : "bg-white/8 text-white"
          } disabled:opacity-50`}
        >
          <Camera size={18} />
        </button>

        <button
          onClick={() => webcamRef.current?.toggleScreen()}
          disabled={controlsDisabled}
          title="Screen Share"
          className={`p-3 rounded-full ${
            screenOn ? "bg-green-500 text-white" : "bg-white/8 text-white"
          } disabled:opacity-50`}
        >
          <Monitor size={18} />
        </button>

        <button
          onClick={() => setPaused((v) => !v)}
          title="Pause / Resume"
          className="p-3 rounded-full bg-white/8 text-white disabled:opacity-50"
        >
          {paused ? <Play size={18} /> : <Pause size={18} />}
        </button>

        <button
          onClick={handleEnd}
          title="End"
          className="p-3 rounded-full bg-red-600 text-white disabled:opacity-50"
        >
          <PhoneOff size={18} />
        </button>
      </div>

      <WebcamScreenShare ref={webcamRef} />
    </div>
  );
}
