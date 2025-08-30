import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import GLBThumb from '../components/GLBThumb'

function Projects() {
  const [loading, setLoading] = useState(true)
  const [homes, setHomes] = useState<Array<{ id: string; public_url: string }>>([])

  // Load user's homes (GLBs) for the grid — identical to Profile's grid
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const { data: userData } = await supabase.auth.getUser()
        const uid = userData?.user?.id
        if (!uid) { if (mounted) setHomes([]); return }
        const { data, error } = await supabase
          .from('homes')
          .select('id, public_url')
          .eq('user_id', uid)
          .not('public_url', 'is', null)
          .order('created_at', { ascending: false })
        if (error) throw error
        if (mounted) setHomes((data as any[])?.map((h) => ({ id: h.id, public_url: h.public_url })) || [])
      } catch {
        if (mounted) setHomes([])
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [])

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <h1 className="text-2xl font-semibold text-white text-center">Projects</h1>
      <p className="mt-2 text-neutral-400 text-center">Create a new project or browse your upcoming projects.</p>

      {loading ? (
        <div className="mt-8 text-neutral-400">Loading projects…</div>
      ) : (
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {homes.map((h) => (
            <NavLink
              key={h.id}
              to={`/viewer-upload?glb=${encodeURIComponent(h.public_url)}`}
              className="group relative aspect-square rounded-xl border border-white/10 bg-neutral-900/60 overflow-hidden transform-gpu transition-transform duration-300 ease-out hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
              aria-label="Open in viewer"
            >
              <div className="absolute inset-0">
                <GLBThumb url={h.public_url} className="w-full h-full" />
              </div>
              <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default Projects
