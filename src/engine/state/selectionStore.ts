import { create } from "zustand";

export type Selection = { kind: 'wall' | 'entity' | 'house'; id: string } | null;

export const useSelectionStore = create<{ selected: Selection; setSelection: (s: Selection) => void }>((set)=> ({
  selected: null,
  setSelection: (selected)=> set({ selected })
}));
