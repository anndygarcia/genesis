import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react'
import { createProject } from '../lib/supabase'
import { buildShell, generateHouse, GenesisApiError, pipelineHealth } from '../lib/genesis-api'
import { stageFloorPlanForStudio } from '../lib/floorplan'
import { toast } from '../components/Toast'

const STEPS = ["Style", "Details", "Notes"] as const

// (removed unused Step type)

type FormData = {
  basics: { floors: number; sqft: number }
  rooms: { beds: number; baths: number; garage: number }
  style: { archetype: string; refs: string[] }
  budget: { amount: number | null }
  notes: string
}

const STYLE_OPTIONS: { label: string; value: string }[] = [
  { label: 'Modern', value: 'modern' },
  { label: 'Farmhouse', value: 'farmhouse' },
  { label: 'Mediterranean', value: 'mediterranean' },
  { label: 'Spanish', value: 'spanish' },
  { label: 'Barndominium', value: 'barndominium' },
  { label: 'Log Cabin', value: 'log-cabin' },
  { label: 'Ranch House', value: 'ranch-house' },
  { label: 'Victorian', value: 'victorian' },
  { label: 'Contemporary', value: 'contemporary' },
]

const defaultData: FormData = {
  basics: { floors: 1, sqft: 1800 },
  rooms: { beds: 3, baths: 2, garage: 0 },
  style: { archetype: '', refs: [] },
  budget: { amount: null },
  notes: ''
}

export default function IntakeForm() {
  const navigate = useNavigate()
  const [stepIndex, setStepIndex] = useState(0)
  const [data, setData] = useState<FormData>(() => {
    const saved = localStorage.getItem('hdv1')
    if (!saved) return defaultData
    try {
      const parsed = JSON.parse(saved) as Partial<FormData>
      // Shallow-safe merge to ensure new fields like rooms.garage and style.refs exist
      return {
        ...defaultData,
        ...parsed,
        basics: { ...defaultData.basics, ...(parsed as any).basics },
        rooms: { ...defaultData.rooms, ...(parsed as any).rooms },
        style: { ...defaultData.style, ...(parsed as any).style },
        budget: { ...defaultData.budget, ...(parsed as any).budget },
      }
    } catch {
      return defaultData
    }
  })
  // Upload state for reference images (persisted to Supabase)
  // (unused while voice is disabled and uploads handled elsewhere)
  const [creating, setCreating] = useState(false)
  // Pipeline generation state
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string>('')
  const [pipelineOnline, setPipelineOnline] = useState(false)
  const [blenderAvailable, setBlenderAvailable] = useState(false)
  // Feature flag to disable voice end-to-end (read from Vite env)
  const DISABLE_VOICE = String(((import.meta as any).env.VITE_DISABLE_VOICE ?? '')).toLowerCase() === 'true'
  // Voice agent overlay (disabled when feature flag is on)
  const [agentOpen, setAgentOpen] = useState(!DISABLE_VOICE)
  const [dockX, setDockX] = useState<number | null>(null)
  // Realtime voice agent state
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const REALTIME_MODEL = (import.meta as any).env.VITE_OPENAI_REALTIME_MODEL || 'gpt-5-realtime-preview'
  const REALTIME_VOICE = (import.meta as any).env.VITE_OPENAI_VOICE || 'verse'
  const SDP_ENDPOINT = (import.meta as any).env.VITE_REALTIME_SDP_ENDPOINT || '/api/realtime/sdp'

  // (removed unused helpers and upload stub)

  useEffect(() => {
    localStorage.setItem('hdv1', JSON.stringify(data))
  }, [data])

  // (removed unused budget input sync)

  // Disconnect on unmount
  useEffect(() => {
    return () => {
      try { disconnectVoice() } catch {}
    }
  }, [])

  // Auto-start voice on mount and try to unlock playback on first gesture (skipped when disabled)
  useEffect(() => {
    if (DISABLE_VOICE) return
    const tryConnect = () => { if (!connected && !connecting) connectVoice() }
    // Attempt immediately
    tryConnect()

    const unlock = () => {
      const el = audioElRef.current as HTMLMediaElement | null
      if (el) {
        const p = el.play?.()
        if (p && typeof p.then === 'function') p.catch(() => {/* ignored */})
      }
    }

    const onUserGesture = () => { unlock() }
    const onVisibility = () => { if (document.visibilityState === 'visible') tryConnect() }

    window.addEventListener('click', onUserGesture, { once: true })
    window.addEventListener('keydown', onUserGesture, { once: true })
    window.addEventListener('touchstart', onUserGesture, { once: true })
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('click', onUserGesture)
      window.removeEventListener('keydown', onUserGesture)
      window.removeEventListener('touchstart', onUserGesture)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  async function connectVoice() {
    if (DISABLE_VOICE) return
    if (connecting || connected) return
    setConnecting(true)
    try {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302','stun:global.stun.twilio.com:3478'] },
        ],
        // More tolerant for NATs
        iceTransportPolicy: 'all',
      } as RTCConfiguration)
      pcRef.current = pc

      // Play remote audio
      pc.ontrack = (event) => {
        const [stream] = event.streams
        if (audioElRef.current) {
          audioElRef.current.srcObject = stream
          ;(audioElRef.current as HTMLMediaElement).muted = false
          ;(audioElRef.current as HTMLMediaElement).volume = 1
          // Attempt to resume playback explicitly to satisfy autoplay policies
          const p = (audioElRef.current as HTMLMediaElement).play?.()
          if (p && typeof p.then === 'function') p.catch((e: any) => {
            // eslint-disable-next-line no-console
            console.warn('[voice] autoplay play() was blocked; will retry on user gesture/visibilitychange', e)
          })
          // Try a few timed resumes in case autoplay was blocked transiently
          let retries = 5
          const tick = () => {
            if (!audioElRef.current || retries-- <= 0) return
            const pr = (audioElRef.current as HTMLMediaElement).play?.()
            if (pr && typeof pr.then === 'function') pr.catch(() => { setTimeout(tick, 800) })
          }
          setTimeout(tick, 800)
        }
      }

      // Data channel for events/tools
      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          handleRealtimeMessage(msg)
        } catch {}
      }

      // Create a single audio transceiver that will both send our mic and receive remote audio
      let audioTransceiver: RTCRtpTransceiver | null = null
      try { audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' }) } catch {}

      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
        } as MediaTrackConstraints,
      })
      micStreamRef.current = mic
      const track = mic.getAudioTracks()[0]
      if (audioTransceiver && track) {
        // Only replace if PC is alive
        if (pcRef.current && pcRef.current.connectionState !== 'closed') {
          await audioTransceiver.sender.replaceTrack(track)
        }
        // Restart mic automatically if it ends (device change or permission blip)
        track.onended = async () => {
          // eslint-disable-next-line no-console
          console.warn('[voice] mic track ended, attempting to reacquire')
          try {
            const newMic = await navigator.mediaDevices.getUserMedia({ audio: true })
            const nt = newMic.getAudioTracks()[0]
            if (nt && pcRef.current && pcRef.current.connectionState !== 'closed') {
              await audioTransceiver!.sender.replaceTrack(nt)
            }
            micStreamRef.current = newMic
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[voice] failed to reacquire mic', e)
          }
        }
      }

      // Offer/Answer via your backend proxy
      if (pc.signalingState === 'closed') {
        throw new Error('PC closed before createOffer')
      }
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false })
      await pc.setLocalDescription(offer)

      // Wait for ICE gathering to complete to maximize server connectivity
      await new Promise<void>((resolve) => {
        if (!pcRef.current) return resolve()
        if (pcRef.current.iceGatheringState === 'complete') return resolve()
        const check = () => {
          if (!pcRef.current) return resolve()
          if (pcRef.current.iceGatheringState === 'complete') {
            pcRef.current.removeEventListener('icegatheringstatechange', check)
            resolve()
          }
        }
        pcRef.current.addEventListener('icegatheringstatechange', check)
        // Safety timeout 1.5s
        setTimeout(() => resolve(), 1500)
      })

      // ICE diagnostics
      pc.onicegatheringstatechange = () => console.log('[voice] iceGatheringState:', pc.iceGatheringState)
      pc.oniceconnectionstatechange = () => console.log('[voice] iceConnectionState:', pc.iceConnectionState)
      pc.onicecandidateerror = (e: any) => console.warn('[voice] iceCandidateError', e?.errorCode, e?.errorText)

      // eslint-disable-next-line no-console
      if (!SDP_ENDPOINT) {
        console.error('[voice] Missing VITE_REALTIME_SDP_ENDPOINT. Check your .env.local and restart Vite.')
      }
      console.log('[voice] POST SDP to', SDP_ENDPOINT)
      const res = await fetch(SDP_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: REALTIME_MODEL, sdp: offer.sdp }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Failed to create Realtime session (SDP): ${res.status} ${text}`)
      }
      const { sdp: answerSdp } = await res.json()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

      pc.onconnectionstatechange = () => {
        // eslint-disable-next-line no-console
        console.log('[voice] pc state:', pc.connectionState)
        if (pc.connectionState === 'connected') {
          setConnected(true)
          // Ensure audio is unmuted and tries to play
          if (audioElRef.current) {
            ;(audioElRef.current as HTMLMediaElement).muted = false
            ;(audioElRef.current as HTMLMediaElement).volume = 1
            const p = (audioElRef.current as HTMLMediaElement).play?.()
            if (p && typeof p.then === 'function') p.catch(() => {/* ignored */})
          }
          // Configure session: enable audio + our tools
          sendSessionUpdate()
          // Greet via model
          sendUserMessage('Greetings! What type of house would you like to build today? You can say things like: "Show me modern" or "Pick ranch house".')
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          cleanupVoice()
        } else if (pc.connectionState === 'disconnected') {
          // Allow brief network hiccups to recover before tearing down
          const current = pc
          setTimeout(() => {
            if (pcRef.current === current && current.connectionState === 'disconnected') {
              // eslint-disable-next-line no-console
              console.warn('[voice] still disconnected after grace period; cleaning up')
              cleanupVoice()
            }
          }, 5000)
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[voice] connect error', err)
      alert('Unable to start voice session. Check mic permissions and the SDP proxy logs. See console for details.')
      cleanupVoice()
    } finally {
      setConnecting(false)
    }
  }

  function cleanupVoice() {
    setConnected(false)
    if (dcRef.current) { try { dcRef.current.close() } catch {} dcRef.current = null }
    if (pcRef.current) { try { pcRef.current.close() } catch {} pcRef.current = null }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null }
  }

  function disconnectVoice() { cleanupVoice() }

  function postEvent(event: any) {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify(event))
  }

  function sendSessionUpdate() {
    postEvent({
      type: 'session.update',
      session: {
        instructions:
          'You are a friendly, warm home-design assistant. Sound natural and human: use contractions, vary sentence length, add brief pauses and confirmations, and keep responses under 2 sentences unless asked for detail. If the user states or implies a house style, call the set_style tool with one of: modern, farmhouse, mediterranean, spanish, barndominium, log-cabin, ranch-house, victorian, contemporary.',
        modalities: ['text','audio'],
        audio: { voice: REALTIME_VOICE },
        tools: [
          {
            type: 'function',
            name: 'set_style',
            description: 'Set the selected house style in the UI',
            parameters: {
              type: 'object',
              properties: { style: { type: 'string', enum: STYLE_OPTIONS.map(o => o.value) } },
              required: ['style']
            }
          }
        ]
      }
    })
  }

  function sendUserMessage(text: string) {
    postEvent({
      type: 'response.create',
      response: {
        modalities: ['text','audio'],
        instructions: text,
      }
    })
  }

  // Minimal tool routing from Realtime messages
  async function handleRealtimeMessage(msg: any) {
    // response.output_item.done fires when a tool call item is fully streamed
    if (msg.type === 'response.output_item.done' && msg.item?.type === 'function_call') {
      const tool = msg.item
      if (tool.name === 'set_style') {
        // arguments arrives as a JSON string from the Realtime API
        let parsedArgs: { style?: string } = {}
        try { parsedArgs = JSON.parse(tool.arguments || '{}') } catch {}
        const { style } = parsedArgs
        if (style && STYLE_OPTIONS.some(o => o.value === style)) {
          setData(d => ({ ...d, style: { ...d.style, archetype: style } }))
          // Submit tool output using the Realtime API conversation item format
          postEvent({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: tool.call_id,
              output: JSON.stringify({ ok: true }),
            },
          })
          // Prompt the model to continue after receiving the tool result
          postEvent({ type: 'response.create' })
          // close overlay once chosen
          setAgentOpen(false)
        }
      }
    }
  }

  function next() {
    if (stepIndex < STEPS.length - 1) setStepIndex(i => i + 1)
    else navigate('/preview')
  }
  function prev() {
    if (stepIndex > 0) setStepIndex(i => i - 1)
  }

  // Poll pipeline health so we can disable the generate button when offline.
  useEffect(() => {
    let mounted = true
    const check = async () => {
      const res = await pipelineHealth()
      if (mounted) {
        setPipelineOnline(res.ok)
        setBlenderAvailable(!!res.capabilities?.blender_shell)
      }
    }
    check()
    const id = setInterval(check, 10_000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  async function onGenerateHome() {
    if (generating) return
    setGenerateError('')
    // Graceful pre-flight: confirm the server is reachable.
    const health = await pipelineHealth()
    if (!health.ok) {
      const apiUrl = (import.meta as any).env?.VITE_GENESIS_API_URL || 'http://127.0.0.1:8787'
      const msg = `Pipeline is offline. Start it first:\n  uvicorn pipeline.api.server:app --port 8787\nOr set VITE_GENESIS_API_URL=${apiUrl}`
      setGenerateError(msg)
      toast.error(msg)
      return
    }
    setGenerating(true)
    try {
      toast.info(`Generating ${data.style.archetype || 'modern'} home…`)
      const intakePayload = {
        basics: data.basics,
        rooms: data.rooms,
        style: data.style,
        budget: data.budget,
        notes: data.notes,
      }
      const { plan, brief } = await generateHouse(intakePayload)
      // Stash the exact intake we sent so the brief panel can replay it
      // for /refine_plan without needing the user to re-fill the form.
      try {
        localStorage.setItem('genesis_intake_v1', JSON.stringify(intakePayload))
      } catch {}
      toast.success(`Home generated! ${plan.rooms.length} rooms, ${plan.walls.length} walls, ${plan.furniture.length} furniture items.`)
      // Stage the FloorPlan into CreateStudio's draft storage so the
      // editor opens with the generated home pre-loaded.
      stageFloorPlanForStudio(plan)
      try {
        // Surface the architect brief to the editor for an info banner.
        localStorage.setItem('genesis_architect_brief_v1', JSON.stringify(brief))
        // A new home was generated; reset any prior dismissal so the
        // brief panel reappears for the user.
        localStorage.removeItem('genesis_brief_dismissed_v1')
        // Mark shell build as pending so the editor shows a status pill
        // while Blender does its work in the background.
        localStorage.setItem('genesis_shell_status_v1', JSON.stringify({
          state: 'pending', startedAt: new Date().toISOString(),
        }))
        localStorage.removeItem('genesis_shell_v1')
      } catch {}

      // Fire-and-forget the Blender shell build only if Blender is known
      // to be available. Otherwise we skip the 503 and use templated mode.
      if (blenderAvailable) {
        void buildShell({ plan }).then((res) => {
          try {
            localStorage.setItem('genesis_shell_v1', JSON.stringify(res))
            localStorage.setItem('genesis_shell_status_v1', JSON.stringify({
              state: 'ready', updatedAt: new Date().toISOString(),
            }))
            toast.success('3D shell build complete!')
          } catch {}
        }).catch((err) => {
          const is503 = err instanceof GenesisApiError && err.status === 503
          if (is503) {
            toast.info('Using templated 3D mode (install Blender for photoreal shells).')
          } else {
            // eslint-disable-next-line no-console
            console.warn('[shell] background build failed', err)
            toast.warning('Shell build failed — using templated primitives.')
          }
          try {
            localStorage.setItem('genesis_shell_status_v1', JSON.stringify({
              state: 'failed',
              updatedAt: new Date().toISOString(),
              message: err instanceof GenesisApiError
                ? `${err.status}: ${err.body?.slice(0, 240) || 'pipeline error'}`
                : (err instanceof Error ? err.message : 'unknown error'),
            }))
          } catch {}
        })
      } else {
        try {
          localStorage.setItem('genesis_shell_status_v1', JSON.stringify({
            state: 'skipped',
            updatedAt: new Date().toISOString(),
            message: 'Blender not available — using templated 3D mode. Install Blender to enable photoreal shells.',
          }))
        } catch {}
      }

      navigate('/start')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[generate_home] failed', err)
      const msg = err instanceof GenesisApiError
        ? `Pipeline error ${err.status}. Is the API running on ${(import.meta as any).env?.VITE_GENESIS_API_URL || 'http://127.0.0.1:8787'}?`
        : err instanceof Error
          ? err.message
          : 'Unknown error'
      setGenerateError(msg)
      toast.error(msg)
    } finally {
      setGenerating(false)
    }
  }

  async function onCreateProject() {
    if (creating) return
    try {
      setCreating(true)
      // Name fallback from style archetype or generic label
      const styleName = data.style.archetype
        ? data.style.archetype.replace(/(^|[-_\s])([a-z])/g, (_m, p1, p2) => (p1 ? ' ' : '') + String(p2).toUpperCase())
        : ''
      const name = styleName ? `My ${styleName} Home` : 'Untitled Project'

      // Refs already store public URLs (uploaded via uploadReferenceImages)
      const image_urls = data.style.refs || []

      await createProject({
        name,
        location: null,
        style: data.style.archetype || null,
        sqft: data.basics.sqft ?? null,
        price_amount: data.budget.amount ?? null,
        image_urls,
        is_public: true,
      })
      // Navigate to user's projects (could also go to feed: '/')
      navigate('/projects')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Create project failed', err)
      alert('Failed to create project. Please make sure you are signed in and try again.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      {!DISABLE_VOICE && agentOpen && (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center">
          {/* backdrop */}
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setAgentOpen(false)} />
          {/* panel */}
          <div className="relative z-10 w-full max-w-4xl mx-auto p-4 sm:p-6">
            <div className="rounded-2xl border border-white/10 bg-neutral-900/95 shadow-2xl overflow-hidden">
              <div className="p-4 sm:p-6">
                <h2 className="text-2xl sm:text-3xl font-semibold text-white text-center">
                  Greetings, what type of House would you like to build today?
                </h2>
                <p className="mt-2 text-center text-neutral-400 text-sm">Hover and slide across the dock to choose a style</p>
                <div className="mt-4 flex items-center justify-center gap-3">
                  {!connected ? (
                    <button
                      type="button"
                      onClick={connectVoice}
                      disabled={connecting}
                      className="rounded-md border border-white/10 px-3 py-1.5 text-neutral-200 hover:bg-white/10"
                      title="Retry voice connection"
                    >
                      {connecting ? 'Connecting…' : 'Retry connect'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={disconnectVoice}
                      className="rounded-md border border-white/10 px-3 py-1.5 text-neutral-200 hover:bg-white/10"
                    >
                      Disconnect
                    </button>
                  )}
                  {/* Hidden audio element to satisfy autoplay policies and allow explicit play() */}
                  <audio ref={audioElRef} autoPlay className="sr-only" />
                </div>
              </div>
              {/* Dock-like selector */}
              <div
                className="relative px-4 pb-4 sm:px-6 sm:pb-6"
                onMouseMove={(e) => {
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
                  setDockX(e.clientX - rect.left)
                }}
                onMouseLeave={() => setDockX(null)}
              >
                <div className="mx-auto max-w-3xl">
                  <ul className="flex items-end justify-center gap-3 sm:gap-4 select-none">
                    {STYLE_OPTIONS.map((opt, idx) => {
                      const itemWidth = 96 // px approximate slot width
                      const center = (idx + 0.5) * itemWidth
                      const x = dockX ?? center
                      const dist = Math.abs(x - center)
                      const influence = Math.max(0, 1 - dist / 160) // linear falloff
                      const scale = 1 + influence * 0.9 // up to ~1.9x
                      return (
                        <li key={opt.value} className="transition-transform duration-120 will-change-transform"
                          style={{ transform: `translateZ(0) scale(${scale.toFixed(3)})` }}
                        >
                          <button
                            type="button"
                            onClick={() => { setData(d => ({ ...d, style: { ...d.style, archetype: opt.value } })); setAgentOpen(false) }}
                            className={`w-24 sm:w-28 aspect-[3/4] rounded-xl border ${data.style.archetype===opt.value ? 'border-[#a588ef] ring-2 ring-[#a588ef]/60' : 'border-white/10'} bg-neutral-800/60 hover:bg-neutral-800 text-white shadow-md overflow-hidden`}
                            title={opt.label}
                          >
                            <div className="h-full w-full grid place-items-center p-2">
                              <div className="text-sm sm:text-base font-semibold text-center leading-tight px-1">{opt.label}</div>
                              <div className="mt-1 text-[10px] sm:text-xs text-neutral-400">Click to choose</div>
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
              <div className="px-4 pb-4 sm:px-6 sm:pb-6 flex justify-center gap-3">
                <button
                  type="button"
                  className="rounded-md border border-white/10 px-3 py-1.5 text-neutral-300 hover:bg-white/10"
                  onClick={() => setAgentOpen(false)}
                >
                  Skip for now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Step progress bar */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          {STEPS.map((stepName, i) => (
            <button
              key={stepName}
              type="button"
              onClick={() => setStepIndex(i)}
              className={`text-sm font-medium transition-colors ${i <= stepIndex ? 'text-[#a588ef]' : 'text-neutral-500'}`}
            >
              {stepName}
            </button>
          ))}
        </div>
        <div className="h-1 rounded-full bg-neutral-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#a588ef] to-purple-400 transition-all duration-500 ease-out"
            style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Step Content */}
      <div className="min-h-[420px]">
        {/* Step 1: Style */}
        {stepIndex === 0 && (
          <div>
            <h2 className="text-2xl font-semibold text-white mb-1">Choose your style</h2>
            <p className="text-neutral-400 text-sm mb-6">Select the architectural style that speaks to you. This guides the AI's design choices.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {STYLE_OPTIONS.map((opt) => {
                const isSelected = data.style.archetype === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setData(d => ({ ...d, style: { ...d.style, archetype: opt.value } }))}
                    className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-200 ease-out hover:-translate-y-0.5 ${
                      isSelected
                        ? 'border-[#a588ef] bg-[#a588ef]/10 ring-1 ring-[#a588ef]/40 shadow-[0_0_24px_rgba(165,136,239,0.15)]'
                        : 'border-white/10 bg-neutral-900/60 hover:border-white/20 hover:bg-neutral-800/60'
                    }`}
                  >
                    <div className={`mb-2 h-1 w-8 rounded-full transition-all duration-300 ${isSelected ? 'bg-[#a588ef]' : 'bg-neutral-700 group-hover:bg-neutral-600'}`} />
                    <div className={`text-sm font-semibold ${isSelected ? 'text-white' : 'text-neutral-200'}`}>{opt.label}</div>
                    {isSelected && (
                      <div className="absolute top-2 right-2">
                        <div className="h-2 w-2 rounded-full bg-[#a588ef] shadow-[0_0_8px_rgba(165,136,239,0.6)]" />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Step 2: Details */}
        {stepIndex === 1 && (
          <div>
            <h2 className="text-2xl font-semibold text-white mb-1">Tell us the details</h2>
            <p className="text-neutral-400 text-sm mb-6">Dial in the size and layout of your dream home.</p>

            <div className="space-y-6">
              {/* Square footage */}
              <div className="rounded-xl border border-white/10 bg-neutral-900/60 p-5">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-medium text-neutral-200">Square Footage</label>
                  <span className="text-lg font-semibold text-white tabular-nums">{data.basics.sqft.toLocaleString()} sqft</span>
                </div>
                <input
                  type="range"
                  min={800}
                  max={8000}
                  step={100}
                  value={data.basics.sqft}
                  onChange={(e) => setData(d => ({ ...d, basics: { ...d.basics, sqft: parseInt(e.target.value) } }))}
                  className="w-full accent-[#a588ef]"
                />
                <div className="flex justify-between text-xs text-neutral-500 mt-1">
                  <span>800</span>
                  <span>8,000</span>
                </div>
              </div>

              {/* Counter grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Floors', key: 'basics' as const, field: 'floors' as const, min: 1, max: 4 },
                  { label: 'Bedrooms', key: 'rooms' as const, field: 'beds' as const, min: 1, max: 8 },
                  { label: 'Bathrooms', key: 'rooms' as const, field: 'baths' as const, min: 1, max: 6 },
                  { label: 'Garage (cars)', key: 'rooms' as const, field: 'garage' as const, min: 0, max: 4 },
                ].map((item) => {
                  const value = (data as any)[item.key][item.field] as number
                  return (
                    <div key={item.field} className="rounded-xl border border-white/10 bg-neutral-900/60 p-4 text-center">
                      <div className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-2">{item.label}</div>
                      <div className="flex items-center justify-center gap-3">
                        <button
                          type="button"
                          disabled={value <= item.min}
                          onClick={() => setData(d => ({
                            ...d,
                            [item.key]: { ...(d as any)[item.key], [item.field]: Math.max(item.min, value - 1) }
                          }))}
                          className="h-8 w-8 rounded-lg border border-white/10 bg-neutral-800 text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          −
                        </button>
                        <span className="text-xl font-bold text-white tabular-nums w-6 text-center">{value}</span>
                        <button
                          type="button"
                          disabled={value >= item.max}
                          onClick={() => setData(d => ({
                            ...d,
                            [item.key]: { ...(d as any)[item.key], [item.field]: Math.min(item.max, value + 1) }
                          }))}
                          className="h-8 w-8 rounded-lg border border-white/10 bg-neutral-800 text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Budget (optional) */}
              <div className="rounded-xl border border-white/10 bg-neutral-900/60 p-5">
                <label className="text-sm font-medium text-neutral-200 block mb-2">Budget (optional)</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span>
                  <input
                    type="number"
                    placeholder="e.g. 350000"
                    value={data.budget.amount ?? ''}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      setData(d => ({ ...d, budget: { amount: v ? parseInt(v) : null } }))
                    }}
                    className="w-full rounded-lg border border-white/10 bg-neutral-800 pl-7 pr-3 py-2.5 text-white placeholder:text-neutral-500 outline-none focus:border-[#a588ef]/60 focus:ring-1 focus:ring-[#a588ef]/30 transition-colors"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Notes */}
        {stepIndex === 2 && (
          <div>
            <h2 className="text-2xl font-semibold text-white mb-1">Anything else?</h2>
            <p className="text-neutral-400 text-sm mb-6">Add notes, preferences, or special requests for the AI architect.</p>

            <textarea
              value={data.notes}
              onChange={(e) => setData(d => ({ ...d, notes: e.target.value }))}
              placeholder="e.g. Open kitchen flowing into the living room, big windows toward the backyard, home office near the entry, mudroom from the garage..."
              rows={6}
              className="w-full rounded-xl border border-white/10 bg-neutral-900/60 px-4 py-3 text-white placeholder:text-neutral-500 outline-none focus:border-[#a588ef]/60 focus:ring-1 focus:ring-[#a588ef]/30 resize-y transition-colors"
            />

            <div className="mt-4 grid grid-cols-2 gap-3">
              {[
                'Open concept kitchen + living',
                'Big windows to the backyard',
                'Home office near entry',
                'Walk-in closet in master',
                'Mudroom from garage',
                'Covered patio or porch',
              ].map((tip) => (
                <button
                  key={tip}
                  type="button"
                  onClick={() => setData(d => ({ ...d, notes: d.notes ? `${d.notes}\n${tip}` : tip }))}
                  className="rounded-lg border border-white/10 bg-neutral-900/60 px-3 py-2 text-left text-xs text-neutral-400 transition-colors hover:border-white/20 hover:bg-neutral-800/60 hover:text-neutral-200"
                >
                  + {tip}
                </button>
              ))}
            </div>

            {/* Summary */}
            <div className="mt-6 rounded-xl border border-white/10 bg-neutral-900/40 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-3">Summary</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-neutral-500">Style</span>
                  <div className="text-white font-medium">{data.style.archetype ? STYLE_OPTIONS.find(o => o.value === data.style.archetype)?.label || data.style.archetype : 'Not set'}</div>
                </div>
                <div>
                  <span className="text-neutral-500">Size</span>
                  <div className="text-white font-medium">{data.basics.sqft.toLocaleString()} sqft</div>
                </div>
                <div>
                  <span className="text-neutral-500">Layout</span>
                  <div className="text-white font-medium">{data.rooms.beds}bd / {data.rooms.baths}ba</div>
                </div>
                <div>
                  <span className="text-neutral-500">Floors</span>
                  <div className="text-white font-medium">{data.basics.floors}{data.rooms.garage > 0 ? ` + ${data.rooms.garage}-car garage` : ''}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Navigation footer */}
      <div className="mt-8 flex items-center justify-between">
        <button onClick={prev} disabled={stepIndex===0}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-neutral-200 transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ArrowLeft className="size-4" /> Back
        </button>
        {stepIndex < STEPS.length - 1 ? (
          <button onClick={next}
            className="inline-flex items-center gap-2 rounded-lg btn-accent px-5 py-2.5 text-white shadow-[0_0_16px_rgba(165,136,239,0.18)] transform-gpu transition-transform duration-300 ease-out hover:scale-105 active:scale-100"
          >
            Next <ArrowRight className="size-4" />
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <button onClick={onCreateProject} disabled={creating || generating}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-neutral-200 transition-colors hover:bg-white/10 disabled:opacity-60"
            >
              {creating ? 'Saving…' : 'Save as Project'}
            </button>
            <button onClick={onGenerateHome} disabled={generating || creating || !pipelineOnline}
              className="inline-flex items-center gap-2 rounded-lg btn-accent px-5 py-2.5 text-white shadow-[0_0_16px_rgba(165,136,239,0.18)] disabled:opacity-60"
              title={pipelineOnline ? "Run the Genesis pipeline to generate a full home from your intake" : "Pipeline offline — start the backend server first"}
            >
              <Sparkles className="size-4" />
              {generating ? 'Generating…' : !pipelineOnline ? 'Pipeline Offline' : 'Generate Home'}
            </button>
          </div>
        )}
      </div>
      {generateError && stepIndex === STEPS.length - 1 && (
        <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {generateError}
        </div>
      )}
    </div>
  )
}

// (removed unused NumberField and RadioCard components)
