import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useEffect, useRef } from 'react'

export default function Landing({ onStart }: { onStart?: () => void }) {
  // Native video background (most reliable). Allow env override; default to local file.
  const videoWebm = (import.meta.env.VITE_HERO_VIDEO_WEBM as string | undefined) ?? '/media/modern-home-video.webm'
  const videoMp4 = (import.meta.env.VITE_HERO_VIDEO_MP4 as string | undefined) ?? '/media/modern-home-video.mp4'
  const videoRef = useRef<HTMLVideoElement | null>(null)

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
  return (
    <div className="relative overflow-hidden">
      {/* Background video + ambient gradients */}
      <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
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
          {/* Prefer WebM when available for broader compatibility; browser will skip missing/unsupported sources */}
          <source src={videoWebm} type="video/webm" />
          <source src={videoMp4} type="video/mp4" />
        </video>
        {/* darken for readability */}
        <div className="absolute inset-0 bg-black/50" />
        {/* subtle color glows on top */}
        <div className="absolute left-1/2 top-[-10%] h-[40rem] w-[40rem] -translate-x-1/2 rounded-full blur-3xl opacity-35 dark:opacity-25 bg-[radial-gradient(circle_at_center,theme(colors.indigo.500/.6),transparent_60%)]" />
        <div className="absolute right-[-10%] bottom-[-10%] h-[36rem] w-[36rem] rounded-full blur-3xl opacity-30 dark:opacity-20 bg-[radial-gradient(circle_at_center,theme(colors.fuchsia.500/.6),transparent_60%)]" />
        <div className="absolute left-[-10%] bottom-[-20%] h-[30rem] w-[30rem] rounded-full blur-3xl opacity-20 bg-[radial-gradient(circle_at_center,theme(colors.cyan.400/.6),transparent_60%)]" />
      </div>

      <section className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 pt-20 sm:pt-28">
        {/* Dark concrete hero panel */}
        <div className="rounded-3xl texture-concrete-dark p-6 sm:p-10 border border-white/5 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
          <div className="grid items-center justify-items-center gap-10 md:grid-cols-1">
            {/* Copy */}
            <div className="text-center max-w-2xl mx-auto">
              <div className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-white/95 bg-white/10 ring-1 ring-white/20 backdrop-blur supports-[backdrop-filter]:bg-white/15 dark:supports-[backdrop-filter]:bg-neutral-900/50 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
                <span className="inline-block h-2 w-2 rounded-full bg-gradient-to-r from-indigo-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_10px_rgba(168,85,247,0.8)] animate-pulse" />
                <span className="drop-shadow-[0_1px_0_rgba(0,0,0,0.6)]">Next‑gen AI Home Designer</span>
              </div>
              <h1 className="mt-4 text-4xl/tight sm:text-6xl/tight font-semibold tracking-tight">
                <span className="metal-text-satin metal-shine">From idea to ideal.</span>
                <br />
                <span className="metal-text-satin metal-shine">Genesis AI engineers your one‑of‑a‑kind Dream Custom Home.</span>
              </h1>
              <p className="mt-5 text-neutral-600 dark:text-neutral-300 max-w-prose">
                A sleek pipeline that converts your vision into elegant 2D plans and cinematic 3D renders.
                Purely frontend demo for now—experience the interface and motion design.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                {/* If onStart provided, intercept click and open sign-up modal */}
                <Link
                  to="/start"
                  onClick={(e) => {
                    if (onStart) {
                      e.preventDefault()
                      onStart()
                    }
                  }}
                  className="inline-flex items-center gap-2 rounded-md btn-accent px-5 py-3 text-white shadow-sm transition"
                >
                  Start your design
                  <ArrowRight className="size-4" />
                </Link>
              </div>
            </div>
            {/* Right-side illustration removed for a more symmetrical, centered hero */}
          </div>
        </div>
        {/* control dock removed */}
      </section>
    </div>
  )
}
