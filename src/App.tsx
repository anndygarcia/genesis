import { useEffect, useRef, useState } from 'react'
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import MetalInteractiveInline from './components/MetalInteractiveInline'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from './lib/supabase'
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js'

import './App.css'
import Landing from './pages/Landing'
import IntakeForm from './pages/IntakeForm'
import Preview from './pages/Preview'
import Profile from './pages/Profile'
import ProfileSettings from './pages/ProfileSettings'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import ProjectUpload from './pages/ProjectUpload'
import Feed from './pages/Feed'

function App() {
  const navigate = useNavigate()
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('dark')
    localStorage.setItem('theme', 'dark')
  }, [])
  const [authOpen, setAuthOpen] = useState(false)
  // Smooth modal mount/unmount with exit animation
  const [authVisible, setAuthVisible] = useState(false)
  const [authClosing, setAuthClosing] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn')
  const [user, setUser] = useState<User | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authNotice, setAuthNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cooldown, setCooldown] = useState(0) // seconds remaining before next attempt
  const strongPwRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-={}\[\]|;:'",.<>\/?]).{8,}$/

  // User menu (profile dropdown)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Hover close delay to prevent flicker when moving from trigger to menu
  const hoverCloseTimeout = useRef<number | null>(null)

  // Close on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAuthOpen(false)
        setMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Close profile menu on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!menuOpen) return
      const el = menuRef.current
      if (el && !el.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  // Reset sign-up specific fields when switching modes
  useEffect(() => {
    setAuthError('')
    setAuthNotice('')
    setConfirmPassword('')
    setShowConfirmPassword(false)
    setCooldown(0)
  }, [mode])

  // Tick down cooldown once per second
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setInterval(() => setCooldown((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [cooldown])

  // Initialize session and subscribe to auth state changes
  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      if (!mounted) return
      setUser(data.session?.user ?? null)
      console.log('[AUTH] getSession user=', data.session?.user?.id || null)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      setUser(session?.user ?? null)
      console.log('[AUTH] onAuthStateChange user=', session?.user?.id || null)
      if (session?.user) {
        // Ensure home route re-evaluates element when auth changes
        navigate('/', { replace: true })
      }
    })
    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // Debug current user state
  useEffect(() => {
    console.log('[AUTH] user state changed ->', user ? { id: user.id, email: user.email } : null)
  }, [user])

  // Drive visible/closing state from authOpen for seamless animations
  useEffect(() => {
    if (authOpen) {
      // open -> ensure mounted and reset closing
      if (closeTimer.current) {
        clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      setAuthVisible(true)
      setAuthClosing(false)
    } else if (authVisible && !authClosing) {
      // start closing animation
      setAuthClosing(true)
      // unmount after the longest exit animation duration (ms)
      closeTimer.current = window.setTimeout(() => {
        setAuthVisible(false)
        setAuthClosing(false)
        closeTimer.current = null
      }, 360)
    }
  }, [authOpen, authVisible, authClosing])

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  // Interactive metal panel
  const panelRef = useRef<HTMLDivElement | null>(null)
  const rafId = useRef<number | null>(null)
  // Smoothed state for interactive sheen/tilt to avoid micro-jitter
  const lastVars = useRef({ mx: 0.5, my: 0.5, ang: 0, rx: 0, ry: 0, shine: 0.18 })

  // Cleanup rAF on unmount
  useEffect(() => () => { if (rafId.current) cancelAnimationFrame(rafId.current) }, [])

  // --- Corner logo spin management ---
  const logoImgRef = useRef<HTMLImageElement | null>(null)
  const logoSpinRef = useRef<Animation | null>(null)
  const logoDecelRef = useRef<Animation | null>(null)

  // --- Auth modal logo loading spin ---
  const modalLogoRef = useRef<HTMLImageElement | null>(null)
  const modalSpinRef = useRef<Animation | null>(null)
  const startModalSpin = () => {
    const img = modalLogoRef.current
    if (!img) return
    modalSpinRef.current?.cancel()
    img.style.removeProperty('transform')
    modalSpinRef.current = img.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 900, iterations: Infinity, easing: 'linear' }
    )
  }
  const stopModalSpin = () => {
    modalSpinRef.current?.cancel()
    modalSpinRef.current = null
  }

  const getRotationDeg = (el: HTMLElement): number => {
    const st = getComputedStyle(el)
    const tr = st.transform
    if (!tr || tr === 'none') return 0
    // matrix(a, b, c, d, e, f)
    const m2d = tr.match(/matrix\(([^)]+)\)/)
    if (m2d) {
      const parts = m2d[1].split(',').map((v) => parseFloat(v.trim()))
      const a = parts[0] ?? 1
      const b = parts[1] ?? 0
      return Math.atan2(b, a) * (180 / Math.PI)
    }
    // matrix3d(...)
    const m3d = tr.match(/matrix3d\(([^)]+)\)/)
    if (m3d) {
      const p = m3d[1].split(',').map((v) => parseFloat(v.trim()))
      // 2D rotation components are a = m11, b = m12 in 3d matrix
      const a = p[0] ?? 1
      const b = p[1] ?? 0
      return Math.atan2(b, a) * (180 / Math.PI)
    }
    return 0
  }

  const handleLogoEnter = () => {
    const img = logoImgRef.current
    if (!img) return
    // Cancel any deceleration and infinite spin before starting a new one
    logoDecelRef.current?.cancel()
    logoSpinRef.current?.cancel()
    img.style.removeProperty('transform')
    logoSpinRef.current = img.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 1200, iterations: Infinity, easing: 'linear' }
    )
  }

  const handleLogoLeave = () => {
    const img = logoImgRef.current
    if (!img) return
    // Capture current rotation angle
    const currentDeg = getRotationDeg(img)
    // Stop infinite spin
    logoSpinRef.current?.cancel()
    logoSpinRef.current = null
    // Normalize angle to [0, 360)
    const base = ((currentDeg % 360) + 360) % 360
    // Seamless deceleration to the original starting pose (0deg)
    // Only finish the current rotation: rotate the remaining amount to reach the next exact 0deg.
    const toNextZero = (360 - base) % 360
    const total = toNextZero
    // Continue briefly at current speed, then ease-out to stop exactly at 0deg
    const linearPortion = Math.min(80, Math.max(40, total * 0.35)) // degrees during linear phase
    const mid = base + linearPortion
    const target = base + total // lands exactly at 0deg modulo 360
    // Duration scales with remaining angle so short remainders stop faster
    const duration = Math.round(350 + (total / 360) * 350) // 350–700ms
    logoDecelRef.current?.cancel()
    img.style.transform = `rotate(${base}deg)`
    logoDecelRef.current = img.animate(
      [
        { transform: `rotate(${base}deg)`, easing: 'linear', offset: 0 },
        { transform: `rotate(${mid}deg)`, easing: 'linear', offset: 0.35 },
        { transform: `rotate(${target}deg)`, easing: 'cubic-bezier(.08,.8,.18,1)', offset: 1 },
      ],
      { duration, fill: 'forwards' }
    )
  }

  const handlePanelLeave = () => {
    const el = panelRef.current
    if (!el) return
    // Reset to neutral
    el.style.setProperty('--mx', '50%')
    el.style.setProperty('--my', '50%')
    // Center-relative offsets for 300% canvas (range [-size .. +size])
    el.style.setProperty('--dx', `0px`)
    el.style.setProperty('--dy', `0px`)
    el.style.setProperty('--rx', '0deg')
    el.style.setProperty('--ry', '0deg')
    el.style.setProperty('--elev', '0px')
    el.style.setProperty('--ang', '0deg')
    el.style.setProperty('--shine', '0.18')
    lastVars.current = { mx: 0.5, my: 0.5, ang: 0, rx: 0, ry: 0, shine: 0.18 }
  }

  const handlePanelMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = panelRef.current
    if (!el) return
    const { left, top, width, height } = el.getBoundingClientRect()
    const x = Math.min(Math.max(e.clientX - left, 0), width)
    const y = Math.min(Math.max(e.clientY - top, 0), height)
    const px = x / width
    const py = y / height
    // Target values
    const ry = (px - 0.5) * 8 // tilt Y
    const rx = -(py - 0.5) * 8 // tilt X
    // Sheen angle tracks both horizontal and vertical tilt to feel continuous in all directions
    // while staying near-vertical to avoid harsh flips.
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
    const angDeg = 90 + clamp(ry * 1.8 + rx * 1.4, -26, 26)
    // Smooth edge bias: draw sheen toward nearest horizontal edge, keep vertical following cursor
    let bias = Math.min(1, Math.abs(px - 0.5) * 2) // 0 center -> 1 edges
    // Ease bias to avoid sudden edge snapping
    bias = Math.pow(bias, 0.6)
    const edgeTargetX = px < 0.5 ? 0.04 : 0.96 // keep inside rounded borders
    const mx = (1 - 0.5 * bias) * px + (0.5 * bias) * edgeTargetX
    const my = clamp(py, 0.06, 0.94)
    // Intensity scales with distance from center (edges brighter)
    const dx = px - 0.5
    const dy = py - 0.5
    const dist = Math.hypot(dx, dy) / Math.SQRT1_2 // normalize by ~0.7071
    const shine = Math.max(0.24, Math.min(0.56, 0.24 + 0.34 * dist))
    // rAF to avoid flooding style writes
    if (rafId.current) cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(() => {
      // Lerp smoothing to reduce micro-jitter
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t
      // Smooth angle across wrap-around using shortest path
      const currentAng = lastVars.current.ang
      let targetAng = angDeg
      let delta = targetAng - currentAng
      if (delta > 180) delta -= 360
      if (delta < -180) delta += 360
      const smAng = currentAng + delta * 0.12
      const smMx = lerp(lastVars.current.mx, mx, 0.16)
      const smMy = lerp(lastVars.current.my, my, 0.16)
      const smRx = lerp(lastVars.current.rx, rx, 0.18)
      const smRy = lerp(lastVars.current.ry, ry, 0.18)
      const smShine = lerp(lastVars.current.shine, shine, 0.12)
      lastVars.current = { mx: smMx, my: smMy, ang: smAng, rx: smRx, ry: smRy, shine: smShine }
      // Keep percentage vars updated (if used elsewhere)
      el.style.setProperty('--mx', `${(smMx * 100).toFixed(3)}%`)
      el.style.setProperty('--my', `${(smMy * 100).toFixed(3)}%`)
      // Center-relative pixel offsets for background-position calc(50% + var(--dx/--dy)).
      // With background-size: 300%, moving by [-size .. +size] pans the full canvas.
      const dx = (smMx - 0.5) * 2 * width
      // Reduce vertical panning to avoid a dead zone at the very top
      const dy = (smMy - 0.5) * 1.6 * height
      el.style.setProperty('--dx', `${dx.toFixed(3)}px`)
      el.style.setProperty('--dy', `${dy.toFixed(3)}px`)
      el.style.setProperty('--rx', `${smRx.toFixed(2)}deg`)
      el.style.setProperty('--ry', `${smRy.toFixed(2)}deg`)
      el.style.setProperty('--ang', `${smAng.toFixed(2)}deg`)
      el.style.setProperty('--shine', smShine.toFixed(3))
      el.style.setProperty('--elev', '8px')
    })
  }

  return (
    <div className="min-h-full flex flex-col texture-concrete-dark">
      <header className="border-b border-white/10 bg-neutral-950/60 backdrop-blur-xl sticky top-0 z-10">
        <div className="relative w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          {/* Centered brand text logo (perfectly centered) */}
          <div className="absolute inset-0 hidden sm:flex items-center justify-center pointer-events-none">
            <NavLink to="/" aria-label="Genesis AI Home" className="select-none pointer-events-auto">
              <MetalInteractiveInline mode="text">
                <span className="metal-text-satin text-xl md:text-3xl font-extrabold tracking-[0.35em] drop-shadow-[0_1px_6px_rgba(165,136,239,0.25)]">
                  GENESIS
                </span>
              </MetalInteractiveInline>
            </NavLink>
          </div>
          <NavLink to="/" className="text-xl font-semibold tracking-tight">
            <span className="sr-only">Genesis AI</span>
            <MetalInteractiveInline mode="image" maskSrc="/media/genesis-logo.png" className="spin-managed">
              <img
                src="/media/genesis-logo.png"
                alt="Genesis AI logo"
                ref={logoImgRef}
                onMouseEnter={handleLogoEnter}
                onMouseLeave={handleLogoLeave}
                className="h-12 w-12 sm:h-16 sm:w-16 select-none"
                draggable={false}
              />
            </MetalInteractiveInline>
          </NavLink>
          <nav className="flex items-center gap-6 text-sm">
            <NavLink to="/" className={({isActive}) => `hover:text-[#a588ef] ${isActive ? 'text-[#a588ef]' : 'text-neutral-200'}`}>Home</NavLink>
            <NavLink to="/start" className={({isActive}) => `hover:text-[#a588ef] ${isActive ? 'text-[#a588ef]' : 'text-neutral-200'}`}>Create</NavLink>
            {user ? (
              <div
                className="relative"
                ref={menuRef}
                onMouseEnter={() => {
                  if (hoverCloseTimeout.current) {
                    clearTimeout(hoverCloseTimeout.current)
                    hoverCloseTimeout.current = null
                  }
                  setMenuOpen(true)
                }}
                onMouseLeave={() => {
                  // small delay so moving cursor from trigger to menu doesn't immediately close it
                  hoverCloseTimeout.current = window.setTimeout(() => {
                    setMenuOpen(false)
                    hoverCloseTimeout.current = null
                  }, 180)
                }}
              >
                {(() => {
                  const meta = (user as any)?.user_metadata || {}
                  const fn = meta.first_name as string | undefined
                  const ln = meta.last_name as string | undefined
                  const displayName = (fn || ln)
                    ? `${fn ?? ''}${fn && ln ? ' ' : ''}${ln ?? ''}`.trim()
                    : user.email || 'Account'
                  const initials = (() => {
                    const a = (fn?.[0] || '').toUpperCase()
                    const b = (ln?.[0] || '').toUpperCase()
                    if (a || b) return `${a}${b}`
                    const em = (user.email || '').trim()
                    return em ? em[0]!.toUpperCase() : 'U'
                  })()
                  const avatarUrl = meta.avatar_url as string | undefined

                  return (
                    <>
                      {/* Trigger: avatar + name (vertical) */}
                      <button
                        type="button"
                        className="flex flex-col items-center gap-1 focus:outline-none"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        title={displayName}
                        onClick={() => setMenuOpen((v) => !v)}
                      >
                        <div className="h-10 w-10 rounded-full bg-neutral-800 border border-white/10 overflow-hidden grid place-items-center">
                          {avatarUrl ? (
                            <img
                              src={avatarUrl}
                              alt={displayName}
                              className="h-full w-full object-cover cursor-pointer"
                              title="Go to profile"
                              onClick={(e) => { e.stopPropagation(); navigate('/profile') }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); navigate('/profile') } }}
                              role="link"
                              tabIndex={0}
                            />
                          ) : (
                            <span
                              className="text-sm text-neutral-300 cursor-pointer"
                              title="Go to profile"
                              onClick={(e) => { e.stopPropagation(); navigate('/profile') }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); navigate('/profile') } }}
                              role="link"
                              tabIndex={0}
                            >
                              {initials}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-neutral-300 max-w-[7rem] truncate">{displayName}</span>
                      </button>

                      {/* Dropdown */}
                      <div
                        role="menu"
                        className={`${menuOpen ? 'visible opacity-100' : 'invisible opacity-0 pointer-events-none'} transition-opacity duration-150 absolute right-0 mt-2 w-44 rounded-md border border-white/10 bg-neutral-900 shadow-xl p-1 z-20`}
                        onMouseEnter={() => {
                          if (hoverCloseTimeout.current) {
                            clearTimeout(hoverCloseTimeout.current)
                            hoverCloseTimeout.current = null
                          }
                          setMenuOpen(true)
                        }}
                        onMouseLeave={() => {
                          hoverCloseTimeout.current = window.setTimeout(() => {
                            setMenuOpen(false)
                            hoverCloseTimeout.current = null
                          }, 180)
                        }}
                      >
                        <div className="px-3 pb-1">
                          <NavLink
                            to="/profile"
                            role="menuitem"
                            onClick={() => setMenuOpen(false)}
                            className={({ isActive }) => `block w-full px-2 py-1.5 rounded-md font-semibold ${isActive ? 'bg-white/10 text-[#a588ef]' : 'text-[#a588ef] hover:bg-white/5'}`}
                          >
                            Profile
                          </NavLink>
                          <NavLink
                            to="/projects"
                            role="menuitem"
                            onClick={() => setMenuOpen(false)}
                            className={({ isActive }) => `mt-1 block w-full px-2 py-1.5 rounded-md ${isActive ? 'bg-white/10 text-white' : 'text-neutral-200 hover:bg-white/5'}`}
                          >
                            Projects
                          </NavLink>
                        </div>
                        <div className="my-1 h-px bg-white/10" />
                        <NavLink
                          to="/settings"
                          role="menuitem"
                          onClick={() => setMenuOpen(false)}
                          className={({ isActive }) => `block w-full px-3 py-2 rounded-md ${isActive ? 'bg-white/10 text-white' : 'text-neutral-200 hover:bg-white/5'}`}
                        >
                          Settings
                        </NavLink>
                        <NavLink
                          to="/profile/settings"
                          role="menuitem"
                          onClick={() => setMenuOpen(false)}
                          className={({ isActive }) => `block w-full px-3 py-2 rounded-md ${isActive ? 'bg-white/10 text-white' : 'text-neutral-200 hover:bg-white/5'}`}
                        >
                          Profile Settings
                        </NavLink>
                        <div className="my-1 h-px bg-white/10" />
                        <button
                          type="button"
                          role="menuitem"
                          className="w-full text-left px-3 py-2 rounded-md text-red-400 hover:bg-red-500/10 hover:text-red-300"
                          onClick={async () => {
                            setMenuOpen(false)
                            try {
                              await supabase.auth.signOut()
                            } finally {
                              navigate('/')
                            }
                          }}
                        >
                          Log out
                        </button>
                      </div>
                    </>
                  )
                })()}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setMode('signIn'); setAuthOpen(true) }}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-white/10 bg-neutral-900/60 text-neutral-200 hover:text-white hover:bg-neutral-800/70 transform-gpu transition-colors transition-transform duration-350 ease-out hover:scale-110 active:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef] shadow-sm"
              >
                Log In
              </button>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Routes>
          <Route
            path="/"
            element={
              user ? (
                <Feed />
              ) : (
                <Landing onStart={() => { setMode('signUp'); setAuthOpen(true) }} />
              )
            }
          />
          <Route path="/start" element={<IntakeForm />} />
          <Route path="/preview" element={<Preview />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/profile/settings" element={<ProfileSettings />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/new" element={<ProjectUpload />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      {/* Auth Modal */}
      {authVisible && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          aria-modal="true"
          role="dialog"
        >
          {/* overlay */}
          <div
            className={`absolute inset-0 bg-black/70 backdrop-blur-sm ${authClosing ? 'animate-veil-opacity-out-slow' : 'animate-veil-opacity-slow'}`}
            onClick={() => setAuthOpen(false)}
          />
          {/* panel */}
          <div
            ref={panelRef}
            onMouseMove={handlePanelMove}
            onMouseLeave={handlePanelLeave}
            className={`relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-6 shadow-2xl metal-glow metal-brushed metal-cut metal-interactive will-change-transform ${authClosing ? 'animate-ghost-pop-out-smooth' : 'animate-ghost-pop-smooth'}`}
          >
            {/* ethereal sweep */}
            <div className="metal-wisp-wide rounded-2xl" aria-hidden />
            <div className="mb-5 text-center">
              <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight flex items-center justify-center">
                <span className="sr-only">Genesis AI</span>
                <MetalInteractiveInline mode="image" maskSrc="/media/genesis-logo.png" className="spin-managed">
                  <img
                    src="/media/genesis-logo.png"
                    alt="Genesis AI logo"
                    ref={modalLogoRef}
                    className="h-24 w-24 sm:h-28 sm:w-28 select-none"
                    draggable={false}
                  />
                </MetalInteractiveInline>
              </h2>
              <p className="mt-1 text-xs text-neutral-400">
                {mode === 'signIn' ? 'Sign In' : 'Create an account'}
              </p>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                if (submitting) return
                if (cooldown > 0) {
                  setAuthError(`For security purposes, please wait ${cooldown}s before trying again`)
                  return
                }
                if (mode === 'signUp') {
                  if (!strongPwRegex.test(password)) {
                    setAuthError('Password must be at least 8 characters and include upper, lower, number, and symbol')
                    return
                  }
                  if (password !== confirmPassword) {
                    setAuthError('Passwords do not match')
                    return
                  }
                }
                setAuthError('')
                setAuthNotice('')
                setSubmitting(true)
                startModalSpin()
                try {
                  const em = email.trim()
                  if (mode === 'signIn') {
                    const { data, error } = await supabase.auth.signInWithPassword({ email: em, password })
                    if (error) throw error
                    if (data.session?.user) {
                      setAuthOpen(false)
                    }
                  } else {
                    const { data, error } = await supabase.auth.signUp({
                      email: em,
                      password,
                      options: { data: { first_name: firstName, last_name: lastName } }
                    })
                    if (error) throw error
                    // Depending on project settings, email confirmation may be required; close modal if we have a session.
                    if (data.session?.user) {
                      setAuthOpen(false)
                    } else if (data.user) {
                      // Sign-up created the user but email confirmation is required
                      setAuthNotice(`We sent a confirmation link to ${em}. Please verify your email to finish creating your account.`)
                      // Prevent rapid re-clicks that cause 429
                      setCooldown((s) => (s > 0 ? s : 60))
                    }
                  }
                } catch (err: any) {
                  // Handle Supabase 429 rate limit nicely
                  const msg: string = err?.message || 'Authentication failed'
                  const is429 = err?.status === 429 || /only request this after/i.test(msg)
                  if (is429) {
                    const secs = (() => {
                      const m = msg.match(/after\s+(\d+)\s*seconds?/i)
                      return m ? parseInt(m[1], 10) : 60
                    })()
                    setCooldown(secs)
                    setAuthError(`For security purposes, please wait ${secs}s before trying again`)
                  } else {
                    setAuthError(msg)
                  }
                }
                finally {
                  stopModalSpin()
                  setSubmitting(false)
                }
              }}
              className="space-y-4"
            >
              {mode === 'signUp' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-sm text-neutral-300">First name</label>
                    <input value={firstName} onChange={(e)=>setFirstName(e.target.value)} className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60" placeholder="Tony" required />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm text-neutral-300">Last name</label>
                    <input value={lastName} onChange={(e)=>setLastName(e.target.value)} className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60" placeholder="Stark" required />
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label className="text-sm text-neutral-300">Email address</label>
                <input
                  type="email"
                  autoComplete={mode === 'signIn' ? 'username' : 'email'}
                  className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60"
                  placeholder="DreamHome@Genesis-AI.tech"
                  value={email}
                  onChange={(e)=>setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm text-neutral-300">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                    minLength={8}
                    title="At least 8 characters, including uppercase, lowercase, number, and symbol"
                    className="w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 pr-10 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60"
                    placeholder="••••••••"
                    required
                    aria-invalid={mode === 'signUp' && !!authError}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute inset-y-0 right-0 grid place-items-center px-3 text-neutral-400 hover:text-[#a588ef] focus:outline-none"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
              </div>

              {mode === 'signIn' && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-sm text-neutral-400 hover:text-[#a588ef]"
                    onClick={() => console.log('[AUTH] forgot password click')}
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {mode === 'signUp' && (
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-neutral-300">Confirm password</label>
                  <div className="relative">
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      title="At least 8 characters, including uppercase, lowercase, number, and symbol"
                      className={`w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 pr-10 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60 ${authError ? 'ring-2 ring-red-500 focus:ring-red-500' : ''}`}
                      placeholder="••••••••"
                      required
                      aria-invalid={!!authError}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(v => !v)}
                      className="absolute inset-y-0 right-0 grid place-items-center px-3 text-neutral-400 hover:text-[#a588ef] focus:outline-none"
                      aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                      title={showConfirmPassword ? 'Hide password' : 'Show password'}
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              {authError && (
                <div className="text-sm text-red-400">{authError}</div>
              )}
              {authNotice && (
                <div className="text-sm text-emerald-300">{authNotice}</div>
              )}
              <div className="mt-2 flex items-center justify-between gap-3">
                <button type="button" className="text-sm text-neutral-400 hover:text-neutral-200" onClick={() => setAuthOpen(false)}>Cancel</button>
                <button
                  type="submit"
                  disabled={submitting || cooldown > 0}
                  className={`btn-accent rounded-md px-4 py-2 text-white ${submitting || cooldown > 0 ? 'opacity-70 cursor-not-allowed' : ''}`}
                >
                  {submitting
                    ? (mode === 'signIn' ? 'Signing in…' : 'Creating…')
                    : cooldown > 0
                      ? `${mode === 'signIn' ? 'Sign In' : 'Create account'} (${cooldown})`
                      : (mode === 'signIn' ? 'Sign In' : 'Create account')}
                </button>
              </div>
            </form>
            <div className="mt-4 text-center text-sm text-neutral-400">
              {mode === 'signIn' ? (
                <button className="hover:text-[#a588ef]" onClick={() => setMode('signUp')}>Create an account</button>
              ) : (
                <button className="hover:text-[#a588ef]" onClick={() => setMode('signIn')}>Already a member? Sign In</button>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-white/10 py-6 text-center text-sm text-neutral-400">
        {new Date().getFullYear()} Genesis AI. All rights reserved.
      </footer>
    </div>
  )
}

export default App
