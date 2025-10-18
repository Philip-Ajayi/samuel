// components/gemini/GeminiContext.tsx
"use client";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  PropsWithChildren,
} from "react";
import {
  GoogleGenAI,
  Modality,
  type Session,
  type Blob as GenAIBlob,
  type LiveServerMessage, // ✅ add correct type
} from "@google/genai";

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
const MODEL_NAME = "gemini-2.0-flash-live-001";
const TARGET_SAMPLE_RATE = 16000;
const WORKLET_BUFFER_SIZE = 4096;

type AudioHandler = (pcmArrayBuffer: ArrayBuffer) => void;

interface GeminiContextValue {
  isConnected: boolean;
  isSetupComplete: boolean;
  transcription: string;
  paused: boolean;
  avatarLoaded: boolean;
  connect: () => Promise<boolean>;
  disconnect: () => void;
  startMic: () => Promise<void>;
  stopMic: () => void;
  sendImageFrame: (base64: string, mimeType: string) => void;
  sendTextWithOptionalImage: (text: string, imageFile?: File) => Promise<void>;
  registerAudioHandler: (h: AudioHandler) => () => void;
  setPaused: React.Dispatch<React.SetStateAction<boolean>>;
  setAvatarLoaded: React.Dispatch<React.SetStateAction<boolean>>;
}

const GeminiContext = createContext<GeminiContextValue | null>(null);

export const useGemini = (): GeminiContextValue => {
  const ctx = useContext(GeminiContext);
  if (!ctx) throw new Error("useGemini must be used inside GeminiProvider");
  return ctx;
};

export const GeminiProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [transcription, setTranscription] = useState("");
  const [paused, setPaused] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);

  const genAIRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const connectingRef = useRef(false);

  const audioHandlersRef = useRef<Set<AudioHandler>>(new Set());
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null);

  // ------------------ Utility ------------------

  const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result as string);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });

  // ------------------ Connection ------------------

  useEffect(() => {
    if (!API_KEY) {
      console.error("Missing NEXT_PUBLIC_GEMINI_API_KEY");
      return;
    }
    if (!genAIRef.current)
      genAIRef.current = new GoogleGenAI({
        apiKey: API_KEY,
        apiVersion: "v1alpha",
      });
  }, []);

  async function connect(): Promise<boolean> {
    if (connectingRef.current || !genAIRef.current) return false;
    if (sessionRef.current && isSetupComplete) return true;

    connectingRef.current = true;
    try {
      if (sessionRef.current) sessionRef.current.close();

      const s = await genAIRef.current.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("✅ Gemini connected");
            setIsConnected(true);
          },
          // ✅ Correctly typed message callback
          onmessage: (msg: LiveServerMessage) => {
            if (msg.setupComplete) {
              console.log("✅ Setup complete");
              setIsSetupComplete(true);
            }

            const parts = msg.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const p of parts) {
                const data = p.inlineData?.data;
                if (data) {
                  const ab = base64ToArrayBuffer(data);
                  audioHandlersRef.current.forEach((h) => h(ab));
                }
              }
            }

            const text = msg.serverContent?.outputTranscription?.text;
            if (text) setTranscription(text);
          },
          onerror: (e: Event) => {
            console.error("❌ Gemini websocket error", e);
            setIsConnected(false);
            setIsSetupComplete(false);
          },
          onclose: () => {
            console.warn("⚠️ Gemini session closed");
            setIsConnected(false);
            setIsSetupComplete(false);
          },
        },
      });

      sessionRef.current = s;
      connectingRef.current = false;
      return true;
    } catch (err) {
      console.error("connect error", err);
      connectingRef.current = false;
      return false;
    }
  }

  function disconnect(): void {
    console.log("🔌 Disconnecting Gemini...");
    sessionRef.current?.close();
    sessionRef.current = null;
    setIsConnected(false);
    setIsSetupComplete(false);
    stopMic();
  }

  // Auto-reconnect loop
  useEffect(() => {
    let running = true;
    const loop = async () => {
      while (running) {
        if (!paused && !isConnected && !connectingRef.current) {
          await connect();
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    loop();
    return () => {
      running = false;
    };
  }, [paused, isConnected]);

  // ------------------ Audio ------------------

  async function ensureAudioWorklet(): Promise<void> {
    if (!audioContextRef.current) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext ||
        AudioContext;

      audioContextRef.current = new Ctx();

      const blob = new Blob(
        [
          `
          class AudioProcessor extends AudioWorkletProcessor {
            constructor(o){
              super();
              this.targetRate = o.processorOptions.targetRate;
              this.bufferSize = o.processorOptions.bufferSize;
              this.ratio = sampleRate / this.targetRate;
              this.buffer = new Float32Array(this.bufferSize * 4);
              this.idx = 0;
            }
            process(inputs){
              const input = inputs[0]?.[0];
              if(!input) return true;
              if(this.idx + input.length <= this.buffer.length){
                this.buffer.set(input, this.idx);
                this.idx += input.length;
              }
              if(this.idx >= this.bufferSize * this.ratio){
                const out = new Float32Array(this.bufferSize);
                for(let i=0;i<this.bufferSize;i++){
                  const p = i * this.ratio;
                  const k = Math.floor(p);
                  const t = p - k;
                  out[i] = (this.buffer[k]||0)*(1-t)+(this.buffer[k+1]||0)*t;
                }
                const pcm = new Int16Array(out.length);
                for(let i=0;i<out.length;i++){
                  pcm[i] = Math.max(-1, Math.min(1, out[i]))*32767;
                }
                this.port.postMessage({pcmData: pcm.buffer}, [pcm.buffer]);
                this.buffer.copyWithin(0,this.bufferSize*this.ratio,this.idx);
                this.idx -= this.bufferSize*this.ratio;
              }
              return true;
            }
          }
          registerProcessor("audio-processor", AudioProcessor);
        `,
        ],
        { type: "application/javascript" }
      );

      await audioContextRef.current.audioWorklet.addModule(
        URL.createObjectURL(blob)
      );
    }
  }

  async function startMic(): Promise<void> {
    if (paused || !isSetupComplete || !isConnected) return;
    await ensureAudioWorklet();
    const ctx = audioContextRef.current!;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
    });
    micStreamRef.current = stream;
    micSourceNodeRef.current = ctx.createMediaStreamSource(stream);
    audioWorkletNodeRef.current = new AudioWorkletNode(ctx, "audio-processor", {
      processorOptions: {
        targetRate: TARGET_SAMPLE_RATE,
        bufferSize: WORKLET_BUFFER_SIZE,
      },
    });
    audioWorkletNodeRef.current.port.onmessage = (
      ev: MessageEvent<{ pcmData: ArrayBuffer }>
    ) => {
      const { pcmData } = ev.data;
      if (!pcmData || !sessionRef.current || paused) return;
      const base64 = arrayBufferToBase64(pcmData);
      const blob: GenAIBlob = {
        data: base64,
        mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}`,
      };
      sessionRef.current.sendRealtimeInput({ media: blob });
    };
    micSourceNodeRef.current.connect(audioWorkletNodeRef.current);
  }

  function stopMic(): void {
    audioWorkletNodeRef.current?.disconnect();
    micSourceNodeRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
  }

  // ------------------ Sending data ------------------

  function sendImageFrame(base64: string, mimeType: string): void {
    if (!sessionRef.current || paused || !isSetupComplete) return;
    try {
      const blob: GenAIBlob = { data: base64, mimeType };
      sessionRef.current.sendRealtimeInput({ media: blob });
      console.log("📷 Sent image frame", mimeType, base64.slice(0, 40));
    } catch (e) {
      console.error("sendImageFrame error", e);
    }
  }

  async function sendTextWithOptionalImage(
    text: string,
    imageFile?: File
  ): Promise<void> {
    if (!sessionRef.current || paused || !isSetupComplete)
      throw new Error("Session not ready");
    if (imageFile) {
      const base64 = await fileToBase64(imageFile);
      const blob: GenAIBlob = {
        data: base64.split(",")[1],
        mimeType: imageFile.type,
      };
      sessionRef.current.sendRealtimeInput({ media: blob });
      await new Promise((r) => setTimeout(r, 200));
    }
    sessionRef.current.sendClientContent({ turns: text });
  }

  // ------------------ Audio handlers ------------------

  const registerAudioHandler = (h: AudioHandler): (() => void) => {
    audioHandlersRef.current.add(h);
    return () => audioHandlersRef.current.delete(h);
  };

  return (
    <GeminiContext.Provider
      value={{
        isConnected,
        isSetupComplete,
        transcription,
        paused,
        avatarLoaded,
        connect,
        disconnect,
        startMic,
        stopMic,
        sendImageFrame,
        sendTextWithOptionalImage,
        registerAudioHandler,
        setPaused,
        setAvatarLoaded,
      }}
    >
      {children}
    </GeminiContext.Provider>
  );
};
