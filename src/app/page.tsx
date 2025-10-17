"use client";
import { useEffect } from "react";
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  type Session,
  type Blob as GenAIBlob,
} from "@google/genai";

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
const MODEL_NAME = "gemini-2.0-flash-live-001";
const TARGET_SAMPLE_RATE = 16000;
const WORKLET_BUFFER_SIZE = 4096;
const IMAGE_SEND_INTERVAL_MS = 5000;

// --- Helpers ---
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export default function Page() {
  useEffect(() => {
    if (!API_KEY) return console.error("Missing NEXT_PUBLIC_GEMINI_API_KEY");

    class GeminiLiveVoiceApp {
      private genAI = new GoogleGenAI({ apiKey: API_KEY!, apiVersion: "v1alpha" });
      private recordButton = document.getElementById("recordButton") as HTMLButtonElement;
      private micIcon = document.getElementById("micIcon")!;
      private recordText = document.getElementById("recordText")!;
      private statusEl = document.getElementById("recordingStatus") as HTMLSpanElement;
      private imageInput = document.getElementById("imageUpload") as HTMLInputElement;
      private imagePreview = document.getElementById("imagePreview") as HTMLImageElement;
      private imageContainer = document.getElementById("imagePreviewContainer") as HTMLDivElement;
      private removeImageBtn = document.getElementById("removeImageButton") as HTMLButtonElement;
      private transcriptionEl = document.getElementById("transcription") as HTMLDivElement;
      private session: Session | null = null;
      private audioCtx: AudioContext | null = null;
      private micStream: MediaStream | null = null;
      private micSource: MediaStreamAudioSourceNode | null = null;
      private worklet: AudioWorkletNode | null = null;
      private audioQueue: ArrayBuffer[] = [];
      private isRecording = false;
      private isPlaying = false;
      private isSetup = false;
      private imgData: { base64: string; type: string } | null = null;
      private imgTimer: number | null = null;

      constructor() {
        this.recordButton.addEventListener("click", () => this.toggleRecording());
        this.imageInput.addEventListener("change", (e) => this.handleImage(e));
        this.removeImageBtn.addEventListener("click", () => this.clearImage());
        window.addEventListener("sendTextMessage", (e: Event) => {
          const val = (e as CustomEvent<string>).detail;
          this.sendText(val);
        });
        this.setStatus('Click "Talk" or Upload an Image');
      }

      private setStatus(msg: string, err = false) {
        this.statusEl.textContent = msg;
        this.statusEl.style.color = err ? "#ff453a" : "#A8A8A8";
      }

      private showText(txt: string) {
        this.transcriptionEl.textContent = txt;
      }

      private async sendText(msg: string) {
        this.showText("");
        if (!this.session) await this.connect();
        this.session?.sendClientContent({ turns: msg });
      }

      private async handleImage(e: Event) {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
          return this.setStatus("Invalid image type", true);
        const reader = new FileReader();
        reader.onload = (ev) => {
          const base64 = (ev.target?.result as string).split(",")[1];
          this.imgData = { base64, type: file.type };
          this.imagePreview.src = ev.target?.result as string;
          this.imageContainer.style.display = "block";
          this.setStatus("Image ready — will send during voice chat.");
        };
        reader.readAsDataURL(file);
      }

      private clearImage() {
        this.imgData = null;
        this.imagePreview.src = "#";
        this.imageContainer.style.display = "none";
        this.imageInput.value = "";
        this.setStatus('Image removed. Click "Talk" or Upload an Image');
      }

      private startImageLoop() {
        if (this.imgTimer) clearInterval(this.imgTimer);
        if (!this.session || !this.isSetup || !this.isRecording) return;
        this.imgTimer = window.setInterval(() => this.sendImage(), IMAGE_SEND_INTERVAL_MS);
        if (this.imgData) this.sendImage();
      }

      private stopImageLoop() {
        if (this.imgTimer) clearInterval(this.imgTimer);
      }

      private sendImage() {
        if (!this.session || !this.isRecording || !this.imgData) return;
        const blob: GenAIBlob = { data: this.imgData.base64, mimeType: this.imgData.type };
        this.session.sendRealtimeInput({ media: blob });
      }

      private async setupAudio() {
        if (!this.audioCtx) {
          this.audioCtx = new (window.AudioContext ||
            (window as any).webkitAudioContext)();
          const workletCode = `
            class AudioProcessor extends AudioWorkletProcessor {
              constructor(o){super();this.sampleRate=sampleRate;
                this.targetRate=o.processorOptions.targetSampleRate||16000;
                this.bufferSize=o.processorOptions.bufferSize||4096;
                this.buf=new Float32Array(this.bufferSize*4);this.idx=0;
                this.ratio=this.sampleRate/this.targetRate;}
              process(i){const c=i[0]?.[0];
                if(c){if(this.idx+c.length<=this.buf.length){this.buf.set(c,this.idx);this.idx+=c.length;}}
                if(this.idx>=this.bufferSize*this.ratio)this.flush();return true;}
              flush(){const o=new Float32Array(this.bufferSize);
                for(let i=0;i<this.bufferSize;i++){const p=i*this.ratio;
                  const k=Math.floor(p);const t=p-k;
                  o[i]=this.buf[k]*(1-t)+(this.buf[k+1]||0)*t;}
                const pcm=new Int16Array(o.length);
                for(let i=0;i<o.length;i++)pcm[i]=Math.max(-1,Math.min(1,o[i]))*32767;
                this.port.postMessage({pcmData:pcm.buffer},[pcm.buffer]);
                this.buf.copyWithin(0,this.bufferSize*this.ratio,this.idx);
                this.idx-=this.bufferSize*this.ratio;}
            }registerProcessor("audio-processor",AudioProcessor);
          `;
          const blob = new Blob([workletCode], { type: "application/javascript" });
          await this.audioCtx.audioWorklet.addModule(URL.createObjectURL(blob));
        } else if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
      }

      private async connect() {
        this.setStatus("Connecting...");
        try {
          if (this.session) this.session.close();
          this.session = await this.genAI.live.connect({
            model: MODEL_NAME,
            config: {
              responseModalities: [Modality.AUDIO],
              outputAudioTranscription: {},
              realtimeInputConfig: {
                automaticActivityDetection: {
                  disabled: false,
                  startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                  endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                },
              },
            },
            callbacks: {
              onopen: () => this.setStatus("Connected. Ready."),
              onmessage: (msg) => {
                if (msg?.setupComplete) {
                  this.isSetup = true;
                  this.setStatus("Ready to talk or Upload Image");
                }
                if (msg?.serverContent?.modelTurn?.parts)
                  msg.serverContent.modelTurn.parts.forEach((p) => {
                    if (p.inlineData?.data)
                      this.enqueue(base64ToArrayBuffer(p.inlineData.data));
                  });
                if (msg?.serverContent?.outputTranscription?.text)
                  this.showText(msg.serverContent.outputTranscription.text);
                if (msg?.serverContent?.turnComplete)
                  this.setStatus("Turn complete. Ready for next input.");
              },
              onerror: (e) => {
                console.error(e);
                this.setStatus("Error", true);
                this.cleanup();
              },
              onclose: () => {
                this.cleanup();
                this.setStatus("Disconnected");
              },
            },
          });
        } catch {
          this.setStatus("Connection failed", true);
          this.cleanup();
        }
      }

      private enqueue(buf: ArrayBuffer) {
        this.audioQueue.push(buf);
        if (!this.isPlaying) this.play();
      }

      private async play() {
        if (this.audioQueue.length === 0) {
          this.isPlaying = false;
          return;
        }
        this.isPlaying = true;
        if (!this.audioCtx) await this.setupAudio();
        const buf = this.audioQueue.shift()!;
        const PLAYBACK_SR = 24000;
        const int16 = new Int16Array(buf);
        const f32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
        const audioBuf = this.audioCtx!.createBuffer(1, f32.length, PLAYBACK_SR);
        audioBuf.copyToChannel(f32, 0);
        const src = this.audioCtx!.createBufferSource();
        src.buffer = audioBuf;
        src.connect(this.audioCtx!.destination);
        src.start();
        src.onended = () => this.play();
      }

      private cleanup() {
        this.isRecording = false;
        this.isSetup = false;
        this.stopImageLoop();
        this.micStream?.getTracks().forEach((t) => t.stop());
        this.session?.close();
        this.audioQueue = [];
        this.isPlaying = false;
        this.updateButton();
      }

      private async toggleRecording() {
        await this.setupAudio();
        if (this.isRecording) this.stop();
        else {
          this.showText("");
          this.isRecording = true;
          this.updateButton();
          await this.start();
        }
      }

      private async start() {
        await this.connect();
        if (!this.isSetup) return this.setStatus("Setting up...");
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
          this.micSource = this.audioCtx!.createMediaStreamSource(this.micStream);
          this.worklet = new AudioWorkletNode(this.audioCtx!, "audio-processor", {
            processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, bufferSize: WORKLET_BUFFER_SIZE },
          });
          this.worklet.port.onmessage = (e) => {
            if (e.data.pcmData && this.session && this.isRecording) {
              const b64 = arrayBufferToBase64(e.data.pcmData);
              const blob: GenAIBlob = { data: b64, mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}` };
              this.session.sendRealtimeInput({ media: blob });
            }
          };
          this.micSource.connect(this.worklet);
          this.setStatus("Listening...");
          this.startImageLoop();
        } catch {
          this.setStatus("Mic error", true);
          this.isRecording = false;
          this.updateButton();
        }
      }

      private stop() {
        this.isRecording = false;
        this.stopImageLoop();
        this.micStream?.getTracks().forEach((t) => t.stop());
        this.session?.close();
        this.setStatus("Call ended.");
        this.updateButton();
      }

      private updateButton() {
        if (this.isRecording) {
          this.recordButton.classList.add("bg-red-500");
          this.recordText.textContent = "Stop";
          this.micIcon.classList.replace("fa-microphone", "fa-stop");
        } else {
          this.recordButton.classList.remove("bg-red-500");
          this.recordText.textContent = "Talk";
          this.micIcon.classList.replace("fa-stop", "fa-microphone");
        }
      }
    }

    new GeminiLiveVoiceApp();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#121212] text-[#E1E1E1]">
      <div className="flex flex-col items-center space-y-6">
        <h1 className="text-3xl font-semibold">Multimodal Live Chat - YeyuLab</h1>
        <div className="p-6 bg-[#1E1E1E] rounded-2xl shadow-lg flex flex-col items-center">
          <span id="recordingStatus" className="text-[#A8A8A8] mb-4">Ready</span>
          <button id="recordButton" className="w-24 h-24 rounded-full bg-[#82aaff] flex flex-col justify-center items-center text-white transition-colors hover:bg-[#6c8edf] relative">
            <i id="micIcon" className="fas fa-microphone text-3xl mb-1" />
            <span id="recordText" className="text-sm font-medium">Talk</span>
          </button>

          {/* Single-line, cleared-per-turn transcription */}
          <div id="transcription" className="mt-4 text-sm text-gray-400 max-w-xs text-center"></div>

          <input
            id="chatInput"
            type="text"
            placeholder="Type a message..."
            className="mt-2 w-80 rounded px-3 py-2 bg-[#1E1E1E] text-white focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = e.currentTarget.value.trim();
                if (v) {
                  window.dispatchEvent(new CustomEvent("sendTextMessage", { detail: v }));
                  e.currentTarget.value = "";
                }
              }
            }}
          />

          <div className="mt-6 flex flex-col items-center bg-[#2a2a2a] rounded-lg p-4 w-80 border border-white/10 space-y-3">
            <label htmlFor="imageUpload" className="bg-[#82aaff] hover:bg-[#6c8edf] text-white rounded px-4 py-2 flex items-center cursor-pointer space-x-2">
              <i className="fas fa-image"></i>
              <span>Upload Image</span>
            </label>
            <input id="imageUpload" type="file" accept="image/png,image/jpeg,image/webp" className="hidden" />
            <div id="imagePreviewContainer" className="hidden relative border-2 border-dashed border-white/20 p-2 rounded w-full">
              <img id="imagePreview" src="#" alt="Preview" className="max-h-52 mx-auto rounded object-contain" />
              <button id="removeImageButton" title="Remove" className="absolute -top-3 -right-3 bg-red-500 text-white w-6 h-6 rounded-full text-sm font-bold">×</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
