import React from 'react'
import { useApp } from '../store'
import type { Tool } from '../types'

const tools: { key: Tool; label: string }[] = [
  { key: 'select', label: 'Select' },
  { key: 'pan', label: 'Pan' },
  { key: 'wall', label: 'Wall' },
  { key: 'room', label: 'Room' },
  { key: 'rotate', label: 'Rotate' },
]

export function Toolbar() {
  const { tool, setTool, deleteSelected, clearPlan, adminMode, toggleAdmin, undo, redo, historyPast, historyFuture, selection } = useApp()
  const canUndo = historyPast.length > 0
  const canRedo = historyFuture.length > 0
  const hasSelection = !!selection.type
  return (
    <div className="toolbar">
      {tools.map((t) => (
        <button key={t.key} className="button" style={{ background: tool === t.key ? 'var(--accent)' : undefined }} onClick={() => setTool(t.key)}>
          {t.label}
        </button>
      ))}
      <button className="button" onClick={undo} disabled={!canUndo} title="Undo (Cmd/Ctrl+Z)">↶ Undo</button>
      <button className="button" onClick={redo} disabled={!canRedo} title="Redo (Cmd/Ctrl+Shift+Z)">↷ Redo</button>
      <button className="button" onClick={deleteSelected} disabled={!hasSelection} title={hasSelection ? 'Delete selected (Del/Backspace)' : 'Select a wall or room to enable delete'}>Delete</button>
      <button className="button" onClick={clearPlan}>Clear</button>
      <span className="badge">Tool: {tool}</span>
      <div style={{ marginLeft: 'auto' }} />
      <button className="button" onClick={toggleAdmin}>
        {adminMode ? 'Exit Admin' : 'Admin Mode'}
      </button>
    </div>
  )
}
