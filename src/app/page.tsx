'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GoogleGenAI, Modality, Session } from '@google/genai';
import type { Blob as GenAIBlob } from '@google/genai';

const MODEL_NAME = 'gemini-2.0-flash-live-001';
const TARGET_SAMPLE_RATE = 16000;
const WORKLET_BUFFER_SIZE = 4096;
const IMAGE_SEND_INTERVAL_MS = 5000;

// Environment variable (set via .env.local)
const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export default function Page(): JSX.Element {
  const [status, setStatus] = useState<string>('Ready to talk or upload an image');
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState<string | null>(null);

  const genAIRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  const imageIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // --- Initialize Google GenAI instance ---
  useEffect(() => {
    if (!API_KEY) {
      setStatus('Missing API key. Please set NEXT_PUBLIC_GEMINI_API_KEY.');
      return;
    }
    genAIRef.current = new GoogleGenAI({ apiKey: API_KEY, apiVersion: 'v1alpha' });
  }, []);

  // --- Helper: Play queued audio chunks sequentially ---
  const playNextAudio = useCallback(async () => {
    const queue = audioQueueRef.current;
    if (queue.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    const chunk = queue.shift()!;
    const ctx = audioContextRef.current ?? new AudioContext();
    audioContextRef.current = ctx;

    const int16Array = new Int16Array(chunk);
    const float32 = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) float32[i] = int16Array[i] / 32768;
    const buf = ctx.createBuffer(1, float32.length, 24000);
    buf.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    src.onended = () => playNextAudio();
  }, []);

  const enqueueAudio = useCallback(
    (buf: ArrayBuffer) => {
      audioQueueRef.current.push(buf);
      if (!isPlayingRef.current) void playNextAudio();
    },
    [playNextAudio]
  );

  // --- Connect to Gemini session ---
  const connectToGemini = useCallback(async (): Promise<boolean> => {
    const genAI = genAIRef.current;
    if (!genAI) {
      setStatus('GenAI not initialized');
      return false;
    }

    try {
      sessionRef.current = await genAI.live.connect({
        model: MODEL_NAME,
        config: { responseModalities: [Modality.AUDIO] },
        callbacks: {
          onopen: () => setStatus('Connected to Gemini'),
          onmessage: (event) => {
            const msg = event;
            if (msg?.setupComplete) setStatus('Setup complete. Listening...');
            if (msg?.serverContent?.modelTurn?.parts) {
              msg.serverContent.modelTurn.parts.forEach((part) => {
                if (part.inlineData?.data) {
                  enqueueAudio(base64ToArrayBuffer(part.inlineData.data));
                }
              });
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('WebSocket error', e);
            setStatus(`Error: ${e.message}`);
          },
          onclose: () => {
            setStatus('Disconnected');
            stopRecording();
          },
        },
      });
      return true;
    } catch (err) {
      console.error('connectToGemini error', err);
      setStatus('Connection failed');
      return false;
    }
  }, [enqueueAudio]);

  // --- Initialize Audio System ---
  const initAudioSystem = useCallback(async (): Promise<AudioContext | null> => {
    try {
      const ctx = new AudioContext();
      const blob = new Blob(
        [
          `
          class AudioProcessor extends AudioWorkletProcessor {
            constructor() { super(); this.buffer = []; }
            process(inputs) {
              const input = inputs[0][0];
              if (input) {
                const pcm = new Int16Array(input.length);
                for (let i=0;i<input.length;i++) pcm[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
                this.port.postMessage({ pcmData: pcm.buffer }, [pcm.buffer]);
              }
              return true;
            }
          }
          registerProcessor('audio-processor', AudioProcessor);
        `,
        ],
        { type: 'application/javascript' }
      );
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      audioContextRef.current = ctx;
      return ctx;
    } catch (err) {
      console.error('initAudioSystem failed', err);
      setStatus('Audio init failed');
      return null;
    }
  }, []);

  // --- Start Recording ---
  const startRecording = useCallback(async () => {
    setStatus('Starting...');
    const ctx = (await initAudioSystem()) ?? audioContextRef.current;
    if (!ctx) return;
    await connectToGemini();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'audio-processor');
    node.port.onmessage = (ev: MessageEvent<{ pcmData: ArrayBuffer }>) => {
      const pcm = ev.data.pcmData;
      const session = sessionRef.current;
      if (session && pcm) {
        const base64 = arrayBufferToBase64(pcm);
        const blob: GenAIBlob = { data: base64, mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}` };
        session.sendRealtimeInput({ media: blob });
      }
    };
    src.connect(node);
    setStatus('Listening...');
    setIsRecording(true);
  }, [connectToGemini, initAudioSystem]);

  // --- Stop Recording ---
  const stopRecording = useCallback(() => {
    setIsRecording(false);
    if (imageIntervalRef.current) clearInterval(imageIntervalRef.current);
    sessionRef.current?.close();
    setStatus('Call ended');
  }, []);

  // --- Handle Image Upload ---
  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const mime = file.type;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      setStatus('Unsupported image type');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      setImagePreview(reader.result as string);
      setImageMime(mime);
      setStatus('Image loaded');
      const sendImage = () => {
        const session = sessionRef.current;
        if (session && base64 && isRecording) {
          const blob: GenAIBlob = { data: base64, mimeType: mime };
          session.sendRealtimeInput({ media: blob });
          console.log('Sent image to Gemini');
        }
      };
      sendImage();
      imageIntervalRef.current = setInterval(sendImage, IMAGE_SEND_INTERVAL_MS);
    };
    reader.readAsDataURL(file);
  }, [isRecording]);

  const removeImage = useCallback(() => {
    setImagePreview(null);
    setImageMime(null);
    if (imageIntervalRef.current) clearInterval(imageIntervalRef.current);
    setStatus('Image removed');
  }, []);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-gray-950 text-gray-100 p-6">
      <h1 className="text-3xl font-semibold mb-8 text-center text-blue-400">
        Multimodal Live Chat – YeyuLab
      </h1>

      <div className="flex flex-col items-center bg-gray-900 p-8 rounded-2xl shadow-xl w-full max-w-md">
        <span className="mb-4 text-gray-400 text-sm">{status}</span>

        {/* Record Button */}
        <button
          onClick={isRecording ? stopRecording : startRecording}
          className={`relative flex flex-col items-center justify-center w-24 h-24 rounded-full transition-colors ${
            isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'
          }`}
        >
          <i
            className={`fa-solid ${isRecording ? 'fa-stop' : 'fa-microphone'} text-3xl mb-1`}
          ></i>
          <span className="text-sm">{isRecording ? 'Stop' : 'Talk'}</span>
          {isRecording && (
            <svg className="absolute inset-0 w-full h-full animate-ping text-red-400 opacity-50">
              <circle cx="50%" cy="50%" r="40%" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
          )}
        </button>

        {/* Image Upload */}
        <div className="mt-6 flex flex-col items-center gap-3 w-full">
          <label
            htmlFor="imageUpload"
            className="flex items-center px-4 py-2 bg-blue-500 hover:bg-blue-600 rounded-md cursor-pointer text-white text-sm"
          >
            <i className="fa-solid fa-image mr-2"></i> Upload Image
          </label>
          <input
            id="imageUpload"
            type="file"
            accept="image/png, image/jpeg, image/webp"
            onChange={handleImageUpload}
            className="hidden"
          />
          {imagePreview && (
            <div className="relative border border-gray-700 rounded-md overflow-hidden">
              <img src={imagePreview} alt="Preview" className="max-h-48 object-contain" />
              <button
                onClick={removeImage}
                className="absolute top-1 right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5"
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
