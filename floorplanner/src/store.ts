import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GeneratorInput, Plan, Tool, Vec2, Viewport, Wall, Room } from './types'

function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

const DEFAULT_VIEWPORT: Viewport = { zoom: 1.2, offset: { x: 200, y: 120 } }

export type AppState = {
  tool: Tool
  adminMode: boolean
  plan: Plan
  viewport: Viewport
  selection: { type: 'wall' | 'room' | null; id?: string } | { type: 'multi'; items: { type: 'wall' | 'room'; id: string }[] }
  // history
  historyPast: Plan[]
  historyFuture: Plan[]
  // actions
  setTool: (t: Tool) => void
  toggleAdmin: () => void
  setViewport: (v: Partial<Viewport>) => void
  addWall: (a: Vec2, b: Vec2, thickness?: number) => string
  updateWall: (id: string, patch: Partial<Wall>) => void
  addRoom: (points: Vec2[], name?: string) => string
  updateRoom: (id: string, patch: Partial<Room>) => void
  setSelection: (sel: AppState['selection']) => void
  deleteSelected: () => void
  clearPlan: () => void
  // IO
  exportJSON: () => string
  importJSON: (json: string) => void
  // Generator
  generatePlan: (g: GeneratorInput) => void
  // History controls
  undo: () => void
  redo: () => void
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      tool: 'select',
      adminMode: false,
      plan: { walls: [], rooms: [] },
      viewport: DEFAULT_VIEWPORT,
      selection: { type: null },
      historyPast: [],
      historyFuture: [],

      setTool: (t) => set({ tool: t }),
      toggleAdmin: () => set((s) => ({ adminMode: !s.adminMode })),
      setViewport: (v) => set((s) => ({ viewport: { ...s.viewport, ...v } })),

      addWall: (a, b, thickness = 10) => {
        const id = uid('wall')
        const newWall = { id, a, b, thickness }
        set((s) => ({
          historyPast: [...s.historyPast, s.plan],
          historyFuture: [],
          plan: { ...s.plan, walls: [...s.plan.walls, newWall] },
          selection: { type: null },
        }))
        return id
      },
      updateWall: (id, patch) =>
        set((s) => ({
          historyPast: [...s.historyPast, s.plan],
          historyFuture: [],
          plan: {
            ...s.plan,
            walls: s.plan.walls.map((w) => (w.id === id ? { ...w, ...patch } : w)),
          },
          selection: { type: null },
        })),

      addRoom: (points, name) => {
        const id = uid('room')
        set((s) => ({
          historyPast: [...s.historyPast, s.plan],
          historyFuture: [],
          plan: { ...s.plan, rooms: [...s.plan.rooms, { id, points, name }] },
          selection: { type: null },
        }))
        return id
      },
      updateRoom: (id, patch) =>
        set((s) => ({
          historyPast: [...s.historyPast, s.plan],
          historyFuture: [],
          plan: { ...s.plan, rooms: s.plan.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) },
          selection: { type: null },
        })),

      setSelection: (sel) => set({ selection: sel }),
      deleteSelected: () => {
        const { selection } = get()
        if (selection.type === 'wall' && selection.id) {
          set((s) => ({
            historyPast: [...s.historyPast, s.plan],
            historyFuture: [],
            plan: { ...s.plan, walls: s.plan.walls.filter((w) => w.id !== selection.id) },
            selection: { type: null },
          }))
        } else if (selection.type === 'room' && selection.id) {
          set((s) => ({
            historyPast: [...s.historyPast, s.plan],
            historyFuture: [],
            plan: { ...s.plan, rooms: s.plan.rooms.filter((r) => r.id !== selection.id) },
            selection: { type: null },
          }))
        } else if (selection.type === 'multi') {
          const wallIds = new Set(selection.items.filter((i) => i.type === 'wall').map((i) => i.id))
          const roomIds = new Set(selection.items.filter((i) => i.type === 'room').map((i) => i.id))
          set((s) => ({
            historyPast: [...s.historyPast, s.plan],
            historyFuture: [],
            plan: {
              ...s.plan,
              walls: s.plan.walls.filter((w) => !wallIds.has(w.id)),
              rooms: s.plan.rooms.filter((r) => !roomIds.has(r.id)),
            },
            selection: { type: null },
          }))
        } else {
          set({ selection: { type: null } })
        }
      },
      clearPlan: () => set((s) => ({
        historyPast: [...s.historyPast, s.plan],
        historyFuture: [],
        plan: { walls: [], rooms: [] },
        selection: { type: null },
      })),

      exportJSON: () => JSON.stringify({ plan: get().plan }, null, 2),
      importJSON: (json: string) => {
        try {
          const data = JSON.parse(json)
          if (data && data.plan && Array.isArray(data.plan.walls) && Array.isArray(data.plan.rooms)) {
            set((s) => ({
              historyPast: [...s.historyPast, s.plan],
              historyFuture: [],
              plan: data.plan,
              selection: { type: null },
            }))
          }
        } catch (e) {
          console.error('Invalid JSON import', e)
        }
      },

      generatePlan: (g) => {
        // Minimal naive generator: create a rectangle sized by sqft, then partition into rooms.
        // Assume 1 canvas unit = 1 cm. 1 sqft ~ 929.03 cm^2. We'll create a rectangle around aspect based on style.
        const areaCm2 = g.sqft * 929.03
        const aspect = g.style === 'ranch' ? 3.0 : g.style === 'modern' ? 1.6 : 1.3
        const width = Math.sqrt(areaCm2 * aspect)
        const height = width / aspect
        const origin: Vec2 = { x: 0, y: 0 }
        const rect: Vec2[] = [
          { x: origin.x, y: origin.y },
          { x: origin.x + width, y: origin.y },
          { x: origin.x + width, y: origin.y + height },
          { x: origin.x, y: origin.y + height },
        ]

        // Clear existing
        set((s) => ({ historyPast: [...s.historyPast, s.plan], historyFuture: [], plan: { walls: [], rooms: [] }, selection: { type: null } }))

        // Outer walls
        const thick = 20
        const addW = (a: Vec2, b: Vec2) => get().addWall(a, b, thick)
        addW(rect[0], rect[1])
        addW(rect[1], rect[2])
        addW(rect[2], rect[3])
        addW(rect[3], rect[0])

        // Partition horizontally into bands for bedrooms/baths/garage simplistic
        const bands = Math.max(1, Math.min(4, g.bedrooms + (g.bathrooms > 1 ? 1 : 0)))
        const bandH = height / bands
        const rooms: { points: Vec2[]; name: string }[] = []
        for (let i = 0; i < bands; i++) {
          const y0 = origin.y + i * bandH
          const y1 = y0 + bandH
          // split each band into 2-3 rooms
          const cols = i === 0 && g.garageSpots > 0 ? (g.garageSpots >= 2 ? 2 : 1) : 3
          const colW = width / cols
          for (let c = 0; c < cols; c++) {
            const x0 = origin.x + c * colW
            const x1 = x0 + colW
            const points = [
              { x: x0, y: y0 },
              { x: x1, y: y0 },
              { x: x1, y: y1 },
              { x: x0, y: y1 },
            ]
            let name = 'Room'
            if (i === 0 && c < Math.min(g.garageSpots, 2)) name = 'Garage'
            else if (rooms.filter((r) => r.name.startsWith('Bedroom')).length < g.bedrooms) name = `Bedroom ${rooms.filter((r) => r.name.startsWith('Bedroom')).length + 1}`
            else if (rooms.filter((r) => r.name.startsWith('Bath')).length < g.bathrooms) name = `Bath ${rooms.filter((r) => r.name.startsWith('Bath')).length + 1}`
            else if (!rooms.find((r) => r.name === 'Living')) name = 'Living'
            else if (!rooms.find((r) => r.name === 'Kitchen')) name = 'Kitchen'
            rooms.push({ points, name })
          }
        }
        rooms.forEach((r) => get().addRoom(r.points, r.name))
      },

      undo: () => {
        const past = get().historyPast
        if (past.length === 0) return
        const previous = past[past.length - 1]
        const current = get().plan
        set((s) => ({
          plan: previous,
          historyPast: s.historyPast.slice(0, -1),
          historyFuture: [current, ...s.historyFuture],
          selection: { type: null },
        }))
      },
      redo: () => {
        const future = get().historyFuture
        if (future.length === 0) return
        const next = future[0]
        const current = get().plan
        set((s) => ({
          plan: next,
          historyPast: [...s.historyPast, current],
          historyFuture: s.historyFuture.slice(1),
          selection: { type: null },
        }))
      },
    }),
    {
      name: 'floorplanner-store',
      partialize: (s) => ({ plan: s.plan, viewport: s.viewport }),
    }
  )
)

export function screenToWorld(p: Vec2, viewport: Viewport): Vec2 {
  return { x: (p.x - viewport.offset.x) / viewport.zoom, y: (p.y - viewport.offset.y) / viewport.zoom }
}
export function worldToScreen(p: Vec2, viewport: Viewport): Vec2 {
  return { x: p.x * viewport.zoom + viewport.offset.x, y: p.y * viewport.zoom + viewport.offset.y }
}
