import { useState } from 'react'

export default function ProjectUpload() {
  const [dragging, setDragging] = useState(false)
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [style, setStyle] = useState('')
  const [sqft, setSqft] = useState<string>('')
  // Price: formatted like Budget ($###,###). Keep display text + numeric value
  const [priceAmount, setPriceAmount] = useState<number | null>(null)
  const [priceInput, setPriceInput] = useState<string>('')

  // Currency helpers (same behavior as IntakeForm budget)
  function formatCurrency(n: number | null): string {
    if (n == null || Number.isNaN(n)) return ''
    return '$' + new Intl.NumberFormat('en-US').format(n)
  }
  function parseCurrencyToNumber(s: string): number | null {
    const digits = s.replace(/[^0-9]/g, '')
    return digits ? Number(digits) : null
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold text-white">Upload a new project</h1>
      <p className="mt-1 text-neutral-400">Add photos, plans, or references to start a new project.</p>

      {/* Basic details */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 sm:col-span-2">
          <span className="text-sm text-neutral-300">Project Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Lakeside Retreat"
            className="h-11 rounded-md border border-white/10 px-3 bg-neutral-800 text-white placeholder:text-white/70 focus:outline-none focus:ring-2 ring-[#a588ef]"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm text-neutral-300">Location</span>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="City, State"
            className="h-11 rounded-md border border-white/10 px-3 bg-neutral-800 text-white placeholder:text-white/70 focus:outline-none focus:ring-2 ring-[#a588ef]"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm text-neutral-300">Style</span>
          <input
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="e.g. Modern"
            className="h-11 rounded-md border border-white/10 px-3 bg-neutral-800 text-white placeholder:text-white/70 focus:outline-none focus:ring-2 ring-[#a588ef]"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm text-neutral-300">Sqft</span>
          <input
            value={sqft}
            onChange={(e) => setSqft(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            placeholder="e.g. 2200"
            className="h-11 rounded-md border border-white/10 px-3 bg-neutral-800 text-white placeholder:text-white/70 focus:outline-none focus:ring-2 ring-[#a588ef]"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm text-neutral-300">Price</span>
          <input
            value={priceInput}
            onChange={(e) => {
              const num = parseCurrencyToNumber(e.target.value)
              setPriceAmount(num)
              setPriceInput(e.target.value.startsWith('$') ? e.target.value : (num == null ? '' : formatCurrency(num)))
            }}
            onBlur={() => setPriceInput(formatCurrency(priceAmount))}
            inputMode="numeric"
            placeholder="$1,000,000"
            className="h-11 rounded-md border border-white/10 px-3 bg-neutral-800 text-white placeholder:text-white/70 focus:outline-none focus:ring-2 ring-[#a588ef]"
          />
        </label>
      </div>

      {/* Upload area */}
      <div
        className={`mt-6 rounded-xl border border-dashed p-8 text-center transition-all ${dragging ? 'border-white/40 ring-2 ring-[#a588ef]' : 'border-white/20'}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false) }}
        onDrop={(e) => { e.preventDefault(); setDragging(false) }}
      >
        <p className="text-neutral-300">Drag and drop files here</p>
        <p className="text-neutral-500 text-sm">or</p>
        <label className="inline-flex items-center gap-2 rounded-md px-3 py-2 btn-accent cursor-pointer mt-2 transform-gpu transition-transform duration-300 ease-out hover:scale-105">
          <input type="file" multiple className="sr-only" />
          <span>Choose files</span>
        </label>
      </div>
    </div>
  )
}
