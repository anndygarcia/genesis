import { Suspense, useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, PointerLockControls, Environment, useGLTF, useProgress, Html } from '@react-three/drei'
import * as THREE from 'three'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import LogoSpinner from '../components/LogoSpinner'

// Minimal GLB loader + auto-frame (duplicated here so we don't depend on Viewer.tsx internals)
type GLBHandle = { frame: () => void }
type BoundsInfo = { size: THREE.Vector3; center: THREE.Vector3; floorY: number }
type Home = { id: string; name: string; public_url: string; size?: number; created_at?: string; path?: string }

// Tiny GLB preview thumbnail used in the Homes library list
// Enlarged and framed closer for better visibility
function GLBThumb({ url, width = 200, height = 140 }: { url: string; width?: number; height?: number }) {
  return (
    <div style={{ width, height }} className="bg-neutral-800">
      <Canvas
        orthographic={false}
        frameloop="demand"
        dpr={[1, 1]}
        shadows={false}
        gl={{
          antialias: false,
          powerPreference: 'low-power',
          alpha: true,
          preserveDrawingBuffer: false,
          outputColorSpace: THREE.SRGBColorSpace,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.4,
        }}
        camera={{ position: [0.6, 0.9, 2.2], fov: 38, near: 0.05, far: 1000 }}
        style={{ width, height }}
        onCreated={({ gl }) => {
          const isWebGL2 = (gl as any).getParameter?.((gl as any).VERSION)?.includes('WebGL 2')
          console.info('[GLBThumb] Canvas created', { webgl2: !!isWebGL2 })
        }}
      >
        <color attach="background" args={[0x1a1a1a]} />
        <ambientLight intensity={1.4} />
        <hemisphereLight args={[0xffffff, 0x666666, 0.9]} />
        <directionalLight position={[2, 3, 2]} intensity={1.2} />
        <directionalLight position={[-3, 2, 1]} intensity={0.7} />
        <Suspense fallback={null}>
          <ThumbModel url={url} />
        </Suspense>
      </Canvas>
    </div>
  )
}

function CenteredCanvasSpinner() {
  const { active } = useProgress()
  if (!active) return null
  return (
    <Html center>
      <div className="pointer-events-none bg-black/10 rounded-lg p-1 border border-white/5 shadow-[0_0_12px_rgba(165,136,239,0.2)]">
        <LogoSpinner size={24} className="animate-spin-slow" />
      </div>
    </Html>
  )
}

function ThumbModel({ url }: { url: string }) {
  const { scene } = useGLTF(url, true)
  const { camera, invalidate } = useThree()
  const cloned = useMemo(() => scene.clone(true), [scene])

  useEffect(() => {
    // Frame once loaded
    const box = new THREE.Box3().setFromObject(cloned)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 0) {
      const scale = 2 / maxDim // scale to a manageable size
      cloned.scale.setScalar(scale)
      const sBox = new THREE.Box3().setFromObject(cloned)
      sBox.getSize(size)
      sBox.getCenter(center)
    }
    // center
    cloned.position.sub(center)

    // Normalize materials so thumbnails aren't too dark/transparent
    cloned.traverse((obj) => {
      const m = obj as THREE.Mesh
      if ((m as any).isMesh) {
        const mat: any = m.material
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
    // position camera
    const dist = Math.max(size.x, size.y, size.z) * 0.9 + 0.8 // closer
    camera.position.set(0.9, 0.9, dist)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    invalidate() // render once
  }, [cloned, camera, invalidate])

  return <primitive object={cloned} />
}

const GLBModel = forwardRef<GLBHandle, { url: string; onBounds?: (info: BoundsInfo) => void }>(function GLBModel({ url, onBounds }, ref) {
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

    // Compute a robust floorY using weighted mesh bounding boxes
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
        entries.push({ y: bb.min.y, area })
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
    camera.position.set(0, Math.max(floorY + 1.6, size.y * 0.3), dist)
    camera.lookAt(0, floorY + 1.2, 0)
    camera.updateProjectionMatrix()
  }, [cloned, camera])

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
  const [speed, setSpeed] = useState<number>(3)
  const [floorOffset, setFloorOffset] = useState<number>(0.02) // small lift to avoid z-fighting and sit flush visually
  const [floorY, setFloorY] = useState<number>(0)
  const glbRef = useRef<GLBHandle>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [searchParams] = useSearchParams()
  const [showLibrary, setShowLibrary] = useState(false)
  const [homes, setHomes] = useState<Home[]>([])
  const [showHomesGlow, setShowHomesGlow] = useState<boolean>(false)

  // Turn on a rotating glow for the Homes button on first visit only
  useEffect(() => {
    try {
      const seen = localStorage.getItem('ui_homes_glow_seen')
      if (!seen) setShowHomesGlow(true)
    } catch {}
  }, [])
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

  // Load GLB from query param if provided
  useEffect(() => {
    const raw = searchParams.get('glb')
    const url = raw ? decodeURIComponent(raw) : null
    if (url) setLocalUrl(url)
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
              className="relative px-3 py-1 rounded-r-md transition shadow bg-transparent text-neutral-300 shadow-[inset_0_0_6px_rgba(0,0,0,0.5)] pointer-events-none opacity-60"
              aria-disabled
            >
              POV
              {/* Purple X overlay confined to POV button */}
              <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                <span className="relative block w-6 h-6">
                  <span className="absolute left-1/2 top-0 -translate-x-1/2 h-6 w-[2px] bg-[#a588ef] rotate-45" />
                  <span className="absolute left-1/2 top-0 -translate-x-1/2 h-6 w-[2px] bg-[#a588ef] -rotate-45" />
                </span>
              </span>
            </button>
          </div>
          <span className="mt-1 text-[10px] text-[#a588ef]">coming soon</span>
        </div>
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
              <span>Floor Offset</span>
              <input
                type="range"
                min={-0.5}
                max={0.5}
                step={0.005}
                value={floorOffset}
                onChange={(e) => setFloorOffset(parseFloat(e.target.value))}
              />
              <span className="w-12 text-right tabular-nums">{floorOffset.toFixed(3)}m</span>
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
        key={localUrl || 'empty'}
        shadows
        dpr={[1, 2]}
        style={{ width: '100%', height: '100%', display: 'block' }}
        gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }}
        camera={{ position: [0, 1.6, 4], fov: 65, near: 0.05, far: 5000 }}
        onCreated={({ gl }) => {
          const version = (gl as any).getParameter?.((gl as any).VERSION)
          console.info('[ViewerUpload] Main Canvas created. WebGL version:', version)
        }}
      >
        <color attach="background" args={[0x333333]} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[6, 10, 6]} intensity={1.2} castShadow />
        {localUrl && (
          <gridHelper args={[200, 200, '#666', '#333']} position={[0, floorY + floorOffset, 0]} />
        )}
        <Suspense fallback={<CenteredCanvasSpinner />}>
          {localUrl ? (
            <>
              <GLBModel key={localUrl} ref={glbRef} url={localUrl} onBounds={({ floorY }) => setFloorY(floorY)} />
              <Environment preset="city" />
            </>
          ) : null}
        </Suspense>

        {orbit ? <OrbitControls enableDamping dampingFactor={0.08} /> : <PointerLockControls />}
        {!orbit && <FPSController speed={speed} sprint={Math.max(6, speed * 2)} />}
        {!orbit && <FloorPicker enabled onPick={(y) => setFloorY(Math.round(y * 1000) / 1000)} />}
      </Canvas>

      {/* Canvas-based loading overlay is handled via Suspense fallback */}

      {/* Homes Library Panel */}
      {showLibrary && (
        <div className="absolute left-2 top-16 bottom-2 w-[360px] z-30 rounded-lg border border-white/10 bg-neutral-900/70 backdrop-blur-md p-3 overflow-y-auto">
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
            <ul className="space-y-2">
              {homes.map((h) => (
                <li key={h.id} className="rounded-md border border-white/10 bg-neutral-900/60 p-2">
                  <div className="flex items-start gap-2">
                    <div className="shrink-0 rounded-md overflow-hidden border border-white/10 bg-neutral-800">
                      <GLBThumb url={h.public_url} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white truncate">{h.name}</div>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          className="rounded-md border border-[#a588ef]/40 bg-[#7f63d6]/60 px-4 py-2 text-sm text-white hover:bg-[#7f63d6]/70 ring-1 ring-[#a588ef]/20 shadow-[0_0_10px_rgba(165,136,239,0.35)]"
                          onClick={() => {
                            setLocalUrl(h.public_url)
                            setTimeout(() => glbRef.current?.frame(), 300)
                          }}
                        >Open</button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* FPS capture button */}
      {!orbit && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center z-20">
            <button id="enter-fps-upload" className="pointer-events-auto rounded-md border border-white/10 bg-neutral-900/80 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-800">
              Click the canvas to capture mouse (FPS) — W/A/S/D to move, Shift to sprint — Press F to set floor to crosshair
            </button>
          </div>
          {/* Crosshair */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
            <div className="h-3 w-3 rounded-full border border-white/30 bg-white/20 shadow-[0_0_6px_rgba(255,255,255,0.25)]" />
          </div>
        </>
      )}
    </div>
  )
}

// WASD + Shift sprint first-person movement on the horizontal plane
function FPSController({ speed = 3, sprint = 6 }: { speed?: number; sprint?: number }) {
  const { camera } = useThree()
  const keys = useRef<Record<string, boolean>>({})
  const velocity = useRef(new THREE.Vector3())
  const direction = useRef<THREE.Vector3>(new THREE.Vector3())

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
    const moveSpeed = (keys.current['ShiftLeft'] || keys.current['ShiftRight']) ? sprint : speed
    direction.current.set(0, 0, 0)
    const forward = Number(keys.current['KeyW']) - Number(keys.current['KeyS'])
    const strafe = Number(keys.current['KeyD']) - Number(keys.current['KeyA'])

    if (forward !== 0) direction.current.z = forward
    if (strafe !== 0) direction.current.x = strafe

    if (direction.current.lengthSq() > 0) direction.current.normalize()

    // Convert local direction to world using camera orientation
    const move = new THREE.Vector3(direction.current.x, 0, direction.current.z)
    move.applyQuaternion(camera.quaternion)
    move.y = 0 // lock to horizontal plane

    velocity.current.x = move.x * moveSpeed
    velocity.current.z = move.z * moveSpeed

    camera.position.x += velocity.current.x * delta
    camera.position.z += velocity.current.z * delta
  })

  return null
}

// Press 'F' to set floorY to the surface under the crosshair (raycast forward from camera)
function FloorPicker({ enabled, onPick }: { enabled: boolean; onPick: (y: number) => void }) {
  const { camera, scene, raycaster } = useThree()

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyF') return
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize()
      const origin = camera.position.clone()
      raycaster.set(origin, dir)
      const intersects = raycaster.intersectObjects(scene.children, true)
      if (intersects.length > 0) {
        onPick(intersects[0].point.y)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, camera, scene, raycaster, onPick])

  return null
}
