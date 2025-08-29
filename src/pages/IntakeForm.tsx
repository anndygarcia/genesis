import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { createProject } from '../lib/supabase'

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
    // Tool call detection pattern per Realtime events
    if (msg.type === 'response.output_item.added' && msg.item?.type === 'tool_call') {
      const tool = msg.item
      if (tool.name === 'set_style') {
        const { style } = tool.arguments || {}
        if (style && STYLE_OPTIONS.some(o => o.value === style)) {
          setData(d => ({ ...d, style: { ...d.style, archetype: style } }))
          // respond with tool output (ack)
          postEvent({
            type: 'tool.output',
            tool_call_id: tool.id,
            output: JSON.stringify({ ok: true })
          })
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
      <div className="mb-6 flex items-center justify-between">
        <div className="text-sm text-neutral-400">Step {stepIndex + 1} of {STEPS.length}</div>
        <button onClick={prev} disabled={stepIndex===0}
          className="inline-flex items-center gap-2 rounded-md border border-white/10 px-4 py-2 text-neutral-200 hover:bg:white/10 disabled:opacity-50"
        >
          <ArrowLeft className="size-4" /> Back
        </button>
        {stepIndex < STEPS.length - 1 ? (
          <button onClick={next}
            className="inline-flex items-center gap-2 rounded-md btn-accent px-4 py-2 text-white shadow transform-gpu transition-transform duration-300 ease-out hover:scale-105 active:scale-100"
          >
            Next <ArrowRight className="size-4" />
          </button>
        ) : (
          <button onClick={onCreateProject} disabled={creating}
            className="inline-flex items-center gap-2 rounded-md btn-accent px-4 py-2 text-white shadow disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'Create Project'}
          </button>
        )}
      </div>
    </div>
  )
}

// (removed unused NumberField and RadioCard components)
