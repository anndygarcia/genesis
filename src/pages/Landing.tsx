import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

export default function Landing({ onStart }: { onStart?: () => void }) {
  return (
    <div className="relative overflow-hidden">
      {/* Background video + ambient gradients */}
      <div aria-hidden className="absolute inset-0 -z-10 pointer-events-none">
        <video
          className="h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster="/vite.svg"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            console.log('[BG-VIDEO] loadedmetadata', {
              duration: v.duration,
              videoWidth: v.videoWidth,
              videoHeight: v.videoHeight,
              readyState: v.readyState,
            })
          }}
          onPlay={() => console.log('[BG-VIDEO] play fired')}
          onError={(e) => {
            const el = e.currentTarget
            const mediaErr = el.error
            const code = mediaErr?.code ?? 0
            // 1: MEDIA_ERR_ABORTED, 2: MEDIA_ERR_NETWORK, 3: MEDIA_ERR_DECODE, 4: MEDIA_ERR_SRC_NOT_SUPPORTED
            console.error('[BG-VIDEO] error', {
              message: mediaErr?.message ?? 'unknown',
              code,
              currentSrc: el.currentSrc,
              networkState: el.networkState,
              readyState: el.readyState,
            })
          }}
          onLoadedData={(e) => {
            const v = e.currentTarget
            console.log('[BG-VIDEO] loadeddata', { readyState: v.readyState, currentSrc: v.currentSrc })
          }}
          onCanPlay={(e) => {
            const v = e.currentTarget
            console.log('[BG-VIDEO] canplay', { readyState: v.readyState, currentSrc: v.currentSrc })
          }}
          onCanPlayThrough={(e) => console.log('[BG-VIDEO] canplaythrough, readyState=', e.currentTarget.readyState)}
          onStalled={() => console.warn('[BG-VIDEO] stalled')}
          onWaiting={() => console.warn('[BG-VIDEO] waiting')}
          onSuspend={() => console.warn('[BG-VIDEO] suspend (loading paused)')}
          onProgress={(e) => {
            const v = e.currentTarget
            const ranges = [] as string[]
            for (let i = 0; i < v.buffered.length; i++) {
              ranges.push(`${v.buffered.start(i).toFixed(2)}-${v.buffered.end(i).toFixed(2)}`)
            }
            console.log('[BG-VIDEO] progress buffered=', ranges.join(','))
          }}
        >
          {/* Prefer WebM first (confirmed it plays in your Chrome); add cache-busting */}
          <source src="/media/modern-home-video.webm?v=1" type="video/webm" />
          {/* MP4 fallback */}
          <source src="/media/modern-home-video.mp4?v=1" type="video/mp4" />
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
