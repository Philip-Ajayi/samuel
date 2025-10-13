"use client";

import { useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality, type Session, type Blob as GenAIBlob } from "@google/genai";

const MODEL_NAME = "gemini-2.0-flash-live-001";
const TARGET_SAMPLE_RATE = 16000;
const WORKLET_BUFFER_SIZE = 4096;
const IMAGE_SEND_INTERVAL_MS = 5000;

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
};

const base64ToArrayBuffer = (base64: string) => {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
};

export default function HomePage() {
  const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY!;
  const genAI = useRef<GoogleGenAI | null>(null);
  const session = useRef<Session | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Ready to talk or Upload Image");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string | null>(null);

  const audioContext = useRef<AudioContext | null>(null);
  const audioWorkletNode = useRef<AudioWorkletNode | null>(null);
  const micSourceNode = useRef<MediaStreamAudioSourceNode | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const imageInterval = useRef<number | null>(null);

  const audioQueue = useRef<ArrayBuffer[]>([]);
  const isPlayingAudio = useRef(false);
  const isSetupComplete = useRef(false);

  useEffect(() => {
    genAI.current = new GoogleGenAI({ apiKey: API_KEY, apiVersion: "v1alpha" });
  }, [API_KEY]);

  const updateStatus = (msg: string) => {
    console.log("[Status]", msg);
    setStatus(msg);
  };

  const cleanupAudioNodes = () => {
    if (audioWorkletNode.current) {
      audioWorkletNode.current.disconnect();
      audioWorkletNode.current = null;
    }
    if (micSourceNode.current) {
      micSourceNode.current.disconnect();
      micSourceNode.current = null;
    }
    if (micStream.current) {
      micStream.current.getTracks().forEach((t) => t.stop());
      micStream.current = null;
    }
  };

  const initializeAudio = async () => {
    if (!audioContext.current) {
      audioContext.current = new AudioContext();
      if (audioContext.current.state === "suspended") await audioContext.current.resume();

      const workletCode = `
        class AudioProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0][0];
            if (input) {
              const pcm = new Int16Array(input.length);
              for (let i = 0; i < input.length; i++)
                pcm[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
              this.port.postMessage({ pcmData: pcm.buffer }, [pcm.buffer]);
            }
            return true;
          }
        }
        registerProcessor('audio-processor', AudioProcessor);
      `;
      const blob = new Blob([workletCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await audioContext.current.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    }
  };

  const connectToGemini = async () => {
    if (!genAI.current) return;
    updateStatus("Connecting to Gemini...");
    try {
      session.current = await genAI.current.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          audioConfig: { sampleRateHertz: 24000 }, // ✅ ensure playback-compatible PCM
        },
        callbacks: {
          onopen: () => updateStatus("Connected!"),
          onmessage: (msg) => {
            if (msg?.setupComplete) {
              updateStatus("Setup complete. Ready!");
              isSetupComplete.current = true;
            }
            if (msg?.serverContent?.modelTurn?.parts) {
              msg.serverContent.modelTurn.parts.forEach((p) => {
                if (p.inlineData?.data) {
                  enqueueAudio(base64ToArrayBuffer(p.inlineData.data));
                }
              });
            }
          },
          onclose: () => updateStatus("Disconnected."),
          onerror: (err) => updateStatus(`Error: ${err.message}`),
        },
      });
    } catch (e) {
      console.error(e);
      updateStatus("Connection failed.");
    }
  };

  // 🟦 Audio queue & playback
  const enqueueAudio = (buf: ArrayBuffer) => {
    audioQueue.current.push(buf);
    if (!isPlayingAudio.current) {
      isPlayingAudio.current = true;
      playNext();
    }
  };

  const playNext = async () => {
    if (!audioQueue.current.length || !audioContext.current) {
      isPlayingAudio.current = false;
      return;
    }
    const ctx = audioContext.current;
    if (ctx.state === "suspended") await ctx.resume();

    const buffer = audioQueue.current.shift()!;
    const int16 = new Int16Array(buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    const PLAYBACK_SR = 24000;
    const audioBuffer = ctx.createBuffer(1, float32.length, PLAYBACK_SR);
    audioBuffer.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;

    const gain = ctx.createGain();
    gain.gain.value = 1.0;

    src.connect(gain).connect(ctx.destination);
    src.start();

    src.onended = () => {
      if (audioQueue.current.length) playNext();
      else isPlayingAudio.current = false;
    };
  };

  const startRecording = async () => {
    await initializeAudio();
    await connectToGemini();

    updateStatus("Requesting microphone...");
    micStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = audioContext.current!;
    micSourceNode.current = ctx.createMediaStreamSource(micStream.current);

    audioWorkletNode.current = new AudioWorkletNode(ctx, "audio-processor");
    audioWorkletNode.current.port.onmessage = (e) => {
      if (e.data.pcmData && session.current) {
        const base64 = arrayBufferToBase64(e.data.pcmData);
        const blob: GenAIBlob = {
          data: base64,
          mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}`,
        };
        session.current.sendRealtimeInput({ media: blob });
      }
    };

    micSourceNode.current.connect(audioWorkletNode.current);
    updateStatus("Listening...");
    startImageInterval();
  };

  const stopRecording = () => {
    cleanupAudioNodes();
    stopImageInterval();
    setIsRecording(false);
    updateStatus("Call ended.");
    session.current?.close();
  };

  const handleToggle = async () => {
    if (isRecording) stopRecording();
    else {
      setIsRecording(true);
      await startRecording();
    }
  };

  const startImageInterval = () => {
    stopImageInterval();
    if (!imageBase64 || !session.current) return;
    imageInterval.current = window.setInterval(() => {
      sendImage();
    }, IMAGE_SEND_INTERVAL_MS);
    sendImage(); // send once immediately
  };

  const stopImageInterval = () => {
    if (imageInterval.current) clearInterval(imageInterval.current);
    imageInterval.current = null;
  };

  const sendImage = () => {
    if (!session.current || !imageBase64 || !imageMimeType) return;
    const blob: GenAIBlob = { data: imageBase64, mimeType: imageMimeType };
    session.current.sendRealtimeInput({ media: blob });
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setImageBase64(result.split(",")[1]);
      setImageMimeType(file.type);
    };
    reader.readAsDataURL(file);
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
      <h1 className="text-3xl font-semibold mb-8">🎙️ Multimodal Live Chat – Fixed</h1>

      <div className="bg-neutral-900 p-6 rounded-2xl shadow-lg flex flex-col items-center gap-6 w-full max-w-md">
        <span className="text-gray-400">{status}</span>

        <button
          onClick={handleToggle}
          className={`relative w-28 h-28 rounded-full flex flex-col items-center justify-center transition-colors ${
            isRecording ? "bg-red-500 hover:bg-red-600" : "bg-blue-500 hover:bg-blue-600"
          } text-white`}
        >
          <i className={`fas ${isRecording ? "fa-stop" : "fa-microphone"} text-3xl mb-2`} />
          <span>{isRecording ? "Stop" : "Talk"}</span>
        </button>

        <div className="bg-neutral-800 rounded-xl p-4 w-full max-w-xs flex flex-col items-center border border-neutral-700">
          <label
            htmlFor="imageUpload"
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md cursor-pointer hover:bg-blue-600 text-sm"
          >
            <i className="fas fa-image"></i> Upload Image
          </label>
          <input
            id="imageUpload"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleImageUpload}
            className="hidden"
          />
          {imageBase64 && (
            <div className="relative mt-4">
              <img
                src={`data:${imageMimeType};base64,${imageBase64}`}
                alt="Preview"
                className="max-h-40 rounded-md border border-neutral-700"
              />
              <button
                onClick={() => {
                  setImageBase64(null);
                  setImageMimeType(null);
                }}
                className="absolute -top-2 -right-2 bg-red-500 text-white w-6 h-6 rounded-full"
              >
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
