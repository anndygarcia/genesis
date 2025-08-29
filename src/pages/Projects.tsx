import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { listUserProjects, type Project } from '../lib/supabase'

function Projects() {
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const data = await listUserProjects()
        if (mounted) setProjects(data)
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
      ) : projects.length === 0 ? (
        <div className="mt-8 flex justify-center">
          <NavLink
            to="/projects/new"
            aria-label="Create new project"
            className="group relative w-[320px] sm:w-[360px] aspect-square rounded-xl border border-white/10 bg-neutral-900/60 text-neutral-500 transform-gpu transition-transform duration-300 ease-out hover:scale-105 overflow-hidden cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
          >
            <span className="absolute inset-0 grid place-items-center transition-opacity duration-300 ease-out group-hover:opacity-0">
              Start a new project
            </span>
            <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100">
              <Plus className="h-10 w-10 text-neutral-300" />
            </span>
          </NavLink>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {/* Create new project tile */}
          <NavLink
            to="/projects/new"
            aria-label="Create new project"
            className="group relative aspect-square rounded-xl border border-white/10 bg-neutral-900/60 text-neutral-500 transform-gpu transition-transform duration-300 ease-out hover:scale-105 overflow-hidden cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
          >
            <span className="absolute inset-0 grid place-items-center transition-opacity duration-300 ease-out group-hover:opacity-0">
              Start a new project
            </span>
            <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100">
              <Plus className="h-10 w-10 text-neutral-300" />
            </span>
          </NavLink>

          {/* User projects */}
          {projects.map((p) => {
            const image = p.image_urls?.[0]
            return (
              <div key={p.id} className="group relative aspect-square rounded-xl border border-white/10 bg-neutral-900/60 overflow-hidden">
                <div className="absolute inset-0">
                  {image ? (
                    <img src={image} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full grid place-items-center text-neutral-500">No image</div>
                  )}
                </div>
                <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/60 to-transparent">
                  <div className="text-white font-medium truncate">{p.name}</div>
                  <div className="text-xs text-neutral-300 truncate">{p.location || '—'}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default Projects
