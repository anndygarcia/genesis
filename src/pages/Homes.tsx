import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import GLBThumb from '../components/GLBThumb'

const STORAGE_PUBLIC_PREFIX = '/storage/v1/object/public/glbs/'

function decodeRepeated(value: string, maxPasses = 2) {
  let out = value
  for (let i = 0; i < maxPasses; i += 1) {
    try {
      const next = decodeURIComponent(out)
      if (next === out) break
      out = next
    } catch {
      break
    }
  }
  return out
}

function normalizeStorageKey(raw: string) {
  return decodeRepeated(String(raw || '').trim(), 3)
    .replace(/^\/+/, '')
}

function extractStorageKey(raw: string) {
  const input = String(raw || '').trim()
  if (!input) return ''
  const normalized = normalizeStorageKey(input)
  if (!/^https?:\/\//i.test(normalized)) return normalized
  try {
    const parsed = new URL(normalized)
    const markerIndex = parsed.pathname.toLowerCase().indexOf(STORAGE_PUBLIC_PREFIX)
    if (markerIndex >= 0) {
      return normalizeStorageKey(parsed.pathname.slice(markerIndex + STORAGE_PUBLIC_PREFIX.length))
    }
    return ''
  } catch {
    return ''
  }
}

function toCanonicalGlbUrl(inputUrl: string, fallbackPath: string | undefined) {
  const bucket = supabase.storage.from('glbs')
  const input = String(inputUrl || '').trim()
  const fallback = String(fallbackPath || '').trim()

  if (!input && !fallback) return ''

  const fallbackKey = extractStorageKey(fallback)
  if (fallbackKey) return bucket.getPublicUrl(fallbackKey).data.publicUrl

  const inputKey = extractStorageKey(input)
  if (inputKey) return bucket.getPublicUrl(inputKey).data.publicUrl

  if (!/^https?:\/\//i.test(input)) {
    const key = normalizeStorageKey(input || fallback)
    if (!key) return ''
    return bucket.getPublicUrl(key).data.publicUrl
  }

  try {
    const parsed = new URL(input)
    const markerIndex = parsed.pathname.toLowerCase().indexOf(STORAGE_PUBLIC_PREFIX)
    if (markerIndex >= 0) {
      const keyPart = parsed.pathname.slice(markerIndex + STORAGE_PUBLIC_PREFIX.length)
      const key = normalizeStorageKey(keyPart)
      if (key) return bucket.getPublicUrl(key).data.publicUrl
    }
    return encodeURI(decodeRepeated(input, 2))
  } catch {
    return encodeURI(decodeRepeated(input, 2))
  }
}

export default function Homes({ onSelect, onClose }: { onSelect?: (url: string) => void; onClose?: () => void }) {
  const [homes, setHomes] = useState<Array<{ id: string; name?: string; public_url: string; path?: string; created_at?: string }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('homes')
          .select('id,name,public_url,path,created_at')
          .order('created_at', { ascending: false })
          .limit(300)
        if (error) throw error
        const rows = (data as any[]) || []
        // Normalize URL (legacy rows may store key/path instead of full URL), then dedupe.
        const seen = new Map<string, any>()
        for (const r of rows) {
          const url = toCanonicalGlbUrl(r.public_url, r.path)
          if (!url) continue
          const row = { ...r, public_url: url }
          if (!seen.has(url)) seen.set(url, row)
        }
        if (mounted) setHomes(Array.from(seen.values()))
      } catch {
        if (mounted) setHomes([])
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [])

  const sendSelect = (url: string) => {
    if (onSelect) return onSelect(url)
    try {
      const msg = { type: 'HOMES_SELECT_GLB', url }
      // Notify parent (GenesisViewer) – same-origin
      window.parent?.postMessage(msg, window.location.origin)
    } catch {}
  }

  const close = () => {
    if (onClose) return onClose()
    try { window.parent?.postMessage({ type: 'HOMES_CLOSE' }, window.location.origin) } catch {}
  }

  return (
    <div className="w-full h-full bg-neutral-950 text-neutral-100 overflow-y-auto" data-homes-scroll-root>
      <div className="max-w-4xl mx-auto px-4 py-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Homes Library</h2>
          <button
            className="rounded-md border border-white/10 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
            onClick={close}
          >Close</button>
        </div>
        {loading ? (
          <div className="text-neutral-400">Loading…</div>
        ) : homes.length === 0 ? (
          <div className="text-neutral-400">No homes found.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {homes.map((h) => (
              <button
                key={h.id}
                className="group relative aspect-square rounded-lg overflow-hidden border border-white/10 bg-neutral-900 hover:scale-[1.02] transition-transform"
                onClick={() => sendSelect(h.public_url)}
                title={h.name || 'Open'}
              >
                <div className="absolute inset-0">
                  <GLBThumb url={h.public_url} className="w-full h-full" lazy />
                </div>
                <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/50 to-transparent text-left">
                  <div className="text-xs truncate text-neutral-200">{h.name || 'Untitled'}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
