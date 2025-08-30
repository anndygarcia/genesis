import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createProject, uploadReferenceImages, uploadGlbsAndInsertHomes } from '../lib/supabase'

export default function ProjectUpload() {
  const [dragging, setDragging] = useState(false)
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [style, setStyle] = useState('')
  // Sqft: formatted with thousands separators, keep numeric value separately
  const [sqftValue, setSqftValue] = useState<number | null>(null)
  const [sqftInput, setSqftInput] = useState<string>('')
  // Price: formatted like Budget ($###,###). Keep display text + numeric value
  const [priceAmount, setPriceAmount] = useState<number | null>(null)
  const [priceInput, setPriceInput] = useState<string>('')
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const navigate = useNavigate()

  // Currency helpers (same behavior as IntakeForm budget)
  function formatCurrency(n: number | null): string {
    if (n == null || Number.isNaN(n)) return ''
    return '$' + new Intl.NumberFormat('en-US').format(n)
  }
  function parseCurrencyToNumber(s: string): number | null {
    const digits = s.replace(/[^0-9]/g, '')
    return digits ? Number(digits) : null
  }
  function formatNumber(n: number | null): string {
    if (n == null || Number.isNaN(n)) return ''
    return new Intl.NumberFormat('en-US').format(n)
  }

  function onSelectFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    const next = Array.from(list)
      .filter((f) => f.type.startsWith('image/') || /\.glb$/i.test(f.name))
    setFiles((prev) => [...prev, ...next])
  }

  // Generate preview URLs for selected files and clean them up
  const previews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files])
  useEffect(() => {
    return () => {
      previews.forEach((p) => URL.revokeObjectURL(p.url))
    }
  }, [previews])

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) return ''
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let val = bytes
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024
      i++
    }
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
  }

  async function onSubmit() {
    try {
      setSaving(true)
      // 1) Separate and upload files
      const imageFiles = files.filter((f) => f.type.startsWith('image/'))
      const glbFiles = files.filter((f) => !f.type.startsWith('image/') && /\.glb$/i.test(f.name))
      const imageUrls = imageFiles.length ? await uploadReferenceImages(imageFiles) : []
      // Upload GLBs to public bucket and insert into homes (global visibility)
      if (glbFiles.length) {
        await uploadGlbsAndInsertHomes(glbFiles)
      }
      // 2) Create project row
      const fallbackName = files[0]?.name?.replace(/\.[^/.]+$/, '') || 'Untitled Project'
      await createProject({
        name: name.trim() || fallbackName,
        location: location.trim() || null,
        style: style.trim() || null,
        sqft: sqftValue ?? null,
        price_amount: priceAmount ?? null,
        image_urls: imageUrls,
        is_public: true,
      })
      // 3) Navigate to Projects
      navigate('/projects')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to save project', err)
      alert('Failed to save project. Please make sure you are signed in and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
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
            value={sqftInput}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^0-9]/g, '')
              const num = digits ? Number(digits) : null
              setSqftValue(num)
              setSqftInput(digits ? formatNumber(num) : '')
            }}
            onBlur={() => setSqftInput(formatNumber(sqftValue))}
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
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!e.dataTransfer?.files) return
          const allowed = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/') || /\.glb$/i.test(f.name))
          setFiles((prev) => [...prev, ...allowed])
        }}
      >
        <p className="text-neutral-300">Drag and drop files here</p>
        <p className="text-neutral-500 text-sm">or</p>
        <label className="inline-flex items-center gap-2 rounded-md px-3 py-2 btn-accent cursor-pointer mt-2 transform-gpu transition-transform duration-300 ease-out hover:scale-105">
          <input type="file" multiple accept="image/*,.glb" className="sr-only" onChange={(e) => onSelectFiles(e.target.files)} />
          <span>Choose files</span>
        </label>
        {files.length > 0 && (
          <>
            <div className="mt-3 text-sm text-neutral-400">
              {files.length} file{files.length > 1 ? 's' : ''} selected
            </div>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {previews.map(({ file, url }) => {
                const isImage = file.type.startsWith('image/')
                return (
                  <div key={`${file.name}-${file.size}-${file.lastModified}`}
                       className="group relative rounded-lg overflow-hidden border border-white/10 bg-neutral-900/60">
                    {isImage ? (
                      <img src={url} alt={file.name} className="h-36 w-full object-cover" />
                    ) : (
                      <div className="h-36 w-full grid place-items-center text-neutral-300">
                        <div className="text-center px-2">
                          <div className="text-sm font-medium truncate" title={file.name}>{file.name}</div>
                          <div className="text-xs text-neutral-400 mt-1">{formatBytes(file.size)}</div>
                        </div>
                      </div>
                    )}
                    {/* Show caption overlay only for non-image files */}
                    {!isImage && (
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                        <div className="text-xs text-neutral-200 truncate" title={file.name}>{file.name}</div>
                        <div className="text-[10px] text-neutral-400">{formatBytes(file.size)}</div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Submit */}
      <div className="mt-6">
        <button
          onClick={onSubmit}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md btn-accent px-4 py-2 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Create project'}
        </button>
      </div>
    </div>
  )
}
