// components/gemini/AvatarDisplay.tsx
"use client";
import React, { useEffect, useRef, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, Environment, useGLTF, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { useGemini } from "./GeminiContext";

type AvatarProps = {
  glbPath?: string;
};

const visemeNames = ["mouthOpen", "mouthSmile", "eyesClosed", "eyesLookUp", "eyesLookDown"];

function AvatarModel({ glbPath }: { glbPath: string }) {
  const { scene } = useGLTF(glbPath) as any;
  const meshesRef = useRef<THREE.Mesh[]>([]);
  const morphInfluences = useRef<Record<string, number>>({});
  const headRef = useRef<THREE.Object3D | null>(null);
  const leftEyeRef = useRef<THREE.Mesh | null>(null);
  const rightEyeRef = useRef<THREE.Mesh | null>(null);
  const avgAmp = useRef(0);

  useEffect(() => {
    visemeNames.forEach((n) => (morphInfluences.current[n] = 0));
  }, []);

  useEffect(() => {
    const found: THREE.Mesh[] = [];
    scene.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).morphTargetDictionary) {
        found.push(child as THREE.Mesh);
      }
      const name = child.name?.toLowerCase?.() || "";
      if (name.includes("lefteye")) leftEyeRef.current = child as THREE.Mesh;
      if (name.includes("righteye")) rightEyeRef.current = child as THREE.Mesh;
    });
    meshesRef.current = found;
    headRef.current = scene.getObjectByName("Head") || scene;
  }, [scene]);

  useFrame((state) => {
    const elapsed = state.clock.getElapsedTime();
    const mouthVal = morphInfluences.current["mouthOpen"] ?? 0;
    if (headRef.current) {
      headRef.current.rotation.x = Math.sin(elapsed * 2) * 0.03 * mouthVal;
      headRef.current.rotation.y = Math.sin(elapsed * 0.8) * 0.02;
    }

    const slowPulse = 0.05 * Math.sin(elapsed * 0.8) + 0.05 * Math.sin(elapsed * 0.3);
    const dilation = THREE.MathUtils.clamp(1 + slowPulse + avgAmp.current * 0.2, 0.85, 1.15);
    if (leftEyeRef.current) leftEyeRef.current.scale.setScalar(dilation);
    if (rightEyeRef.current) rightEyeRef.current.scale.setScalar(dilation);

    meshesRef.current.forEach((mesh) => {
      const inf = mesh.morphTargetInfluences!;
      const dict = mesh.morphTargetDictionary!;
      for (const [name, value] of Object.entries(morphInfluences.current)) {
        if (dict[name] !== undefined) inf[dict[name]] = value;
      }
    });
  });

  (window as any).__fluentpath_morphInfluences = morphInfluences;
  (window as any).__fluentpath_avgAmp = avgAmp;

  return <primitive object={scene} />;
}

export default function AvatarDisplay({ glbPath = "/avatar.glb" }: { glbPath?: string }) {
  const { registerAudioHandler, setAvatarLoaded } = useGemini();
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const analyserRef = useRef<AnalyserNode | null>(null);

  useEffect(() => {
    const handleAudio = (ab: ArrayBuffer) => {
      playQueueRef.current.push(ab);
      if (!isPlayingRef.current) playNext();
    };
    const unregister = registerAudioHandler(handleAudio);

    async function ensureAudio() {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        analyserRef.current = audioCtxRef.current.createAnalyser();
        analyserRef.current.fftSize = 512;
      }
    }
    ensureAudio();
    setAvatarLoaded(true);

    return () => {
      unregister();
      setAvatarLoaded(false);
      try {
        analyserRef.current?.disconnect();
        audioCtxRef.current?.close();
      } catch (e) {}
    };
  }, []);

  async function playNext() {
    if (playQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    const buf = playQueueRef.current.shift()!;
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = audioCtxRef.current;

    const int16 = new Int16Array(buf);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;

    const audioBuffer = ctx.createBuffer(1, f32.length, 24000);
    audioBuffer.copyToChannel(f32, 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;

    if (!analyserRef.current) {
      analyserRef.current = ctx.createAnalyser();
      analyserRef.current.fftSize = 512;
    }
    src.connect(analyserRef.current!);
    analyserRef.current!.connect(ctx.destination);

    const morphRef = (window as any).__fluentpath_morphInfluences as React.MutableRefObject<Record<string, number>> | undefined;
    const avgAmpRef = (window as any).__fluentpath_avgAmp as React.MutableRefObject<number> | undefined;

    const updateVisemeInterval = setInterval(() => {
      if (!analyserRef.current) return;
      const data = new Uint8Array(analyserRef.current.fftSize);
      analyserRef.current.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
      const amp = sum / data.length / 64;
      if (avgAmpRef) avgAmpRef.current = THREE.MathUtils.lerp(avgAmpRef.current || 0, amp, 0.2);
      const amplified = Math.pow(amp, 1.1);
      const openVal = THREE.MathUtils.clamp(amplified * 6.75, 0, 1);
      if (morphRef?.current) {
        morphRef.current["mouthOpen"] = THREE.MathUtils.lerp(morphRef.current["mouthOpen"] || 0, openVal, 0.35);
        morphRef.current["mouthSmile"] = THREE.MathUtils.lerp(morphRef.current["mouthSmile"] || 0, 0.15, 0.02);
      }
    }, 50);

    src.start();
    src.onended = () => {
      clearInterval(updateVisemeInterval);
      try { analyserRef.current?.disconnect(); } catch (e) {}
      playNext();
    };
  }

  return (
    <div className="w-full max-w-3xl aspect-[4/3] sm:aspect-[16/9] bg-[#0b0f14] rounded-2xl overflow-hidden flex items-center justify-center">
      <Canvas camera={{ position: [0, 1.5, 1.2], fov: 28 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[1, 2, 1]} intensity={1.2} />
        <spotLight position={[0, 3, 2]} intensity={0.5} penumbra={0.8} />

        <Suspense fallback={<Html center><div className="text-white">Loading avatar...</div></Html>}>
          <Environment files="/environment.exr" background />
          <AvatarModel glbPath={glbPath} />
        </Suspense>

        <OrbitControls
          enableZoom={false}
          enablePan={false}
          maxPolarAngle={Math.PI / 2.1}
          minPolarAngle={Math.PI / 2.5}
          target={[0, 1.5, 0]}
        />
      </Canvas>
    </div>
  );
}
