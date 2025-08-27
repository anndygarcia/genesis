import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Save } from 'lucide-react'
import { uploadReferenceImages } from '../lib/supabase'

const STEPS = ["Style", "Details", "Notes"] as const

type Step = typeof STEPS[number]

type FormData = {
  basics: { floors: number; sqft: number }
  rooms: { beds: number; baths: number; garage: number }
  style: { archetype: string; refs: string[] }
  budget: { amount: number | null }
  notes: string
}

const STYLE_OPTIONS: { label: string; value: string }[] = [
  { label: 'Modern', value: 'modern' },
  { label: 'Farmhouse', value: 'farmhouse' },
  { label: 'Mediterranean', value: 'mediterranean' },
  { label: 'Spanish', value: 'spanish' },
  { label: 'Barndominium', value: 'barndominium' },
  { label: 'Log Cabin', value: 'log-cabin' },
  { label: 'Ranch House', value: 'ranch-house' },
  { label: 'Victorian', value: 'victorian' },
  { label: 'Contemporary', value: 'contemporary' },
]

const defaultData: FormData = {
  basics: { floors: 1, sqft: 1800 },
  rooms: { beds: 3, baths: 2, garage: 0 },
  style: { archetype: '', refs: [] },
  budget: { amount: null },
  notes: ''
}

export default function IntakeForm() {
  const navigate = useNavigate()
  const [stepIndex, setStepIndex] = useState(0)
  const [data, setData] = useState<FormData>(() => {
    const saved = localStorage.getItem('hdv1')
    if (!saved) return defaultData
    try {
      const parsed = JSON.parse(saved) as Partial<FormData>
      // Shallow-safe merge to ensure new fields like rooms.garage and style.refs exist
      return {
        ...defaultData,
        ...parsed,
        basics: { ...defaultData.basics, ...(parsed as any).basics },
        rooms: { ...defaultData.rooms, ...(parsed as any).rooms },
        style: { ...defaultData.style, ...(parsed as any).style },
        budget: { ...defaultData.budget, ...(parsed as any).budget },
      }
    } catch {
      return defaultData
    }
  })
  // Upload state for reference images (persisted to Supabase)
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [budgetInput, setBudgetInput] = useState('')

  // Helpers for currency formatting
  function formatCurrency(n: number | null): string {
    if (n == null || Number.isNaN(n)) return ''
    return '$' + new Intl.NumberFormat('en-US').format(n)
  }
  function parseCurrencyToNumber(s: string): number | null {
    const digits = s.replace(/[^0-9]/g, '')
    return digits ? Number(digits) : null
  }

  async function addRefImages(files: FileList | File[]) {
    const list = Array.from(files)
    if (!list.length) return
    setIsUploading(true)
    try {
      const urls = await uploadReferenceImages(list)
      if (urls.length) {
        setData(d => ({ ...d, style: { ...d.style, refs: [...(d.style.refs || []), ...urls] } }))
      }
    } finally {
      setIsUploading(false)
    }
  }

  const step: Step = useMemo(() => STEPS[stepIndex], [stepIndex])

  useEffect(() => {
    localStorage.setItem('hdv1', JSON.stringify(data))
  }, [data])

  // Initialize and sync budget input display from stored value
  useEffect(() => {
    setBudgetInput(formatCurrency(data.budget.amount))
  }, [data.budget.amount])

  function next() {
    if (stepIndex < STEPS.length - 1) setStepIndex(i => i + 1)
    else navigate('/preview')
  }
  function prev() {
    if (stepIndex > 0) setStepIndex(i => i - 1)
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div className="text-sm text-neutral-400">Step {stepIndex + 1} of {STEPS.length}</div>
        <button
          className="inline-flex items-center gap-2 text-sm text-neutral-300 hover:text-[#a588ef]"
          onClick={() => localStorage.setItem('hdv1', JSON.stringify(data))}
        >
          <Save className="size-4" /> Save progress
        </button>
      </div>

      <h1 className="text-2xl font-semibold tracking-tight mb-6 text-neutral-100">Tell us about your home</h1>

      <div className="rounded-xl border texture-aluminum backdrop-blur-xl p-6">
        {step === 'Details' && (
          <>
            {/* Basics */}
            <div className="grid gap-6 sm:grid-cols-2">
              <NumberField label="Floors" value={data.basics.floors} min={1}
                onChange={v => setData(d => ({ ...d, basics: { ...d.basics, floors: v }}))}
              />
              <NumberField label="Total Sq Ft" value={data.basics.sqft} min={400} placeholder="0"
                onChange={v => setData(d => ({ ...d, basics: { ...d.basics, sqft: v }}))}
              />
            </div>

            {/* Rooms */}
            <div className="mt-6 grid gap-6 sm:grid-cols-3">
              <NumberField label="Bedrooms" value={data.rooms.beds} onChange={v => setData(d => ({...d, rooms:{...d.rooms, beds:v}}))} />
              <NumberField label="Bathrooms" value={data.rooms.baths} onChange={v => setData(d => ({...d, rooms:{...d.rooms, baths:v}}))} />
              <NumberField label="Garage Capacity" value={data.rooms.garage} onChange={v => setData(d => ({...d, rooms:{...d.rooms, garage:v}}))} />
            </div>

            {/* Budget */}
            <div className="mt-6 grid gap-3">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-neutral-100">Budget</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="$"
                  value={budgetInput}
                  onChange={(e) => {
                    const num = parseCurrencyToNumber(e.target.value)
                    setData(d => ({ ...d, budget: { amount: num } }))
                    setBudgetInput(e.target.value.startsWith('$') ? e.target.value : (num == null ? '' : formatCurrency(num)))
                  }}
                  onBlur={() => setBudgetInput(formatCurrency(data.budget.amount))}
                  className="h-11 rounded-md border border-white/10 px-3 bg-transparent text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:ring-2 ring-[#a588ef]"
                />
              </label>
            </div>
          </>
        )}
        {step === 'Style' && (
          <>
            <div className="grid gap-6 sm:grid-cols-3">
              {STYLE_OPTIONS.map(opt => (
                <RadioCard
                  key={opt.value}
                  label={opt.label}
                  value={opt.value}
                  checked={data.style.archetype === opt.value}
                  onChange={() => setData(d => ({ ...d, style: { ...d.style, archetype: opt.value } }))}
                />
              ))}
            </div>

            {/* Reference images uploader */}
            <div
              className={`mt-6 rounded-lg border border-dashed p-4 transition-all ${isDragging ? 'border-white/40 ring-2 ring-[#a588ef]' : 'border-white/20'}`}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true) }}
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true) }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false) }}
              onDrop={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(false)
                const files = e.dataTransfer.files
                if (files && files.length) await addRefImages(files)
              }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-neutral-100">Reference photos (optional)</div>
                  <div className="text-sm text-neutral-400">Upload or drag-and-drop images of homes you like to guide the design.</div>
                </div>
                <label className="inline-flex items-center gap-2 rounded-md px-3 py-2 btn-accent cursor-pointer transform-gpu transition-transform duration-300 ease-out hover:scale-105 active:scale-100">
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="sr-only"
                    onChange={async (e) => {
                      const files = e.target.files
                      if (!files) return
                      await addRefImages(files)
                      e.currentTarget.value = ''
                    }}
                  />
                  <span>{isUploading ? 'Uploading…' : 'Upload images'}</span>
                </label>
              </div>

              {data.style.refs?.length > 0 && (
                <div className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-3">
                  {data.style.refs.map((src, i) => (
                    <div key={i} className="relative group">
                      <img src={src} alt="reference" className="h-20 w-full object-cover rounded-md border border-white/10" />
                      <button
                        type="button"
                        className="absolute -top-2 -right-2 hidden group-hover:block bg-neutral-900 text-xs text-white rounded-full px-2 py-0.5 border border-white/10"
                        onClick={() => setData(d => ({ ...d, style: { ...d.style, refs: d.style.refs.filter((_, idx) => idx !== i) } }))}
                        aria-label="Remove image"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {step === 'Notes' && (
          <div className="grid gap-2">
            <textarea
              placeholder="Must-haves, constraints, materials, outdoor spaces, etc."
              value={data.notes}
              onChange={e => setData(d => ({...d, notes:e.target.value}))}
              className="min-h-40 rounded-md border border-white/10 px-3 py-2 bg-transparent text-neutral-100 placeholder:text-white/85 placeholder:font-medium focus:outline-none focus:ring-2 ring-[#a588ef]"
            />
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button onClick={prev} disabled={stepIndex===0}
            className="inline-flex items-center gap-2 rounded-md border border-white/10 px-4 py-2 text-neutral-200 hover:bg-white/10 disabled:opacity-50"
          >
            <ArrowLeft className="size-4" /> Back
          </button>
          <button onClick={next}
            className="inline-flex items-center gap-2 rounded-md btn-accent px-4 py-2 text-white shadow transform-gpu transition-transform duration-300 ease-out hover:scale-105 active:scale-100"
          >
            {stepIndex < STEPS.length - 1 ? (
              <>
                Next <ArrowRight className="size-4" />
              </>
            ) : (
              <>Go to Preview <ArrowRight className="size-4" /></>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function NumberField({ label, value, onChange, placeholder = '0', min = 0 }: { label: string, value: number, onChange: (v:number)=>void, placeholder?: string, min?: number }) {
  const [text, setText] = useState<string>('')
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(value != null && !Number.isNaN(value) && value !== 0 ? String(value) : '')
  }, [value, focused])

  return (
    <label className="grid gap-2">
      <span className="text-sm font-semibold text-neutral-100">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          const digits = text.replace(/[^0-9]/g, '')
          if (digits === '') {
            onChange(min ?? 0)
            setText('')
          } else {
            const n = Math.max(min ?? 0, Number(digits))
            onChange(n)
            setText(String(n))
          }
        }}
        onChange={(e) => {
          const raw = e.target.value
          const digits = raw.replace(/[^0-9]/g, '')
          setText(digits)
          if (digits !== '') onChange(Math.max(min ?? 0, Number(digits)))
        }}
        className="h-11 rounded-md border border-white/10 px-3 focus:outline-none focus:ring-2 ring-[#a588ef] bg-transparent text-neutral-100 placeholder:text-neutral-500"
      />
    </label>
  )
}

function RadioCard({ label, value, checked, onChange }: { label:string, value:string, checked:boolean, onChange:()=>void }) {
  return (
    <label className={`rounded-lg border border-white/10 p-4 cursor-pointer transform-gpu transition-transform transition-colors duration-300 ease-out hover:scale-105 hover:bg-[#a588ef]/16 hover:border-[#a588ef]/60 ${checked ? 'ring-2 ring-[#a588ef] border-[#a588ef]' : ''}`}>
      <input type="radio" name="style" value={value} checked={checked} onChange={onChange} className="sr-only" />
      <div className="font-medium text-neutral-100">{label}</div>
      <div className="text-sm text-neutral-400">{checked ? 'Selected' : 'Choose'}</div>
    </label>
  )
}
