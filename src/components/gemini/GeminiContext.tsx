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

  useEffect(() => {
    if (!API_KEY) {
      console.error("Missing NEXT_PUBLIC_GEMINI_API_KEY");
      return;
    }
    if (!genAIRef.current) {
      genAIRef.current = new GoogleGenAI({ apiKey: API_KEY, apiVersion: "v1alpha" });
    }
  }, []);

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = window.atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function registerAudioHandler(h: AudioHandler): () => void {
    audioHandlersRef.current.add(h);
    return () => audioHandlersRef.current.delete(h);
  }

  async function ensureAudioWorklet(): Promise<void> {
    if (!audioContextRef.current) {
      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioContextRef.current = new AudioCtx();
      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

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
          onmessage: (msg: unknown) => {
            const message = msg as {
              setupComplete?: boolean;
              serverContent?: {
                modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
                outputTranscription?: { text?: string };
              };
            };
            if (message.setupComplete) setIsSetupComplete(true);
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              parts.forEach((p) => {
                const data = p.inlineData?.data;
                if (data) {
                  const ab = base64ToArrayBuffer(data);
                  audioHandlersRef.current.forEach((h) => h(ab));
                }
              });
            }
            const text = message.serverContent?.outputTranscription?.text;
            if (text) setTranscription(text);
          },
          onerror: (e: Event) => {
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

  function disconnect(): void {
    console.log("Gemini disconnecting...");
    sessionRef.current?.close();
    sessionRef.current = null;
    setIsConnected(false);
    setIsSetupComplete(false);
    connectingRef.current = false;
    stopMic();
  }

  useEffect(() => {
    let shouldRun = true;
    const watch = async (): Promise<void> => {
      while (shouldRun) {
        if (!paused && !isConnected && !connectingRef.current) {
          await connect();
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    void watch();
    return () => {
      shouldRun = false;
    };
  }, [paused, isConnected]);

  async function startMic(): Promise<void> {
    if (paused) return;
    try {
      await ensureAudioWorklet();
      if (!audioContextRef.current) throw new Error("AudioContext not ready");
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      micSourceNodeRef.current = audioContextRef.current.createMediaStreamSource(micStreamRef.current);
      audioWorkletNodeRef.current = new AudioWorkletNode(audioContextRef.current, "audio-processor", {
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, bufferSize: WORKLET_BUFFER_SIZE },
      });
      audioWorkletNodeRef.current.port.onmessage = (ev: MessageEvent<{ pcmData: ArrayBuffer }>) => {
        const { pcmData } = ev.data;
        if (pcmData && sessionRef.current && !paused) {
          const base64 = arrayBufferToBase64(pcmData);
          const blob: GenAIBlob = { data: base64, mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}` };
          sessionRef.current.sendRealtimeInput({ media: blob });
        }
      };
      micSourceNodeRef.current.connect(audioWorkletNodeRef.current);
    } catch (e) {
      console.error("startMic error", e);
    }
  }

  function stopMic(): void {
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

  function sendImageFrame(base64: string, mimeType: string): void {
    if (!sessionRef.current || paused) return;
    try {
      const blob: GenAIBlob = { data: base64, mimeType };
      sessionRef.current.sendRealtimeInput({ media: blob });
    } catch (e) {
      console.error("sendImageFrame error", e);
    }
  }

  async function sendTextWithOptionalImage(text: string, imageFile?: File): Promise<void> {
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

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
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
