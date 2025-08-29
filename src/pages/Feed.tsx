import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'
import { Canvas, useThree } from '@react-three/fiber'
import { Suspense } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import LogoSpinner from '../components/LogoSpinner'

type Home = { id: string; name: string; public_url: string; created_at?: string | null }

function GLBThumb({ url, className }: { url: string; className?: string }) {
  return (
    <div className={className}>
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

    const dist = Math.max(size.x, size.y, size.z) * 0.9 + 0.8
    camera.position.set(0.9, 0.9, dist)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }, [cloned, camera, invalidate])
  return <primitive object={cloned} />
}

export default function Feed() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [homes, setHomes] = useState<Home[]>([])

  useEffect(() => {
    let mounted = true
    const fetchHomes = async () => {
      const { data, error } = await supabase
        .from('homes')
        .select('id,name,public_url,created_at')
        .order('created_at', { ascending: false })
        .limit(100)
      if (!mounted) return
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[Feed] homes fetch error', error.message)
        setHomes([])
      } else {
        // dedupe by public_url keeping first occurrence (newest due to order)
        const seen = new Set<string>()
        const dedup = (data || []).filter((h) => {
          if (!h.public_url) return false
          if (seen.has(h.public_url)) return false
          seen.add(h.public_url)
          return true
        }) as Home[]
        setHomes(dedup)
      }
      setLoading(false)
    }
    fetchHomes()

    // realtime subscription for inserts
    const channel = supabase.channel('homes-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'homes' }, (payload: any) => {
        const h = payload.new as Home
        if (!h?.public_url) return
        // prepend if new unique URL
        setHomes((prev) => {
          if (prev.some((p) => p.public_url === h.public_url)) return prev
          return [h, ...prev]
        })
      })
      .subscribe()

    return () => {
      mounted = false
      try { supabase.removeChannel(channel) } catch {}
    }
  }, [])

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <h1 className="sr-only">Feed</h1>
      {loading ? (
        <div className="relative min-h-[240px]">
          <div className="absolute inset-0 grid place-items-center">
            <div className="bg-black/10 rounded-lg p-1 border border-white/5 shadow-[0_0_12px_rgba(165,136,239,0.2)]">
              <LogoSpinner size={24} className="animate-spin-slow" />
            </div>
          </div>
        </div>
      ) : homes.length === 0 ? (
        <div className="text-neutral-400">No homes yet. Upload a GLB to get started.</div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {homes.map((h) => (
            <li key={h.id} className="rounded-lg border border-white/10 bg-neutral-900/60 overflow-hidden">
              <button
                className="w-full text-left"
                onClick={() => navigate(`/viewer-upload?glb=${encodeURIComponent(h.public_url)}`)}
                title={`Open ${h.name}`}
              >
                <div className="aspect-[4/3] bg-neutral-800">
                  <GLBThumb url={h.public_url} className="w-full h-full" />
                </div>
                <div className="p-3">
                  <div className="text-white truncate">{h.name}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
