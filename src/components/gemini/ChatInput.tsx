// components/gemini/ChatInput.tsx
"use client";
import React, { useRef, useState } from "react";
import { Send } from "lucide-react";
import { useGemini } from "./GeminiContext";

export default function ChatInput() {
  const { sendTextWithOptionalImage, paused, isConnected, isSetupComplete } = useGemini();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const disabled = paused || !isConnected || !isSetupComplete;

  async function handleSend() {
    if (!text.trim() && !file) return;
    try {
      await sendTextWithOptionalImage(text.trim(), file ?? undefined);
      setText("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      console.error("send error", e);
      alert("Failed to send message");
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) return;
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(f.type)) {
      alert("Only PNG/JPEG/WEBP allowed");
      return;
    }
    setFile(f);
  }

  return (
    <div className="w-full max-w-3xl px-4 sm:px-0">
      <div className="flex items-center gap-3 bg-[#111214] border border-white/6 rounded-full px-3 py-2">
        <label className="cursor-pointer" title="Attach image">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={onFileChange} className="hidden" />
          <div className="w-8 h-8 rounded flex items-center justify-center bg-white/6 text-white">📎</div>
        </label>

        <input
          type="text"
          placeholder="Type a message..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
          disabled={disabled}
          className="flex-1 bg-transparent outline-none text-sm text-white placeholder:text-white/50"
        />

        <button onClick={handleSend} disabled={disabled} title="Send" className="p-2 rounded-full bg-[#3b82f6] disabled:opacity-40">
          <Send size={16} color="white" />
        </button>
      </div>

      {file && (
        <div className="mt-2 max-w-xs">
          <img src={URL.createObjectURL(file)} alt="attachment" className="max-h-28 rounded-md object-contain" />
        </div>
      )}
    </div>
  );
}
