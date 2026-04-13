import { Suspense, useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, PointerLockControls, Environment, useGLTF, Html } from '@react-three/drei'
import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import LogoSpinner from '../components/LogoSpinner'
import { GLBThumb as SharedGLBThumb } from '../components/GLBThumb'

// three-mesh-bvh: attach helpers to prototypes once
// @ts-ignore
;(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree
// @ts-ignore
;(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree
// @ts-ignore
;(THREE.Mesh.prototype as any).raycast = acceleratedRaycast

// Minimal GLB loader + auto-frame (duplicated here so we don't depend on Viewer.tsx internals)
type GLBHandle = { frame: () => void }
type BoundsInfo = { size: THREE.Vector3; center: THREE.Vector3; floorY: number }
type Home = { id: string; name: string; public_url: string; size?: number; created_at?: string; path?: string }
const PLAYER_HEIGHT_M = 1.0
const EYE_HEIGHT_M = 1.0

function isGlassLikeMaterial(mat: any) {
  if (!mat) return false
  const matName = String(mat.name || '').toLowerCase()
  const transparent = !!mat.transparent || (typeof mat.opacity === 'number' && mat.opacity < 0.98)
  const transmissive = typeof mat.transmission === 'number' && mat.transmission > 0.04
  return transparent || transmissive || matName.includes('glass') || matName.includes('window')
}

function isPassThroughMesh(mesh: THREE.Mesh) {
  const meshName = String(mesh.name || '').toLowerCase()
  if (meshName.includes('glass') || meshName.includes('window') || meshName.includes('pane')) return true
  const mats = Array.isArray((mesh as any).material) ? (mesh as any).material : [(mesh as any).material]
  return mats.some((m: any) => isGlassLikeMaterial(m))
}

function CenteredCanvasSpinner() {
  return (
    <Html center>
      <div className="pointer-events-none bg-black/10 rounded-lg p-1 border border-white/5 shadow-[0_0_12px_rgba(165,136,239,0.2)]">
        <LogoSpinner size={24} className="animate-spin-slow" />
      </div>
    </Html>
  )
}

// Note: we now reuse the shared GLBThumb which already has an ErrorBoundary

const GLBModel = forwardRef<GLBHandle, { url: string; onBounds?: (info: BoundsInfo) => void; onColliders?: (meshes: THREE.Mesh[]) => void }>(function GLBModel({ url, onBounds, onColliders }, ref) {
  const { scene } = useGLTF(url, true)
  const { camera } = useThree()
  const cloned = useMemo(() => scene.clone(true), [scene])

  const doFrame = useCallback(() => {
    console.info('[GLBModel] framing model')
    // Ensure visibility
    cloned.traverse((obj) => {
      const m = obj as THREE.Mesh
      if ((m as any).isMesh) {
        m.castShadow = true
        m.receiveShadow = true
        const mat: any = m.material
        if (Array.isArray(mat)) {
          mat.forEach((mm: any) => {
            mm.side = THREE.DoubleSide
            if (mm.transparent && mm.opacity < 0.1) { mm.transparent = false; mm.opacity = 1 }
            if (!mm.map && mm.color && mm.color.r === 0 && mm.color.g === 0 && mm.color.b === 0) {
              mm.color = new THREE.Color('#bfbfbf')
            }
          })
        } else if (mat) {
          mat.side = THREE.DoubleSide
          if (mat.transparent && mat.opacity < 0.1) { mat.transparent = false; mat.opacity = 1 }
          if (!mat.map && mat.color && mat.color.r === 0 && mat.color.g === 0 && mat.color.b === 0) {
            mat.color = new THREE.Color('#bfbfbf')
          }
        } else {
          m.material = new THREE.MeshStandardMaterial({ color: '#c8c8c8' })
        }
      }
    })

    const box = new THREE.Box3().setFromObject(cloned)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)

    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 50) {
      const scale = 50 / maxDim
      cloned.scale.setScalar(scale)
      const sBox = new THREE.Box3().setFromObject(cloned)
      sBox.getSize(size)
      sBox.getCenter(center)
    }

    cloned.position.sub(center)

    // Compute a robust floorY using weighted mesh bounding boxes (use top surface: max.y)
    const estimateFloorY = (root: THREE.Object3D) => {
      const entries: { y: number; area: number }[] = []
      root.updateWorldMatrix(true, true)
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (!(m as any).isMesh || !m.geometry) return
        const geom = m.geometry as THREE.BufferGeometry
        if (!geom.boundingBox) geom.computeBoundingBox()
        const bb = geom.boundingBox?.clone()
        if (!bb) return
        bb.applyMatrix4(m.matrixWorld)
        const area = Math.max(0, (bb.max.x - bb.min.x)) * Math.max(0, (bb.max.z - bb.min.z))
        if (!isFinite(area) || area < 0.05) return // ignore tiny parts
        entries.push({ y: bb.max.y, area })
      })
      if (entries.length === 0) return 0
      entries.sort((a, b) => a.y - b.y)
      const total = entries.reduce((s, e) => s + e.area, 0)
      const target = total * 0.2 // 20th percentile by footprint area
      let acc = 0
      for (const e of entries) {
        acc += e.area
        if (acc >= target) return e.y
      }
      return entries[0]!.y
    }

    const centeredBox = new THREE.Box3().setFromObject(cloned)
    const fallbackFloor = centeredBox.min.y
    const robustFloor = estimateFloorY(cloned)
    // Round to millimeter to prevent flicker on minor recomputations
    const floorY = Number.isFinite(robustFloor) ? Math.round(robustFloor * 1000) / 1000 : fallbackFloor
    onBounds?.({ size, center, floorY })

    const dist = Math.max(size.x, size.z) * 1.6 + 2
    camera.position.set(0, Math.max(floorY + EYE_HEIGHT_M, size.y * 0.3), dist)
    camera.lookAt(0, floorY + 1.2, 0)
    camera.updateProjectionMatrix()
  }, [cloned, camera])

  // Build BVH on geometries and expose colliders up
  useEffect(() => {
    const list: THREE.Mesh[] = []
    cloned.traverse((obj) => {
      const m = obj as THREE.Mesh
      if ((m as any).isMesh && m.geometry) {
        const geom = m.geometry as THREE.BufferGeometry & { boundsTree?: any }
        // Attach accelerated raycast
        ;(m as any).raycast = acceleratedRaycast
        // Compute bounds tree if not present
        try {
          // @ts-ignore - methods injected by three-mesh-bvh
          if (!geom.boundsTree) computeBoundsTree.call(geom)
        } catch (e) {
          // Ignore compute errors for non-indexed/degenerate geometries
        }
        if (!isPassThroughMesh(m)) {
          list.push(m)
        }
      }
    })
    onColliders?.(list)
    return () => {
      // Dispose bounds trees to free memory
      cloned.traverse((obj) => {
        const m = obj as THREE.Mesh
        if ((m as any).isMesh && m.geometry) {
          const geom = m.geometry as any
          try {
            if (geom.boundsTree) disposeBoundsTree.call(geom)
          } catch { /* noop */ }
        }
      })
    }
  }, [cloned, onColliders])

  useEffect(() => {
    console.info('[GLBModel] mounted with url', url)
    doFrame()
    return () => {
      console.info('[GLBModel] unmounted for url', url)
    }
  }, [doFrame, url])
  useImperativeHandle(ref, () => ({ frame: doFrame }), [doFrame])

  return <primitive object={cloned} />
})



export default function ViewerUpload() {
  const [localUrl, setLocalUrl] = useState<string>('')
  const [orbit, setOrbit] = useState<boolean>(true)
  const [ghost, setGhost] = useState<boolean>(false)
  const [speed, setSpeed] = useState<number>(3)
  const [floorY, setFloorY] = useState<number>(0)
  const [bounds, setBounds] = useState<BoundsInfo | null>(null)
  const [colliders, setColliders] = useState<THREE.Mesh[]>([])
  const glbRef = useRef<GLBHandle>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [searchParams] = useSearchParams()
  const [showLibrary, setShowLibrary] = useState(false)
  const [homes, setHomes] = useState<Home[]>([])
  const [showHomesGlow, setShowHomesGlow] = useState<boolean>(false)
  const [canvasKey, setCanvasKey] = useState(0)
  const [viewerCanvasWarning, setViewerCanvasWarning] = useState<string | null>(null)
  const supportsPointerLock = useMemo(() => {
    if (typeof document === 'undefined') return false
    const canvas = document.createElement('canvas')
    return typeof canvas.requestPointerLock === 'function'
  }, [])

  // Turn on a rotating glow for the Homes button on first visit only
  useEffect(() => {
    try {
      const seen = localStorage.getItem('ui_homes_glow_seen')
      if (!seen) setShowHomesGlow(true)
    } catch {}
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'KeyG') return
      if (orbit) return
      e.preventDefault()
      setGhost((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [orbit])
  const [loadingHomes, setLoadingHomes] = useState(false)
  // Note: useProgress works best within Canvas subtree; we'll use it in a Suspense fallback below

  // Fetch global homes for the library panel (public feed)
  const loadHomes = useCallback(async () => {
    setLoadingHomes(true)
    try {
      const { data, error } = await supabase
        .from('homes')
        .select('id,name,public_url,size,created_at,path')
        .order('created_at', { ascending: false })
        .limit(200)
      if (!error) {
        const rows = (data as Home[]) || []
        // Deduplicate by public_url (fallback to path), keep the latest by created_at (already sorted desc)
        const seen = new Map<string, Home>()
        for (const r of rows) {
          const key = r.public_url || r.path || `${r.name}:${r.size}`
          if (!seen.has(key)) seen.set(key, r)
        }
        setHomes(Array.from(seen.values()))
      } else {
        setHomes([])
      }
    } finally {
      setLoadingHomes(false)
    }
  }, [])

  // Cleanup object URLs
  useEffect(() => {
    return () => {
      if (localUrl && localUrl.startsWith('blob:')) URL.revokeObjectURL(localUrl)
    }
  }, [localUrl])

  // Load GLB from query param and respond to changes when navigating from Feed
  useEffect(() => {
    const raw = searchParams.get('glb')
    const url = raw ? decodeURIComponent(raw) : ''
    if (url && url !== localUrl) {
      setLocalUrl(url)
      // After setting, give the model a moment to mount then frame it
      setTimeout(() => glbRef.current?.frame(), 300)
    }
    // If query removed, don't forcibly clear localUrl to avoid blanking the viewer mid-session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Extra safety: on first mount, also read from window.location if needed
  useEffect(() => {
    if (localUrl) return
    try {
      const params = new URLSearchParams(window.location.search)
      const raw = params.get('glb')
      const url = raw ? decodeURIComponent(raw) : ''
      if (url) {
        console.info('[ViewerUpload] Loaded glb from window.location', url)
        setLocalUrl(url)
        setTimeout(() => glbRef.current?.frame(), 300)
      }
    } catch {}
    // only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-open Homes library when navigated with ?open=homes
  useEffect(() => {
    const open = (searchParams.get('open') || '').toLowerCase()
    if (open === 'homes') {
      setShowLibrary(true)
      loadHomes()
      if (showHomesGlow) {
        setShowHomesGlow(false)
        try { localStorage.setItem('ui_homes_glow_seen', '1') } catch {}
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Allow the host viewer to forward a selected Home into this iframe/viewer.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      try {
        const data = event.data
        if (!data || typeof data !== 'object') return
        if ((data as any).type !== 'GENESIS_LOAD_GLB') return

        const url = String((data as any).url || '').trim()
        if (!url) return

        setLocalUrl(url)
        setShowLibrary(false)
        if (showHomesGlow) {
          setShowHomesGlow(false)
          try { localStorage.setItem('ui_homes_glow_seen', '1') } catch {}
        }

        setTimeout(() => glbRef.current?.frame(), 300)
      } catch {}
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [showHomesGlow])

  const onFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return
    const f = files[0]!
    if (!/\.(glb|gltf)$/i.test(f.name)) {
      alert('Please select a .glb or .gltf file')
      return
    }
    const url = URL.createObjectURL(f)
    setLocalUrl(url)
    // small delay then frame after load
    setTimeout(() => glbRef.current?.frame(), 300)

    // Also upload to Supabase Storage and save metadata to 'homes' table
    ;(async () => {
      try {
        const { data: userData, error: userErr } = await supabase.auth.getUser()
        if (userErr) throw userErr
        const userId = userData.user?.id
        if (!userId) return

        const path = `${userId}/${Date.now()}_${f.name}`
        const bucket = supabase.storage.from('glbs')
        const { error: upErr } = await bucket.upload(path, f, { upsert: false })
        if (upErr && upErr.message && !upErr.message.includes('The resource already exists')) throw upErr

        const { data: pub } = bucket.getPublicUrl(path)
        const publicUrl = pub.publicUrl

        const { error: insErr } = await supabase
          .from('homes')
          .insert({ user_id: userId, name: f.name, path, public_url: publicUrl, size: f.size })
        if (insErr) throw insErr

        // Optional: notify in console; UI toast can be added later
        console.info('Uploaded GLB and saved to homes:', { name: f.name, path })

        // Refresh library if visible
        if (showLibrary) {
          await loadHomes()
        }
      } catch (err) {
        console.error('Failed to save GLB to Homes:', err)
      }
    })()
  }, [showLibrary])

  useEffect(() => { if (showLibrary) loadHomes() }, [showLibrary, loadHomes])

  const onInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => onFiles(e.target.files), [onFiles])

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    onFiles(e.dataTransfer.files)
  }, [onFiles])

  const requestFpsCapture = useCallback(() => {
    try {
      if (!supportsPointerLock) {
        setViewerCanvasWarning('Pointer lock is unavailable here. Using orbit fallback.')
        return
      }
      const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
      if (!canvas) return
      if (document.pointerLockElement === canvas) return
      canvas.requestPointerLock()
    } catch {}
  }, [supportsPointerLock])

  

  return (
    <div
      className="fixed inset-x-0 top-16 bottom-0 z-10"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => e.preventDefault()}
    >
      {/* Controls */}
      <div className="absolute left-1/2 -translate-x-1/2 top-2 z-20 flex items-center gap-2">
        <button
          className={`pointer-events-auto rounded-lg border border-[#a588ef]/60 bg-[#7f63d6]/65 px-4 py-2 text-base font-semibold text-white hover:bg-[#7f63d6]/75 ring-1 ring-[#a588ef]/20 shadow-[0_0_10px_rgba(165,136,239,0.30)] whitespace-nowrap ${showHomesGlow ? 'btn-pulse' : ''}`}
          onClick={() => {
            const next = !showLibrary
            setShowLibrary(next)
            if (next) loadHomes()
            if (showHomesGlow) {
              setShowHomesGlow(false)
              try { localStorage.setItem('ui_homes_glow_seen', '1') } catch {}
            }
          }}
        >
          Homes
        </button>
        <button
          className="pointer-events-auto rounded-md border border-white/10 bg-neutral-900/70 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
          onClick={() => inputRef.current?.click()}
        >
          Upload
        </button>
        <div className="flex flex-col items-center">
          <div className="flex items-center text-xs text-neutral-300 bg-neutral-900/70 border border-white/10 rounded-md">
            <button
              className={`px-3 py-1 rounded-l-md transition shadow ${
                orbit
                  ? 'bg-neutral-800 text-white ring-1 ring-[#a588ef]/25 shadow-[0_0_12px_rgba(165,136,239,0.35)]'
                  : 'bg-transparent text-neutral-300 shadow-[inset_0_0_6px_rgba(0,0,0,0.5)]'
              }`}
              onMouseDown={(e) => { e.stopPropagation() }}
              onClick={(e) => { e.stopPropagation(); setOrbit(true) }}
            >
              3D
            </button>
            <div className="h-5 w-px bg-white/10 self-stretch" />
            <button
              className={`px-3 py-1 rounded-r-md transition shadow ${
                !orbit
                  ? 'bg-neutral-800 text-white ring-1 ring-[#a588ef]/25 shadow-[0_0_12px_rgba(165,136,239,0.35)]'
                  : 'bg-transparent text-neutral-300 shadow-[inset_0_0_6px_rgba(0,0,0,0.5)]'
              }`}
              onMouseDown={(e) => { e.stopPropagation() }}
              onClick={(e) => {
                e.stopPropagation()
                setOrbit(false)
                requestFpsCapture()
              }}
            >
              POV
            </button>
          </div>
        </div>
        {!orbit && (
          <button
            className={`pointer-events-auto rounded-md border px-3 py-1.5 text-sm transition ${
              ghost
                ? 'border-emerald-300/40 bg-emerald-900/50 text-emerald-100'
                : 'border-white/10 bg-neutral-900/70 text-neutral-200 hover:bg-neutral-800'
            }`}
            onClick={() => setGhost((v) => !v)}
            title="Toggle ghost mode (G)"
          >
            {ghost ? 'Ghost: On' : 'Ghost: Off'}
          </button>
        )}
        {localUrl && (
          <>
            <label className="flex items-center gap-2 text-xs text-neutral-300 bg-neutral-900/70 border border-white/10 rounded-md px-2 py-1">
              <span>Speed</span>
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
              />
              <span className="w-8 text-right tabular-nums">{speed.toFixed(1)}</span>
            </label>
            <button
              className="pointer-events-auto rounded-md border border-white/10 bg-neutral-900/70 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
              onClick={() => glbRef.current?.frame()}
            >
              Reset
            </button>
          </>
        )}
        {/* Filename hidden to keep controls clean and centered */}
      </div>

      {/* Hidden file input */}
      <input ref={inputRef} type="file" accept=".glb,.gltf" className="hidden" onChange={onInput} />

      {viewerCanvasWarning && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-40 rounded-md border border-amber-400/40 bg-amber-900/80 px-3 py-2 text-xs text-amber-100">
          {viewerCanvasWarning}
        </div>
      )}

      {/* Drop zone overlay when no model loaded */}
      {!localUrl && (
        <div
          className="absolute inset-0 grid place-items-center text-center text-neutral-200"
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={(e) => e.preventDefault()}
        >
          <div className="pointer-events-none select-none">
            <p className="text-lg opacity-90">Drop a .glb/.gltf here or click "Upload"</p>
            <p className="text-xs text-neutral-400 mt-1">Then explore in first person</p>
          </div>
        </div>
      )}

      {/* Viewer Canvas */}
      <Canvas
        key={canvasKey}
        shadows
        dpr={[1, 2]}
        style={{ width: '100%', height: '100%', display: 'block' }}
        gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }}
        camera={{ position: [0, EYE_HEIGHT_M, 4], fov: 65, near: 0.01, far: 5000 }}
        onCreated={({ gl }) => {
          const version = (gl as any).getParameter?.((gl as any).VERSION)
          console.info('[ViewerUpload] Main Canvas created. WebGL version:', version)
          setViewerCanvasWarning(null)
          const canvas = (gl as any).domElement as HTMLCanvasElement | undefined
          if (canvas) {
            const onLost = (e: Event) => {
              e.preventDefault()
              setViewerCanvasWarning('Viewer graphics context was reset. Recovering...')
              window.setTimeout(() => setCanvasKey((k) => k + 1), 120)
            }
            canvas.addEventListener('webglcontextlost', onLost as EventListener, { once: true })
          }
        }}
      >
        <color attach="background" args={[0x333333]} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[6, 10, 6]} intensity={1.2} castShadow />
        {localUrl && (
          <>
            <Suspense fallback={<CenteredCanvasSpinner />}>
              <GLBModel
                ref={glbRef}
                url={localUrl}
                onBounds={(info) => { setFloorY(info.floorY); setBounds(info) }}
                onColliders={(meshes) => setColliders(meshes)}
              />
              <Environment preset="city" />
            </Suspense>
          </>
        )}
        {/* Ensure correct eye height and center when entering POV */}
        <POVEnterAdjuster orbit={orbit} eyeY={floorY + EYE_HEIGHT_M} bounds={bounds} colliders={colliders} />
        {orbit || !supportsPointerLock ? (
          <OrbitControls enableDamping dampingFactor={0.08} />
        ) : (
          <>
            <PointerLockControls selector="canvas, #enter-fps-upload" />
            <CapsuleFPSController speed={speed} sprint={Math.max(6, speed * 2)} colliders={colliders} ghost={ghost} />
          </>
        )}
      </Canvas>

      {/* FPS capture button + crosshair overlay (must stay outside Canvas) */}
      {!orbit && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center z-20">
            <button
              id="enter-fps-upload"
              className="pointer-events-auto rounded-md border border-white/10 bg-neutral-900/80 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-800"
              onClick={requestFpsCapture}
            >
              Click the canvas to capture mouse (FPS) — W/A/S/D move, Shift sprint, Space jump, G ghost mode (Space/Q vertical in ghost) — Press F to set floor
            </button>
          </div>
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
            <div className="h-3 w-3 rounded-full border border-white/30 bg-white/20 shadow-[0_0_6px_rgba(255,255,255,0.25)]" />
          </div>
        </>
      )}

      {/* Canvas-based loading overlay is handled via Suspense fallback */}

      {/* Homes Library Panel */}
      {showLibrary && (
        <div className="absolute left-2 top-16 bottom-2 w-[360px] z-30 rounded-lg border border-white/10 bg-neutral-900/70 backdrop-blur-md p-3 overflow-y-auto overflow-x-hidden">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-white">Homes</h3>
            <button
              className="rounded-md border border-white/10 bg-neutral-800/80 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
              onClick={() => setShowLibrary(false)}
            >Close</button>
          </div>
          {loadingHomes ? (
            <div className="relative min-h-[200px]">
              <div className="absolute inset-0 grid place-items-center">
                <div className="bg-black/10 rounded-lg p-1 border border-white/5 shadow-[0_0_12px_rgba(165,136,239,0.2)]">
                  <LogoSpinner size={24} className="animate-spin-slow" />
                </div>
              </div>
            </div>
          ) : homes.length === 0 ? (
            <div className="text-sm text-neutral-400">No homes yet. Upload a GLB to add it.</div>
          ) : (
            <ul className="space-y-3">
              {homes.map((h) => (
                <li key={h.id} className="rounded-lg border border-white/10 bg-neutral-900/70 p-2">
                  {/* Thumbnail */}
                  <div className="rounded-md overflow-hidden border border-white/10 bg-neutral-800 w-full h-[120px]">
                    <SharedGLBThumb url={h.public_url} className="w-full h-full" lazy />
                  </div>
                  {/* Footer row */}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-neutral-300 truncate">{h.name}</div>
                    </div>
                    <button
                      className="rounded-md border border-[#a588ef]/40 bg-[#7f63d6]/60 px-3 py-1.5 text-sm text-white hover:bg-[#7f63d6]/70 ring-1 ring-[#a588ef]/20 shadow-[0_0_10px_rgba(165,136,239,0.35)]"
                      onClick={() => {
                        setLocalUrl(h.public_url)
                        setShowLibrary(false)
                        setTimeout(() => glbRef.current?.frame(), 300)
                      }}
                    >Open</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// Adjust camera eye height and snap to model center on entering POV mode, using sampled downward raycasts against BVH colliders
function POVEnterAdjuster({ orbit, eyeY, bounds, colliders = [] }: { orbit: boolean; eyeY: number; bounds?: BoundsInfo | null; colliders?: THREE.Mesh[] }) {
  const { camera, raycaster } = useThree()
  const prevOrbit = useRef<boolean>(true)
  useEffect(() => {
    // Transition: orbit -> POV
    if (prevOrbit.current && !orbit && bounds) {
      // Model is re-centered to world origin in GLBModel, so start at (0, *, 0)
      const cx = 0
      const cz = 0
      // Prefer spawning near the front of the house while still on valid floor
      const sizeX = bounds.size.x
      const sizeZ = bounds.size.z
      const approachDist = Math.max(1.4, Math.min(4.5, Math.max(sizeX, sizeZ) * 0.35))
      const step = Math.max(0.35, Math.min(1.0, Math.max(sizeX, sizeZ) * 0.015))
      const preferred = [
        new THREE.Vector3(cx, 0, cz + approachDist),
        new THREE.Vector3(cx + approachDist * 0.7, 0, cz + approachDist * 0.7),
        new THREE.Vector3(cx - approachDist * 0.7, 0, cz + approachDist * 0.7),
        new THREE.Vector3(cx, 0, cz + approachDist * 0.45),
        new THREE.Vector3(cx, 0, cz)
      ]
      const samples: THREE.Vector3[] = []
      for (const p of preferred) {
        for (let ix = -1; ix <= 1; ix++) {
          for (let iz = -1; iz <= 1; iz++) {
            samples.push(new THREE.Vector3(p.x + ix * step, 0, p.z + iz * step))
          }
        }
      }
      const originY = Math.max(100, bounds.size.y * 2 + 10)
      const down = new THREE.Vector3(0, -1, 0)
      const yBandMin = bounds.floorY - 0.5
      const yBandMax = bounds.floorY + 3.0
      let bestHit: { y: number; x: number; z: number; score: number } | null = null
      const targets = colliders.length > 0 ? colliders : undefined
      for (const p of samples) {
        const origin = new THREE.Vector3(p.x, originY, p.z)
        raycaster.set(origin, down)
        const hits = targets ? raycaster.intersectObjects(targets, true) : []
        if (hits.length === 0) continue
        const h = hits[0]
        const y = h.point.y
        if (Number.isFinite(y) && y >= yBandMin && y <= yBandMax) {
          const floorScore = Math.abs(y - bounds.floorY)
          const nearFrontScore = Math.hypot(p.x - preferred[0].x, p.z - preferred[0].z)
          const score = floorScore * 2 + nearFrontScore * 0.35
          if (!bestHit || score < bestHit.score || (score === bestHit.score && y > bestHit.y)) {
            bestHit = { y, x: p.x, z: p.z, score }
          }
        }
      }
      let y = eyeY
      let px = cx
      let pz = cz
      if (bestHit) {
        y = bestHit.y + EYE_HEIGHT_M
        px = bestHit.x
        pz = bestHit.z
      }
      camera.position.set(px, y, pz)
      // Always look back toward the model center when entering POV
      camera.lookAt(new THREE.Vector3(cx, y, cz))
      camera.updateProjectionMatrix()
    }
    prevOrbit.current = orbit
  }, [orbit, eyeY, bounds, colliders, camera, raycaster])
  return null
}

// Capsule-based FPS controller with BVH collision detection (Strategy Fox pattern)
function CapsuleFPSController({ speed = 3, sprint = 6, colliders = [], ghost = false }: { speed?: number; sprint?: number; colliders?: THREE.Mesh[]; ghost?: boolean }) {
  const { camera, raycaster } = useThree()
  const keys = useRef<Record<string, boolean>>({})
  const velocity = useRef(new THREE.Vector3())
  const lastSafeFeetY = useRef<number | null>(null)
  const jumpOffset = useRef(0)
  const jumpVelocity = useRef(0)
  const grounded = useRef(true)
  const prevJumpPressed = useRef(false)
  const eyeHeight = EYE_HEIGHT_M
  const capsuleHeight = PLAYER_HEIGHT_M
  const probeHeights = [0.2, 0.9, 1.45]
  const capsule = useRef({
    start: new THREE.Vector3(),
    end: new THREE.Vector3(),
    radius: 0.26
  })
  const tempVec = useRef(new THREE.Vector3())
  const tempVec2 = useRef(new THREE.Vector3())

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { keys.current[e.code] = true }
    const onKeyUp = (e: KeyboardEvent) => { keys.current[e.code] = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useFrame((_, delta) => {
    const moveSpeed = keys.current['ShiftLeft'] || keys.current['ShiftRight'] ? sprint : speed
    const jumpPressed = !!keys.current['Space']
    
    // Input handling
    let forward = 0, strafe = 0, rise = 0
    if (keys.current['KeyW'] || keys.current['ArrowUp']) forward += 1
    if (keys.current['KeyS'] || keys.current['ArrowDown']) forward -= 1
    if (keys.current['KeyA'] || keys.current['ArrowLeft']) strafe -= 1
    if (keys.current['KeyD'] || keys.current['ArrowRight']) strafe += 1
    if (keys.current['KeyE'] || keys.current['Space']) rise += 1
    if (keys.current['ControlLeft'] || keys.current['ControlRight'] || keys.current['KeyQ']) rise -= 1

    // Convert to world space movement
    const direction = tempVec.current.set(strafe, ghost ? rise : 0, -forward)
    if (direction.lengthSq() > 0) {
      direction.normalize()
      direction.applyQuaternion(camera.quaternion)
      if (!ghost) {
        direction.y = 0 // Lock to horizontal
        direction.normalize()
      }
    }

    // Apply movement with damping
    const targetVel = direction.multiplyScalar(moveSpeed)
    velocity.current.lerp(targetVel, Math.min(delta * 10, 1))
    if (!ghost) velocity.current.y = 0

    // Update capsule position from camera eye position
    capsule.current.start.copy(camera.position).add(new THREE.Vector3(0, -eyeHeight, 0))
    capsule.current.end.copy(capsule.current.start).add(new THREE.Vector3(0, capsuleHeight, 0))
    if (lastSafeFeetY.current === null) lastSafeFeetY.current = capsule.current.start.y

    if (ghost) {
      const deltaPos = velocity.current.clone().multiplyScalar(delta)
      camera.position.add(deltaPos)
      grounded.current = false
      jumpOffset.current = 0
      jumpVelocity.current = 0
      prevJumpPressed.current = jumpPressed
      return
    }

    if (jumpPressed && !prevJumpPressed.current && grounded.current) {
      jumpVelocity.current = 5.25
      grounded.current = false
    }
    prevJumpPressed.current = jumpPressed

    if (!grounded.current || jumpOffset.current > 0 || jumpVelocity.current > 0) {
      jumpVelocity.current -= 13 * delta
      jumpOffset.current = Math.max(0, jumpOffset.current + jumpVelocity.current * delta)
      if (jumpOffset.current <= 0 && jumpVelocity.current < 0) {
        jumpOffset.current = 0
        jumpVelocity.current = 0
      }
    }

    // Collision detection and response
    if (colliders.length > 0) {
      const deltaPos = tempVec2.current.copy(velocity.current).multiplyScalar(delta)
      
      // Test movement in 2 passes: X, Z (stable ground-follow in normal POV)
      const axes: Array<'x' | 'z'> = ['x', 'z']
      for (const axis of axes) {
        const testDelta = new THREE.Vector3()
        testDelta[axis] = deltaPos[axis]
        const moveDistance = Math.abs(testDelta[axis])
        if (moveDistance <= 1e-5) continue

        let collision = false
        const moveDir = new THREE.Vector3(testDelta.x, 0, testDelta.z).normalize()
        const clearance = Math.max(0.08, capsule.current.radius * 0.65)

        for (const h of probeHeights) {
          const probeOrigin = capsule.current.start.clone().add(new THREE.Vector3(0, h, 0))
          raycaster.set(probeOrigin, moveDir)
          const hits = raycaster.intersectObjects(colliders, true)
          const hit = hits[0]
          if (hit && hit.distance > 0.02 && hit.distance <= moveDistance + clearance) {
            collision = true
            break
          }
        }

        if (!collision) {
          capsule.current.start.add(testDelta)
          capsule.current.end.add(testDelta)
        } else {
          velocity.current[axis] = 0
        }
      }

      // Ground follow (prevents fall/bounce oscillation in normal POV)
      const groundRay = tempVec.current.set(0, -1, 0)
      const snapOrigin = capsule.current.start.clone().add(new THREE.Vector3(0, 1.2, 0))
      raycaster.set(snapOrigin, groundRay)
      const groundHits = raycaster.intersectObjects(colliders, true)
      
      if (groundHits.length > 0) {
        const groundY = groundHits[0].point.y
        if (jumpOffset.current <= 0 && jumpVelocity.current <= 0) {
          grounded.current = true
        }
        capsule.current.start.y = groundY + jumpOffset.current
        capsule.current.end.y = groundY + capsuleHeight + jumpOffset.current
        lastSafeFeetY.current = groundY
      } else {
        if (lastSafeFeetY.current != null) {
          capsule.current.start.y = lastSafeFeetY.current + jumpOffset.current
          capsule.current.end.y = lastSafeFeetY.current + capsuleHeight + jumpOffset.current
        }
      }

      if (jumpOffset.current <= 0 && jumpVelocity.current <= 0) {
        grounded.current = true
      }

      // Update camera back to eye position
      camera.position.copy(capsule.current.start).add(new THREE.Vector3(0, eyeHeight, 0))
    } else {
      // Fallback to horizontal movement only if no colliders are available
      const deltaPos = velocity.current.clone().multiplyScalar(delta)
      deltaPos.y = 0
      velocity.current.y = 0
      lastSafeFeetY.current = camera.position.y - eyeHeight
      grounded.current = true
      jumpOffset.current = 0
      jumpVelocity.current = 0
      camera.position.add(deltaPos)
    }
  })

  return null
}
