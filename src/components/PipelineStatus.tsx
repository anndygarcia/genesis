import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { pipelineHealth } from '../lib/genesis-api'

type Status = 'checking' | 'online' | 'offline'

export default function PipelineStatus() {
  const [status, setStatus] = useState<Status>('checking')
  const [hasBlender, setHasBlender] = useState(false)
  const [hasVlm, setHasVlm] = useState(false)

  useEffect(() => {
    let mounted = true
    const check = async () => {
      const res = await pipelineHealth()
      if (!mounted) return
      if (res.ok) {
        setStatus('online')
        setHasBlender(!!res.capabilities?.blender_shell)
        setHasVlm(!!(res.capabilities as any)?.vlm)
      } else {
        setStatus('offline')
      }
    }
    check()
    // Re-check every 30s
    const id = setInterval(check, 30_000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  if (status === 'checking') {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-neutral-400">
        <Activity className="size-3 animate-pulse" />
        <span>Pipeline…</span>
      </div>
    )
  }

  if (status === 'offline') {
    return (
      <div
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 cursor-help"
        title="Genesis pipeline is not reachable. Start it with: uvicorn pipeline.api.server:app --port 8787"
      >
        <AlertTriangle className="size-3" />
        <span>Pipeline offline</span>
      </div>
    )
  }

  const extras = [hasBlender && 'Blender', hasVlm && 'VLM'].filter(Boolean)

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/8 px-2.5 py-1 text-[11px] text-emerald-300 cursor-help"
      title={`Pipeline online${extras.length ? ` (${extras.join(', ')} available)` : ' (core only)'}`}
    >
      <CheckCircle2 className="size-3" />
      <span>Pipeline</span>
      {extras.length > 0 && <span className="text-emerald-400">+ {extras.join(' + ')}</span>}
    </div>
  )
}
