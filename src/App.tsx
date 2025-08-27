import { useEffect, useRef, useState } from 'react'
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'
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

function App() {
  const navigate = useNavigate()
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('dark')
    localStorage.setItem('theme', 'dark')
  }, [])
  const [authOpen, setAuthOpen] = useState(false)
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
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      setUser(session?.user ?? null)
    })
    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return (
    <div className="min-h-full flex flex-col texture-concrete-dark">
      <header className="border-b border-white/10 bg-neutral-950/60 backdrop-blur-xl sticky top-0 z-10">
        <div className="relative mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          {/* Centered brand text logo */}
          <NavLink
            to="/"
            aria-label="Genesis AI Home"
            className="absolute left-1/2 -translate-x-1/2 hidden sm:block select-none"
          >
            <span className="metal-text-satin metal-shine text-lg md:text-2xl font-extrabold tracking-[0.35em] drop-shadow-[0_1px_6px_rgba(165,136,239,0.25)]">
              GENESIS AI
            </span>
          </NavLink>
          <NavLink to="/" className="text-xl font-semibold tracking-tight">
            <span className="sr-only">Genesis AI</span>
            <img
              src="/media/genesis-logo.png"
              alt="Genesis AI logo"
              className="h-12 w-12 sm:h-16 sm:w-16 select-none"
              draggable={false}
            />
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
                  // small delay so moving cursor from button to menu doesn't immediately close it
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
                            <img src={avatarUrl} alt={displayName} className="h-full w-full object-cover" />
                          ) : (
                            <span className="text-sm text-neutral-300">{initials}</span>
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
                className="text-neutral-200 hover:text-[#a588ef]"
              >
                Log In
              </button>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/start" element={<IntakeForm />} />
          <Route path="/preview" element={<Preview />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/profile/settings" element={<ProfileSettings />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      {/* Auth Modal */}
      {authOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          aria-modal="true"
          role="dialog"
        >
          {/* overlay */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setAuthOpen(false)}
          />
          {/* panel */}
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-6 shadow-2xl">
            <div className="mb-5 text-center">
              <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight flex items-center justify-center">
                <span className="sr-only">Genesis AI</span>
                <img
                  src="/media/genesis-logo.png"
                  alt="Genesis AI logo"
                  className="h-24 w-24 sm:h-28 sm:w-28 select-none"
                  draggable={false}
                />
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
