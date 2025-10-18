// components/gemini/FluentPathInterface.tsx
"use client";
import React from "react";
import { GeminiProvider, useGemini } from "./GeminiContext";
import AvatarDisplay from "./AvatarDisplay";
import ChatControls from "./ChatControls";
import ChatInput from "./ChatInput";

function InnerInterface() {
  const { isConnected, isSetupComplete, transcription, paused, avatarLoaded } = useGemini();

  const ready = isConnected && isSetupComplete && avatarLoaded;

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-b from-[#0b0f14] to-[#071019] p-4">
      <div className="w-full max-w-5xl space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-white text-xl font-semibold">FluentPath — Professional Tutor</h1>
          <div className="text-sm text-white/70">{ready ? "Connected" : "Connecting..."}</div>
        </header>

        <main className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          {/* Avatar area */}
          <div className="flex flex-col items-center">
            <AvatarDisplay glbPath="/avatar.glb" />
            <div className="mt-3 text-center">
              <div className="text-white/90 text-sm">Live Tutor</div>
              <div className="text-white/60 text-xs mt-1">
                Captions: <span className="text-white/80">{transcription || "—"}</span>
              </div>
            </div>

            <div className="mt-4">
              {/* Chat controls handle webcam, screen share, mic */}
              <ChatControls />
            </div>
          </div>

          {/* Chat area */}
          <div className="flex flex-col items-center w-full">
            <div className="w-full">
              <div className="bg-[#0f1720] rounded-2xl p-4 min-h-[240px] flex flex-col items-center justify-center">
                <div className="text-white/60">No conversation history — single session chat UI</div>
                <div className="mt-3 text-xs text-white/40">Use the controls below to interact.</div>
              </div>

              <div className="mt-4">
                <ChatInput />
              </div>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="flex items-center justify-between">
          <div className="text-xs text-white/50">Session mode: {paused ? "Paused" : "Live"}</div>
          <div className="text-xs text-white/40">Mobile responsive</div>
        </footer>
      </div>
    </div>
  );
}

export default function FluentPathInterface() {
  return (
    <GeminiProvider>
      <InnerInterface />
    </GeminiProvider>
  );
}
