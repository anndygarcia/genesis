// Floating panel that surfaces the architect brief + code/zoning issues
// produced by the Genesis pipeline for the home currently loaded in
// CreateStudio. The panel is read-only and reads from localStorage so
// it stays decoupled from CreateStudio's internal state.
//
// Storage keys it reads:
//   genesis_floorplan_v1            - the FloorPlan returned by /generate_house
//   genesis_architect_brief_v1      - the ArchitectBrief (rationale + warnings + codeIssues)
//
// Both are written by IntakeForm when the user clicks "Generate Home".

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Box, Camera, CheckCircle2, ChevronDown, ChevronUp, Cpu, Download, Eye, History, Info, Loader2, MessageSquareQuote, RefreshCw, Sparkles, Star, X, XCircle } from 'lucide-react'
import type { ArchitectBriefPayload, BuildShellResponse, CodeIssue, CodeSeverity, GenerateHouseRequest, HeroView, RenderViewsResponse, RendersCritique } from '../lib/genesis-api'
import { buildShell, critiqueRenders, GenesisApiError, refinePlan, renderViews, resolveArtifactUrl } from '../lib/genesis-api'
import { stageFloorPlanForStudio } from '../lib/floorplan'
import type { FloorPlan } from '../lib/floorplan'
import { readStagedFloorPlan } from '../lib/floorplan'
import GenesisShellViewer from './GenesisShellViewer'

const BRIEF_KEY = 'genesis_architect_brief_v1'
const PANEL_DISMISSED_KEY = 'genesis_brief_dismissed_v1'
const SHELL_KEY = 'genesis_shell_v1'
const SHELL_STATUS_KEY = 'genesis_shell_status_v1'

type ShellState = 'idle' | 'pending' | 'ready' | 'failed'

interface ShellStatus {
  state: ShellState
  message?: string
}

interface PanelData {
  plan: FloorPlan | null
  brief: ArchitectBriefPayload | null
  shell: BuildShellResponse | null
  shellStatus: ShellStatus
}

function readBrief(): ArchitectBriefPayload | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(BRIEF_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.codeIssues ?? [])) {
      return {
        program: String(parsed.program ?? ''),
        rationale: String(parsed.rationale ?? ''),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
        codeIssues: Array.isArray(parsed.codeIssues) ? parsed.codeIssues : [],
        // Pass StyleAnalysis through verbatim if present; the schema is
        // forgiving on the front-end side so we don't need strict validation.
        styleCues: parsed.styleCues && typeof parsed.styleCues === 'object'
          ? parsed.styleCues
          : null,
      }
    }
  } catch {}
  return null
}

function readShell(): BuildShellResponse | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(SHELL_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.glb_url === 'string') return parsed as BuildShellResponse
  } catch {}
  return null
}

function readShellStatus(): ShellStatus {
  if (typeof localStorage === 'undefined') return { state: 'idle' }
  const raw = localStorage.getItem(SHELL_STATUS_KEY)
  if (!raw) return { state: 'idle' }
  try {
    const parsed = JSON.parse(raw)
    const state = parsed?.state as ShellState | undefined
    if (state === 'pending' || state === 'ready' || state === 'failed') {
      return { state, message: parsed?.message }
    }
  } catch {}
  return { state: 'idle' }
}

function readPanelData(): PanelData {
  return {
    plan: readStagedFloorPlan(),
    brief: readBrief(),
    shell: readShell(),
    shellStatus: readShellStatus(),
  }
}

function severityCounts(issues: CodeIssue[]): Record<CodeSeverity, number> {
  const counts: Record<CodeSeverity, number> = { error: 0, warning: 0, info: 0 }
  for (const i of issues) counts[i.severity] = (counts[i.severity] ?? 0) + 1
  return counts
}

const SEVERITY_STYLES: Record<CodeSeverity, { bg: string; border: string; text: string; Icon: typeof AlertTriangle }> = {
  error:   { bg: 'bg-red-500/10',    border: 'border-red-500/40',    text: 'text-red-300',    Icon: XCircle },
  warning: { bg: 'bg-amber-500/10',  border: 'border-amber-500/40',  text: 'text-amber-300',  Icon: AlertTriangle },
  info:    { bg: 'bg-sky-500/10',    border: 'border-sky-500/40',    text: 'text-sky-300',    Icon: Info },
}

function formatSource(source: string): { label: string; isLLM: boolean } {
  // Source looks like "llm:qwen/qwen-2.5-72b-instruct+templated_v1" or "rules+templated_v1".
  if (source.startsWith('llm:')) {
    const model = source.slice(4).split('+')[0]
    return { label: model, isLLM: true }
  }
  if (source.startsWith('llm+')) return { label: 'LLM (model unknown)', isLLM: true }
  return { label: 'Deterministic rules', isLLM: false }
}

type RenderState = 'idle' | 'pending' | 'ready' | 'failed'

const VIEW_LABELS: Record<HeroView, string> = {
  exterior_front:   'Exterior · Front',
  exterior_aerial:  'Exterior · Aerial',
  interior_living:  'Interior · Living',
  interior_master:  'Interior · Master',
}

export default function GenesisBriefPanel() {
  const [data, setData] = useState<PanelData>(() => readPanelData())
  const [expanded, setExpanded] = useState<boolean>(true)
  const [shellViewerOpen, setShellViewerOpen] = useState<boolean>(false)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(PANEL_DISMISSED_KEY) === '1'
  })
  // Render-views state. Kept local (not persisted) because renders are
  // ephemeral artifacts and the panel is per-session anyway.
  const [renderState, setRenderState] = useState<RenderState>('idle')
  const [renderResult, setRenderResult] = useState<RenderViewsResponse | null>(null)
  const [renderError, setRenderError] = useState<string>('')
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  // VLM critique state for the rendered hero views.
  const [critiqueState, setCritiqueState] = useState<RenderState>('idle')
  const [critique, setCritique] = useState<RendersCritique | null>(null)
  const [critiqueError, setCritiqueError] = useState<string>('')
  const [expandedCritique, setExpandedCritique] = useState<string | null>(null)
  // Autonomous refinement state.
  const [refineState, setRefineState] = useState<RenderState>('idle')
  const [refineError, setRefineError] = useState<string>('')
  const [refineSkipReason, setRefineSkipReason] = useState<string>('')

  const handleCritique = async (jobId: string, views?: HeroView[]) => {
    if (critiqueState === 'pending') return
    setCritiqueState('pending')
    setCritiqueError('')
    try {
      const res = await critiqueRenders({ job_id: jobId, views, max_tokens: 500 })
      setCritique(res)
      setCritiqueState('ready')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[critique_renders] failed', err)
      const msg = err instanceof GenesisApiError
        ? `${err.status}: ${err.body?.slice(0, 200) || 'pipeline error'}`
        : err instanceof Error
          ? err.message
          : 'Unknown error'
      setCritiqueError(msg)
      setCritiqueState('failed')
    }
  }

  const handleRefine = async () => {
    if (refineState === 'pending') return
    if (!brief || !critique) return

    let intake: GenerateHouseRequest | null = null
    try {
      const raw = localStorage.getItem('genesis_intake_v1')
      if (raw) intake = JSON.parse(raw)
    } catch {}
    if (!intake) {
      setRefineError('Original intake not found in storage. Re-generate from the intake form first.')
      setRefineState('failed')
      return
    }

    const previousIteration = brief.iteration?.iteration ?? 1
    const nextIteration = previousIteration + 1
    setRefineState('pending')
    setRefineError('')
    setRefineSkipReason('')

    try {
      const res = await refinePlan({
        intake,
        previous_brief: brief,
        critique,
        iteration: nextIteration,
        previous_job_id: renderResult?.job_id ?? null,
        // Always force refinement when the user clicks the button -- the
        // score-gate is for headless / scripted callers, not interactive
        // users who explicitly asked for a v2.
        force: true,
      })

      if (!res.refined || !res.plan || !res.brief) {
        setRefineSkipReason(res.skip_reason || 'Refinement skipped.')
        setRefineState('ready')
        return
      }

      // Stage the refined plan + brief just like IntakeForm does after
      // a fresh generate, so the editor and the BriefPanel pick them up
      // through their existing storage poller.
      stageFloorPlanForStudio(res.plan)
      try {
        localStorage.setItem(BRIEF_KEY, JSON.stringify(res.brief))
        localStorage.removeItem(PANEL_DISMISSED_KEY)
        // Reset the shell + critique surfaces -- the user is now looking
        // at a v2 plan, so previous renders/critique are stale.
        localStorage.setItem(SHELL_STATUS_KEY, JSON.stringify({
          state: 'pending', startedAt: new Date().toISOString(),
        }))
        localStorage.removeItem(SHELL_KEY)
      } catch {}

      // Reset in-memory render/critique state -- the user can re-render
      // and re-critique against the new shell once it's built.
      setRenderResult(null)
      setRenderState('idle')
      setRenderError('')
      setCritique(null)
      setCritiqueState('idle')
      setCritiqueError('')
      setRefineState('ready')

      // Fire-and-forget the new shell build, mirroring IntakeForm.
      void buildShell({ plan: res.plan }).then((shellRes) => {
        try {
          localStorage.setItem(SHELL_KEY, JSON.stringify(shellRes))
          localStorage.setItem(SHELL_STATUS_KEY, JSON.stringify({
            state: 'ready', updatedAt: new Date().toISOString(),
          }))
        } catch {}
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[refine] background shell build failed', err)
        try {
          localStorage.setItem(SHELL_STATUS_KEY, JSON.stringify({
            state: 'failed',
            updatedAt: new Date().toISOString(),
            message: err instanceof GenesisApiError
              ? `${err.status}: ${err.body?.slice(0, 240) || 'pipeline error'}`
              : (err instanceof Error ? err.message : 'unknown error'),
          }))
        } catch {}
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[refine_plan] failed', err)
      const msg = err instanceof GenesisApiError
        ? `${err.status}: ${err.body?.slice(0, 200) || 'pipeline error'}`
        : err instanceof Error
          ? err.message
          : 'Unknown error'
      setRefineError(msg)
      setRefineState('failed')
    }
  }

  const handleRender = async (plan: FloorPlan, jobId?: string) => {
    if (renderState === 'pending') return
    setRenderState('pending')
    setRenderError('')
    try {
      const res = await renderViews({
        plan,
        job_id: jobId ?? null,
        samples: 32,
        resolution: [1280, 720],
      })
      setRenderResult(res)
      setRenderState('ready')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[render_views] failed', err)
      const msg = err instanceof GenesisApiError
        ? `${err.status}: ${err.body?.slice(0, 200) || 'pipeline error'}`
        : err instanceof Error
          ? err.message
          : 'Unknown error'
      setRenderError(msg)
      setRenderState('failed')
    }
  }

  // Refresh from localStorage whenever another tab updates the keys, and
  // poll lightly so an in-tab regeneration / background shell build shows
  // up (we don't dispatch a synthetic storage event from IntakeForm; this
  // keeps coupling minimal).
  useEffect(() => {
    const refresh = () => setData(readPanelData())
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === BRIEF_KEY
        || e.key === 'genesis_floorplan_v1'
        || e.key === SHELL_KEY
        || e.key === SHELL_STATUS_KEY
      ) refresh()
    }
    window.addEventListener('storage', onStorage)
    const id = window.setInterval(refresh, 1500)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.clearInterval(id)
    }
  }, [])

  const { plan, brief, shell, shellStatus } = data
  const counts = useMemo(() => severityCounts(brief?.codeIssues ?? []), [brief])
  const source = plan ? formatSource(plan.meta.source ?? 'rules+templated_v1') : null
  const totalIssues = (brief?.codeIssues ?? []).length

  // Hide the panel entirely if there's nothing to show or the user dismissed it.
  if (dismissed || (!plan && !brief)) return null

  const headerBadgeText = totalIssues === 0
    ? 'All clear'
    : `${counts.error}E · ${counts.warning}W · ${counts.info}I`

  const headerBadgeClass = totalIssues === 0
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : counts.error > 0
      ? 'border-red-500/40 bg-red-500/10 text-red-300'
      : counts.warning > 0
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : 'border-sky-500/40 bg-sky-500/10 text-sky-300'

  return (
    <>
      {shellViewerOpen && shell && (
        <GenesisShellViewer glbUrl={shell.glb_url} onClose={() => setShellViewerOpen(false)} />
      )}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setLightboxUrl(null) }}
            className="absolute right-4 top-4 rounded-md border border-white/10 bg-neutral-900/80 p-2 text-neutral-200 hover:bg-white/10"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
          <a
            href={lightboxUrl}
            download
            onClick={(e) => e.stopPropagation()}
            className="absolute right-16 top-4 inline-flex items-center gap-1 rounded-md border border-white/10 bg-neutral-900/80 px-3 py-2 text-xs text-neutral-200 hover:bg-white/10"
          >
            <Download className="size-3.5" /> PNG
          </a>
          <img
            src={lightboxUrl}
            alt="Render preview"
            className="max-h-[92vh] max-w-[96vw] object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
      <div className="pointer-events-none absolute right-3 top-3 z-30 w-[360px] max-w-[calc(100vw-1.5rem)]">
      <div className="pointer-events-auto rounded-2xl border border-white/10 bg-neutral-950/85 shadow-2xl backdrop-blur-xl overflow-hidden">
        {/* Header */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <Sparkles className="size-4 text-[#a588ef]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white truncate">
              {plan ? `${capitalize(plan.meta.style)} · ${Math.round(plan.meta.sqft)} sqft` : 'Generated Home'}
            </div>
            <div className="text-[11px] text-neutral-400 truncate">
              {plan ? `${plan.rooms.length} rooms · ${plan.walls.length} walls · ${plan.openings.length} openings` : 'Architect brief'}
            </div>
          </div>
          <div className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-mono ${headerBadgeClass}`}>
            {headerBadgeText}
          </div>
          {expanded ? <ChevronUp className="size-4 text-neutral-400" /> : <ChevronDown className="size-4 text-neutral-400" />}
          <span
            role="button"
            tabIndex={0}
            aria-label="Dismiss panel"
            onClick={(e) => {
              e.stopPropagation()
              setDismissed(true)
              try { localStorage.setItem(PANEL_DISMISSED_KEY, '1') } catch {}
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setDismissed(true)
                try { localStorage.setItem(PANEL_DISMISSED_KEY, '1') } catch {}
              }
            }}
            className="ml-1 -mr-1 rounded p-1 text-neutral-500 hover:bg-white/10 hover:text-neutral-200 cursor-pointer"
          >
            <X className="size-3.5" />
          </span>
        </button>

        {expanded && (
          <div className="max-h-[70vh] overflow-y-auto border-t border-white/10 p-3 space-y-3 text-sm text-neutral-200">
            {/* Source line */}
            {source && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
                <Cpu className="size-3.5" />
                <span>Architect:</span>
                <span className={source.isLLM ? 'text-[#a588ef]' : 'text-neutral-300'}>{source.label}</span>
                {/* Iteration provenance: shown only when this plan is a refinement. */}
                {brief?.iteration && brief.iteration.iteration > 1 && (
                  <span
                    className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                    title={
                      brief.iteration.previous_average_score != null
                        ? `Refined from v${brief.iteration.iteration - 1} (prev avg score ${brief.iteration.previous_average_score.toFixed(1)})`
                        : `Refined from v${brief.iteration.iteration - 1}`
                    }
                  >
                    <History className="size-3" />
                    v{brief.iteration.iteration}
                    {brief.iteration.previous_average_score != null && (
                      <span className="text-neutral-400">
                        · prev {brief.iteration.previous_average_score.toFixed(1)}/10
                      </span>
                    )}
                  </span>
                )}
              </div>
            )}

            {/* Addressed issues from the previous critique, when refining. */}
            {brief?.iteration && brief.iteration.addressed_issues.length > 0 && (
              <section>
                <h3 className="mb-1 text-[10px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
                  Addressed in v{brief.iteration.iteration}
                </h3>
                <ul className="space-y-1 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px] text-neutral-200">
                  {brief.iteration.addressed_issues.map((issue, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-amber-400/80">→</span>
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* VLM-extracted style cues from uploaded reference images */}
            {brief?.styleCues && (() => {
              const cues = brief.styleCues!
              const successful = cues.refs.filter((r) => !r.error)
              const failed = cues.refs.filter((r) => r.error)
              const hasAggregate = !!(cues.archetype || cues.materials.length || cues.palette.length || cues.features.length || cues.mood)
              return (
                <section>
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="text-[10px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
                      Style Cues
                    </h3>
                    {cues.backend && (
                      <span className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400">
                        <Eye className="size-3" /> {cues.backend}{cues.model ? ` · ${cues.model}` : ''}
                      </span>
                    )}
                  </div>

                  {!hasAggregate && successful.length === 0 && (
                    <div className="text-[11px] text-neutral-500">
                      Uploaded {cues.refs.length} reference{cues.refs.length === 1 ? '' : 's'}, but no cues were extracted.
                      {failed.length > 0 && ` ${failed.length} failed.`}
                    </div>
                  )}

                  {hasAggregate && (
                    <div className="space-y-1.5 rounded-md border border-[#a588ef]/30 bg-[#a588ef]/5 px-2.5 py-2">
                      {cues.archetype && (
                        <div className="flex items-baseline gap-2 text-[11px]">
                          <span className="w-16 shrink-0 text-neutral-500">archetype</span>
                          <span className="font-medium text-[#cdb6ff]">{cues.archetype}</span>
                        </div>
                      )}
                      {cues.materials.length > 0 && (
                        <div className="flex items-baseline gap-2 text-[11px]">
                          <span className="w-16 shrink-0 text-neutral-500">materials</span>
                          <div className="flex flex-wrap gap-1">
                            {cues.materials.map((m) => (
                              <span key={m} className="rounded bg-white/5 px-1.5 py-0.5 text-neutral-200">{m}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {cues.palette.length > 0 && (
                        <div className="flex items-baseline gap-2 text-[11px]">
                          <span className="w-16 shrink-0 text-neutral-500">palette</span>
                          <div className="flex flex-wrap gap-1">
                            {cues.palette.map((c) => (
                              <span key={c} className="rounded bg-white/5 px-1.5 py-0.5 text-neutral-200">{c}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {cues.features.length > 0 && (
                        <div className="flex items-baseline gap-2 text-[11px]">
                          <span className="w-16 shrink-0 text-neutral-500">features</span>
                          <div className="flex flex-wrap gap-1">
                            {cues.features.map((f) => (
                              <span key={f} className="rounded bg-white/5 px-1.5 py-0.5 text-neutral-200">{f}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {cues.mood && (
                        <div className="flex items-baseline gap-2 text-[11px]">
                          <span className="w-16 shrink-0 text-neutral-500">mood</span>
                          <span className="text-neutral-200 italic">{cues.mood}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Per-reference thumbnail strip */}
                  {cues.refs.length > 0 && (
                    <ul className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
                      {cues.refs.map((r, i) => (
                        <li
                          key={`${r.image_url ?? i}`}
                          className={`relative shrink-0 overflow-hidden rounded-md border ${r.error ? 'border-amber-500/40' : 'border-white/10'} bg-neutral-900`}
                          title={r.error ? `Failed: ${r.error}` : (r.archetype_raw || r.archetype || 'analyzed')}
                        >
                          {r.image_url ? (
                            <img
                              src={r.image_url}
                              alt={`Reference ${i + 1}`}
                              loading="lazy"
                              className="size-14 object-cover"
                            />
                          ) : (
                            <div className="flex size-14 items-center justify-center text-[10px] text-neutral-500">
                              ref {i + 1}
                            </div>
                          )}
                          {r.error && (
                            <div className="absolute inset-x-0 bottom-0 bg-amber-500/80 text-center text-[9px] text-amber-50">
                              failed
                            </div>
                          )}
                          {!r.error && r.archetype && (
                            <div className="absolute inset-x-0 bottom-0 bg-black/70 text-center text-[9px] text-neutral-200 truncate">
                              {r.archetype}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )
            })()}

            {/* Photoreal shell status */}
            <section>
              <h3 className="mb-1 text-[10px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">Photoreal Shell</h3>
              {shellStatus.state === 'pending' && (
                <div className="flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-2.5 py-2 text-sky-300">
                  <Loader2 className="size-4 animate-spin" />
                  <span className="text-xs">Building 3D shell in Blender…</span>
                </div>
              )}
              {shellStatus.state === 'failed' && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-amber-300">
                  <div className="flex items-center gap-2 text-xs">
                    <AlertTriangle className="size-4" />
                    <span>Shell build failed.</span>
                  </div>
                  {shellStatus.message && (
                    <div className="mt-1 text-[11px] text-amber-200/80 break-words">{shellStatus.message}</div>
                  )}
                  <div className="mt-1 text-[11px] text-neutral-400">
                    Install Blender 3.6+ and set <code className="text-neutral-300">GENESIS_BLENDER_BIN</code> if it isn't on PATH.
                  </div>
                </div>
              )}
              {shellStatus.state === 'ready' && shell && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2 text-emerald-200">
                  <div className="flex items-center gap-2 text-xs">
                    <Box className="size-4" />
                    <span>Shell ready · {shell.duration_s.toFixed(1)}s</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShellViewerOpen(true)}
                    className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20"
                  >
                    View 3D
                  </button>
                </div>
              )}
              {shellStatus.state === 'idle' && (
                <div className="text-[11px] text-neutral-500">
                  No shell built yet. Click <span className="text-neutral-300">Generate Home</span> on the intake to start one.
                </div>
              )}
            </section>

            {/* Hero renders (Cycles) */}
            {plan && (
              <section>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="text-[10px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">Hero Renders</h3>
                  <div className="flex items-center gap-1">
                    {/* Refine button: only after a critique exists.
                        Triggers a v{N+1} architect pass that addresses the
                        recurring issues, then auto-rebuilds the shell. */}
                    {critiqueState === 'ready' && critique && refineState !== 'pending' && (
                      <button
                        type="button"
                        onClick={handleRefine}
                        className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/20"
                        title="Re-run the architect to address the critique findings (produces v{n+1})"
                      >
                        <RefreshCw className="size-3.5" />
                        Refine
                      </button>
                    )}
                    {/* Critique button: only relevant once renders exist. */}
                    {renderState === 'ready' && renderResult?.job_id && critiqueState !== 'pending' && (
                      <button
                        type="button"
                        onClick={() => handleCritique(renderResult.job_id)}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20"
                        title="Run an architect-quality VLM critique on the renders"
                      >
                        <MessageSquareQuote className="size-3.5" />
                        {critiqueState === 'ready' ? 'Re-critique' : 'Critique'}
                      </button>
                    )}
                    {renderState !== 'pending' && shellStatus.state !== 'failed' && (
                      <button
                        type="button"
                        onClick={() => handleRender(plan, shell?.job_id)}
                        className="inline-flex items-center gap-1 rounded-md border border-[#a588ef]/40 bg-[#a588ef]/10 px-2 py-0.5 text-[11px] font-medium text-[#a588ef] hover:bg-[#a588ef]/20"
                        title="Render 4 photoreal views via Cycles"
                      >
                        <Camera className="size-3.5" />
                        {renderState === 'ready' ? 'Re-render' : 'Render'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Refinement status banner sits at the top of the section so
                    the user can see the loop progressing without scrolling. */}
                {refineState === 'pending' && (
                  <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-amber-200">
                    <Loader2 className="size-4 animate-spin" />
                    <span className="text-xs">Architect refining design (v{(brief?.iteration?.iteration ?? 1) + 1})…</span>
                  </div>
                )}
                {refineState === 'failed' && refineError && (
                  <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-amber-300">
                    <div className="flex items-center gap-2 text-xs">
                      <AlertTriangle className="size-4" />
                      <span>Refinement failed.</span>
                    </div>
                    <div className="mt-1 text-[11px] text-amber-200/80 break-words">{refineError}</div>
                  </div>
                )}
                {refineState === 'ready' && refineSkipReason && (
                  <div className="mb-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-2.5 py-2 text-[11px] text-sky-200">
                    <div className="flex items-center gap-2 text-xs text-sky-300">
                      <Info className="size-3.5" />
                      <span>Refinement skipped</span>
                    </div>
                    <div className="mt-1 text-sky-200/80 break-words">{refineSkipReason}</div>
                  </div>
                )}

                {renderState === 'idle' && (
                  <div className="text-[11px] text-neutral-500">
                    Render 4 photoreal Cycles views (front, aerial, living, master). Takes ~1–3 min on CPU; faster with GPU.
                  </div>
                )}

                {renderState === 'pending' && (
                  <div className="flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-2.5 py-2 text-sky-300">
                    <Loader2 className="size-4 animate-spin" />
                    <span className="text-xs">Rendering Cycles views — this can take a few minutes…</span>
                  </div>
                )}

                {renderState === 'failed' && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-amber-300">
                    <div className="flex items-center gap-2 text-xs">
                      <AlertTriangle className="size-4" />
                      <span>Render failed.</span>
                    </div>
                    {renderError && (
                      <div className="mt-1 text-[11px] text-amber-200/80 break-words">{renderError}</div>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRender(plan, shell?.job_id)}
                      className="mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/20"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {renderState === 'ready' && renderResult && (
                  <div className="space-y-2">
                    <div className="text-[11px] text-neutral-400">
                      {renderResult.renders.length} views · {renderResult.duration_s.toFixed(1)}s · {renderResult.samples} samples · {renderResult.resolution[0]}×{renderResult.resolution[1]}
                    </div>
                    <ul className="grid grid-cols-2 gap-1.5">
                      {renderResult.renders.map((r) => {
                        const fullUrl = resolveArtifactUrl(r.url)
                        const label = VIEW_LABELS[r.view as HeroView] ?? r.view
                        return (
                          <li key={r.url} className="group relative overflow-hidden rounded-md border border-white/10 bg-neutral-900">
                            <button
                              type="button"
                              onClick={() => setLightboxUrl(fullUrl)}
                              className="block w-full"
                              title={label}
                            >
                              <img
                                src={fullUrl}
                                alt={label}
                                loading="lazy"
                                className="h-24 w-full object-cover transition group-hover:opacity-90"
                              />
                            </button>
                            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-1.5 pt-3 pb-1 text-[10px] text-neutral-200">
                              <span className="truncate">{label}</span>
                              <a
                                href={fullUrl}
                                download
                                onClick={(e) => e.stopPropagation()}
                                className="rounded p-0.5 text-neutral-300 hover:bg-white/10 hover:text-white"
                                title="Download PNG"
                              >
                                <Download className="size-3" />
                              </a>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}

                {/* VLM critique panel — appears under the thumbnails once
                    renders exist and the user clicks Critique. */}
                {critiqueState === 'pending' && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2 text-emerald-300">
                    <Loader2 className="size-4 animate-spin" />
                    <span className="text-xs">Architect critique in progress…</span>
                  </div>
                )}

                {critiqueState === 'failed' && (
                  <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-amber-300">
                    <div className="flex items-center gap-2 text-xs">
                      <AlertTriangle className="size-4" />
                      <span>Critique failed.</span>
                    </div>
                    {critiqueError && (
                      <div className="mt-1 text-[11px] text-amber-200/80 break-words">{critiqueError}</div>
                    )}
                    {renderResult?.job_id && (
                      <button
                        type="button"
                        onClick={() => handleCritique(renderResult.job_id)}
                        className="mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/20"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                )}

                {critiqueState === 'ready' && critique && (() => {
                  const successful = critique.critiques.filter((c) => !c.error)
                  const allEmpty = successful.length === 0
                  return (
                    <div className="mt-2 space-y-2">
                      {/* Header: aggregate score + backend badge */}
                      <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5">
                        <div className="flex items-center gap-2 text-emerald-200">
                          <Star className="size-4" />
                          {critique.average_score != null ? (
                            <span className="text-sm font-semibold">{critique.average_score.toFixed(1)}<span className="text-[11px] text-emerald-300/80">/10</span></span>
                          ) : (
                            <span className="text-xs">no score</span>
                          )}
                          <span className="text-[11px] text-neutral-400">· {successful.length}/{critique.critiques.length} views · {critique.duration_s.toFixed(1)}s</span>
                        </div>
                        {critique.backend && (
                          <span className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400">
                            <Eye className="size-3" /> {critique.backend}{critique.model ? ` · ${critique.model}` : ''}
                          </span>
                        )}
                      </div>

                      {/* Overall summary */}
                      {critique.overall_summary && (
                        <div className="rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] leading-relaxed text-neutral-300">
                          {critique.overall_summary}
                        </div>
                      )}

                      {allEmpty && critique.warnings.length > 0 && (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-300">
                          {critique.warnings[0]}
                        </div>
                      )}

                      {/* Per-view critique cards (collapsible) */}
                      {critique.critiques.map((c) => {
                        const isOpen = expandedCritique === c.view
                        const tone = c.error
                          ? 'border-amber-500/40 bg-amber-500/5'
                          : (c.score != null && c.score < 5.5)
                            ? 'border-red-500/30 bg-red-500/5'
                            : 'border-white/10 bg-white/[0.02]'
                        return (
                          <div key={c.view} className={`rounded-md border ${tone}`}>
                            <button
                              type="button"
                              onClick={() => setExpandedCritique(isOpen ? null : c.view)}
                              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.03]"
                            >
                              <span className="text-[11px] font-medium text-neutral-200 capitalize">
                                {c.view.replace(/_/g, ' ')}
                              </span>
                              {c.error ? (
                                <span className="text-[10px] text-amber-300">failed</span>
                              ) : c.score != null ? (
                                <span className="ml-auto text-[11px] font-semibold text-emerald-300">{c.score.toFixed(1)}<span className="text-[10px] text-neutral-500">/10</span></span>
                              ) : null}
                              {!c.error && c.summary && !isOpen && (
                                <span className="ml-2 truncate text-[10px] text-neutral-400 max-w-[180px]">{c.summary}</span>
                              )}
                              {isOpen ? <ChevronUp className="size-3 text-neutral-500" /> : <ChevronDown className="size-3 text-neutral-500" />}
                            </button>
                            {isOpen && (
                              <div className="border-t border-white/5 px-2.5 py-2 space-y-1.5 text-[11px]">
                                {c.error && (
                                  <div className="text-amber-300/90 break-words">{c.error}</div>
                                )}
                                {!c.error && c.summary && (
                                  <div className="text-neutral-300 italic">{c.summary}</div>
                                )}
                                {c.strengths.length > 0 && (
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-0.5">Strengths</div>
                                    <ul className="list-disc pl-4 text-neutral-300 space-y-0.5">
                                      {c.strengths.map((s, i) => <li key={i}>{s}</li>)}
                                    </ul>
                                  </div>
                                )}
                                {c.issues.length > 0 && (
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-red-400/80 mb-0.5">Issues</div>
                                    <ul className="list-disc pl-4 text-neutral-300 space-y-0.5">
                                      {c.issues.map((s, i) => <li key={i}>{s}</li>)}
                                    </ul>
                                  </div>
                                )}
                                {c.suggestions.length > 0 && (
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-sky-400/80 mb-0.5">Suggestions</div>
                                    <ul className="list-disc pl-4 text-neutral-300 space-y-0.5">
                                      {c.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </section>
            )}

            {/* Rationale */}
            {brief?.rationale && (
              <section>
                <h3 className="mb-1 text-[10px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">Rationale</h3>
                <p className="text-sm leading-relaxed text-neutral-200 whitespace-pre-wrap">{brief.rationale}</p>
              </section>
            )}

            {/* Program */}
            {brief?.program && (
              <section>
                <h3 className="mb-1 text-[10px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">Program</h3>
                <pre className="text-xs leading-snug text-neutral-300 whitespace-pre-wrap font-mono">{brief.program}</pre>
              </section>
            )}

            {/* Code issues */}
            <section>
              <h3 className="mb-1 flex items-center gap-2 text-[10px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">
                Code Review
                <span className="font-mono text-[10px] tracking-normal text-neutral-500">IRC 2021</span>
              </h3>
              {totalIssues === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2 text-emerald-300">
                  <CheckCircle2 className="size-4" />
                  <span className="text-xs">No issues detected by deterministic IRC checks.</span>
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {(brief?.codeIssues ?? []).map((issue, idx) => {
                    const style = SEVERITY_STYLES[issue.severity]
                    const Icon = style.Icon
                    return (
                      <li
                        key={`${issue.code}-${idx}`}
                        className={`rounded-md border ${style.border} ${style.bg} px-2.5 py-2`}
                      >
                        <div className="flex items-start gap-2">
                          <Icon className={`mt-0.5 size-4 shrink-0 ${style.text}`} />
                          <div className="flex-1 min-w-0">
                            <div className={`flex items-center gap-2 text-[11px] font-mono ${style.text}`}>
                              <span>{issue.code}</span>
                              <span className="uppercase tracking-wider opacity-70">{issue.severity}</span>
                            </div>
                            <div className="mt-0.5 text-xs leading-snug text-neutral-200">{issue.message}</div>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {/* Warnings (architect repair notes, fallback messages, etc.) */}
            {brief?.warnings && brief.warnings.length > 0 && (
              <section>
                <h3 className="mb-1 text-[10px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">Notes</h3>
                <ul className="space-y-1 text-xs text-neutral-400">
                  {brief.warnings.map((w, i) => (
                    <li key={i} className="rounded-md border border-white/5 bg-white/5 px-2 py-1.5">{w}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
      </div>
    </>
  )
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
