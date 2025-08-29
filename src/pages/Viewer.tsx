import { Suspense, useEffect, useMemo, useRef, forwardRef, useImperativeHandle, useState } from 'react'
import { createPortal } from 'react-dom'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PointerLockControls, StatsGl, useGLTF, Environment, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useSearchParams } from 'react-router-dom'

// Simple FPS controller: WASD + space (jump) + shift (sprint)
function FPSController({ speed = 3, sprint = 6 }: { speed?: number; sprint?: number }) {
  const { camera, gl } = useThree()
  const keys = useRef<Record<string, boolean>>({})
  const velocity = useRef(new THREE.Vector3())
  const direction = useRef(new THREE.Vector3())
  const onKeyDown = (e: KeyboardEvent) => { keys.current[e.code] = true }
  const onKeyUp = (e: KeyboardEvent) => { keys.current[e.code] = false }

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [gl.domElement])

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
    move.y = 0 // lock to horizontal plane for now

    velocity.current.x = move.x * moveSpeed
    velocity.current.z = move.z * moveSpeed

    camera.position.x += velocity.current.x * delta
    camera.position.z += velocity.current.z * delta
  })

  return null
}

type GLBHandle = { frame: () => void }

const GLBModel = forwardRef<GLBHandle, { url: string }>(function GLBModel({ url }, ref) {
  console.log('[Viewer] Loading URL', url)
  const { scene } = useGLTF(url, true)
  const { camera } = useThree()
  const cloned = useMemo(() => scene.clone(true), [scene])
  // Ensure model casts/receives light and auto-fit camera
  const doFrame = () => {
    // Lighting flags
    let meshCount = 0
    let matCount = 0
    cloned.traverse((obj) => {
      const m = obj as THREE.Mesh
      if ((m as any).isMesh) {
        meshCount++
        m.castShadow = true
        m.receiveShadow = true
        const mat = (m.material as any)
        if (Array.isArray(mat)) {
          mat.forEach((mm: any) => {
            matCount++
            mm.side = THREE.DoubleSide
            if (mm.transparent && mm.opacity < 0.1) { mm.transparent = false; mm.opacity = 1 }
            // If fully black/unlit with no map, give it a neutral albedo
            if (!mm.map && mm.color && mm.color.r === 0 && mm.color.g === 0 && mm.color.b === 0) {
              mm.color = new THREE.Color('#bfbfbf')
            }
          })
        } else if (mat) {
          matCount++
          mat.side = THREE.DoubleSide
          if (mat.transparent && mat.opacity < 0.1) { mat.transparent = false; mat.opacity = 1 }
          if (!mat.map && mat.color && mat.color.r === 0 && mat.color.g === 0 && mat.color.b === 0) {
            mat.color = new THREE.Color('#bfbfbf')
          }
        } else {
          // Fallback standard material if none
          m.material = new THREE.MeshStandardMaterial({ color: '#c8c8c8' })
          matCount++
        }
      }
    })
    console.log('[Viewer] Meshes:', meshCount, 'Materials:', matCount)

    // Compute bounds
    const box = new THREE.Box3().setFromObject(cloned)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    console.log('[Viewer] GLB bounds', { size: size.toArray(), center: center.toArray() })

    // If model is extremely large, scale it down
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 50) {
      const scale = 50 / maxDim
      cloned.scale.setScalar(scale)
      // Recompute bounds after scaling
      const sBox = new THREE.Box3().setFromObject(cloned)
      sBox.getSize(size)
      sBox.getCenter(center)
    }

    // Re-center model around world origin for convenience
    cloned.position.sub(center)

    // Position the camera to frame the model nicely
    const dist = Math.max(size.x, size.z) * 1.6 + 2
    camera.position.set(0, Math.max(1.6, size.y * 0.6), dist)
    camera.lookAt(0, Math.max(0.5, size.y * 0.3), 0)
    camera.updateProjectionMatrix()
  }

  useEffect(() => { doFrame() }, [cloned, camera])
  useImperativeHandle(ref, () => ({ frame: doFrame }), [cloned])

  // Add a bounding box helper for visibility
  const helper = useMemo(() => {
    const b = new THREE.Box3().setFromObject(cloned)
    const h = new THREE.Box3Helper(b, 0x44aa88)
    h.updateMatrixWorld(true)
    return h
  }, [cloned])

  return (
    <group>
      <primitive object={cloned} />
      <primitive object={helper} />
    </group>
  )
})

export default function Viewer() {
  const [params] = useSearchParams()
  const url = params.get('url') || ''
  const debugOrbit = params.get('orbit') === '1'
  const raw = params.get('raw') === '1'
  const glbRef = useRef<GLBHandle>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const logDomState = () => {
      try {
        const cont = containerRef.current
        const canvases = cont ? [...cont.querySelectorAll('canvas')] : []
        // Also try inside any shadow roots directly under the container
        const shadowCanvases: HTMLCanvasElement[] = []
        if (cont) {
          cont.querySelectorAll('*').forEach((el) => {
            const anyEl = el as any
            const sr: ShadowRoot | undefined = anyEl && anyEl.shadowRoot
            if (sr) shadowCanvases.push(...Array.from(sr.querySelectorAll('canvas')))
          })
        }
        const all = [...canvases, ...shadowCanvases]
        const info = all.map((c, i) => {
          const rect = c.getBoundingClientRect()
          return {
            i,
            className: c.className,
            zIndex: getComputedStyle(c).zIndex,
            size: { w: rect.width, h: rect.height, x: rect.x, y: rect.y },
            canvas: { width: c.width, height: c.height },
          }
        })
        console.log('[Viewer][DOM] canvases in container', info)
        try { console.log('[Viewer][DOM] canvases JSON', JSON.stringify(info)) } catch {}
        const x = Math.floor(window.innerWidth / 2)
        const y = Math.floor((window.innerHeight - 0) / 2)
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        if (el) {
          const r = el.getBoundingClientRect()
          console.log('[Viewer][DOM] elementAtCenter', {
            tag: el.tagName,
            cls: el.className,
            z: getComputedStyle(el).zIndex,
            rect: { w: r.width, h: r.height, x: r.x, y: r.y },
          })
        }
      } catch (e) {}
    }
    const id = setTimeout(logDomState, 250)
    window.addEventListener('resize', logDomState)
    // Observe subtree for canvases appearing, including inside shadow roots
    const cont = containerRef.current
    let observer: MutationObserver | null = null
    if (cont) {
      observer = new MutationObserver(() => logDomState())
      observer.observe(cont, { childList: true, subtree: true })
      // Also observe any shadow roots under cont
      cont.querySelectorAll('*').forEach((el) => {
        const sr = (el as any).shadowRoot as ShadowRoot | undefined
        if (sr) {
          const o = new MutationObserver(() => logDomState())
          o.observe(sr, { childList: true, subtree: true })
        }
      })
    }
    return () => { clearTimeout(id); window.removeEventListener('resize', logDomState); observer?.disconnect() }
  }, [])

  return (
    <>
    {/* Hidden 2D canvas to avoid context-type conflicts from injected scripts selecting the first canvas */}
    <Dummy2DCanvas />
    <div ref={containerRef} className="fixed inset-x-0 top-16 bottom-0 z-10">{/* fill viewport below header */}
      {raw ? (
        <>
        </>
      ) : (
      <ShadowHost>
      <Canvas
        shadows
        dpr={[1, 2]}
        onCreated={({ gl, size }) => {
          console.log('[Viewer] WebGLRenderer created', {
            webgl2: gl.getContext()?.constructor?.name,
            antialias: gl.getContextAttributes()?.antialias,
            canvasClientSize: { w: gl.domElement.clientWidth, h: gl.domElement.clientHeight },
            canvasBufferSize: { w: gl.domElement.width, h: gl.domElement.height },
            dpr: window.devicePixelRatio,
          })
        }}
        gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }}
        style={{ width: '100%', height: '100%', display: 'block' }}
        camera={{ position: [0, 1.6, 4], fov: 65, near: 0.05, far: 5000 }}
      >
        <color attach="background" args={[0x333333]} />
        {/* World axes at origin */}
        <primitive object={new THREE.AxesHelper(2)} position={[0, 0.01, 0]} />
        <hemisphereLight intensity={1.0} groundColor={0x333333} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[5, 10, 5]} intensity={1.0} castShadow />
        <directionalLight
          position={[8, 12, 6]}
          intensity={1.6}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
        />
        <directionalLight position={[-8, 6, -6]} intensity={0.6} />

        {/* Ground */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
          <planeGeometry args={[400, 400]} />
          <meshStandardMaterial color="#202020" />
        </mesh>
        <gridHelper args={[200, 200, '#666', '#333']} position={[0, 0.001, 0]} />

        {/* Reference cube at origin for debug visibility */}
        <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#3fa9f5" emissive="#1a7bd6" emissiveIntensity={0.4} />
        </mesh>

        <Suspense fallback={null}>
          {/* Always render strong visual helpers */}
          <primitive object={new THREE.GridHelper(50, 50, 0x444444, 0x222222)} position={[0, 0.001, 0]} />
          <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color={'#2d6cff'} emissive={'#0a2a80'} emissiveIntensity={0.2} />
          </mesh>

          {url ? (
            <GLBModel ref={glbRef} url={url} />
          ) : null}
          <Environment preset="city" />
        </Suspense>

        <FPSController />
        {debugOrbit ? <OrbitControls enableDamping dampingFactor={0.08} /> : <PointerLockControls selector="#enter-fps" />}
        <StatsGl className="!fixed !left-2 !top-20" />
      </Canvas>
      </ShadowHost>
      )}
      {raw ? (
        <Canvas
          shadows
          dpr={[1, 2]}
          onCreated={({ gl }) => {
            console.log('[Viewer][RAW] WebGLRenderer created', {
              webgl2: gl.getContext()?.constructor?.name,
              antialias: gl.getContextAttributes()?.antialias,
              canvasClientSize: { w: gl.domElement.clientWidth, h: gl.domElement.clientHeight },
              canvasBufferSize: { w: gl.domElement.width, h: gl.domElement.height },
              dpr: window.devicePixelRatio,
            })
          }}
          gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }}
          style={{ width: '100%', height: '100%', display: 'block' }}
          camera={{ position: [0, 1.6, 4], fov: 65, near: 0.05, far: 5000 }}
        >
          <color attach="background" args={[0x333333]} />
          <primitive object={new THREE.AxesHelper(2)} position={[0, 0.01, 0]} />
          <ambientLight intensity={1.2} />
          <directionalLight position={[5, 10, 5]} intensity={1.2} />
          <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#ff4444" emissive="#ff4444" emissiveIntensity={1.0} />
          </mesh>
          <mesh position={[0, 0, 0]}>
            <sphereGeometry args={[10, 16, 16]} />
            <meshBasicMaterial color="#2222ff" wireframe transparent opacity={0.3} />
          </mesh>
          <gridHelper args={[200, 200, '#888', '#444']} position={[0, 0.001, 0]} />
          {url ? <GLBModel ref={glbRef} url={url} /> : null}
          {debugOrbit ? <OrbitControls enableDamping dampingFactor={0.08} /> : <PointerLockControls selector="#enter-fps" />}
          <StatsGl className="!fixed !left-2 !top-20" />
        </Canvas>
      ) : null}
    </div>
    {/* Overlay outside of canvas stacking context */}
    <div className="pointer-events-none fixed inset-x-0 top-16 flex justify-center z-20">
      <button
        id="enter-fps"
        className="pointer-events-auto mt-2 rounded-md border border-white/10 bg-neutral-900/70 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
      >
        Click to capture mouse (FPS)
      </button>
      <div className="pointer-events-auto mt-2 ml-2 text-xs text-neutral-400 select-text">
        Tip: add <code>?orbit=1</code> to the URL to enable orbit controls for debugging.
      </div>
      <button
        onClick={() => glbRef.current?.frame()}
        className="pointer-events-auto mt-2 ml-3 rounded-md border border-white/10 bg-neutral-900/70 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
      >
        Frame Model
      </button>
    </div>
    </>
  )
}

function Dummy2DCanvas() {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (!ref.current) return
    try {
      const ctx = ref.current.getContext('2d')
      if (ctx) {
        ctx.fillStyle = 'rgba(0,0,0,0)'
        ctx.fillRect(0, 0, 1, 1)
        // Intentionally keep this 2D context allocated
        console.log('[Viewer] Dummy 2D canvas context acquired')
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

useGLTF.preload('/placeholder.glb')

// Renders children inside a Shadow DOM root to reduce interference from page-level content scripts/styles
function ShadowHost({ children }: { children: React.ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const shadowRef = useRef<ShadowRoot | null>(null)
  const [mountEl, setMountEl] = useState<Element | null>(null)

  useEffect(() => {
    if (hostRef.current && !shadowRef.current) {
      shadowRef.current = hostRef.current.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = `:host, :host * { box-sizing: border-box; } html, body { margin: 0; padding: 0; }`
      shadowRef.current.appendChild(style)
      const mount = document.createElement('div')
      mount.setAttribute('id', 'shadow-mount')
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
