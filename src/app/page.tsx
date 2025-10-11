'use client';

import { useRef, useState } from 'react';
import { GoogleGenAI, Modality, Session } from '@google/genai';
import type { Blob as GenAIBlob } from '@google/genai';

const API_KEY = 'AIzaSyCzUlQqOLxJWZfpSm8AFHOY_1P-mjatqUY';
const MODEL_NAME = 'gemini-2.0-flash-live-001';
const TARGET_SAMPLE_RATE = 16000;
const WORKLET_BUFFER_SIZE = 4096;
const IMAGE_SEND_INTERVAL_MS = 5000;

// Extend Window type for Safari support
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

// Helpers
function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Typed message from AudioWorklet
interface AudioWorkletMessage {
  pcmData: ArrayBuffer;
}

export default function LivePage() {
  const [status, setStatus] = useState('Ready');
  const [isRecording, setIsRecording] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [currentImageBase64, setCurrentImageBase64] = useState<string | null>(null);
  const [currentImageMimeType, setCurrentImageMimeType] = useState<string | null>(null);

  const sessionRef = useRef<Session | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingAudioRef = useRef(false);
  const imageIntervalRef = useRef<number | null>(null);
  const genAIRef = useRef(new GoogleGenAI({ apiKey: API_KEY, apiVersion: 'v1alpha' }));

  // --- UI Handlers ---
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setStatus('Invalid image type. Use JPG, PNG, or WEBP.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64Full = ev.target?.result as string;
      setCurrentImageBase64(base64Full.split(',')[1]);
      setCurrentImageMimeType(file.type);
      setImagePreview(base64Full);
      setStatus('Image loaded. Will be sent periodically.');
    };
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setCurrentImageBase64(null);
    setCurrentImageMimeType(null);
    setImagePreview(null);
    setStatus('Image removed.');
  };

  // --- Audio Helpers ---
  const initializeAudio = async (): Promise<boolean> => {
    if (!audioContextRef.current) {
      try {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
        }

        // AudioWorklet code as a string
        const workletCode = `
          class AudioProcessor extends AudioWorkletProcessor {
            constructor(options) {
              super();
              this.sampleRate = sampleRate;
              this.targetSampleRate = options.processorOptions.targetSampleRate || 16000;
              this.bufferSize = options.processorOptions.bufferSize || 4096;
              const minBuffer = Math.ceil(this.bufferSize * (this.sampleRate / this.targetSampleRate)) + 128;
              this._internalBuffer = new Float32Array(Math.max(minBuffer, this.bufferSize * 2));
              this._internalBufferIndex = 0;
              this.isProcessing = false;
              this.lastSendTime = currentTime;
              this.MAX_BUFFER_AGE_SECONDS = 0.5;
              this.resampleRatio = this.sampleRate / this.targetSampleRate;
            }
            process(inputs) {
              const input = inputs[0]?.[0];
              if (input?.length) {
                const space = this._internalBuffer.length - this._internalBufferIndex;
                const len = Math.min(space, input.length);
                this._internalBuffer.set(input.slice(0, len), this._internalBufferIndex);
                this._internalBufferIndex += len;
              }
              const minInput = Math.floor(this.bufferSize * this.resampleRatio);
              const shouldSend = (currentTime - this.lastSendTime > this.MAX_BUFFER_AGE_SECONDS && this._internalBufferIndex > 0)
                                || this._internalBufferIndex >= minInput;
              if (shouldSend && !this.isProcessing) this.sendBuffer();
              return true;
            }
            sendBuffer() {
              if (this._internalBufferIndex === 0) return;
              this.isProcessing = true;
              this.lastSendTime = currentTime;
              const output = new Float32Array(this.bufferSize);
              let outputIndex = 0;
              let consumed = 0;
              for (let i = 0; i < this.bufferSize; i++) {
                const P = i * this.resampleRatio;
                const K = Math.floor(P);
                const T = P - K;
                if (K + 1 < this._internalBufferIndex) {
                  output[outputIndex++] = this._internalBuffer[K] * (1 - T) + this._internalBuffer[K + 1] * T;
                } else if (K < this._internalBufferIndex) {
                  output[outputIndex++] = this._internalBuffer[K];
                } else break;
                consumed = K + 1;
              }
              const finalBuffer = output.slice(0, outputIndex);
              const pcmData = new Int16Array(finalBuffer.length);
              for (let i = 0; i < finalBuffer.length; i++) pcmData[i] = Math.max(-1, Math.min(1, finalBuffer[i])) * 32767;
              this.port.postMessage({ pcmData: pcmData.buffer }, [pcmData.buffer]);
              this._internalBuffer.copyWithin(0, consumed, this._internalBufferIndex);
              this._internalBufferIndex -= consumed;
              this.isProcessing = false;
            }
          }
          registerProcessor('audio-processor', AudioProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await audioContextRef.current.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        return true;
      } catch (err) {
        setStatus('Audio initialization failed.');
        console.error(err);
        return false;
      }
    }
    if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
    return true;
  };

  // --- Gemini Connection ---
  const connectToGemini = async (): Promise<boolean> => {
    setStatus('Connecting to Gemini...');
    try {
      sessionRef.current?.close();
      const session = await genAIRef.current.live.connect({
        model: MODEL_NAME,
        config: { responseModalities: [Modality.AUDIO] },
        callbacks: {
          onopen: () => setStatus('Connected to Gemini!'),
          onmessage: (msg) => {
            if (msg?.setupComplete) {
              setStatus('Ready to talk or Upload Image');
            }
            msg?.serverContent?.modelTurn?.parts?.forEach((part) => {
              if (part.inlineData?.data && typeof part.inlineData.data === 'string') {
                enqueueAudio(base64ToArrayBuffer(part.inlineData.data));
              }
            });
          },
          onerror: (e) => {
            console.error(e);
            setStatus('Gemini WebSocket Error');
          },
          onclose: () => {
            setStatus('Disconnected.');
          },
        },
      });
      sessionRef.current = session;
      return true;
    } catch (err) {
      console.error(err);
      setStatus('Failed to connect Gemini.');
      return false;
    }
  };

  // --- Audio Queue ---
  const enqueueAudio = (buffer: ArrayBuffer) => {
    audioQueueRef.current.push(buffer);
    if (!isPlayingAudioRef.current) playNextInQueue();
  };

  const playNextInQueue = async () => {
    if (!audioQueueRef.current.length) {
      isPlayingAudioRef.current = false;
      if (!isRecording) setStatus('Ready to talk or Upload Image');
      return;
    }
    isPlayingAudioRef.current = true;
    const buffer = audioQueueRef.current.shift()!;
    if (!audioContextRef.current) await initializeAudio();

    try {
      const int16 = new Int16Array(buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
      const audioBuffer = audioContextRef.current!.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);
      const source = audioContextRef.current!.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContextRef.current!.destination);
      source.start();
      source.onended = playNextInQueue;
    } catch (err) {
      console.error(err);
      playNextInQueue();
    }
  };

  // --- Image Interval ---
  const startImageInterval = () => {
    if (imageIntervalRef.current) clearInterval(imageIntervalRef.current);
    imageIntervalRef.current = window.setInterval(() => {
      if (sessionRef.current && currentImageBase64 && currentImageMimeType) {
        const blob: GenAIBlob = { data: currentImageBase64, mimeType: currentImageMimeType };
        sessionRef.current.sendRealtimeInput({ media: blob });
      }
    }, IMAGE_SEND_INTERVAL_MS);
  };

  const stopImageInterval = () => {
    if (imageIntervalRef.current) clearInterval(imageIntervalRef.current);
  };

  // --- Recording ---
  const toggleRecording = async () => {
    if (isRecording) stopRecording();
    else {
      const ready = await initializeAudio();
      if (!ready) return;
      const connected = await connectToGemini();
      if (!connected) return;
      startRecording();
    }
  };

  const startRecording = async () => {
    setIsRecording(true);
    setStatus('Listening...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      micStreamRef.current = stream;
      const source = audioContextRef.current!.createMediaStreamSource(stream);
      micNodeRef.current = source;

      const worklet = new AudioWorkletNode(audioContextRef.current!, 'audio-processor', {
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, bufferSize: WORKLET_BUFFER_SIZE },
      });

      worklet.port.onmessage = (e: MessageEvent<AudioWorkletMessage>) => {
        if (e.data.pcmData && sessionRef.current) {
          const base64 = arrayBufferToBase64(e.data.pcmData);
          const blob: GenAIBlob = { data: base64, mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}` };
          sessionRef.current.sendRealtimeInput({ media: blob });
        }
      };

      source.connect(worklet);
      workletNodeRef.current = worklet;
      startImageInterval();
    } catch (err) {
      console.error(err);
      setStatus('Mic error.');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    stopImageInterval();
    micNodeRef.current?.disconnect();
    workletNodeRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    setStatus('Call ended.');
    sessionRef.current?.close();
    sessionRef.current = null;
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 text-gray-200 p-4">
      <h1 className="text-3xl font-semibold mb-6">Multimodal Live Chat</h1>

      <div className="flex flex-col items-center bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md space-y-6">
        <span className="text-gray-400">{status}</span>

        <button
          onClick={toggleRecording}
          className={`flex flex-col items-center justify-center w-24 h-24 rounded-full ${
            isRecording ? 'bg-red-600' : 'bg-blue-600'
          }`}
        >
          <i className={`fas ${isRecording ? 'fa-stop' : 'fa-microphone'} text-3xl mb-2`}></i>
          <span>{isRecording ? 'Stop' : 'Talk'}</span>
        </button>

        <div className="flex flex-col items-center w-full">
          <label className="flex items-center px-4 py-2 bg-blue-600 rounded-md cursor-pointer hover:bg-blue-500">
            <i className="fas fa-image mr-2"></i> Upload Image
            <input type="file" accept="image/png, image/jpeg, image/webp" onChange={handleImageUpload} className="hidden" />
          </label>

          {imagePreview && (
            <div className="relative mt-4 border-2 border-dashed border-gray-500 rounded p-1 w-full">
              <img src={imagePreview} alt="preview" className="w-full object-contain max-h-48 rounded" />
              <button
                onClick={removeImage}
                className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center"
              >
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
