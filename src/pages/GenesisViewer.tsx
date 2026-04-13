import { useEffect, useRef, useState } from 'react'
import Homes from './Homes'

const BLOCKED_EMBED_PATHS = new Set(['/', '/viewer', '/homes', '/homes-embed'])

function normalizePathname(pathname: string) {
  if (!pathname) return '/'
  if (pathname === '/') return '/'
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed || '/'
}

function isBlockedEmbedPath(pathname: string) {
  return BLOCKED_EMBED_PATHS.has(normalizePathname(pathname))
}

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]' || hostname === '::1'
}

function isHostAppOrigin(candidate: URL, current: URL) {
  if (candidate.origin === current.origin) return true
  const sameProtocol = candidate.protocol === current.protocol
  const candidatePort = candidate.port || (candidate.protocol === 'https:' ? '443' : '80')
  const currentPort = current.port || (current.protocol === 'https:' ? '443' : '80')
  if (!sameProtocol || candidatePort !== currentPort) return false
  return isLoopbackHost(candidate.hostname) && isLoopbackHost(current.hostname)
}

type EmbedResolution = {
  baseUrl: string
  warning: string | null
}

function resolveEmbedBaseUrl(): EmbedResolution {
  if (typeof window === 'undefined') return { baseUrl: '/viewer-upload', warning: null }
  const fallback = `${window.location.origin}/viewer-upload`
  const q = new URLSearchParams(window.location.search)
  const forceHomeDesigner = (q.get('engine') || '').toLowerCase() === 'home-designer'
  const explicit = String(q.get('viewerUrl') || '').trim()
  const configured = String((import.meta as any)?.env?.VITE_EMBED_VIEWER_URL || '').trim()
  const homeDesigner = String((import.meta as any)?.env?.VITE_HOME_DESIGNER_VIEWER_URL || '').trim()
  if (forceHomeDesigner && !explicit && !homeDesigner) {
    return {
      baseUrl: fallback,
      warning: 'Home Designer engine requested, but VITE_HOME_DESIGNER_VIEWER_URL is not set. Using internal viewer fallback.'
    }
  }
  const candidate = explicit || (forceHomeDesigner ? (homeDesigner || configured) : (configured || homeDesigner)) || fallback
  try {
    const u = new URL(candidate, window.location.origin)
    const current = new URL(window.location.origin)
    const isHostOrigin = isHostAppOrigin(u, current)
    if (isHostOrigin && isBlockedEmbedPath(u.pathname)) {
      return {
        baseUrl: fallback,
        warning: forceHomeDesigner
          ? 'Home Designer engine URL points to this app (or a local alias) on a blocked route. Using internal viewer fallback.'
          : null
      }
    }
    return { baseUrl: u.toString(), warning: null }
  } catch {
    return {
      baseUrl: fallback,
      warning: forceHomeDesigner
        ? 'Home Designer engine URL is invalid. Using internal viewer fallback.'
        : null
    }
  }
}

export default function GenesisViewer(){
  const parent = typeof window !== 'undefined' ? window.location.origin : '';
  const forceHomeDesigner = typeof window !== 'undefined'
    ? (new URLSearchParams(window.location.search).get('engine') || '').toLowerCase() === 'home-designer'
    : false
  const resolved = resolveEmbedBaseUrl()
  const base = resolved.baseUrl
  const viewerWarning = resolved.warning
  const [frameWarning, setFrameWarning] = useState<string | null>(null)
  const src = (() => {
    if (typeof window === 'undefined') return base
    try {
      const u = new URL(base, window.location.origin)
      const q = new URLSearchParams(window.location.search)
      if (parent) u.searchParams.set('parent', parent)
      const glbRaw = q.get('glb')
      let glb = glbRaw || ''
      if (glb && /^https?%3A/i.test(glb)) {
        try { glb = decodeURIComponent(glb) } catch {}
      }
      if (glb) u.searchParams.set('glb', glb)
      const open = q.get('open')
      if (open) u.searchParams.set('open', open)
      return u.toString()
    } catch {
      return `${window.location.origin}/viewer-upload`
    }
  })();

  const [showHomesModal, setShowHomesModal] = useState(false)
  const viewerRef = useRef<HTMLIFrameElement | null>(null)
  const windowOrigin = typeof window !== 'undefined' ? window.location.origin : ''

  // No URL or history interception. Modal is controlled only via messages and local state.

  // Prevent unintended navigation away from the viewer to '/', '/homes', or '/homes-embed'
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || window.self !== window.top) return
      const blocked = new Set<string>(['/', '/homes', '/homes-embed'])
      const origPush = history.pushState
      const origReplace = history.replaceState
      const guard = (url?: string | URL | null) => {
        if (!url) return false
        try {
          const u = new URL(String(url), window.location.origin)
          if (blocked.has(u.pathname)) {
            try { console.debug('[ViewerHost] blocked navigation to', u.pathname) } catch {}
            // Keep modal visible if Homes was intended
            if (u.pathname !== '/') setShowHomesModal(true)
            return true
          }
        } catch {}
        return false
      }
      history.pushState = function (state: any, title: string, url?: string | URL | null) {
        if (guard(url)) return
        return origPush.apply(history, [state, title, url as any])
      } as any
      history.replaceState = function (state: any, title: string, url?: string | URL | null) {
        if (guard(url)) return
        return origReplace.apply(history, [state, title, url as any])
      } as any
      const onPop = () => {
        try {
          if (blocked.has(window.location.pathname)) {
            // Immediately go back to viewer without changing URL (cancel pop)
            const viewerUrl = new URL(window.location.href)
            viewerUrl.pathname = '/viewer'
            origReplace.call(history, history.state, document.title, viewerUrl.toString())
            setShowHomesModal(true)
          }
        } catch {}
      }
      window.addEventListener('popstate', onPop)
      // Block anchor clicks to blocked paths
      const onClick = (e: MouseEvent) => {
        try {
          let n: any = e.target
          while (n && n !== document) {
            if (n.tagName === 'A' && typeof n.href === 'string') {
              const u = new URL(n.href)
              if (blocked.has(u.pathname)) {
                e.preventDefault(); e.stopPropagation()
                setShowHomesModal(u.pathname !== '/')
                return
              }
            }
            n = n.parentNode
          }
        } catch {}
      }
      window.addEventListener('click', onClick, true)
      return () => {
        try { history.pushState = origPush as any; history.replaceState = origReplace as any; window.removeEventListener('popstate', onPop); window.removeEventListener('click', onClick, true) } catch {}
      }
    } catch {}
  }, [])

  // While modal is open: block all navigations and anchor clicks at the host level
  useEffect(() => {
    if (!showHomesModal) return
    try {
      if (typeof window === 'undefined' || window.self !== window.top) return
      const origPush = history.pushState
      const origReplace = history.replaceState
      history.pushState = function () { return } as any
      history.replaceState = function () { return } as any
      const onClick = (e: MouseEvent) => {
        try {
          let n: any = e.target
          while (n && n !== document) {
            if (n.tagName === 'A') { e.preventDefault(); e.stopPropagation(); return }
            n = n.parentNode
          }
        } catch {}
      }
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation() }
      }
      window.addEventListener('click', onClick, true)
      window.addEventListener('keydown', onKey, true)
      return () => {
        try { history.pushState = origPush as any; history.replaceState = origReplace as any; window.removeEventListener('click', onClick, true); window.removeEventListener('keydown', onKey, true) } catch {}
      }
    } catch {}
  }, [showHomesModal])
  useEffect(() => {
    const viewerOrigin = (() => {
      try { return new URL(src).origin } catch { return windowOrigin || 'http://localhost:5173' }
    })()
    const parentPort = (() => { try { return new URL(window.location.origin).port || '5173' } catch { return '5173' } })()
    const isFromParent = (origin: string) => {
      try {
        const o = new URL(origin)
        if (origin === windowOrigin) return true
        return (o.port || '80') === parentPort && (o.protocol === 'http:' || o.protocol === 'https:')
      } catch { return false }
    }
    const onMessage = (e: MessageEvent) => {
      try {
        const data = e.data
        if (!data || typeof data !== 'object') return
        // From embedded viewer -> open homes (relax origin in dev)
        if ((data as any).type === 'GENESIS_OPEN_HOMES') {
          try { console.debug('[ViewerHost] GENESIS_OPEN_HOMES received from', e.origin) } catch {}
          // ACK back to the sender (the embedded iframe) to cancel any fallbacks
          try { (e.source as WindowProxy | null)?.postMessage({ type: 'GENESIS_OPEN_HOMES_ACK' }, e.origin) } catch {}
          setShowHomesModal(true)
          // reflect in URL so refresh preserves state
          try {
            const u = new URL(window.location.href)
            u.searchParams.set('open', 'homes')
            window.history.replaceState({}, '', u.toString())
          } catch {}
          return
        }
        // From homes modal (same-origin) -> forward selection to embedded viewer and close
        if (isFromParent(e.origin)) {
          if ((data as any).type === 'HOMES_SELECT_GLB') {
            const url = String((data as any).url || '')
            try {
              if (viewerRef.current?.contentWindow) {
                viewerRef.current.contentWindow.postMessage({ type: 'GENESIS_LOAD_GLB', url }, viewerOrigin)
                try { console.debug('[ViewerHost] Forwarded HOMES_SELECT_GLB -> GENESIS_LOAD_GLB', { to: viewerOrigin, url }) } catch {}
              } else {
                try { console.warn('[ViewerHost] viewer iframe not ready to forward GENESIS_LOAD_GLB') } catch {}
              }
              // Update parent URL for shareability
              const u = new URL(window.location.href)
              u.searchParams.set('glb', url)
              window.history.replaceState({}, '', u.toString())
            } catch {}
            setShowHomesModal(false)
            try { const u = new URL(window.location.href); u.searchParams.delete('open'); window.history.replaceState({}, '', u.toString()) } catch {}
            return
          }
          if ((data as any).type === 'HOMES_CLOSE') {
            try { console.debug('[ViewerHost] HOMES_CLOSE received') } catch {}
            setShowHomesModal(false)
            try { const u = new URL(window.location.href); u.searchParams.delete('open'); window.history.replaceState({}, '', u.toString()) } catch {}
            return
          }
        }
      } catch {}
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [src, windowOrigin])

  // Measure actual header height so the viewer fits perfectly without page scroll
  const [headerH, setHeaderH] = useState<number>(64)
  useEffect(() => {
    const measure = () => {
      try {
        const hdr = document.querySelector('header') as HTMLElement | null
        const h = hdr ? hdr.getBoundingClientRect().height : 64
        setHeaderH(Math.max(0, Math.round(h)))
      } catch {}
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  return (
    <div style={{ height: `calc(100vh - ${headerH}px)`, width:'100%', position: 'relative', overflow: 'hidden' }}>
      {(viewerWarning || frameWarning) && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            right: 12,
            zIndex: 10000,
            border: '1px solid rgba(251, 191, 36, 0.35)',
            background: 'rgba(120, 53, 15, 0.92)',
            color: '#fde68a',
            borderRadius: 10,
            padding: '10px 12px',
            fontSize: 13,
            lineHeight: 1.35
          }}
        >
          {viewerWarning || frameWarning}
        </div>
      )}
      <iframe
        src={src}
        title="Genesis 3D Viewer"
        style={{ border: 'none', width: '100%', height: '100%' }}
        allow="fullscreen; clipboard-read; clipboard-write; accelerometer; gyroscope; autoplay; gamepad; xr-spatial-tracking; cross-origin-isolated; pointer-lock"
        ref={viewerRef}
        onLoad={() => setFrameWarning(null)}
        onError={() => {
          if (!forceHomeDesigner) return
          setFrameWarning('Home Designer viewer could not be reached. Make sure VITE_HOME_DESIGNER_VIEWER_URL is correct and the home-designer app is running.')
        }}
      />

      {showHomesModal && (
        <div style={{ position:'fixed', inset: 0, zIndex: 9999 }}>
          {/* backdrop */}
          <div
            onClick={() => setShowHomesModal(false)}
            style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.35)' }}
          />
          {/* dropdown-style panel anchored near top-left of viewer */}
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position:'absolute',
              top: 76, // under viewer top bar
              left: 16,
              width: 880,
              height: 560,
              border:'1px solid rgba(255,255,255,0.1)',
              borderRadius:12,
              overflow:'hidden',
              boxShadow:'0 18px 48px rgba(0,0,0,0.55)',
              background:'#0b0b0b'
            }}
          >
            <Homes
              onSelect={(url: string) => {
                try {
                  const vOrigin = (() => { try { return new URL(src).origin } catch { return windowOrigin || 'http://localhost:5173' } })()
                  viewerRef.current?.contentWindow?.postMessage({ type: 'GENESIS_LOAD_GLB', url }, vOrigin)
                } catch {}
                setShowHomesModal(false)
              }}
              onClose={() => setShowHomesModal(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
