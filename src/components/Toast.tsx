/**
 * Minimal toast notification system for Genesis AI.
 * 
 * Usage:
 *   import { toast, ToastContainer } from './Toast'
 *   
 *   // Place <ToastContainer /> once in your App
 *   toast.success('Home generated!')
 *   toast.error('Pipeline connection failed')
 *   toast.info('Building 3D shell in the background...')
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface ToastData {
  id: string
  type: ToastType
  message: string
  duration: number
}

type Listener = (toasts: ToastData[]) => void

// Global toast store
let _toasts: ToastData[] = []
let _listeners: Listener[] = []
let _nextId = 0

function emit() {
  for (const fn of _listeners) fn([..._toasts])
}

function addToast(type: ToastType, message: string, duration = 4000) {
  const id = `toast-${++_nextId}`
  _toasts = [..._toasts, { id, type, message, duration }]
  emit()
  if (duration > 0) {
    setTimeout(() => removeToast(id), duration)
  }
}

function removeToast(id: string) {
  _toasts = _toasts.filter((t) => t.id !== id)
  emit()
}

export const toast = {
  success: (msg: string, duration?: number) => addToast('success', msg, duration),
  error: (msg: string, duration?: number) => addToast('error', msg, duration ?? 6000),
  warning: (msg: string, duration?: number) => addToast('warning', msg, duration ?? 5000),
  info: (msg: string, duration?: number) => addToast('info', msg, duration),
}

const TOAST_STYLES: Record<ToastType, { bg: string; border: string; text: string; Icon: typeof Info }> = {
  success: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-300', Icon: CheckCircle2 },
  error:   { bg: 'bg-red-500/10',     border: 'border-red-500/30',     text: 'text-red-300',     Icon: XCircle },
  warning: { bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   text: 'text-amber-300',   Icon: AlertTriangle },
  info:    { bg: 'bg-sky-500/10',      border: 'border-sky-500/30',     text: 'text-sky-300',     Icon: Info },
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([])
  const exitingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    _listeners.push(setToasts)
    return () => {
      _listeners = _listeners.filter((l) => l !== setToasts)
    }
  }, [])

  const dismiss = useCallback((id: string) => {
    exitingRef.current.add(id)
    setToasts((t) => [...t]) // force re-render for exit animation
    setTimeout(() => {
      exitingRef.current.delete(id)
      removeToast(id)
    }, 250)
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col-reverse gap-2 max-w-sm pointer-events-none">
      {toasts.map((t) => {
        const style = TOAST_STYLES[t.type]
        const Icon = style.Icon
        const isExiting = exitingRef.current.has(t.id)
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border ${style.border} ${style.bg} backdrop-blur-xl px-3.5 py-3 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.5)] transition-all duration-250 ${
              isExiting ? 'opacity-0 translate-x-4 scale-95' : 'opacity-100 translate-x-0 scale-100 animate-[slide-in-right_0.3s_ease-out]'
            }`}
          >
            <Icon className={`mt-0.5 size-4 shrink-0 ${style.text}`} />
            <span className="flex-1 text-sm text-neutral-200 leading-snug">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded-md p-0.5 text-neutral-500 hover:text-neutral-200 hover:bg-white/10 transition-colors"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
