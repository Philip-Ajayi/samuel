'use client';

import { useEffect, useRef, useState } from 'react';
import { GoogleGenAI, Modality, Session } from '@google/genai';
import type { Blob as GenAIBlob } from '@google/genai';

const MODEL_NAME = 'gemini-2.0-flash-live-001';
const TARGET_SAMPLE_RATE = 16000;
const WORKLET_BUFFER_SIZE = 4096;
const IMAGE_SEND_INTERVAL_MS = 5000;

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export default function Page() {
  const [status, setStatus] = useState('Click "Talk" or Upload an Image');
  const [isRecording, setIsRecording] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const genAI = useRef<GoogleGenAI | null>(null);
  const session = useRef<Session | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const micSourceNode = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioWorkletNode = useRef<AudioWorkletNode | null>(null);

  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState<string | null>(null);
  const imageSendInterval = useRef<NodeJS.Timeout | null>(null);
  const audioQueue = useRef<ArrayBuffer[]>([]);
  const isPlayingAudio = useRef(false);
  const isSetupComplete = useRef(false);

  // ==========================
  // === INITIALIZATION
  // ==========================
  useEffect(() => {
    if (!API_KEY) {
      setStatus('API Key not found. Set NEXT_PUBLIC_GEMINI_API_KEY.');
      return;
    }
    genAI.current = new GoogleGenAI({ apiKey: API_KEY, apiVersion: 'v1alpha' });
  }, []);

  // ==========================
  // === IMAGE HANDLERS
  // ==========================
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const mimeType = file.type;
    const valid = ['image/jpeg', 'image/png', 'image/webp'];
    if (!valid.includes(mimeType)) {
      setStatus('Invalid image type. Use JPG, PNG, or WEBP.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = (ev.target?.result as string).split(',')[1];
      setImageBase64(base64);
      setImageMime(mimeType);
      setImagePreview(ev.target?.result as string);
      setStatus('Image loaded. It will be sent periodically.');
    };
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setImagePreview(null);
    setImageBase64(null);
    setImageMime(null);
    setStatus('Image removed. Click "Talk" or Upload an Image');
  };

  // ==========================
  // === AUDIO SYSTEM
  // ==========================
  async function initAudio() {
    if (!audioContext.current) {
      try {
        audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        if (audioContext.current.state === 'suspended') await audioContext.current.resume();

        // Load audio worklet for real-time PCM downsampling
        const workletCode = `
          class AudioProcessor extends AudioWorkletProcessor {
            constructor() {
              super();
              this.buffer = [];
              this.sampleRateIn = sampleRate;
              this.targetRate = ${TARGET_SAMPLE_RATE};
              this.ratio = this.sampleRateIn / this.targetRate;
            }
            process(inputs) {
              const input = inputs[0]?.[0];
              if (input) {
                const downsampled = new Int16Array(Math.floor(input.length / this.ratio));
                for (let i = 0; i < downsampled.length; i++) {
                  const idx = Math.floor(i * this.ratio);
                  downsampled[i] = Math.max(-1, Math.min(1, input[idx])) * 32767;
                }
                this.port.postMessage({ pcmData: downsampled.buffer }, [downsampled.buffer]);
              }
              return true;
            }
          }
          registerProcessor('audio-processor', AudioProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await audioContext.current.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error('Audio init error', e);
        setStatus('Error initializing audio system.');
        return false;
      }
    }
    return true;
  }

  async function connectToGemini() {
    if (!genAI.current) return false;
    setStatus('Connecting to Gemini...');
    try {
      session.current = await genAI.current.live.connect({
        model: MODEL_NAME,
        config: { responseModalities: [Modality.AUDIO] },
        callbacks: {
          onopen: () => setStatus('Connected to Gemini'),
          onmessage: (msg) => {
            if (msg.setupComplete) {
              isSetupComplete.current = true;
              setStatus('Ready to talk or Upload Image');
              if (isRecording) startRecording(); // auto-start if user clicked earlier
            }
            if (msg.serverContent?.modelTurn?.parts) {
              msg.serverContent.modelTurn.parts.forEach((part: any) => {
                if (part.inlineData?.data) {
                  const buf = base64ToArrayBuffer(part.inlineData.data);
                  audioQueue.current.push(buf);
                  if (!isPlayingAudio.current) playNextAudio();
                }
              });
            }
          },
          onerror: (err) => {
            console.error('Gemini error', err);
            cleanup();
          },
          onclose: () => {
            setStatus('Disconnected');
            cleanup();
          },
        },
      });
      return true;
    } catch (e) {
      console.error('Gemini connect error', e);
      setStatus('Connection failed');
      return false;
    }
  }

  // ==========================
  // === AUDIO PLAYBACK
  // ==========================
  async function playNextAudio() {
    if (audioQueue.current.length === 0) {
      isPlayingAudio.current = false;
      return;
    }
    isPlayingAudio.current = true;
    const buf = audioQueue.current.shift()!;
    const ctx = audioContext.current;
    if (!ctx) return;
    const PLAYBACK_SR = 24000;
    const int16 = new Int16Array(buf);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const audioBuffer = ctx.createBuffer(1, float32.length, PLAYBACK_SR);
    audioBuffer.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);
    src.start();
    src.onended = playNextAudio;
  }

  // ==========================
  // === RECORDING FLOW
  // ==========================
  async function startRecording() {
    if (!await initAudio()) return;
    if (!session.current || !isSetupComplete.current) {
      await connectToGemini();
      return;
    }
    try {
      setStatus('Requesting microphone...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream.current = stream;
      const ctx = audioContext.current!;
      micSourceNode.current = ctx.createMediaStreamSource(stream);
      audioWorkletNode.current = new AudioWorkletNode(ctx, 'audio-processor');

      audioWorkletNode.current.port.onmessage = (e) => {
        if (e.data.pcmData && isRecording && session.current) {
          const base64Audio = arrayBufferToBase64(e.data.pcmData);
          const audioBlob: GenAIBlob = {
            data: base64Audio,
            mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}`,
          };
          session.current.sendRealtimeInput({ media: audioBlob });
        }
      };
      micSourceNode.current.connect(audioWorkletNode.current);
      setStatus('Listening...');
      startImageInterval();
    } catch (e) {
      console.error('Mic error', e);
      setStatus('Microphone access error');
    }
  }

  function stopRecording() {
    setIsRecording(false);
    setStatus('Call ended.');
    stopImageInterval();
    micStream.current?.getTracks().forEach((t) => t.stop());
    micSourceNode.current?.disconnect();
    audioWorkletNode.current?.disconnect();
    if (session.current) {
      try { session.current.close(); } catch {}
      session.current = null;
    }
  }

  function cleanup() {
    stopRecording();
    isSetupComplete.current = false;
  }

  // ==========================
  // === IMAGE INTERVAL
  // ==========================
  function startImageInterval() {
    stopImageInterval();
    if (!session.current || !isRecording || !imageBase64 || !imageMime) return;
    sendImage();
    imageSendInterval.current = setInterval(sendImage, IMAGE_SEND_INTERVAL_MS);
  }

  function stopImageInterval() {
    if (imageSendInterval.current) clearInterval(imageSendInterval.current);
  }

  function sendImage() {
    if (session.current && imageBase64 && imageMime && isRecording) {
      const blob: GenAIBlob = { data: imageBase64, mimeType: imageMime };
      try {
        session.current.sendRealtimeInput({ media: blob });
      } catch (e) {
        console.error('Send image error', e);
      }
    }
  }

  // ==========================
  // === UI ACTIONS
  // ==========================
  const toggleRecording = async () => {
    if (isRecording) stopRecording();
    else {
      setIsRecording(true);
      await startRecording();
    }
  };

  // ==========================
  // === RENDER
  // ==========================
  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-gray-200 p-4">
      <h1 className="text-3xl font-semibold mb-8 text-white">
        Multimodal Live Chat – YeyuLab
      </h1>

      <div className="bg-neutral-800 rounded-2xl p-8 flex flex-col items-center shadow-lg w-full max-w-md">
        <span className="mb-4 text-sm text-gray-400">{status}</span>

        {/* Record button */}
        <button
          onClick={toggleRecording}
          className={`relative w-24 h-24 rounded-full flex flex-col items-center justify-center text-white transition-colors ${
            isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'
          }`}
        >
          <i
            className={`fas ${isRecording ? 'fa-stop' : 'fa-microphone'} text-3xl mb-2`}
          />
          <span className="text-sm">{isRecording ? 'Stop' : 'Talk'}</span>
          {isRecording && (
            <svg
              className="absolute inset-0 animate-ping opacity-70 text-red-400"
              viewBox="0 0 100 100"
            >
              <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" strokeWidth="4" />
            </svg>
          )}
        </button>

        {/* Image upload */}
        <div className="mt-6 w-full flex flex-col items-center gap-3">
          <label
            htmlFor="imageUpload"
            className="flex items-center gap-2 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded cursor-pointer"
          >
            <i className="fas fa-image" /> Upload Image
          </label>
          <input
            id="imageUpload"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handleImageUpload}
          />
          {imagePreview && (
            <div className="relative border border-gray-600 rounded-lg p-2">
              <img
                src={imagePreview}
                alt="Preview"
                className="max-h-48 rounded object-contain"
              />
              <button
                onClick={removeImage}
                className="absolute -top-2 -right-2 bg-red-600 rounded-full text-white w-6 h-6 flex items-center justify-center text-sm"
                title="Remove image"
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
