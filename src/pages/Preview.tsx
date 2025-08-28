import { Link } from 'react-router-dom'
import { Box, Square, Wand2 } from 'lucide-react'

export default function Preview() {
  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Design Preview</h1>
        <Link to="/start" className="text-sm text-[#a588ef] hover:underline">Edit inputs</Link>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-white/10 texture-aluminum backdrop-blur-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Square className="size-5 text-[#a588ef]" />
            <div className="font-medium text-neutral-100">2D Floor Plan</div>
          </div>
          <EmptyState title="Floor plan not generated yet" subtitle="Your 2D plan will appear here after generation." />
        </div>
        <div className="rounded-xl border border-white/10 texture-aluminum backdrop-blur-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Box className="size-5 text-[#a588ef]" />
            <div className="font-medium text-neutral-100">3D View</div>
          </div>
          <EmptyState title="3D view not generated yet" subtitle="A rendered 3D model will show here." />
        </div>
      </div>

      <div className="mt-8 flex items-center justify-end">
        <button className="inline-flex items-center gap-2 rounded-md btn-accent px-5 py-3 text-white shadow">
          <Wand2 className="size-4" /> Generate from inputs
        </button>
      </div>
    </div>
  )
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="aspect-video grid place-items-center rounded-lg border border-dashed border-white/20">
      <div className="text-center">
        <div className="font-medium text-neutral-100">{title}</div>
        <div className="text-sm text-neutral-400">{subtitle}</div>
      </div>
    </div>
  )
}
