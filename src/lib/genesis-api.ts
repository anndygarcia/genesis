// Client for the Genesis pipeline (FastAPI backend in `pipeline/`).
//
// The pipeline runs the agentic stack: architect agent -> code/zoning agent
// -> style refs -> floorplan solver -> 3D shell -> renderer. For the v1
// MVP the backend returns a deterministic templated FloorPlan so the
// front-end integration can ship immediately; later steps swap in the
// real LLM + HouseDiffusion + Blender stages without touching this file.

import type { FloorPlan } from './floorplan'

export interface IntakeBasics {
  floors: number
  sqft: number
}

export interface IntakeRooms {
  beds: number
  baths: number
  garage: number
}

export interface IntakeStyle {
  archetype: string
  refs: string[]
}

export interface IntakeBudget {
  amount: number | null
}

export interface GenerateHouseRequest {
  basics: IntakeBasics
  rooms: IntakeRooms
  style: IntakeStyle
  budget: IntakeBudget
  notes: string
  /** Optional seed so the same intake produces the same plan. */
  seed?: number
  /** Optional lot info for site-aware variants once the agent supports it. */
  lot?: { width?: number; depth?: number; orientation?: number } | null
}

export type CodeSeverity = 'info' | 'warning' | 'error'

export interface CodeIssue {
  severity: CodeSeverity
  /** Short tag like `IRC-R310.1` so UIs can group / link to docs. */
  code: string
  message: string
  roomId?: string | null
  wallId?: string | null
  openingId?: string | null
}

/** Per-image VLM cues from the style-refs agent. Mirrors `pipeline/schemas.py::StyleCues`. */
export interface StyleCues {
  image_url?: string | null
  /** Normalized to a known archetype slug when possible. */
  archetype?: string | null
  /** What the VLM said verbatim. */
  archetype_raw?: string | null
  materials: string[]
  palette: string[]
  features: string[]
  mood?: string | null
  confidence: number
  error?: string | null
}

/** Aggregated style analysis. Mirrors `pipeline/schemas.py::StyleAnalysis`. */
export interface StyleAnalysis {
  refs: StyleCues[]
  archetype?: string | null
  materials: string[]
  palette: string[]
  features: string[]
  mood?: string | null
  backend?: string | null
  model?: string | null
  warnings: string[]
}

/** Provenance for refined plans. Mirrors `pipeline/schemas.py::IterationMeta`. */
export interface IterationMeta {
  iteration: number
  previous_job_id?: string | null
  previous_average_score?: number | null
  addressed_issues: string[]
}

export interface ArchitectBriefPayload {
  program: string
  rationale: string
  warnings: string[]
  codeIssues: CodeIssue[]
  /** VLM-extracted style cues from the user's uploaded reference images. */
  styleCues?: StyleAnalysis | null
  /** Set when this plan is the result of a /refine_plan call. */
  iteration?: IterationMeta | null
}

export interface GenerateHouseResponse {
  plan: FloorPlan
  brief: ArchitectBriefPayload
}

const RAW_BASE = (import.meta as any).env?.VITE_GENESIS_API_URL as string | undefined
const DEFAULT_BASE = 'http://127.0.0.1:8787'

function apiBase(): string {
  const raw = RAW_BASE && RAW_BASE.trim().length > 0 ? RAW_BASE.trim() : DEFAULT_BASE
  return raw.replace(/\/$/, '')
}

export class GenesisApiError extends Error {
  status: number
  body: string
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Genesis pipeline request failed: ${status}`)
    this.name = 'GenesisApiError'
    this.status = status
    this.body = body
  }
}

/**
 * Ask the pipeline to generate a whole-house FloorPlan from the intake form.
 * Returns the plan and a short architect brief that we can surface in the UI.
 */
export async function generateHouse(req: GenerateHouseRequest, init?: { signal?: AbortSignal }): Promise<GenerateHouseResponse> {
  const url = `${apiBase()}/generate_house`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: init?.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GenesisApiError(res.status, body)
  }
  const data = (await res.json()) as GenerateHouseResponse
  if (!data || !data.plan || data.plan.version !== 1) {
    throw new GenesisApiError(500, JSON.stringify(data), 'Pipeline returned an unexpected payload')
  }
  return data
}

/** Health check for the pipeline. Useful for surfacing connection status in the UI. */
export async function pipelineHealth(): Promise<{ ok: boolean; service?: string; version?: string; capabilities?: { blender_shell?: boolean } }> {
  try {
    const res = await fetch(`${apiBase()}/health`, { method: 'GET' })
    if (!res.ok) return { ok: false }
    return await res.json()
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// Shell build (Blender headless -> GLB)
// ---------------------------------------------------------------------------

export interface BuildShellRequest {
  plan: FloorPlan
  ridge_height?: number
  eave_overhang?: number
}

export interface BuildShellResponse {
  job_id: string
  /** URL relative to the pipeline base (e.g. `/artifacts/abc.../shell.glb`). */
  glb_url: string
  duration_s: number
  blender_bin: string
}

/** Build a 3D shell GLB from a FloorPlan via the Blender stage. */
export async function buildShell(req: BuildShellRequest, init?: { signal?: AbortSignal }): Promise<BuildShellResponse> {
  const url = `${apiBase()}/build_shell`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: init?.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GenesisApiError(res.status, body)
  }
  return (await res.json()) as BuildShellResponse
}

/** Convert a relative artifact URL into a fully-qualified URL the browser can fetch. */
export function resolveArtifactUrl(relative: string): string {
  if (/^https?:\/\//i.test(relative)) return relative
  const base = apiBase()
  return relative.startsWith('/') ? `${base}${relative}` : `${base}/${relative}`
}

// ---------------------------------------------------------------------------
// Cycles hero renders
// ---------------------------------------------------------------------------

export const HERO_VIEWS = [
  'exterior_front',
  'exterior_aerial',
  'interior_living',
  'interior_master',
] as const

export type HeroView = typeof HERO_VIEWS[number]

export interface RenderViewsRequest {
  plan: FloorPlan
  views?: HeroView[]
  samples?: number
  resolution?: [number, number]
  use_gpu?: boolean
  job_id?: string | null
}

export interface RenderedViewPayload {
  view: HeroView | string
  /** Relative artifact URL like `/artifacts/<job>/render_exterior_front.png`. */
  url: string
}

export interface RenderViewsResponse {
  job_id: string
  renders: RenderedViewPayload[]
  duration_s: number
  blender_bin: string
  samples: number
  resolution: [number, number]
}

/** Render the home from configurable camera angles using Blender Cycles. */
export async function renderViews(req: RenderViewsRequest, init?: { signal?: AbortSignal }): Promise<RenderViewsResponse> {
  const url = `${apiBase()}/render_views`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: init?.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GenesisApiError(res.status, body)
  }
  return (await res.json()) as RenderViewsResponse
}

// ---------------------------------------------------------------------------
// VLM render critique
// ---------------------------------------------------------------------------

/** Per-view critique. Mirrors `pipeline/schemas.py::RenderCritique`. */
export interface RenderCritique {
  view: string
  url?: string | null
  strengths: string[]
  issues: string[]
  suggestions: string[]
  /** 1-10. */
  score?: number | null
  /** One-liner verdict. */
  summary?: string | null
  error?: string | null
}

/** Aggregated render critique. Mirrors `pipeline/schemas.py::RendersCritique`. */
export interface RendersCritique {
  job_id: string
  critiques: RenderCritique[]
  average_score?: number | null
  overall_summary?: string | null
  backend?: string | null
  model?: string | null
  duration_s: number
  warnings: string[]
}

export interface CritiqueRendersRequest {
  job_id: string
  views?: HeroView[]
  max_tokens?: number
}

/** Run an architect-quality VLM critique against an existing set of hero renders. */
export async function critiqueRenders(
  req: CritiqueRendersRequest,
  init?: { signal?: AbortSignal },
): Promise<RendersCritique> {
  const url = `${apiBase()}/critique_renders`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: init?.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GenesisApiError(res.status, body)
  }
  return (await res.json()) as RendersCritique
}

// ---------------------------------------------------------------------------
// Autonomous refinement
// ---------------------------------------------------------------------------

export interface RefinePlanRequest {
  intake: GenerateHouseRequest
  previous_brief: ArchitectBriefPayload
  critique: RendersCritique
  iteration?: number
  /** Skip refinement when previous critique avg_score >= this. */
  min_score?: number
  /** Force refinement regardless of score gate. */
  force?: boolean
  previous_job_id?: string | null
}

export interface RefinePlanResponse {
  plan: FloorPlan | null
  brief: ArchitectBriefPayload | null
  refined: boolean
  iteration: number
  previous_average_score?: number | null
  skip_reason?: string | null
}

/** Re-run the architect with a previous brief + critique to produce a v2 plan. */
export async function refinePlan(
  req: RefinePlanRequest,
  init?: { signal?: AbortSignal },
): Promise<RefinePlanResponse> {
  const url = `${apiBase()}/refine_plan`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: init?.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GenesisApiError(res.status, body)
  }
  return (await res.json()) as RefinePlanResponse
}
