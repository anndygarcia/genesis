import { Link } from 'react-router-dom'
import { ArrowRight, ChevronRight, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent } from 'react'

const storyCards = [
  {
    title: 'Describe',
    text: 'Speak your vision in natural language and let Genesis AI turn it into a spatial direction.',
  },
  {
    title: 'Refine',
    text: 'Shape the mood, flow, and proportions with a design system that feels responsive and alive.',
  },
  {
    title: 'Render',
    text: 'Move from concept to cinematic 3D with a polished pipeline that keeps the experience inspiring.',
  },
]

const pulseStats = [
  { label: 'AI guided', value: 'Instant' },
  { label: 'Design modes', value: '2D + 3D' },
  { label: 'Workflow', value: 'Interactive' },
]

export default function Landing({ onStart, onExploreViewer }: { onStart?: () => void; onExploreViewer?: () => void }) {
  // Native video background (most reliable). Use env-only; no local fallback.
  const videoWebm = (import.meta.env.VITE_HERO_VIDEO_WEBM as string | undefined) || ''
  const videoMp4 = (import.meta.env.VITE_HERO_VIDEO_MP4 as string | undefined) || ''
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [spotlight, setSpotlight] = useState({ x: 52, y: 34 })

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    // Ensure muted & inline before attempting playback
    el.defaultMuted = true
    el.muted = true
    el.playsInline = true

    const tryPlay = () => {
      const v = videoRef.current
      if (!v) return
      if (document.visibilityState !== 'visible') return
      const p = v.play()
      if (p && typeof p.then === 'function') {
        p.catch(() => {
          // Ignored: will retry on next user interaction
        })
      }
    }

    // Attempt immediately and on visibility changes
    tryPlay()
    const onVis = () => tryPlay()

    // First user interaction fallback for stricter policies
    let interacted = false
    const onFirstInteract = () => {
      if (interacted) return
      interacted = true
      tryPlay()
      window.removeEventListener('pointerdown', onFirstInteract)
      window.removeEventListener('keydown', onFirstInteract)
    }

    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pointerdown', onFirstInteract, { once: true })
    window.addEventListener('keydown', onFirstInteract, { once: true })

    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pointerdown', onFirstInteract)
      window.removeEventListener('keydown', onFirstInteract)
    }
  }, [])

  const handleSpotlightMove = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = ((event.clientX - rect.left) / rect.width) * 100
    const y = ((event.clientY - rect.top) / rect.height) * 100
    setSpotlight({
      x: Math.min(100, Math.max(0, x)),
      y: Math.min(100, Math.max(0, y)),
    })
  }

  return (
    <div className="relative overflow-hidden">
      {/* Background video + ambient gradients */}
      <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
        {videoWebm || videoMp4 ? (
          <video
            className="h-full w-full object-cover"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster="/vite.svg"
            ref={videoRef}
            onCanPlay={() => {
              // Try again when enough data is available
              try {
                videoRef.current?.play()
              } catch {}
            }}
          >
            {/* Prefer WebM when available; browser will skip missing/unsupported sources */}
            {videoWebm ? <source src={videoWebm} type="video/webm" /> : null}
            {videoMp4 ? <source src={videoMp4} type="video/mp4" /> : null}
          </video>
        ) : (
          // Fallback gradient background when no env video provided
          <div className="h-full w-full bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900" />
        )}
        {/* darken for readability */}
        <div className="absolute inset-0 bg-black/50" />
        <div
          className="absolute inset-0 opacity-90 transition-opacity duration-300"
          style={{
            background: `radial-gradient(circle at ${spotlight.x}% ${spotlight.y}%, rgba(165, 136, 239, 0.20), transparent 30%), radial-gradient(circle at ${100 - spotlight.x}% ${100 - spotlight.y}%, rgba(34, 211, 238, 0.10), transparent 28%)`,
          }}
        />
        {/* subtle color glows on top */}
        <div className="absolute left-1/2 top-[-10%] h-[40rem] w-[40rem] -translate-x-1/2 rounded-full blur-3xl opacity-35 dark:opacity-25 bg-[radial-gradient(circle_at_center,theme(colors.indigo.500/.6),transparent_60%)]" />
        <div className="absolute right-[-10%] bottom-[-10%] h-[36rem] w-[36rem] rounded-full blur-3xl opacity-30 dark:opacity-20 bg-[radial-gradient(circle_at_center,theme(colors.fuchsia.500/.6),transparent_60%)]" />
        <div className="absolute left-[-10%] bottom-[-20%] h-[30rem] w-[30rem] rounded-full blur-3xl opacity-20 bg-[radial-gradient(circle_at_center,theme(colors.cyan.400/.6),transparent_60%)]" />
      </div>

      <section
        className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 pt-20 sm:pt-28"
        onMouseMove={handleSpotlightMove}
        onMouseLeave={() => setSpotlight({ x: 52, y: 34 })}
      >
        <div className="rounded-[2rem] border border-white/10 bg-neutral-950/70 p-5 sm:p-8 shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl">
          <div className="grid items-center gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:gap-12">
            {/* Copy */}
            <div className="text-center lg:text-left max-w-2xl mx-auto lg:mx-0">
              <div className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-white/95 bg-white/10 ring-1 ring-white/20 backdrop-blur supports-[backdrop-filter]:bg-white/15 dark:supports-[backdrop-filter]:bg-neutral-900/50 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
                <span className="inline-block h-2 w-2 rounded-full bg-gradient-to-r from-indigo-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_10px_rgba(168,85,247,0.8)] animate-pulse" />
                <span className="drop-shadow-[0_1px_0_rgba(0,0,0,0.6)]">Genesis AI for inspired home design</span>
              </div>

              <h1 className="mt-5 text-4xl/tight sm:text-6xl/tight font-semibold tracking-tight text-white">
                <span className="metal-text-satin metal-shine">Imagine a home,</span>
                <br />
                <span className="metal-text-satin metal-shine">and watch it become architecture.</span>
              </h1>

              <p className="mt-6 text-base sm:text-lg leading-8 text-neutral-300 max-w-prose mx-auto lg:mx-0">
                Genesis AI turns a feeling, a sketch, or a sentence into a vivid spatial concept.
                Explore the flow from imagination to plan to 3D with a polished experience that feels creative, immediate, and human.
              </p>

              <div className="mt-8 flex flex-wrap items-center justify-center lg:justify-start gap-4">
                <Link
                  to="/start"
                  onClick={(e) => {
                    if (onStart) {
                      e.preventDefault()
                      onStart()
                    }
                  }}
                  className="inline-flex items-center gap-2 rounded-md btn-accent px-5 py-3 text-white shadow-[0_0_20px_rgba(165,136,239,0.24)] transition-transform duration-300 ease-out hover:scale-[1.03] active:scale-[0.99]"
                >
                  Start your design
                  <ArrowRight className="size-4" />
                </Link>
                <Link
                  to="/viewer-upload"
                  onClick={(e) => {
                    if (onExploreViewer) {
                      e.preventDefault()
                      onExploreViewer()
                    }
                  }}
                  className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-5 py-3 text-white/90 shadow-sm transition-colors duration-300 ease-out hover:bg-white/10 hover:text-white"
                >
                  Explore the viewer
                  <ChevronRight className="size-4" />
                </Link>
              </div>

              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                {pulseStats.map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 transition-transform duration-300 ease-out hover:-translate-y-1 hover:border-white/20"
                  >
                    <div className="text-[11px] uppercase tracking-[0.22em] text-neutral-400">{stat.label}</div>
                    <div className="mt-1 text-sm font-semibold text-white">{stat.value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-8 flex flex-wrap items-center justify-center lg:justify-start gap-3">
                {storyCards.map((item) => (
                  <div
                    key={item.title}
                    className="group w-full max-w-[16rem] rounded-2xl border border-white/10 bg-black/15 px-4 py-4 text-left backdrop-blur-sm transition-all duration-300 ease-out hover:-translate-y-1 hover:border-[#a588ef]/30 hover:bg-black/22"
                  >
                    <div className="flex items-center justify-between gap-2 text-sm font-semibold text-white">
                      <span>{item.title}</span>
                      <Sparkles className="size-4 text-[#a588ef] transition-transform duration-300 group-hover:scale-110" />
                    </div>
                    <p className="mt-2 text-sm leading-6 text-neutral-300">{item.text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Interactive preview */}
            <div className="relative mx-auto w-full max-w-xl lg:mx-0">
              <div className="absolute inset-0 rounded-[2.25rem] bg-gradient-to-br from-[#a588ef]/25 via-fuchsia-500/10 to-cyan-400/10 blur-3xl opacity-70 transition-opacity duration-300" />

              <div className="relative overflow-hidden rounded-[2.25rem] border border-white/10 bg-neutral-950/80 shadow-[0_20px_80px_rgba(0,0,0,0.45)]">
                <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 text-xs uppercase tracking-[0.22em] text-neutral-400">
                  <span>Studio pulse</span>
                  <span className="inline-flex items-center gap-2 text-[#d8cfff]">
                    Live inspiration
                    <Sparkles className="size-3.5" />
                  </span>
                </div>

                <div className="p-5 sm:p-6">
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      { label: 'Vision', value: 'Plain language' },
                      { label: 'Layout', value: 'Spatial logic' },
                      { label: 'Finish', value: 'Cinematic render' },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 transition-transform duration-300 ease-out hover:-translate-y-1 hover:border-white/20"
                      >
                        <div className="text-[11px] uppercase tracking-[0.22em] text-neutral-400">{item.label}</div>
                        <div className="mt-2 text-sm font-semibold text-white">{item.value}</div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(165,136,239,0.14),_transparent_55%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-4 sm:p-5">
                    <div className="grid grid-cols-3 gap-2 pt-10">
                      {[
                        'Concept',
                        'Shape',
                        'Polish',
                      ].map((label, index) => (
                        <div key={label} className="rounded-2xl border border-white/10 bg-black/30 p-3 backdrop-blur-sm">
                          <div className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">{label}</div>
                          <div className="mt-3 h-16 rounded-xl border border-white/10 bg-[linear-gradient(180deg,rgba(165,136,239,0.22),rgba(255,255,255,0.02))]">
                            <div className="h-full rounded-xl bg-[radial-gradient(circle_at_50%_38%,rgba(255,255,255,0.18),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.08),transparent)]" />
                          </div>
                          <div className="mt-2 text-xs text-neutral-400">Step {index + 1}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
