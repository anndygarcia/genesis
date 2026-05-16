// Shared FloorPlan schema for Genesis. Mirrors pipeline/schemas.py on the
// backend. The schema is the contract between the Python agentic pipeline
// (architect agent + floorplan solver) and the React 3D editor.
//
// Coordinate system: meters, right-handed, +Y up. The XZ plane is the floor.
// Rooms are axis-aligned rectangles for v1. Walls are explicit so we can
// extrude them with openings; furniture is placed in world coordinates.

export type Vec2 = { x: number; z: number }

export type RoomKind =
  | 'living_room'
  | 'bedroom'
  | 'master_bedroom'
  | 'kitchen'
  | 'dining_room'
  | 'bathroom'
  | 'office'
  | 'garage'
  | 'hallway'
  | 'laundry'
  | 'closet'
  | 'entry'

export interface Room {
  id: string
  kind: RoomKind
  name: string
  /** AABB min corner in meters (XZ plane). */
  min: Vec2
  /** AABB max corner in meters (XZ plane). */
  max: Vec2
  /** 0 = ground floor, 1 = upper, etc. */
  level: number
  /** Floor-to-ceiling height in meters. */
  ceilingHeight: number
}

export interface Wall {
  id: string
  a: Vec2
  b: Vec2
  level: number
  height: number
  thickness: number
  /** Exterior walls get the facade material; interior walls are partitions. */
  exterior: boolean
}

export type OpeningKind = 'door' | 'window' | 'garage_door'

export interface Opening {
  id: string
  wallId: string
  kind: OpeningKind
  /** Distance along the wall from `a` toward `b`, in meters. */
  offset: number
  width: number
  height: number
  /** Distance from finished floor to the bottom of the opening. */
  sill: number
}

export interface FurnitureItem {
  id: string
  /** A free-form kind tag like 'bed', 'sofa', 'desk' used for asset retrieval. */
  kind: string
  name: string
  roomId: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  color?: string
  /** When set, the Blender shell builder imports this GLB instead of the parametric primitive. */
  assetPath?: string | null
  /** Catalog id for traceability and editor display. */
  assetId?: string | null
}

export interface FloorPlanMeta {
  style: string
  sqft: number
  floors: number
  generatedAt: string
  seed: number
  source?: string
}

export interface FloorPlan {
  version: 1
  meta: FloorPlanMeta
  rooms: Room[]
  walls: Wall[]
  openings: Opening[]
  furniture: FurnitureItem[]
}

// ---------------------------------------------------------------------------
// Conversion: FloorPlan -> StudioObject[] (the format CreateStudio renders)
// ---------------------------------------------------------------------------
//
// CreateStudio currently models the world as a flat list of primitive
// objects (`box`, `wall`, `door`, `window`) with center position, scale, and
// rotation. We translate the FloorPlan into that representation so generated
// houses appear immediately in the existing 3D editor with no engine
// changes required.

export type StudioPrimitiveKind = 'box' | 'wall' | 'door' | 'window'

export interface StudioObject {
  id: string
  kind: StudioPrimitiveKind
  name: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  color: string
  opacity: number
  roughness: number
  metalness: number
}

const STYLE_PALETTES: Record<string, { wall: string; floor: string; accent: string; warm: string }> = {
  modern:        { wall: '#e8e8e8', floor: '#3a3a3a', accent: '#9aa0a6', warm: '#b78b62' },
  farmhouse:     { wall: '#f3eee3', floor: '#6b4a2b', accent: '#d4c1a3', warm: '#a06a3a' },
  mediterranean: { wall: '#f1e4cf', floor: '#a05a35', accent: '#cf9b6c', warm: '#c97c4a' },
  spanish:       { wall: '#efe1c8', floor: '#8a3a1d', accent: '#c69767', warm: '#b35f33' },
  barndominium:  { wall: '#cfcfcf', floor: '#4a4a4a', accent: '#8c8c8c', warm: '#a58057' },
  'log-cabin':   { wall: '#a87446', floor: '#5b3a1f', accent: '#8a5a30', warm: '#c69a6c' },
  'ranch-house': { wall: '#ead9bc', floor: '#7a5934', accent: '#caa478', warm: '#b3854b' },
  victorian:     { wall: '#dcd0e0', floor: '#3f2a3a', accent: '#a787a3', warm: '#8a5e76' },
  contemporary:  { wall: '#ededed', floor: '#2f2f2f', accent: '#a6a6a6', warm: '#9c7a52' },
}

function paletteFor(style: string) {
  return STYLE_PALETTES[style.toLowerCase()] ?? STYLE_PALETTES.modern
}

/** Room-type-specific floor colors for visual differentiation in the editor. */
const ROOM_FLOOR_COLORS: Record<RoomKind, string> = {
  living_room:    '#5a7a6b',  // sage green
  kitchen:        '#8a7a52',  // warm gold
  dining_room:    '#7a6a52',  // warm brown
  master_bedroom: '#6a5a7a',  // muted purple
  bedroom:        '#5a6a7a',  // steel blue
  bathroom:       '#4a7a8a',  // teal
  office:         '#6a7a5a',  // olive
  garage:         '#5a5a5a',  // slate
  hallway:        '#6a6a6a',  // neutral
  laundry:        '#5a6a6a',  // blue-grey
  closet:         '#6a6a5a',  // warm grey
  entry:          '#7a6a5a',  // terracotta
}

function studioId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `obj-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

/**
 * Convert a FloorPlan into a flat list of StudioObjects that CreateStudio
 * can render directly. Walls become `wall` primitives with door/window
 * cutouts represented as overlapping `door`/`window` primitives at their
 * proper offsets. Furniture becomes `box` primitives sized in meters.
 *
 * The existing engine doesn't boolean-subtract openings, so for v1 we
 * render door/window primitives as translucent panels in front of the wall
 * — a clear visual signal of placement that we can upgrade later to true
 * boolean cuts in the geometry layer.
 */
export function floorPlanToStudioObjects(plan: FloorPlan): StudioObject[] {
  const palette = paletteFor(plan.meta.style)
  const objects: StudioObject[] = []

  // Index walls so opening conversion can find them.
  const wallById = new Map<string, Wall>()
  for (const w of plan.walls) wallById.set(w.id, w)

  // Walls -------------------------------------------------------------
  for (const wall of plan.walls) {
    const dx = wall.b.x - wall.a.x
    const dz = wall.b.z - wall.a.z
    const length = Math.hypot(dx, dz)
    if (length < 1e-4) continue
    const midX = (wall.a.x + wall.b.x) / 2
    const midZ = (wall.a.z + wall.b.z) / 2
    // rotation around Y so local +X aligns with the wall direction
    const rotY = Math.atan2(dz, dx)
    const color = wall.exterior ? palette.wall : lighten(palette.wall, 0.04)
    objects.push({
      id: studioId(),
      kind: 'wall',
      name: wall.exterior ? 'Exterior Wall' : 'Interior Wall',
      position: [midX, wall.height / 2, midZ],
      rotation: [0, rotY, 0],
      scale: [length, wall.height, wall.thickness],
      color,
      opacity: 1,
      roughness: 0.72,
      metalness: 0.04,
    })
  }

  // Openings (door/window/garage_door rendered as translucent panels) --
  for (const op of plan.openings) {
    const wall = wallById.get(op.wallId)
    if (!wall) continue
    const dx = wall.b.x - wall.a.x
    const dz = wall.b.z - wall.a.z
    const length = Math.hypot(dx, dz)
    if (length < 1e-4) continue
    const tX = dx / length
    const tZ = dz / length
    const px = wall.a.x + tX * op.offset + tX * (op.width / 2)
    const pz = wall.a.z + tZ * op.offset + tZ * (op.width / 2)
    const rotY = Math.atan2(dz, dx)
    const center = op.sill + op.height / 2
    const isDoor = op.kind === 'door' || op.kind === 'garage_door'
    objects.push({
      id: studioId(),
      kind: isDoor ? 'door' : 'window',
      name: op.kind === 'garage_door' ? 'Garage Door' : isDoor ? 'Door' : 'Window',
      position: [px, center, pz],
      rotation: [0, rotY, 0],
      scale: [op.width, op.height, wall.thickness * 1.05],
      color: isDoor ? '#86b7ff' : '#a9d7ff',
      opacity: isDoor ? 0.32 : 0.22,
      roughness: 0.06,
      metalness: 0.0,
    })
  }

  // Furniture --------------------------------------------------------
  for (const f of plan.furniture) {
    objects.push({
      id: studioId(),
      kind: 'box',
      name: f.name,
      position: f.position,
      rotation: f.rotation,
      scale: f.scale,
      color: f.color ?? palette.warm,
      opacity: 1,
      roughness: 0.5,
      metalness: 0.05,
    })
  }

  // Floor slab per room (thin box) + room label tag --------------------
  for (const room of plan.rooms) {
    const w = room.max.x - room.min.x
    const d = room.max.z - room.min.z
    const cx = (room.min.x + room.max.x) / 2
    const cz = (room.min.z + room.max.z) / 2
    const floorColor = ROOM_FLOOR_COLORS[room.kind] ?? palette.floor
    objects.push({
      id: studioId(),
      kind: 'box',
      name: `${room.name} Floor`,
      position: [cx, -0.05, cz],
      rotation: [0, 0, 0],
      scale: [w, 0.1, d],
      color: floorColor,
      opacity: 1,
      roughness: 0.85,
      metalness: 0.02,
      // @ts-expect-error -- extra tag for room labels in the editor
      __roomLabel: room.name,
      __roomKind: room.kind,
    })
  }

  return objects
}

function lighten(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = Math.min(255, Math.round(((n >> 16) & 0xff) + 255 * amount))
  const g = Math.min(255, Math.round(((n >> 8) & 0xff) + 255 * amount))
  const b = Math.min(255, Math.round((n & 0xff) + 255 * amount))
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

// ---------------------------------------------------------------------------
// Bridge into CreateStudio's localStorage draft format so a generated
// FloorPlan loads automatically the next time the editor mounts.
// ---------------------------------------------------------------------------

const CREATE_STUDIO_DRAFT_KEY = 'create_studio_draft_v1'
const FLOORPLAN_SOURCE_KEY = 'genesis_floorplan_v1'

interface DraftPayload {
  version: 1
  objects: StudioObject[]
  snapEnabled: boolean
  snapStep: number
  showGrid: boolean
  updatedAt: string
}

/**
 * Persist a FloorPlan into the shape CreateStudio loads on mount, plus
 * keep the original FloorPlan around for downstream tools (renderer,
 * walkthrough, exports).
 */
export function stageFloorPlanForStudio(plan: FloorPlan): void {
  if (typeof localStorage === 'undefined') return
  const objects = floorPlanToStudioObjects(plan)
  const payload: DraftPayload = {
    version: 1,
    objects,
    snapEnabled: true,
    snapStep: 0.25,
    showGrid: true,
    updatedAt: new Date().toISOString(),
  }
  localStorage.setItem(CREATE_STUDIO_DRAFT_KEY, JSON.stringify(payload))
  localStorage.setItem(FLOORPLAN_SOURCE_KEY, JSON.stringify(plan))
}

/** Read the most recently generated FloorPlan, if any. */
export function readStagedFloorPlan(): FloorPlan | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(FLOORPLAN_SOURCE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.version === 1) return parsed as FloorPlan
  } catch {}
  return null
}
