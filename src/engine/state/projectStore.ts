import { create } from "zustand";

export type Pt = { x: number; z: number };
export type Mode = "2D" | "3D";

export type Transform = { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] };
export type ProjectEntity = {
  id: string;
  type: 'furniture' | 'house';
  transform: Transform;
  data: { name: string; url?: string; bounds?: { min: [number,number,number]; max: [number,number,number] } };
};

export type Opening = { offsetAlongWall: number; width: number; height: number; sill: number };

export type ProjectState = {
  points: Pt[];
  wallHeight: number; // meters
  wallThickness: number; // meters
  mode: Mode;
  entities: ProjectEntity[];
  openings: Record<string, Opening[]>; // key: wallId like "w-0"
  // history
  historyPast: ProjectSnapshot[];
  historyFuture: ProjectSnapshot[];
  // actions
  setPoints: (pts: Pt[]) => void;
  addPoint: (p: Pt, index?: number) => void;
  movePoint: (index: number, p: Pt) => void;
  deletePoint: (index: number) => void;
  setMode: (m: Mode) => void;
  setWallHeight: (h: number) => void;
  setWallThickness: (t: number) => void;
  addEntity: (e: ProjectEntity) => void;
  updateEntity: (id: string, t: Partial<Transform>) => void;
  updateEntityDirect: (id: string, t: Partial<Transform>) => void;
  updateEntityData: (id: string, data: Partial<ProjectEntity["data"]>) => void;
  removeEntity: (id: string) => void;
  addOpening: (wallId: string, o: Opening) => void;
  updateOpenings: (wallId: string, list: Opening[]) => void;
  updateOpeningsDirect: (wallId: string, list: Opening[]) => void;
  setPointsDirect: (pts: Pt[]) => void;
  movePointDirect: (index: number, p: Pt) => void;
  loadPresetHouse: () => void;
  importJSON: (json: string) => void;
  exportJSON: () => string;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  beginAction: () => void;
};

export type ProjectSnapshot = {
  points: Pt[];
  wallHeight: number;
  wallThickness: number;
  entities: ProjectEntity[];
  openings: Record<string, Opening[]>;
};

const defaultPoints: Pt[] = [];

const snapshot = (s: ProjectState): ProjectSnapshot => ({
  points: s.points.map(p=>({x:p.x,z:p.z})),
  wallHeight: s.wallHeight,
  wallThickness: s.wallThickness,
  entities: s.entities.map(e=> ({...e, transform: { position:[...e.transform.position] as any, rotation:[...e.transform.rotation] as any, scale:[...e.transform.scale] as any, }, data: {...e.data} })),
  openings: Object.fromEntries(Object.entries(s.openings).map(([k,v])=>[k, v.map(o=>({ ...o }))]))
});

type Setter = (partial: Partial<ProjectState> | ((state: ProjectState) => Partial<ProjectState>)) => void;
type Getter = () => ProjectState;
const pushPast = (setFn: Setter, getFn: Getter)=>{
  const s = getFn();
  const past = [...s.historyPast, snapshot(s)];
  const cap = past.length > 100 ? past.slice(past.length-100) : past;
  setFn({ historyPast: cap, historyFuture: [] });
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  points: defaultPoints,
  wallHeight: 3,
  wallThickness: 0.2,
  mode: "3D",
  entities: [],
  openings: {},
  historyPast: [],
  historyFuture: [],
  beginAction: () => { pushPast(set, get); },
  setPoints: (pts) => { pushPast(set, get); set({ points: pts }); },
  addPoint: (p, index) => { pushPast(set, get); set((s) => ({ points: index != null ? [...s.points.slice(0, index), p, ...s.points.slice(index)] : [...s.points, p] })); },
  movePoint: (index, p) => { pushPast(set, get); set((s) => ({ points: s.points.map((q, i) => (i === index ? p : q)) })); },
  deletePoint: (index) => { pushPast(set, get); set((s) => ({ points: s.points.filter((_, i) => i !== index) })); },
  setMode: (m) => set({ mode: m }),
  setWallHeight: (h) => { pushPast(set, get); set({ wallHeight: Math.max(0.5, h) }); },
  setWallThickness: (t) => { pushPast(set, get); set({ wallThickness: Math.max(0.05, t) }); },
  addEntity: (e) => { pushPast(set, get); set((s) => ({ entities: [...s.entities, e] })); },
  updateEntity: (id, t) => { pushPast(set, get); set((s) => ({
    entities: s.entities.map((e) => e.id === id ? {
      ...e,
      transform: {
        position: t.position ?? e.transform.position,
        rotation: t.rotation ?? e.transform.rotation,
        scale: t.scale ?? e.transform.scale,
      }
    } : e)
  })); },
  updateEntityDirect: (id, t) => set((s) => ({
    entities: s.entities.map((e) => e.id === id ? {
      ...e,
      transform: {
        position: t.position ?? e.transform.position,
        rotation: t.rotation ?? e.transform.rotation,
        scale: t.scale ?? e.transform.scale,
      }
    } : e)
  })),
  updateEntityData: (id, data) => { pushPast(set, get); set((s) => ({
    entities: s.entities.map((e) => e.id === id ? { ...e, data: { ...e.data, ...data } } : e)
  })); },
  removeEntity: (id) => { pushPast(set, get); set((s) => ({ entities: s.entities.filter((e) => e.id !== id) })); },
  addOpening: (wallId, o) => { pushPast(set, get); set((s) => ({ openings: { ...s.openings, [wallId]: [ ...(s.openings[wallId]||[]), o ] } })); },
  updateOpenings: (wallId, list) => { pushPast(set, get); set((s) => ({ openings: { ...s.openings, [wallId]: list } })); },
  updateOpeningsDirect: (wallId, list) => set((s) => ({ openings: { ...s.openings, [wallId]: list } })),
  setPointsDirect: (pts) => set({ points: pts }),
  movePointDirect: (index, p) => set((s) => ({ points: s.points.map((q, i) => (i === index ? p : q)) })),
  loadPresetHouse: () => set(() => {
    const pts: Pt[] = [
      { x: -6, z: -4 },
      { x: 0, z: -4 },
      { x: 0, z: -1 },
      { x: 4, z: -1 },
      { x: 4, z: 4 },
      { x: -6, z: 4 }
    ];
    const segs = getWallSegments(pts);
    const ops: Record<string, Opening[]> = {};
    // Front door on first segment
    const first = segs[0];
    ops[first.id] = [{ offsetAlongWall: Math.max(0.5, first.length/2 - 0.45), width: 0.9, height: 2.1, sill: 0 }];
    // Two windows on long right wall
    const right = segs[3];
    ops[right.id] = [
      { offsetAlongWall: 0.8, width: 1.2, height: 1.1, sill: 0.9 },
      { offsetAlongWall: 2.8, width: 1.2, height: 1.1, sill: 0.9 }
    ];
    const entities: ProjectEntity[] = [
      { id: 'ent-chair', type: 'furniture', transform: { position: [-4.5, 0, 2.5], rotation: [0, Math.PI/2, 0], scale: [1,1,1] }, data: { name: 'Chair', url: 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models@master/2.0/SheenChair/glTF/SheenChair.gltf' }},
      { id: 'ent-boombox', type: 'furniture', transform: { position: [-2, 0, 0.5], rotation: [0, 0, 0], scale: [1.2,1.2,1.2] }, data: { name: 'BoomBox', url: 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models@master/2.0/BoomBox/glTF/BoomBox.gltf' }}
    ];
    return { points: pts, wallHeight: 3, wallThickness: 0.2, entities, openings: ops, mode: '3D' as Mode };
  }),
  importJSON: (json) => {
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data.points) && typeof data.wallHeight === "number" && typeof data.wallThickness === "number") {
        pushPast(set, get);
        set({
          points: data.points.map((p: any) => ({ x: Number(p.x), z: Number(p.z) })),
          wallHeight: Number(data.wallHeight),
          wallThickness: Number(data.wallThickness),
          entities: Array.isArray(data.entities) ? data.entities : [],
          openings: data.openings || {}
        });
      }
    } catch (e) {
      console.error("Invalid JSON:", e);
    }
  },
  exportJSON: () => {
    const s = get();
    return JSON.stringify({ points: s.points, wallHeight: s.wallHeight, wallThickness: s.wallThickness, entities: s.entities, openings: s.openings }, null, 2);
  },
  undo: () => {
    const s = get();
    if (s.historyPast.length === 0) return;
    const current = snapshot(s);
    const prev = s.historyPast[s.historyPast.length - 1];
    set({
      points: prev.points,
      wallHeight: prev.wallHeight,
      wallThickness: prev.wallThickness,
      entities: prev.entities,
      openings: prev.openings,
      historyPast: s.historyPast.slice(0, -1),
      historyFuture: [current, ...s.historyFuture].slice(0, 100),
    });
  },
  redo: () => {
    const s = get();
    if (s.historyFuture.length === 0) return;
    const current = snapshot(s);
    const next = s.historyFuture[0];
    set({
      points: next.points,
      wallHeight: next.wallHeight,
      wallThickness: next.wallThickness,
      entities: next.entities,
      openings: next.openings,
      historyPast: [...s.historyPast, current].slice(-100),
      historyFuture: s.historyFuture.slice(1),
    });
  },
  reset: () => {
    const s = get();
    pushPast(set, get);
    set({ points: defaultPoints, wallHeight: 3, wallThickness: 0.2, entities: [], openings: {} });
  }
}));

// Helpers
export function wallId(i: number) { return `w-${i}`; }
export function getWallSegments(points: Pt[]) {
  const segs = [] as { id: string; a: Pt; b: Pt; index: number; length: number; dir: {x:number,z:number}; rotY: number; mid: {x:number,z:number} }[];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i+1)%points.length];
    const dx = b.x - a.x; const dz = b.z - a.z; const len = Math.hypot(dx, dz) || 0.0001;
    segs.push({ id: wallId(i), a, b, index: i, length: len, dir: {x: dx/len, z: dz/len}, rotY: Math.atan2(dx, dz), mid: { x: (a.x+b.x)/2, z: (a.z+b.z)/2 } });
  }
  return segs;
}
