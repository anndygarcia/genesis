import { create } from "zustand";

export type LibraryItem = { name: string; url?: string; size?: [number, number, number] };

export type TransformMode = 'translate' | 'rotate' | 'scale';

export type UIState = {
  placing: LibraryItem | null;
  setPlacing: (it: LibraryItem | null) => void;
  snap: boolean;
  elevate: boolean;
  setSnap: (v: boolean) => void;
  setElevate: (v: boolean) => void;
  fp: boolean;
  setFP: (v: boolean) => void;
  transformMode: TransformMode;
  setTransformMode: (m: TransformMode) => void;
  showRoom: boolean;
  setShowRoom: (v: boolean) => void;
  ambient: number;
  setAmbient: (v: number) => void;
  flashlight: boolean;
  setFlashlight: (v: boolean) => void;
  showRoof: boolean;
  setShowRoof: (v: boolean) => void;
  drawWalls: boolean;
  setDrawWalls: (v: boolean) => void;
  wallDraft: { x:number; z:number }[];
  setWallDraft: (pts: {x:number; z:number}[]) => void;
  toolDoor: boolean;
  setToolDoor: (v: boolean) => void;
  toolWindow: boolean;
  setToolWindow: (v: boolean) => void;
  dragWallId: string | null;
  setDragWallId: (id: string | null) => void;
};

export const useUIStore = create<UIState>((set) => ({
  placing: null,
  setPlacing: (placing) => set({ placing }),
  snap: true,
  elevate: false,
  setSnap: (snap) => set({ snap }),
  setElevate: (elevate) => set({ elevate }),
  fp: false,
  setFP: (fp) => set({ fp }),
  transformMode: 'translate',
  setTransformMode: (transformMode) => set({ transformMode }),
  showRoom: false,
  setShowRoom: (showRoom) => set({ showRoom }),
  ambient: 0.8,
  setAmbient: (ambient) => set({ ambient }),
  flashlight: false,
  setFlashlight: (flashlight) => set({ flashlight }),
  showRoof: false,
  setShowRoof: (showRoof) => set({ showRoof }),
  drawWalls: false,
  setDrawWalls: (drawWalls) => set({ drawWalls }),
  wallDraft: [],
  setWallDraft: (wallDraft) => set({ wallDraft }),
  toolDoor: false,
  setToolDoor: (toolDoor) => set({ toolDoor, toolWindow: toolDoor ? false : (useUIStore.getState().toolWindow) }),
  toolWindow: false,
  setToolWindow: (toolWindow) => set({ toolWindow, toolDoor: toolWindow ? false : (useUIStore.getState().toolDoor) }),
  dragWallId: null,
  setDragWallId: (dragWallId) => set({ dragWallId })
}));
