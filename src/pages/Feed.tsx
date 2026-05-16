import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'
import { GLBThumb } from '../components/GLBThumb'
import LogoSpinner from '../components/LogoSpinner'
import { ArrowRight, Box, Clock, Eye, Sparkles, Upload } from 'lucide-react'

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
  return decodeRepeated(String(raw || '').trim(), 3).replace(/^\/+/, '')
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

type Home = { id: string; name: string; public_url: string; path?: string; created_at?: string | null }

const quickActions = [
  {
    title: 'Generate',
    description: 'Describe your dream home and let the AI architect design it for you.',
    icon: Sparkles,
    path: '/intake',
    color: 'from-[#a588ef]/20 to-purple-500/10',
    borderColor: 'border-[#a588ef]/30 hover:border-[#a588ef]/50',
    iconColor: 'text-[#a588ef]',
  },
  {
    title: 'Create',
    description: 'Build freely in the 3D studio with walls, doors, windows, and AI assistance.',
    icon: Box,
    path: '/start',
    color: 'from-cyan-500/15 to-sky-500/10',
    borderColor: 'border-cyan-500/25 hover:border-cyan-500/40',
    iconColor: 'text-cyan-400',
  },
  {
    title: 'View',
    description: 'Upload a GLB model and explore it in the interactive 3D viewer.',
    icon: Eye,
    path: '/viewer-upload',
    color: 'from-emerald-500/15 to-teal-500/10',
    borderColor: 'border-emerald-500/25 hover:border-emerald-500/40',
    iconColor: 'text-emerald-400',
  },
]

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
        .select('id,name,public_url,path,created_at')
        .order('created_at', { ascending: false })
        .limit(100)
      if (!mounted) return
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[Feed] homes fetch error', error.message)
        setHomes([])
      } else {
        // Normalize legacy rows and dedupe by canonical public URL.
        const seen = new Set<string>()
        const dedup = (data || []).filter((h) => {
          const publicUrl = toCanonicalGlbUrl(h.public_url, h.path)
          if (!publicUrl) return false
          if (seen.has(publicUrl)) return false
          seen.add(publicUrl)
          h.public_url = publicUrl
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
        const publicUrl = toCanonicalGlbUrl(h?.public_url || '', h?.path)
        if (!publicUrl) return
        // prepend if new unique URL
        setHomes((prev) => {
          if (prev.some((p) => p.public_url === publicUrl)) return prev
          return [{ ...h, public_url: publicUrl }, ...prev]
        })
      })
      .subscribe()

    return () => {
      mounted = false
      try { supabase.removeChannel(channel) } catch {}
    }
  }, [])

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
      <h1 className="sr-only">Feed</h1>

      {/* Quick Actions */}
      <section className="mb-10">
        <div className="grid gap-4 sm:grid-cols-3">
          {quickActions.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.title}
                onClick={() => navigate(action.path)}
                className={`group relative overflow-hidden rounded-2xl border ${action.borderColor} bg-gradient-to-br ${action.color} p-5 text-left transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.5)]`}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-white/[0.03] to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative">
                  <div className="mb-3 flex items-center justify-between">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 ${action.iconColor}`}>
                      <Icon className="size-5" />
                    </div>
                    <ArrowRight className="size-4 text-neutral-500 transition-all duration-300 group-hover:translate-x-0.5 group-hover:text-neutral-300" />
                  </div>
                  <h2 className="text-base font-semibold text-white">{action.title}</h2>
                  <p className="mt-1 text-sm leading-relaxed text-neutral-400">{action.description}</p>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* Recent Generation */}
      {(() => {
        try {
          const briefRaw = localStorage.getItem('genesis_architect_brief_v1')
          const draftRaw = localStorage.getItem('create_studio_draft_v1')
          const shellRaw = localStorage.getItem('genesis_shell_status_v1')
          if (!briefRaw || !draftRaw) return null
          const brief = JSON.parse(briefRaw)
          const draft = JSON.parse(draftRaw)
          const shell = shellRaw ? JSON.parse(shellRaw) : null
          const objectCount = draft?.objects?.length || 0
          const updatedAt = draft?.updatedAt || null
          const shellState = shell?.state || 'unknown'
          // Extract style from the brief program text
          const styleMatch = brief?.rationale?.match(/(?:single-story|multi-story)\s+(\w+[\s\w]*?)(?:\s+home)/i)
          const styleName = styleMatch ? styleMatch[1] : 'Custom'

          return (
            <section className="mb-8">
              <div className="mb-3 flex items-center gap-2">
                <Clock className="size-4 text-neutral-500" />
                <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider">Recent Generation</h2>
              </div>
              <button
                onClick={() => navigate('/start')}
                className="w-full group rounded-xl border border-[#a588ef]/20 bg-gradient-to-r from-[#a588ef]/8 to-purple-500/5 p-4 text-left transition-all duration-300 hover:border-[#a588ef]/35 hover:shadow-[0_10px_40px_-12px_rgba(165,136,239,0.15)]"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#a588ef]/15 border border-[#a588ef]/20">
                      <Sparkles className="size-5 text-[#a588ef]" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white">{styleName} Home</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-neutral-400">
                        <span>{objectCount} objects</span>
                        <span className="text-neutral-600">·</span>
                        <span className={shellState === 'ready' ? 'text-emerald-400' : shellState === 'pending' ? 'text-amber-400' : 'text-neutral-500'}>
                          {shellState === 'ready' ? '3D shell ready' : shellState === 'pending' ? 'Building shell…' : 'Templated mode'}
                        </span>
                        {updatedAt && (
                          <>
                            <span className="text-neutral-600">·</span>
                            <span>{timeAgo(updatedAt)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="size-4 text-neutral-500 transition-all duration-300 group-hover:translate-x-0.5 group-hover:text-[#a588ef]" />
                </div>
              </button>
            </section>
          )
        } catch {
          return null
        }
      })()}

      {/* Community Gallery */}
      <section>
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Community Gallery</h2>
            <p className="mt-0.5 text-sm text-neutral-400">Explore homes designed by the community</p>
          </div>
          {homes.length > 0 && (
            <button
              onClick={() => navigate('/viewer-upload')}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Upload className="size-3.5" />
              Upload
            </button>
          )}
        </div>

        {loading ? (
          <div className="relative min-h-[240px]">
            <div className="absolute inset-0 grid place-items-center">
              <div className="bg-black/10 rounded-lg p-1 border border-white/5 shadow-[0_0_12px_rgba(165,136,239,0.2)]">
                <LogoSpinner size={24} className="animate-spin-slow" />
              </div>
            </div>
          </div>
        ) : homes.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] py-16 px-6 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <Box className="size-6 text-neutral-500" />
            </div>
            <h3 className="text-base font-medium text-neutral-300">No homes yet</h3>
            <p className="mt-1 text-sm text-neutral-500 max-w-sm">
              Be the first to create or generate a home design and share it with the community.
            </p>
            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={() => navigate('/intake')}
                className="inline-flex items-center gap-2 rounded-lg btn-accent px-4 py-2 text-sm text-white shadow-[0_0_16px_rgba(165,136,239,0.2)]"
              >
                <Sparkles className="size-3.5" />
                Generate Home
              </button>
              <button
                onClick={() => navigate('/viewer-upload')}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-neutral-300 hover:bg-white/10"
              >
                <Upload className="size-3.5" />
                Upload GLB
              </button>
            </div>
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {homes.map((h) => (
              <li key={h.id} className="group relative rounded-xl border border-white/10 bg-neutral-900/60 overflow-hidden transition-all duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.5)]">
                <button
                  className="w-full text-left"
                  onClick={() => navigate(`/viewer-upload?glb=${encodeURIComponent(h.public_url)}`)}
                  title={`Open ${h.name}`}
                >
                  <div className="aspect-[4/3] bg-neutral-800 overflow-hidden">
                    <GLBThumb url={h.public_url} className="w-full h-full transition-transform duration-500 group-hover:scale-105" lazy />
                  </div>
                  <div className="p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-white truncate">{h.name}</span>
                      <Eye className="size-3.5 text-neutral-500 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                    </div>
                    {h.created_at && (
                      <span className="mt-1 block text-xs text-neutral-500">{timeAgo(h.created_at)}</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
