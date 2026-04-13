import React from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Suspense, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'

function decodeRepeated(value: string, maxPasses = 2) {
  let out = value
  for (let i = 0; i < maxPasses; i += 1) {
    try {
      const next = decodeURIComponent(out)
      if (next === out) break
      out = next
    } catch {
      break
    }
  }
  return out
}

function sanitizeGlbUrl(raw: string) {
  const input = String(raw || '').trim()
  if (!input) return ''
  const decoded = decodeRepeated(input, 2)
  try {
    const parsed = new URL(decoded)
    const fixedPath = parsed.pathname
      .split('/')
      .map((seg, i) => (i === 0 ? seg : encodeURIComponent(decodeRepeated(seg, 2))))
      .join('/')
    parsed.pathname = fixedPath
    return parsed.toString()
  } catch {
    try { return encodeURI(decoded) } catch { return decoded }
  }
}

function isCanvasMostlyFlat(canvas: HTMLCanvasElement) {
  try {
    const probe = document.createElement('canvas')
    probe.width = 24
    probe.height = 24
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height)
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data
    let min = 255
    let max = 0
    for (let i = 0; i < data.length; i += 4) {
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3
      if (lum < min) min = lum
      if (lum > max) max = lum
    }
    return (max - min) < 10
  } catch {
    return false
  }
}

const MAX_ACTIVE_THUMB_CANVASES = 6
let activeThumbCanvases = 0
const thumbImageCache = new Map<string, string>()

// Simple error boundary so a failed GLB load doesn't crash the whole page
class ThumbErrorBoundary extends React.Component<{ children: React.ReactNode; onError?: () => void }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode; onError?: () => void }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch() {
    this.props.onError?.()
  }
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
  const claimedCanvasRef = useRef(false)
  const contextLostRef = useRef(false)
  const captureScheduledRef = useRef(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const safeUrl = useMemo(() => sanitizeGlbUrl(url), [url])
  const [inView, setInView] = React.useState(!lazy)
  const [renderEnabled, setRenderEnabled] = React.useState(false)
  const [renderRetryTick, setRenderRetryTick] = React.useState(0)
  const [snapshotSrc, setSnapshotSrc] = React.useState('')

  useEffect(() => {
    const cached = thumbImageCache.get(safeUrl)
    setSnapshotSrc(cached || '')
    captureScheduledRef.current = false
  }, [safeUrl])
  // Observe visibility to lazy-mount thumbnail Canvas
  useEffect(() => {
    if (!lazy) return
    const el = containerRef.current
    if (!el) return
    const root = (el.closest('[data-homes-scroll-root]') as Element | null) ?? null
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
      { root, rootMargin: '40px 0px', threshold: 0.1 }
    )
    obs.observe(el)
    return () => { try { obs.disconnect() } catch {} }
  }, [lazy])
  // Ensure the thumbnail WebGL context is fully released on unmount.
  useEffect(() => {
    return () => {
      if (claimedCanvasRef.current) {
        claimedCanvasRef.current = false
        activeThumbCanvases = Math.max(0, activeThumbCanvases - 1)
      }
      const gl = glRef.current as any
      if (!gl) return
      if (!contextLostRef.current) {
        try {
          gl.forceContextLoss && gl.forceContextLoss()
          contextLostRef.current = true
        } catch {}
      }
      try { gl.dispose && gl.dispose() } catch {}
      glRef.current = null
    }
  }, [])
  useEffect(() => {
    const wantsRender = inView && !!safeUrl && !snapshotSrc
    if (!wantsRender) {
      if (claimedCanvasRef.current) {
        claimedCanvasRef.current = false
        activeThumbCanvases = Math.max(0, activeThumbCanvases - 1)
      }
      if (renderEnabled) setRenderEnabled(false)
      return
    }

    if (claimedCanvasRef.current) {
      if (!renderEnabled) setRenderEnabled(true)
      return
    }

    if (activeThumbCanvases < MAX_ACTIVE_THUMB_CANVASES && !contextLostRef.current) {
      activeThumbCanvases += 1
      claimedCanvasRef.current = true
      setRenderEnabled(true)
      return
    }

    const timer = window.setTimeout(() => setRenderRetryTick((v) => v + 1), 120)
    return () => window.clearTimeout(timer)
  }, [inView, safeUrl, snapshotSrc, renderEnabled, renderRetryTick])

  const releaseCanvasSlot = React.useCallback(() => {
    if (claimedCanvasRef.current) {
      claimedCanvasRef.current = false
      activeThumbCanvases = Math.max(0, activeThumbCanvases - 1)
    }
    setRenderEnabled(false)
  }, [])

  const captureSnapshot = React.useCallback(() => {
    if (!safeUrl || snapshotSrc || captureScheduledRef.current) return
    captureScheduledRef.current = true
    const runCapture = () => {
      try {
        const gl = glRef.current as any
        const canvas = gl?.domElement as HTMLCanvasElement | undefined
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
          captureScheduledRef.current = false
          return
        }
        if (isCanvasMostlyFlat(canvas)) {
          captureScheduledRef.current = false
          return
        }
        const data = canvas.toDataURL('image/webp', 0.82)
        if (data && data.startsWith('data:image')) {
          thumbImageCache.set(safeUrl, data)
          setSnapshotSrc(data)
          releaseCanvasSlot()
          return
        }
      } catch {}
      captureScheduledRef.current = false
    }
    requestAnimationFrame(() => requestAnimationFrame(runCapture))
  }, [safeUrl, snapshotSrc, releaseCanvasSlot])

  const handleThumbError = React.useCallback(() => {
    captureScheduledRef.current = false
    releaseCanvasSlot()
    window.setTimeout(() => setRenderRetryTick((v) => v + 1), 220)
  }, [releaseCanvasSlot])

  return (
    <div className={className} ref={containerRef}>
      <ThumbErrorBoundary onError={handleThumbError}>
        {snapshotSrc ? (
          <img
            src={snapshotSrc}
            alt=""
            className="w-full h-full object-contain"
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : inView && !!safeUrl && renderEnabled ? (
          <ShadowHost>
            <Dummy2DCanvas />
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
                contextLostRef.current = false
                const canvas = (gl as any).domElement as HTMLCanvasElement | undefined
                if (canvas) {
                  canvas.addEventListener('webglcontextlost', (e) => {
                    e.preventDefault()
                    contextLostRef.current = true
                    if (claimedCanvasRef.current) {
                      claimedCanvasRef.current = false
                      activeThumbCanvases = Math.max(0, activeThumbCanvases - 1)
                    }
                    setRenderEnabled(false)
                    captureScheduledRef.current = false
                    window.setTimeout(() => {
                      contextLostRef.current = false
                      setRenderRetryTick((v) => v + 1)
                    }, 250)
                  }, { once: true })
                }
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
                <ThumbModel url={safeUrl} onReady={captureSnapshot} />
              </Suspense>
            </Canvas>
          </ShadowHost>
        ) : (
          <div className="w-full h-full bg-neutral-900" />
        )}
      </ThumbErrorBoundary>
    </div>
  )
}

function ThumbModel({ url, onReady }: { url: string; onReady?: () => void }) {
  const { scene } = useGLTF(url, true)
  const { camera, invalidate } = useThree()
  const cloned = useMemo(() => scene.clone(true), [scene])
  useFrame(() => {
    onReady?.()
  })
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
      if (!obj) return
      const m = obj as THREE.Mesh
      if ((m as any)?.isMesh) {
        const mat: any = (m as any).material
        if (Array.isArray(mat)) {
          mat.forEach((mm: any) => {
            if (!mm) return
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
        } else {
          // Assign a neutral material if missing
          m.material = new THREE.MeshStandardMaterial({ color: '#bfbfbf' })
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

// Shadow DOM host to isolate Canvas from page-level scripts/styles
function ShadowHost({ children }: { children: React.ReactNode }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const shadowRef = React.useRef<ShadowRoot | null>(null)
  const [mountEl, setMountEl] = React.useState<Element | null>(null)
  React.useEffect(() => {
    if (hostRef.current && !shadowRef.current) {
      shadowRef.current = hostRef.current.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = `:host, :host * { box-sizing: border-box; } html, body { margin: 0; padding: 0; }`
      shadowRef.current.appendChild(style)
      const mount = document.createElement('div')
      mount.setAttribute('id', 'shadow-mount-thumb')
      Object.assign(mount.style, { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', width: '100%', height: '100%' })
      shadowRef.current.appendChild(mount)
      setMountEl(mount)
    }
  }, [])
  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {mountEl ? createPortal(children, mountEl) : null}
    </div>
  )
}

function Dummy2DCanvas() {
  const ref = React.useRef<HTMLCanvasElement | null>(null)
  React.useEffect(() => {
    if (!ref.current) return
    try {
      const ctx = ref.current.getContext('2d')
      if (ctx) {
        ctx.fillStyle = 'rgba(0,0,0,0)'
        ctx.fillRect(0, 0, 1, 1)
      }
    } catch {}
  }, [])
  return (
    <canvas
      ref={ref}
      width={1}
      height={1}
      aria-hidden
      style={{ position: 'absolute', width: 1, height: 1, left: -9999, top: -9999, opacity: 0 }}
    />
  )
}
