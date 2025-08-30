import React from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'

// Simple error boundary so a failed GLB load doesn't crash the whole page
class ThumbErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch() { /* noop: errors already surfaced in console by R3F/three */ }
  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full grid place-items-center bg-neutral-900 text-neutral-400 text-xs">
          Preview unavailable
        </div>
      )
    }
    return this.props.children as any
  }
}

export function GLBThumb({ url, className, lazy }: { url: string; className?: string; lazy?: boolean }) {
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [inView, setInView] = React.useState(!lazy)
  // Observe visibility to lazy-mount thumbnail Canvas
  useEffect(() => {
    if (!lazy) return
    const el = containerRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true)
          } else {
            // Unmounting handled by React; we just flip state so Canvas is removed
            setInView(false)
          }
        }
      },
      { root: null, rootMargin: '200px', threshold: 0 }
    )
    obs.observe(el)
    return () => { try { obs.disconnect() } catch {} }
  }, [lazy])
  // Ensure the thumbnail WebGL context is fully released on unmount.
  useEffect(() => {
    return () => {
      const gl = glRef.current as any
      if (!gl) return
      try {
        const ctx = gl.getContext && gl.getContext()
        const ext = ctx && ctx.getExtension && ctx.getExtension('WEBGL_lose_context')
        ext && ext.loseContext && ext.loseContext()
      } catch {}
      try { gl.dispose && gl.dispose() } catch {}
      glRef.current = null
    }
  }, [])
  return (
    <div className={className} ref={containerRef}>
      <ThumbErrorBoundary>
        {inView ? (
          <Canvas
          dpr={[1, 1]}
          frameloop="demand"
          camera={{ position: [0.8, 0.9, 2.2], fov: 38 }}
          gl={{
            antialias: false,
            powerPreference: 'low-power',
            alpha: true,
            preserveDrawingBuffer: false,
            outputColorSpace: THREE.SRGBColorSpace,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.4,
          }}
          onCreated={({ gl }) => {
            glRef.current = gl as unknown as THREE.WebGLRenderer
          }}
        >
          <color attach="background" args={[0x1a1a1a]} />
          <ambientLight intensity={1.4} />
          <hemisphereLight args={[0xffffff, 0x666666, 0.9]} />
          <directionalLight position={[2, 3, 2]} intensity={1.2} />
          <directionalLight position={[-3, 2, 1]} intensity={0.7} />
          <Suspense
            fallback={<mesh><boxGeometry args={[1, 0.6, 0.05]} /><meshStandardMaterial color="#2a2a2a" /></mesh>}
          >
            <ThumbModel url={url} />
          </Suspense>
        </Canvas>
        ) : (
          <div className="w-full h-full bg-neutral-900" />
        )}
      </ThumbErrorBoundary>
    </div>
  )
}

function ThumbModel({ url }: { url: string }) {
  const { scene } = useGLTF(url, true)
  const { camera, invalidate } = useThree()
  const cloned = useMemo(() => scene.clone(true), [scene])
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(cloned)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 0) {
      const scale = 2 / maxDim
      cloned.scale.setScalar(scale)
      const sBox = new THREE.Box3().setFromObject(cloned)
      sBox.getSize(size)
      sBox.getCenter(center)
    }
    cloned.position.sub(center)

    // Normalize materials to avoid overly dark/transparent look
    cloned.traverse((obj) => {
      const m = obj as THREE.Mesh
      if ((m as any).isMesh) {
        const mat: any = (m as any).material
        if (Array.isArray(mat)) {
          mat.forEach((mm: any) => {
            mm.side = THREE.DoubleSide
            if (mm.transparent && mm.opacity < 0.2) { mm.transparent = false; mm.opacity = 1 }
            if (!mm.map && mm.color && mm.color.r < 0.02 && mm.color.g < 0.02 && mm.color.b < 0.02) {
              mm.color = new THREE.Color('#bfbfbf')
            }
          })
        } else if (mat) {
          mat.side = THREE.DoubleSide
          if (mat.transparent && mat.opacity < 0.2) { mat.transparent = false; mat.opacity = 1 }
          if (!mat.map && mat.color && mat.color.r < 0.02 && mat.color.g < 0.02 && mat.color.b < 0.02) {
            mat.color = new THREE.Color('#bfbfbf')
          }
        }
      }
    })

    const dist = Math.max(size.x, size.y, size.z) * 0.9 + 0.8
    camera.position.set(0.9, 0.9, dist)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }, [cloned, camera, invalidate])
  return <primitive object={cloned} />
}

export default GLBThumb
