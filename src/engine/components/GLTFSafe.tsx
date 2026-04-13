"use client";
import * as React from "react";
import { Box3, Group, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export function GLTFSafe({ url, onError, onLoaded }: { url: string; onError?: (e: any) => void; onLoaded?: (info: { scene: Group; bounds: { min: [number,number,number]; max: [number,number,number] } }) => void }) {
  const [scene, setScene] = React.useState<Group | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    setScene(null);
    setFailed(false);
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (!mounted) return;
        // Compute bounds
        const box = new Box3().setFromObject(gltf.scene);
        const min = new Vector3();
        const max = new Vector3();
        box.getSize(max); // We'll compute min/max directly from box
        const bmin = box.min; const bmax = box.max;
        setScene(gltf.scene);
        onLoaded?.({ scene: gltf.scene, bounds: { min: [bmin.x, bmin.y, bmin.z], max: [bmax.x, bmax.y, bmax.z] } });
      },
      undefined,
      (err) => {
        console.warn("GLTF load failed:", url, err);
        if (!mounted) return;
        setFailed(true);
        onError?.(err);
      }
    );
    return () => {
      mounted = false;
    };
  }, [url, onError]);

  if (scene) {
    return <primitive object={scene} />;
  }
  if (failed) {
    // Fallback placeholder if asset fails to load
    return (
      <mesh>
        <boxGeometry args={[1.2, 0.6, 0.6]} />
        <meshStandardMaterial color="#8b5cf6" emissive="#2e1065" emissiveIntensity={0.2} />
      </mesh>
    );
  }
  // Loading ghost
  return (
    <mesh>
      <boxGeometry args={[1, 0.05, 1]} />
      <meshBasicMaterial color="#00ffaa" transparent opacity={0.4} />
    </mesh>
  );
}
