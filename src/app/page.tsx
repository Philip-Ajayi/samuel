"use client";
import { useEffect } from "react";
import { GoogleGenAI, Modality, type Session, type Blob as GenAIBlob } from "@google/genai";

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
const MODEL_NAME = "gemini-2.0-flash-live-001";
const TARGET_SAMPLE_RATE = 16000;
const WORKLET_BUFFER_SIZE = 4096;
const IMAGE_SEND_INTERVAL_MS = 5000;

// --- Helper functions ---
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

// --- Main Component ---
export default function Page() {
  useEffect(() => {
    if (!API_KEY) {
      console.error("Missing NEXT_PUBLIC_GEMINI_API_KEY");
      return;
    }

    class GeminiLiveVoiceApp {
      private genAI: GoogleGenAI;
      private recordButton: HTMLButtonElement;
      private micIcon: HTMLElement;
      private recordText: HTMLElement;
      private recordingStatus: HTMLSpanElement;
      private recordWavesSVG: SVGSVGElement | null;
      private imageUploadInput: HTMLInputElement;
      private imagePreviewContainer: HTMLDivElement;
      private imagePreview: HTMLImageElement;
      private removeImageButton: HTMLButtonElement;
      private currentImageBase64: string | null = null;
      private currentImageMimeType: string | null = null;
      private session: Session | null = null;
      private isRecording = false;
      private audioContext: AudioContext | null = null;
      private micStream: MediaStream | null = null;
      private micSourceNode: MediaStreamAudioSourceNode | null = null;
      private audioWorkletNode: AudioWorkletNode | null = null;
      private audioQueue: ArrayBuffer[] = [];
      private isPlayingAudio = false;
      private isSetupComplete = false;
      private imageSendIntervalId: number | null = null;

      // --- New properties for text input ---
      private textInput: HTMLInputElement;
      private sendTextButton: HTMLButtonElement;

      constructor() {
        this.genAI = new GoogleGenAI({ apiKey: API_KEY!, apiVersion: "v1alpha" });

        this.recordButton = document.getElementById("recordButton") as HTMLButtonElement;
        this.micIcon = document.getElementById("micIcon")!;
        this.recordText = document.getElementById("recordText")!;
        this.recordingStatus = document.getElementById("recordingStatus") as HTMLSpanElement;
        this.recordWavesSVG = document.querySelector(".record-waves") as SVGSVGElement | null;
        this.imageUploadInput = document.getElementById("imageUpload") as HTMLInputElement;
        this.imagePreviewContainer = document.getElementById("imagePreviewContainer") as HTMLDivElement;
        this.imagePreview = document.getElementById("imagePreview") as HTMLImageElement;
        this.removeImageButton = document.getElementById("removeImageButton") as HTMLButtonElement;

        this.recordButton.addEventListener("click", () => this.toggleRecording());
        this.imageUploadInput.addEventListener("change", (e) => this.handleImageUpload(e));
        this.removeImageButton.addEventListener("click", () => this.removeImage());

        // --- Wire up text input elements (added) ---
        this.textInput = document.getElementById("textInput") as HTMLInputElement;
        this.sendTextButton = document.getElementById("sendTextButton") as HTMLButtonElement;
        if (this.sendTextButton) {
          this.sendTextButton.addEventListener("click", () => this.handleTextSend());
        }
        if (this.textInput) {
          this.textInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") this.handleTextSend();
          });
        }

        this.updateStatus('Click "Talk" or Upload an Image');
      }

      private updateStatus(msg: string, err = false) {
        this.recordingStatus.textContent = msg;
        this.recordingStatus.style.color = err ? "#ff453a" : "#A8A8A8";
        if (err) console.error(msg);
      }

      // --- ✅ Show transcription live ---
      private showTranscription(text: string) {
        const transcriptEl = document.getElementById("transcription");
        if (!transcriptEl) return;
        transcriptEl.textContent = text;
      }

      private async handleImageUpload(e: Event) {
        const target = e.target as HTMLInputElement;
        if (!target.files?.[0]) return;
        const img = target.files[0];
        const mimeType = img.type;
        const valid = ["image/jpeg", "image/png", "image/webp"];
        if (!valid.includes(mimeType)) {
          this.updateStatus("Invalid image type.", true);
          return this.removeImage();
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
          const base64Full = ev.target?.result as string;
          this.currentImageBase64 = base64Full.split(",")[1];
          this.currentImageMimeType = mimeType;
          this.imagePreview.src = base64Full;
          this.imagePreviewContainer.style.display = "block";
          this.updateStatus("Image loaded. It will be sent periodically during voice chat.");
        };
        reader.readAsDataURL(img);
      }

      private removeImage() {
        this.currentImageBase64 = null;
        this.currentImageMimeType = null;
        this.imagePreview.src = "#";
        this.imagePreviewContainer.style.display = "none";
        this.imageUploadInput.value = "";
        this.updateStatus('Image removed. Click "Talk" or Upload an Image');
      }

      private startPeriodicImageSending() {
        if (this.imageSendIntervalId) clearInterval(this.imageSendIntervalId);
        if (!this.session || !this.isSetupComplete || !this.isRecording) return;
        this.imageSendIntervalId = window.setInterval(() => this.sendPeriodicImageData(), IMAGE_SEND_INTERVAL_MS);
        if (this.currentImageBase64 && this.currentImageMimeType) this.sendPeriodicImageData();
      }

      private stopPeriodicImageSending() {
        if (this.imageSendIntervalId) clearInterval(this.imageSendIntervalId);
      }

      private sendPeriodicImageData() {
        if (!this.session || !this.isRecording || !this.currentImageBase64) return;
        const blob: GenAIBlob = { data: this.currentImageBase64!, mimeType: this.currentImageMimeType! };
        this.session.sendRealtimeInput({ media: blob });
      }

      private async initializeAudioSystem() {
        if (!this.audioContext) {
          this.audioContext = new (
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
          )();
          if (this.audioContext.state === "suspended") await this.audioContext.resume();
          const workletCode = `
            class AudioProcessor extends AudioWorkletProcessor {
              constructor(o){super();this.sampleRate=sampleRate;this.targetSampleRate=o.processorOptions.targetSampleRate||16000;this.bufferSize=o.processorOptions.bufferSize||4096;
              this._buffer=new Float32Array(this.bufferSize*4);this._index=0;this.resampleRatio=this.sampleRate/this.targetSampleRate;}
              process(i){const c=i[0]?.[0];if(c){if(this._index+c.length<=this._buffer.length){this._buffer.set(c,this._index);this._index+=c.length;}}
              if(this._index>=this.bufferSize*this.resampleRatio)this.flush();return true;}
              flush(){const o=new Float32Array(this.bufferSize);
              for(let i=0;i<this.bufferSize;i++){const P=i*this.resampleRatio;const K=Math.floor(P);const T=P-K;o[i]=this._buffer[K]*(1-T)+(this._buffer[K+1]||0)*T;}
              const pcm=new Int16Array(o.length);for(let i=0;i<o.length;i++){pcm[i]=Math.max(-1,Math.min(1,o[i]))*32767;}
              this.port.postMessage({pcmData:pcm.buffer},[pcm.buffer]);this._buffer.copyWithin(0,this.bufferSize*this.resampleRatio,this._index);this._index-=this.bufferSize*this.resampleRatio;}
            }registerProcessor("audio-processor",AudioProcessor);
          `;
          const blob = new Blob([workletCode], { type: "application/javascript" });
          await this.audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
        } else if (this.audioContext.state === "suspended") await this.audioContext.resume();
        return true;
      }

      private async connectToGeminiIfNeeded() {
        if (this.session && this.isSetupComplete) return true;
        return this.connectToGemini();
      }

      private async connectToGemini() {
        this.updateStatus("Connecting to Gemini...");
        try {
          if (this.session) this.session.close();
          this.session = await this.genAI.live.connect({
            model: MODEL_NAME,
            config: {
              responseModalities: [Modality.AUDIO],
              outputAudioTranscription: {}, // ✅ Enable live transcription
            },
            callbacks: {
              onopen: () => this.updateStatus("Connected to Gemini! Finalizing setup..."),
              onmessage: (msg) => {
                if (msg?.setupComplete) {
                  this.isSetupComplete = true;
                  this.updateStatus("Ready to talk or Upload Image");
                  if (this.isRecording) this.startRecording();
                }

                if (msg?.serverContent?.modelTurn?.parts)
                  msg.serverContent.modelTurn.parts.forEach((p) => {
                    if (p.inlineData?.data)
                      this.enqueueAudio(base64ToArrayBuffer(p.inlineData.data as string));
                  });

                if (msg?.serverContent?.outputTranscription?.text) {
                  this.showTranscription(msg.serverContent.outputTranscription.text);
                }
              },
              onerror: (e) => {
                console.error("WebSocket error", e);
                this.updateStatus("WebSocket Error", true);
                this.cleanup();
              },
              onclose: () => {
                this.cleanup();
                this.updateStatus("Disconnected.");
              },
            },
          });
          return true;
        } catch (e) {
          this.updateStatus("Connection failed.", true);
          this.cleanup();
          return false;
        }
      }

      private enqueueAudio(buf: ArrayBuffer) {
        this.audioQueue.push(buf);
        if (!this.isPlayingAudio) this.playNext();
      }

      private async playNext() {
        if (this.audioQueue.length === 0) {
          this.isPlayingAudio = false;
          this.updateStatus(this.isRecording ? "Listening..." : "Ready to talk or Upload Image");
          return;
        }
        this.isPlayingAudio = true;
        const buf = this.audioQueue.shift()!;
        if (!this.audioContext) await this.initializeAudioSystem();
        const PLAYBACK_SR = 24000;
        const int16 = new Int16Array(buf);
        const f32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
        const audioBuffer = this.audioContext!.createBuffer(1, f32.length, PLAYBACK_SR);
        audioBuffer.copyToChannel(f32, 0);
        const src = this.audioContext!.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(this.audioContext!.destination);
        src.start();
        src.onended = () => this.playNext();
        this.updateStatus("Playing Gemini response...");
      }

      private cleanup() {
        this.isRecording = false;
        this.isSetupComplete = false;
        this.stopPeriodicImageSending();
        this.cleanupAudio();
        this.audioQueue = [];
        this.isPlayingAudio = false;
        this.updateButtonUI();
      }

      private cleanupAudio() {
        this.audioWorkletNode?.disconnect();
        this.micSourceNode?.disconnect();
        this.micStream?.getTracks().forEach((t) => t.stop());
        this.audioWorkletNode = null;
        this.micSourceNode = null;
        this.micStream = null;
      }

      private async toggleRecording() {
        const ok = await this.initializeAudioSystem();
        if (!ok) return this.updateStatus("Audio init failed", true);
        if (this.isRecording) this.stopRecording();
        else {
          this.isRecording = true;
          this.updateButtonUI();
          await this.startRecording();
        }
      }

      private async startRecording() {
        const connected = await this.connectToGeminiIfNeeded();
        if (!connected || !this.isSetupComplete) {
          this.updateStatus("Waiting for connection setup...");
          return;
        }
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
          this.micSourceNode = this.audioContext!.createMediaStreamSource(this.micStream);
          this.audioWorkletNode = new AudioWorkletNode(this.audioContext!, "audio-processor", {
            processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, bufferSize: WORKLET_BUFFER_SIZE },
          });
          this.audioWorkletNode.port.onmessage = (ev) => {
            if (ev.data.pcmData && this.session && this.isRecording) {
              const base64Audio = arrayBufferToBase64(ev.data.pcmData);
              const blob: GenAIBlob = { data: base64Audio, mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}` };
              this.session!.sendRealtimeInput({ media: blob });
            }
          };
          this.micSourceNode.connect(this.audioWorkletNode);
          this.updateStatus("Listening...");
          this.startPeriodicImageSending();
        } catch (e) {
          console.error("Mic error", e);
          this.updateStatus("Mic error", true);
          this.isRecording = false;
          this.updateButtonUI();
        }
      }

      private stopRecording() {
        this.isRecording = false;
        this.stopPeriodicImageSending();
        this.updateButtonUI();
        this.cleanupAudio();
        this.session?.close();
        this.updateStatus("Call ended.");
      }

      private updateButtonUI() {
        if (this.isRecording) {
          this.recordButton.classList.add("bg-red-500");
          this.recordText.textContent = "Stop";
          this.micIcon.classList.remove("fa-microphone");
          this.micIcon.classList.add("fa-stop");
        } else {
          this.recordButton.classList.remove("bg-red-500");
          this.recordText.textContent = "Talk";
          this.micIcon.classList.add("fa-microphone");
          this.micIcon.classList.remove("fa-stop");
        }
      }

      // --- New method: send text using existing session.sendClientContent ---
      private async handleTextSend() {
        const text = this.textInput?.value?.trim();
        if (!text) return;

        // Ensure connected before sending
        const connected = await this.connectToGeminiIfNeeded();
        if (!connected || !this.isSetupComplete) {
          this.updateStatus("Not connected yet.", true);
          return;
        }

        try {
          // send as a client content turn (text only)
          this.session?.sendClientContent({ turns: text });
          this.updateStatus("Message sent.");
          if (this.textInput) this.textInput.value = "";
        } catch (e) {
          console.error("Text send error:", e);
          this.updateStatus("Failed to send text.", true);
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
          <span id="recordingStatus" className="text-[#A8A8A8] mb-4">
            Ready
          </span>

          <button
            id="recordButton"
            className="w-24 h-24 rounded-full bg-[#82aaff] flex flex-col justify-center items-center text-white transition-colors hover:bg-[#6c8edf] relative"
          >
            <i id="micIcon" className="fas fa-microphone text-3xl mb-1" />
            <span id="recordText" className="text-sm font-medium">
              Talk
            </span>
            <svg className="record-waves absolute w-40 h-40 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none hidden">
              <circle className="wave wave1" cx="50" cy="50" r="20" />
            </svg>
          </button>

          {/* ✅ Transcription display */}
          <div id="transcription" className="mt-4 text-sm text-gray-400 max-w-xs text-center"></div>

          <div className="mt-6 flex flex-col items-center bg-[#2a2a2a] rounded-lg p-4 w-80 border border-white/10 space-y-3">
            <label
              htmlFor="imageUpload"
              className="bg-[#82aaff] hover:bg-[#6c8edf] text-white rounded px-4 py-2 flex items-center cursor-pointer space-x-2"
            >
              <i className="fas fa-image"></i>
              <span>Upload Image</span>
            </label>
            <input id="imageUpload" type="file" accept="image/png,image/jpeg,image/webp" className="hidden" />
            <div
              id="imagePreviewContainer"
              className="hidden relative border-2 border-dashed border-white/20 p-2 rounded w-full"
            >
              <img id="imagePreview" src="#" alt="Preview" className="max-h-52 mx-auto rounded object-contain" />
              <button
                id="removeImageButton"
                title="Remove"
                className="absolute -top-3 -right-3 bg-red-500 text-white w-6 h-6 rounded-full text-sm font-bold"
              >
                ×
              </button>
            </div>

            {/* --- WhatsApp-style chat input added below (text-only send) --- */}
            <div className="mt-3 w-full">
              <div className="w-full flex items-center bg-[#222222] rounded-full border border-white/8 px-3 py-2">
                <input
                  id="textInput"
                  type="text"
                  placeholder="Type a message..."
                  className="flex-1 bg-transparent text-white text-sm outline-none placeholder-gray-500"
                />
                <button
                  id="sendTextButton"
                  className="ml-2 bg-[#82aaff] hover:bg-[#6c8edf] text-white rounded-full p-2 transition-colors"
                  title="Send"
                >
                  <i className="fas fa-paper-plane"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
