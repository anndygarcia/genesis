import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'
import GLBThumb from '../components/GLBThumb'
import LogoSpinner from '../components/LogoSpinner'

type Home = { id: string; name: string; public_url: string; created_at?: string | null }

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
