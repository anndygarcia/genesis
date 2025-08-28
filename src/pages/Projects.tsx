import { NavLink } from 'react-router-dom'
import { Plus } from 'lucide-react'

function Projects() {
  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <h1 className="text-2xl font-semibold text-white">Projects</h1>
      <p className="mt-2 text-neutral-400">Create a new project or browse your upcoming projects.</p>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <NavLink
            key={i}
            to="/projects/new"
            aria-label="Create new project"
            className="group relative aspect-square rounded-xl border border-white/10 bg-neutral-900/60 text-neutral-500 transform-gpu transition-transform duration-300 ease-out hover:scale-105 overflow-hidden cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
          >
            <span className="absolute inset-0 grid place-items-center transition-opacity duration-300 ease-out group-hover:opacity-0">
              Coming soon
            </span>
            <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100">
              <Plus className="h-10 w-10 text-neutral-300" />
            </span>
          </NavLink>
        ))}
      </div>
    </div>
  )
}

export default Projects
