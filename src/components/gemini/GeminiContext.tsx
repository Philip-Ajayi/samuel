// components/gemini/GeminiContext.tsx
"use client";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality, type Session, type Blob as GenAIBlob } from "@google/genai";

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
  setPaused: (v: boolean) => void;
  setAvatarLoaded: (v: boolean) => void;
}

const GeminiContext = createContext<GeminiContextValue | null>(null);
export const useGemini = (): GeminiContextValue => {
  const ctx = useContext(GeminiContext);
  if (!ctx) throw new Error("useGemini must be used inside GeminiProvider");
  return ctx;
};

export const GeminiProvider: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [transcription, setTranscription] = useState("");
  const [paused, setPaused] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);

  const genAIRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const connectingRef = useRef(false); // 🧠 new: prevents multiple concurrent connections

  // audio
  const audioHandlersRef = useRef<Set<AudioHandler>>(new Set());
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null);

  useEffect(() => {
    if (!API_KEY) {
      console.error("Missing NEXT_PUBLIC_GEMINI_API_KEY");
      return;
    }
    genAIRef.current ??= new GoogleGenAI({ apiKey: API_KEY!, apiVersion: "v1alpha" });
  }, []);

  // --- helpers ---
  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
  }
  function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
  }

  // --- audio handlers registration ---
  function registerAudioHandler(h: AudioHandler) {
    audioHandlersRef.current.add(h);
    return () => audioHandlersRef.current.delete(h);
  }

  // --- create AudioWorklet dynamically ---
  async function ensureAudioWorklet() {
    if (!audioContextRef.current) {
      audioContextRef.current =
        new (window.AudioContext || (window as any).webkitAudioContext)();
      if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume();
      const workletCode = `
        class AudioProcessor extends AudioWorkletProcessor {
          constructor(o){
            super();
            this.sampleRate = sampleRate;
            this.targetSampleRate = o.processorOptions?.targetSampleRate || ${TARGET_SAMPLE_RATE};
            this.bufferSize = o.processorOptions?.bufferSize || ${WORKLET_BUFFER_SIZE};
            this._buffer = new Float32Array(this.bufferSize * 4);
            this._index = 0;
            this.resampleRatio = this.sampleRate / this.targetSampleRate;
          }
          process(inputs){
            const c = inputs[0]?.[0];
            if (c){
              if (this._index + c.length <= this._buffer.length){
                this._buffer.set(c, this._index);
                this._index += c.length;
              }
            }
            if (this._index >= this.bufferSize * this.resampleRatio) this.flush();
            return true;
          }
          flush(){
            const o = new Float32Array(this.bufferSize);
            for (let i = 0; i < this.bufferSize; i++){
              const P = i * this.resampleRatio;
              const K = Math.floor(P);
              const T = P - K;
              o[i] = (this._buffer[K] || 0) * (1 - T) + (this._buffer[K + 1] || 0) * T;
            }
            const pcm = new Int16Array(o.length);
            for (let i = 0; i < o.length; i++){
              pcm[i] = Math.max(-1, Math.min(1, o[i])) * 32767;
            }
            this.port.postMessage({ pcmData: pcm.buffer }, [pcm.buffer]);
            this._buffer.copyWithin(0, this.bufferSize * this.resampleRatio, this._index);
            this._index -= this.bufferSize * this.resampleRatio;
          }
        }
        registerProcessor("audio-processor", AudioProcessor);
      `;
      const blob = new Blob([workletCode], { type: "application/javascript" });
      await audioContextRef.current.audioWorklet.addModule(URL.createObjectURL(blob));
    } else if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
  }

  // --- connect to Gemini ---
  async function connect(): Promise<boolean> {
    if (connectingRef.current) return false;
    if (!genAIRef.current) return false;
    if (sessionRef.current && isSetupComplete) return true;

    try {
      connectingRef.current = true;
      if (sessionRef.current) sessionRef.current.close();

      const s = await genAIRef.current.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini connected ✅");
            setIsConnected(true);
            connectingRef.current = false;
          },
          onmessage: (msg) => {
            if ((msg as any)?.setupComplete) setIsSetupComplete(true);

            // handle audio parts
            if ((msg as any)?.serverContent?.modelTurn?.parts) {
              (msg as any).serverContent.modelTurn.parts.forEach((p: any) => {
                if (p.inlineData?.data) {
                  const ab = base64ToArrayBuffer(p.inlineData.data as string);
                  audioHandlersRef.current.forEach((h) => h(ab));
                }
              });
            }

            // transcription updates
            if ((msg as any)?.serverContent?.outputTranscription?.text) {
              setTranscription((msg as any).serverContent.outputTranscription.text);
            }
          },
          onerror: (e) => {
            console.error("Gemini websocket error", e);
            setIsConnected(false);
            connectingRef.current = false;
          },
          onclose: () => {
            console.log("Gemini closed ❌");
            setIsConnected(false);
            setIsSetupComplete(false);
            connectingRef.current = false;
          },
        },
      });

      sessionRef.current = s;
      return true;
    } catch (err) {
      console.error("connect error", err);
      setIsConnected(false);
      setIsSetupComplete(false);
      connectingRef.current = false;
      return false;
    }
  }

  function disconnect() {
    console.log("Gemini disconnecting...");
    sessionRef.current?.close();
    sessionRef.current = null;
    setIsConnected(false);
    setIsSetupComplete(false);
    connectingRef.current = false;
    stopMic();
  }

  // --- reconnect loop with guard ---
  useEffect(() => {
    let shouldRun = true;
    async function watch() {
      while (shouldRun) {
        if (!paused && !isConnected && !connectingRef.current) {
          await connect();
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    watch();
    return () => {
      shouldRun = false;
    };
  }, [paused, isConnected]);

  // --- mic control ---
  async function startMic() {
    if (paused) return;
    try {
      await ensureAudioWorklet();
      if (!audioContextRef.current) throw new Error("AudioContext not ready");
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      micSourceNodeRef.current = audioContextRef.current.createMediaStreamSource(micStreamRef.current);
      audioWorkletNodeRef.current = new AudioWorkletNode(audioContextRef.current, "audio-processor", {
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, bufferSize: WORKLET_BUFFER_SIZE },
      });
      audioWorkletNodeRef.current.port.onmessage = (ev) => {
        if (ev.data?.pcmData && sessionRef.current && !paused) {
          const base64 = arrayBufferToBase64(ev.data.pcmData);
          const blob: GenAIBlob = { data: base64, mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}` };
          sessionRef.current!.sendRealtimeInput({ media: blob });
        }
      };
      micSourceNodeRef.current.connect(audioWorkletNodeRef.current);
    } catch (e) {
      console.error("startMic error", e);
    }
  }

  function stopMic() {
    try {
      audioWorkletNodeRef.current?.disconnect();
      micSourceNodeRef.current?.disconnect();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn("stopMic cleanup error", e);
    }
    audioWorkletNodeRef.current = null;
    micSourceNodeRef.current = null;
    micStreamRef.current = null;
  }

  // --- send image frame ---
  function sendImageFrame(base64: string, mimeType: string) {
    if (!sessionRef.current || paused) return;
    try {
      const blob: GenAIBlob = { data: base64, mimeType };
      sessionRef.current.sendRealtimeInput({ media: blob });
    } catch (e) {
      console.error("sendImageFrame error", e);
    }
  }

  // --- send text + optional image ---
  async function sendTextWithOptionalImage(text: string, imageFile?: File) {
    if (!sessionRef.current || paused) throw new Error("Not connected or paused");
    try {
      if (imageFile) {
        const base64 = await fileToBase64(imageFile);
        const mimeType = imageFile.type || "image/png";
        const blob: GenAIBlob = { data: base64.split(",")[1], mimeType };
        sessionRef.current.sendRealtimeInput({ media: blob });
        await new Promise((r) => setTimeout(r, 200));
      }
      sessionRef.current.sendClientContent({ turns: text });
    } catch (e) {
      console.error("sendTextWithOptionalImage error", e);
    }
  }

  function fileToBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  const ctxValue: GeminiContextValue = {
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
  };

  return <GeminiContext.Provider value={ctxValue}>{children}</GeminiContext.Provider>;
};
