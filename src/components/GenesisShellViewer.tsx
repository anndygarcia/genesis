// Inline modal that loads the photoreal shell GLB produced by the
// Blender stage and renders it with @react-three/drei's useGLTF. Kept
// separate from CreateStudio's primary scene so the two views can
// evolve independently (and so the Three.js bundle isn't re-imported
// at the top level).

import { Suspense, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment, OrbitControls, useGLTF } from '@react-three/drei'
import { Download, X } from 'lucide-react'
import { resolveArtifactUrl } from '../lib/genesis-api'

function ShellModel({ url }: { url: string }) {
  const gltf = useGLTF(url)
  // Center / fit a sensible default by computing bounds once.
  const scene = useMemo(() => gltf.scene, [gltf.scene])
  return <primitive object={scene} />
}

interface Props {
  glbUrl: string
  onClose: () => void
}

export default function GenesisShellViewer({ glbUrl, onClose }: Props) {
  const fullUrl = resolveArtifactUrl(glbUrl)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-[min(96vw,1100px)] h-[min(86vh,720px)] rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
          <div className="flex items-center gap-2 text-sm text-neutral-200">
            <span className="font-semibold">Photoreal Shell</span>
            <span className="text-[11px] text-neutral-500 font-mono truncate">{fullUrl}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <a
              href={fullUrl}
              download
              className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-neutral-200 hover:bg-white/10 inline-flex items-center gap-1.5"
              title="Download GLB"
            >
              <Download className="size-3.5" /> GLB
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/10 p-1.5 text-neutral-300 hover:bg-white/10"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 bg-neutral-900">
          <Canvas
            shadows
            dpr={[1, 2]}
            camera={{ position: [12, 9, 14], fov: 45, near: 0.1, far: 200 }}
          >
            <ambientLight intensity={0.35} />
            <directionalLight
              castShadow
              position={[10, 18, 8]}
              intensity={1.4}
              shadow-mapSize-width={1024}
              shadow-mapSize-height={1024}
            />
            <Suspense fallback={null}>
              <ShellModel url={fullUrl} />
              <Environment preset="city" />
            </Suspense>
            <OrbitControls makeDefault enableDamping dampingFactor={0.08} target={[0, 1.5, 0]} />
            <gridHelper args={[40, 40, '#444', '#222']} position={[0, -0.05, 0]} />
          </Canvas>
        </div>
      </div>
    </div>
  )
}
