import React, { useEffect } from 'react'
import { Canvas } from './components/Canvas'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { IOBar } from './components/IOBar'
import { useApp } from './store'

export default function App() {
  const { undo, redo, deleteSelected, selection } = useApp()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const ctrl = isMac ? e.metaKey : e.ctrlKey
      if (!ctrl) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); undo()
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        e.preventDefault(); redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // avoid deleting while typing in inputs
        const target = e.target as HTMLElement | null
        const tag = target?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
        if (selection.type) {
          e.preventDefault()
          deleteSelected()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteSelected, selection])
  return (
    <div className="app-root">
      <Toolbar />
      <div className="workspace">
        <Canvas />
        <Sidebar />
      </div>
      <IOBar />
    </div>
  )
}
