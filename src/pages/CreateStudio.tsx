import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, OrbitControls, PointerLockControls, TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { useNavigate } from 'react-router-dom'
import { Box, BrickWall, Copy, Crosshair, DoorOpen, Eye, Grid2x2, GripHorizontal, GripVertical, Maximize2, Move, PanelTop, Redo2, RotateCw, Save, Sparkles, Trash2, Undo2, Upload } from 'lucide-react'
import AIChatPanel from '../components/AIChatPanel'
import { summarizeToolCall, toolCallToObjects } from '../lib/ai-tools'

type PrimitiveKind = 'box' | 'wall' | 'door' | 'window'
type TransformMode = 'translate' | 'rotate' | 'scale'

type StudioObject = {
  id: string
  kind: PrimitiveKind
  name: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  color: string
  opacity: number
  roughness: number
  metalness: number
}

type DraftPayload = {
  version: 1
  objects: StudioObject[]
  snapEnabled: boolean
  snapStep: number
  showGrid: boolean
  updatedAt: string
}

type HistoryEntry = {
  objects: StudioObject[]
  selectedId: string | null
}

type ToolbarDock = 'left' | 'right' | 'top' | 'bottom'

const DRAFT_KEY = 'create_studio_draft_v1'
const M_TO_FT = 3.28084
const FT_TO_M = 1 / M_TO_FT
const HISTORY_LIMIT = 100

function defaultObject(kind: PrimitiveKind): StudioObject {
  const base = {
    id: crypto.randomUUID(),
    kind,
    position: [0, 0.5, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    roughness: 0.7,
    metalness: 0.1,
  }

  if (kind === 'wall') {
    return { ...base, name: 'Wall', scale: [4, 2.6, 0.2], color: '#d8d8d8', opacity: 1 }
  }
  if (kind === 'door') {
    return { ...base, name: 'Door', scale: [1.2, 2.2, 0.08], color: '#86b7ff', opacity: 0.22, roughness: 0.05, metalness: 0 }
  }
  if (kind === 'window') {
    return { ...base, name: 'Window', scale: [1.6, 1.1, 0.08], color: '#a9d7ff', opacity: 0.2, roughness: 0.05, metalness: 0 }
  }
  return { ...base, name: 'Box', scale: [1, 1, 1], color: '#c8c8c8', opacity: 1 }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function metersToFeet(v: number) {
  return v * M_TO_FT
}

function feetToMeters(v: number) {
  return v * FT_TO_M
}

function cloneObjects(list: StudioObject[]): StudioObject[] {
  return list.map((o) => ({
    ...o,
    position: [...o.position] as [number, number, number],
    rotation: [...o.rotation] as [number, number, number],
    scale: [...o.scale] as [number, number, number],
  }))
}

function makeHistoryEntry(objects: StudioObject[], selectedId: string | null): HistoryEntry {
  return {
    objects: cloneObjects(objects),
    selectedId,
  }
}

const BOX_CORNERS: Array<[number, number, number]> = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [-0.5, 0.5, -0.5],
  [0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [0.5, -0.5, 0.5],
  [-0.5, 0.5, 0.5],
  [0.5, 0.5, 0.5],
]

type ToolIconButtonProps = {
  label: string
  icon: ReactNode
  active?: boolean
  danger?: boolean
  disabled?: boolean
  tooltipPlacement?: 'left' | 'right' | 'top' | 'bottom'
  onClick: () => void
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void
  onPointerMove?: (event: React.PointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (event: React.PointerEvent<HTMLButtonElement>) => void
  onPointerLeave?: (event: React.PointerEvent<HTMLButtonElement>) => void
}

function ToolIconButton({ label, icon, active = false, danger = false, disabled = false, tooltipPlacement = 'right', onClick, onPointerDown, onPointerMove, onPointerUp, onPointerLeave }: ToolIconButtonProps) {
  const tooltipPositionClass = {
    right: 'left-full top-1/2 ml-2 -translate-y-1/2',
    left: 'right-full top-1/2 mr-2 -translate-y-1/2',
    top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
    bottom: 'top-full left-1/2 mt-2 -translate-x-1/2',
  }[tooltipPlacement]

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      className={`group relative flex h-7 w-7 items-center justify-center rounded-lg border transition-all duration-150 ease-out ${
        active
          ? 'border-[#a588ef] bg-[#a588ef]/18 text-white shadow-[0_0_0_1px_rgba(165,136,239,0.25)]'
          : danger
            ? 'border-red-400/30 bg-red-950/30 text-red-100 hover:border-red-300/50 hover:bg-red-900/45'
            : 'border-white/10 bg-neutral-800/80 text-neutral-200 hover:border-white/20 hover:bg-neutral-700/80 hover:text-white'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span className={`transition-transform duration-150 ${active ? 'scale-105' : 'group-hover:scale-105'}`}>
        {icon}
      </span>
      <span className={`pointer-events-none absolute ${tooltipPositionClass} whitespace-nowrap rounded-md border border-white/10 bg-neutral-950/95 px-2 py-0.5 text-[9px] font-medium text-white opacity-0 shadow-lg transition-all duration-150 group-hover:opacity-100 group-focus-visible:opacity-100`}>
        {label}
      </span>
    </button>
  )
}

type ToolbarGroupProps = {
  title: string
  orientation: 'vertical' | 'horizontal'
  children: ReactNode
  showTitle?: boolean
}

function ToolbarGroup({ title, orientation, children, showTitle = true }: ToolbarGroupProps) {
  const isHorizontal = orientation === 'horizontal'
  return (
    <div className={`flex min-w-0 shrink-0 ${isHorizontal ? 'flex-row items-center gap-1 px-1' : 'flex-col items-center gap-0.5 px-0.5 py-0.5'}`}>
      {!isHorizontal && showTitle && (
        <div className="text-[7px] font-semibold text-neutral-500 uppercase tracking-[0.18em] text-center leading-none">
          {title}
        </div>
      )}
      <div className={isHorizontal ? 'flex flex-nowrap items-center justify-center gap-1' : 'flex flex-col items-center justify-center gap-0.5'}>
        {children}
      </div>
    </div>
  )
}

export default function CreateStudio() {
  const navigate = useNavigate()
  const [objects, setObjects] = useState<StudioObject[]>(() => [defaultObject('box')])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pov, setPov] = useState(false)
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [snapStep, setSnapStep] = useState(0.25)
  const [showGrid, setShowGrid] = useState(true)
  const [isTransformDragging, setIsTransformDragging] = useState(false)
  const [hoveredCorner, setHoveredCorner] = useState<string | null>(null)
  const [toolbarDock, setToolbarDock] = useState<ToolbarDock>('left')
  const [isToolbarDragging, setIsToolbarDragging] = useState(false)
  const [toolbarPreviewDock, setToolbarPreviewDock] = useState<ToolbarDock | null>(null)
  const [past, setPast] = useState<HistoryEntry[]>([])
  const [future, setFuture] = useState<HistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [lastSavedAt, setLastSavedAt] = useState<string>('')
  const [aiPanelOpen, setAiPanelOpen] = useState(false)

  const autosaveTimer = useRef<number | null>(null)
  const orbitRef = useRef<any>(null)
  const toolbarShellRef = useRef<HTMLDivElement | null>(null)
  const toolbarDragActiveRef = useRef(false)
  const toolbarDragOffsetRef = useRef({ x: 0, y: 0 })
  const meshRefs = useRef<Record<string, THREE.Mesh | null>>({})
  const objectsRef = useRef<StudioObject[]>(objects)
  const selectedIdRef = useRef<string | null>(selectedId)
  const [toolbarDragPosition, setToolbarDragPosition] = useState<{ left: number; top: number } | null>(null)

  const selected = useMemo(
    () => objects.find((o) => o.id === selectedId) ?? null,
    [objects, selectedId]
  )
  const selectedMesh = selectedId ? meshRefs.current[selectedId] ?? null : null
  const supportsPointerLock = useMemo(() => {
    if (typeof document === 'undefined') return false
    const canvas = document.createElement('canvas')
    return typeof canvas.requestPointerLock === 'function'
  }, [])
  const isToolbarFloating = toolbarDragPosition !== null
  const activeToolbarDock = isToolbarFloating ? toolbarPreviewDock ?? toolbarDock : toolbarDock
  const toolbarOrientation = activeToolbarDock === 'top' || activeToolbarDock === 'bottom' ? 'horizontal' : 'vertical'
  const toolbarTooltipPlacement: 'left' | 'right' | 'top' | 'bottom' =
    activeToolbarDock === 'left' ? 'right' : activeToolbarDock === 'right' ? 'left' : activeToolbarDock === 'top' ? 'bottom' : 'top'
  const toolbarGripIcon = toolbarOrientation === 'horizontal'
    ? <GripHorizontal className="h-4 w-4" />
    : <GripVertical className="h-4 w-4" />

  const toolbarDockClass = {
    left: 'left-2 top-1/2 -translate-y-1/2 w-[46px] h-auto max-h-[calc(100vh-1rem)] flex-col items-center',
    right: 'right-2 top-1/2 -translate-y-1/2 w-[46px] h-auto max-h-[calc(100vh-1rem)] flex-col items-center',
    top: 'left-1/2 top-2 -translate-x-1/2 w-auto max-w-[calc(100vw-1rem)] h-[64px] flex-row items-center',
    bottom: 'left-1/2 bottom-2 -translate-x-1/2 w-auto max-w-[calc(100vw-1rem)] h-[64px] flex-row items-center',
  }[toolbarDock]

  const toolbarFloatingStyle = toolbarDragPosition
    ? { left: toolbarDragPosition.left, top: toolbarDragPosition.top }
    : undefined
  const toolbarShellClassName = isToolbarFloating
    ? 'fixed z-20 pointer-events-none'
    : `absolute z-20 pointer-events-none ${toolbarDockClass}`
  const toolbarShellInnerClassName = isToolbarFloating
    ? `pointer-events-auto flex ${toolbarOrientation === 'horizontal' ? 'h-auto w-auto flex-row items-center justify-center gap-1 px-1.5' : 'h-auto w-auto flex-col items-center justify-center gap-1'} rounded-2xl border border-white/10 bg-neutral-900/90 p-1 backdrop-blur-sm shadow-2xl overflow-visible transition-all duration-150 ease-out`
    : `pointer-events-auto flex ${toolbarOrientation === 'horizontal' ? 'h-full w-auto flex-row items-center justify-center gap-1 px-1.5' : 'h-auto w-full flex-col items-center justify-center gap-1'} rounded-2xl border border-white/10 bg-neutral-900/90 p-1 backdrop-blur-sm shadow-2xl overflow-visible`

  const resolveToolbarDock = useCallback((clientX: number, clientY: number): ToolbarDock => {
    const width = window.innerWidth
    const height = window.innerHeight
    const topZone = height * 0.25
    const bottomZone = height * 0.75
    const leftZone = width * 0.25
    const rightZone = width * 0.75

    if (clientY <= topZone) return 'top'
    if (clientY >= bottomZone) return 'bottom'
    if (clientX <= leftZone) return 'left'
    if (clientX >= rightZone) return 'right'

    const distances: Array<[ToolbarDock, number]> = [
      ['top', clientY],
      ['bottom', height - clientY],
      ['left', clientX],
      ['right', width - clientX],
    ]

    return distances.reduce((best, current) => (current[1] < best[1] ? current : best))[0]
  }, [])

  const beginToolbarDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const rect = toolbarShellRef.current?.getBoundingClientRect()
    if (rect) {
      toolbarDragOffsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      }
      setToolbarDragPosition({ left: rect.left, top: rect.top })
    }
    setToolbarPreviewDock(toolbarDock)
    toolbarDragActiveRef.current = true
    setIsToolbarDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [toolbarDock])

  const moveToolbarDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!toolbarDragActiveRef.current) return
    const nextDock = resolveToolbarDock(e.clientX, e.clientY)
    setToolbarPreviewDock(nextDock)
    setToolbarDragPosition({
      left: e.clientX - toolbarDragOffsetRef.current.x,
      top: e.clientY - toolbarDragOffsetRef.current.y,
    })
  }, [resolveToolbarDock])

  const endToolbarDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!toolbarDragActiveRef.current) return
    toolbarDragActiveRef.current = false
    setIsToolbarDragging(false)
    const nextDock = toolbarPreviewDock ?? resolveToolbarDock(e.clientX, e.clientY)
    setToolbarDock(nextDock)
    setToolbarPreviewDock(null)
    setToolbarDragPosition(null)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
  }, [resolveToolbarDock, toolbarPreviewDock])

  useEffect(() => {
    document.body.style.cursor = isToolbarDragging ? 'grabbing' : hoveredCorner ? 'pointer' : ''
    return () => {
      document.body.style.cursor = ''
    }
  }, [hoveredCorner, isToolbarDragging])

  const fpsColliders = objects
    .filter((o) => o.kind !== 'door' && o.kind !== 'window')
    .map((o) => meshRefs.current[o.id])
    .filter(Boolean) as THREE.Mesh[]

  const requestFpsCapture = useCallback(() => {
    try {
      if (!supportsPointerLock) {
        setStatus('Pointer lock is unavailable in this browser. Using orbit fallback.')
        return
      }
      const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
      if (!canvas) return
      if (document.pointerLockElement === canvas) return
      canvas.requestPointerLock()
    } catch {}
  }, [supportsPointerLock])

  useEffect(() => {
    objectsRef.current = objects
    selectedIdRef.current = selectedId
  }, [objects, selectedId])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as DraftPayload
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.objects)) return
      setObjects(parsed.objects.length ? parsed.objects : [defaultObject('box')])
      setSnapEnabled(!!parsed.snapEnabled)
      setSnapStep(clamp(Number(parsed.snapStep) || 0.25, 0.05, 2))
      setShowGrid(parsed.showGrid !== false)
      setLastSavedAt(parsed.updatedAt || '')
      setStatus('Draft restored')
    } catch {
      setStatus('Failed to restore draft')
    }
  }, [])

  const writeDraft = useCallback((nextObjects: StudioObject[], nextSnapEnabled = snapEnabled, nextSnapStep = snapStep, nextShowGrid = showGrid) => {
    const payload: DraftPayload = {
      version: 1,
      objects: nextObjects,
      snapEnabled: nextSnapEnabled,
      snapStep: nextSnapStep,
      showGrid: nextShowGrid,
      updatedAt: new Date().toISOString(),
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload))
    setLastSavedAt(payload.updatedAt)
    setStatus('Draft saved')
  }, [showGrid, snapEnabled, snapStep])

  useEffect(() => {
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current)
    autosaveTimer.current = window.setTimeout(() => {
      writeDraft(objects, snapEnabled, snapStep, showGrid)
      setStatus('Autosaved')
    }, 850)
    return () => {
      if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current)
    }
  }, [objects, snapEnabled, snapStep, showGrid, writeDraft])

  const pushHistory = useCallback((currentObjects: StudioObject[] = objects, currentSelectedId: string | null = selectedId) => {
    setPast((prev) => {
      const next = [...prev, makeHistoryEntry(currentObjects, currentSelectedId)]
      return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
    })
    setFuture([])
  }, [objects, selectedId])

  const undo = useCallback(() => {
    setPast((prev) => {
      if (!prev.length) return prev
      const entry = prev[prev.length - 1]!
      setFuture((f) => {
        const next = [...f, makeHistoryEntry(objectsRef.current, selectedIdRef.current)]
        return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
      })
      setObjects(cloneObjects(entry.objects))
      setSelectedId(entry.selectedId)
      setStatus('Undo')
      return prev.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (!prev.length) return prev
      const entry = prev[prev.length - 1]!
      setPast((p) => {
        const next = [...p, makeHistoryEntry(objectsRef.current, selectedIdRef.current)]
        return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
      })
      setObjects(cloneObjects(entry.objects))
      setSelectedId(entry.selectedId)
      setStatus('Redo')
      return prev.slice(0, -1)
    })
  }, [])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    pushHistory()
    setObjects((prev) => prev.filter((o) => o.id !== selectedId))
    setSelectedId(null)
  }, [pushHistory, selectedId])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTypingTarget = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      )

      if (isTypingTarget) return

      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      if (key === 'delete' || key === 'backspace') {
        if (pov) return
        if (!selectedId) return
        e.preventDefault()
        deleteSelected()
        return
      }

      if (!mod) return

      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }
      if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteSelected, pov, redo, selectedId, undo])

  const addObject = useCallback((kind: PrimitiveKind) => {
    pushHistory()
    const obj = defaultObject(kind)
    obj.position = [0, kind === 'wall' ? 1.3 : kind === 'box' ? 0.5 : 1.1, 0]
    setObjects((prev) => [...prev, obj])
    setSelectedId(obj.id)
  }, [pushHistory])

  const duplicateSelected = useCallback(() => {
    if (!selected) return
    pushHistory()
    const copy: StudioObject = {
      ...selected,
      id: crypto.randomUUID(),
      name: `${selected.name} Copy`,
      position: [selected.position[0] + 0.6, selected.position[1], selected.position[2] + 0.6],
    }
    setObjects((prev) => [...prev, copy])
    setSelectedId(copy.id)
  }, [pushHistory, selected])

  const updateSelected = useCallback((patch: Partial<StudioObject>) => {
    if (!selectedId) return
    pushHistory()
    setObjects((prev) => prev.map((o) => (o.id === selectedId ? { ...o, ...patch } : o)))
  }, [pushHistory, selectedId])

  const updateSelectedScaleAxis = useCallback((axis: 0 | 1 | 2, nextFeet: number) => {
    if (!selected) return
    const feet = clamp(nextFeet, metersToFeet(0.05), 999)
    const next = [...selected.scale] as [number, number, number]
    next[axis] = feetToMeters(feet)
    updateSelected({ scale: next })
  }, [selected, updateSelected])

  const updateSelectedTransform = useCallback((position: [number, number, number], rotation: [number, number, number], scale: [number, number, number]) => {
    if (!selectedId) return
    setObjects((prev) => prev.map((o) => {
      if (o.id !== selectedId) return o
      return {
        ...o,
        position,
        rotation,
        scale,
      }
    }))
  }, [selectedId])

  const handleTransformObjectChange = useCallback(() => {
    if (!selectedId) return
    const target = meshRefs.current[selectedId]
    if (!target) return
    const p: [number, number, number] = [target.position.x, target.position.y, target.position.z]
    const r: [number, number, number] = [target.rotation.x, target.rotation.y, target.rotation.z]
    const s: [number, number, number] = [target.scale.x, target.scale.y, target.scale.z]
    updateSelectedTransform(p, r, s)
  }, [selectedId, updateSelectedTransform])

  const handleAIToolExecution = useCallback((toolCall: any) => {
    // OpenAI returns tool calls with arguments as a JSON string
    const { name, function: func } = toolCall
    const args = typeof func?.arguments === 'string' ? JSON.parse(func.arguments) : func?.arguments
    
    if (!args) return
    
    if (name === 'get_current_design') {
      setStatus(`Current design: ${objects.length} object${objects.length === 1 ? '' : 's'}`)
      return
    }

    pushHistory()

    if (name === 'generate_room') {
      const roomObjects = toolCallToObjects(toolCall)
      if (roomObjects.length > 0) {
        setObjects(roomObjects)
        setSelectedId(null)
        setStatus(summarizeToolCall(toolCall))
      }
    } else if (name === 'add_object' || name === 'add_wall') {
      const objs = toolCallToObjects(toolCall)
      if (objs.length > 0) {
        setObjects(prev => [...prev, ...objs])
        setStatus(summarizeToolCall(toolCall))
      }
    } else if (name === 'delete_object') {
      const { object_id } = args
      setObjects(prev => prev.filter(o => o.id !== object_id))
      setSelectedId((current) => (current === object_id ? null : current))
      setStatus(summarizeToolCall(toolCall))
    } else if (name === 'modify_object') {
      const { object_id, position, dimensions, rotation } = args
      setObjects(prev => prev.map(o => {
        if (o.id !== object_id) return o
        return {
          ...o,
          ...(position && { position }),
          ...(dimensions && { scale: dimensions }),
          ...(rotation && { rotation }),
        }
      }))
      setStatus(summarizeToolCall(toolCall))
    }
  }, [objects, pushHistory])

  const publish = useCallback(async () => {
    if (!objects.length) {
      setStatus('Add at least one object before publishing')
      return
    }
    setBusy(true)
    setStatus('Building GLB...')

    try {
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x333333)

      const ambient = new THREE.AmbientLight(0xffffff, 0.85)
      const directional = new THREE.DirectionalLight(0xffffff, 1.1)
      directional.position.set(6, 10, 6)
      scene.add(ambient, directional)

      for (const o of objects) {
        const geom = new THREE.BoxGeometry(1, 1, 1)
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(o.color),
          transparent: o.opacity < 0.999,
          opacity: clamp(o.opacity, 0.05, 1),
          roughness: clamp(o.roughness, 0, 1),
          metalness: clamp(o.metalness, 0, 1),
        })
        const mesh = new THREE.Mesh(geom, mat)
        mesh.name = o.name
        mesh.position.set(o.position[0], o.position[1], o.position[2])
        mesh.rotation.set(o.rotation[0], o.rotation[1], o.rotation[2])
        mesh.scale.set(o.scale[0], o.scale[1], o.scale[2])
        scene.add(mesh)
      }

      const exporter = new GLTFExporter()
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(
          scene,
          (result) => {
            if (result instanceof ArrayBuffer) {
              resolve(result)
              return
            }
            reject(new Error('GLB export did not return binary output'))
          },
          (err) => reject(err),
          { binary: true, onlyVisible: true, includeCustomExtensions: false }
        )
      })

      const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' })
      const glbUrl = URL.createObjectURL(blob)
      writeDraft(objects, snapEnabled, snapStep, showGrid)
      setStatus('Published. Opening viewer...')
      navigate(`/viewer-upload?glb=${encodeURIComponent(glbUrl)}`)
    } catch (e) {
      console.error(e)
      setStatus('Failed to publish GLB')
    } finally {
      setBusy(false)
    }
  }, [navigate, objects, showGrid, snapEnabled, snapStep, writeDraft])

  return (
    <div className="fixed inset-x-0 top-16 bottom-0 z-10">
      {/* AI Assistant Floating Button - Bottom Right */}
      <button
        onClick={() => setAiPanelOpen(!aiPanelOpen)}
        className={`fixed right-4 bottom-4 z-50 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all shadow-lg hover:shadow-xl ${
          aiPanelOpen
            ? 'border-[#a588ef] bg-[#a588ef] text-white'
            : 'border-white/10 bg-neutral-900/90 backdrop-blur-sm text-neutral-200 hover:bg-neutral-800/90'
        }`}
      >
        <span className="flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          AI Assistant
        </span>
      </button>

      <div ref={toolbarShellRef} className={toolbarShellClassName} style={toolbarFloatingStyle}>
        <div className={toolbarShellInnerClassName}>
          <ToolIconButton
            label="Move Toolbar"
            icon={toolbarGripIcon}
            tooltipPlacement={toolbarTooltipPlacement}
            onClick={() => {}}
            onPointerDown={beginToolbarDrag}
            onPointerMove={moveToolbarDrag}
            onPointerUp={endToolbarDrag}
          />

          <div className={`flex ${toolbarOrientation === 'horizontal' ? 'flex-row flex-nowrap items-center justify-center gap-1' : 'flex-col items-center gap-1'} ${toolbarOrientation === 'horizontal' ? 'h-full w-auto' : 'w-full'}`}>
            <ToolbarGroup title="Add" orientation={toolbarOrientation} showTitle={toolbarOrientation === 'horizontal'}>
              <ToolIconButton label="Add Box" icon={<Box className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} onClick={() => addObject('box')} />
              <ToolIconButton label="Add Wall" icon={<BrickWall className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} onClick={() => addObject('wall')} />
              <ToolIconButton label="Add Door" icon={<DoorOpen className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} onClick={() => addObject('door')} />
              <ToolIconButton label="Add Window" icon={<PanelTop className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} onClick={() => addObject('window')} />
            </ToolbarGroup>

            <ToolbarGroup title="Transform" orientation={toolbarOrientation} showTitle={toolbarOrientation === 'horizontal'}>
              <ToolIconButton label="Move" icon={<Move className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} active={transformMode === 'translate'} onClick={() => setTransformMode('translate')} />
              <ToolIconButton label="Rotate" icon={<RotateCw className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} active={transformMode === 'rotate'} onClick={() => setTransformMode('rotate')} />
              <ToolIconButton label="Scale" icon={<Maximize2 className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} active={transformMode === 'scale'} onClick={() => setTransformMode('scale')} />
            </ToolbarGroup>

            <ToolbarGroup title="View" orientation={toolbarOrientation} showTitle={toolbarOrientation === 'horizontal'}>
              <ToolIconButton label="3D View" icon={<Box className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} active={!pov} onClick={() => setPov(false)} />
              <ToolIconButton label="POV View" icon={<Eye className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} active={pov} onClick={() => { setPov(true); setTimeout(requestFpsCapture, 0); }} />
            </ToolbarGroup>

            <ToolbarGroup title="Actions" orientation={toolbarOrientation} showTitle={toolbarOrientation === 'horizontal'}>
              <ToolIconButton label="Undo" icon={<Undo2 className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} disabled={!past.length} onClick={undo} />
              <ToolIconButton label="Redo" icon={<Redo2 className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} disabled={!future.length} onClick={redo} />
              <ToolIconButton label="Duplicate" icon={<Copy className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} disabled={!selected || pov} onClick={duplicateSelected} />
              <ToolIconButton label="Delete" icon={<Trash2 className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} disabled={!selected || pov} danger onClick={deleteSelected} />
            </ToolbarGroup>

            <ToolbarGroup title="Options" orientation={toolbarOrientation} showTitle={toolbarOrientation === 'horizontal'}>
              <ToolIconButton label="Snap" icon={<Crosshair className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} active={snapEnabled} onClick={() => setSnapEnabled((prev) => !prev)} />
              <ToolIconButton label="Grid" icon={<Grid2x2 className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} active={showGrid} onClick={() => setShowGrid((prev) => !prev)} />
            </ToolbarGroup>

            <ToolbarGroup title="File" orientation={toolbarOrientation} showTitle={toolbarOrientation === 'horizontal'}>
              <ToolIconButton label="Save Draft" icon={<Save className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} onClick={() => writeDraft(objects)} />
              <ToolIconButton label="Publish" icon={<Upload className="h-3 w-3" />} tooltipPlacement={toolbarTooltipPlacement} disabled={busy} onClick={publish} />
            </ToolbarGroup>
          </div>
        </div>
      </div>

      {selected && (
        <div className="absolute right-4 top-4 z-20 w-52 rounded-xl border border-white/10 bg-neutral-900/90 p-3 text-[11px] backdrop-blur-sm shadow-2xl">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Properties</div>
            <div className="rounded-full border border-[#a588ef]/30 bg-[#a588ef]/10 px-2 py-0.5 text-[10px] font-medium text-[#d9cfff]">
              Selected
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="text-sm font-medium text-white">{selected.name}</div>

            <div className="flex flex-col gap-1">
              <span className="text-neutral-400">Color</span>
              <input
                className="h-7 w-full cursor-pointer rounded-md border border-white/10 bg-neutral-800"
                type="color"
                value={selected.color}
                onChange={(e) => updateSelected({ color: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-neutral-400">Opacity</span>
              <input
                className="w-full"
                type="range"
                min={0.05}
                max={1}
                step={0.01}
                value={selected.opacity}
                onChange={(e) => updateSelected({ opacity: parseFloat(e.target.value) })}
              />
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-neutral-800/40 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-neutral-400">Size</span>
                <span className="text-[10px] text-neutral-500">ft</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {[
                  { label: 'W', axis: 0, title: 'Width' },
                  { label: 'H', axis: 1, title: 'Height' },
                  { label: 'D', axis: 2, title: 'Depth' },
                ].map(({ label, axis, title }) => (
                  <div key={label} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-neutral-900/70 px-2 py-1.5">
                    <div className="w-4 shrink-0 text-[10px] font-semibold text-neutral-300" title={title}>{label}</div>
                    <button
                      type="button"
                      className="h-6 w-6 rounded-md border border-white/10 bg-neutral-800/90 text-neutral-200 transition-colors hover:bg-neutral-700/90"
                      onClick={() => updateSelectedScaleAxis(axis as 0 | 1 | 2, metersToFeet(selected.scale[axis as 0 | 1 | 2]) - 0.25)}
                      aria-label={`Decrease ${title}`}
                    >
                      −
                    </button>
                    <input
                      className="h-6 min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-800 px-1.5 text-center text-[11px] text-white outline-none transition-colors focus:border-[#a588ef]/60"
                      type="number"
                      min={metersToFeet(0.05)}
                      step={0.1}
                      value={metersToFeet(selected.scale[axis as 0 | 1 | 2]).toFixed(2)}
                      onChange={(e) => updateSelectedScaleAxis(axis as 0 | 1 | 2, parseFloat(e.target.value || '0'))}
                      aria-label={title}
                    />
                    <button
                      type="button"
                      className="h-6 w-6 rounded-md border border-white/10 bg-neutral-800/90 text-neutral-200 transition-colors hover:bg-neutral-700/90"
                      onClick={() => updateSelectedScaleAxis(axis as 0 | 1 | 2, metersToFeet(selected.scale[axis as 0 | 1 | 2]) + 0.25)}
                      aria-label={`Increase ${title}`}
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-white/10 pt-2 text-center text-[10px] text-neutral-400">
              {status || 'Ready'}
              {lastSavedAt && <span className="ml-1">• {new Date(lastSavedAt).toLocaleTimeString()}</span>}
            </div>
          </div>
        </div>
      )}

      <Canvas
        shadows
        dpr={[1, 2]}
        style={{ width: '100%', height: '100%', display: 'block' }}
        gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }}
        camera={{ position: [6, 4, 8], fov: 60, near: 0.01, far: 5000 }}
        onPointerMissed={() => {
          if (isTransformDragging || pov) return
          setSelectedId(null)
        }}
      >
        <color attach="background" args={[0x333333]} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[6, 10, 6]} intensity={1.2} castShadow />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color="#2f2f2f" />
        </mesh>
        {showGrid && <gridHelper args={[80, 80, '#666', '#333']} position={[0, 0.001, 0]} />}

        {objects.map((obj) => {
          const isSelected = obj.id === selectedId
          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(obj.color),
            transparent: obj.opacity < 0.999,
            opacity: obj.opacity,
            roughness: isSelected ? Math.max(0, obj.roughness - 0.1) : obj.roughness,
            metalness: obj.metalness,
            emissive: isSelected ? new THREE.Color('#a588ef') : new THREE.Color('#000000'),
            emissiveIntensity: isSelected ? 0.22 : 0,
          })

          const meshNode = (
            <mesh
              ref={(node) => {
                meshRefs.current[obj.id] = node
              }}
              castShadow
              receiveShadow
              position={obj.position}
              rotation={obj.rotation}
              scale={obj.scale}
              onPointerDown={(e) => {
                e.stopPropagation()
                if (pov) return
                setSelectedId(obj.id)
              }}
            >
              <boxGeometry args={[1, 1, 1]} />
              <primitive object={mat} attach="material" />
              {isSelected && !pov && (
                <>
                  <lineSegments>
                    <edgesGeometry args={[new THREE.BoxGeometry(1, 1, 1)]} />
                    <lineBasicMaterial color="#bda2ff" depthTest={false} transparent opacity={0.9} linewidth={1.5} />
                  </lineSegments>
                  {BOX_CORNERS.map((corner, i) => (
                    <group key={i} position={corner}>
                      <mesh
                        scale={2.0}
                        onPointerOver={(e) => {
                          e.stopPropagation()
                          setHoveredCorner(`${obj.id}:${i}`)
                        }}
                        onPointerOut={(e) => {
                          e.stopPropagation()
                          setHoveredCorner((current) => (current === `${obj.id}:${i}` ? null : current))
                        }}
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          setSelectedId(obj.id)
                          setTransformMode('scale')
                        }}
                      >
                        <sphereGeometry args={[0.12, 18, 18]} />
                        <meshBasicMaterial transparent opacity={0.001} depthWrite={false} />
                      </mesh>
                      <mesh scale={hoveredCorner === `${obj.id}:${i}` ? 1.1 : 1.0}>
                        <sphereGeometry args={[0.055, 18, 18]} />
                        <meshBasicMaterial
                          color="#f5efff"
                          transparent
                          opacity={hoveredCorner === `${obj.id}:${i}` ? 0.55 : 0.34}
                          depthWrite={false}
                          blending={THREE.AdditiveBlending}
                        />
                      </mesh>
                      <mesh scale={hoveredCorner === `${obj.id}:${i}` ? 1.25 : 1.02}>
                        <sphereGeometry args={[0.035, 16, 16]} />
                        <meshStandardMaterial
                          color="#faf8ff"
                          emissive="#a588ef"
                          emissiveIntensity={hoveredCorner === `${obj.id}:${i}` ? 1.2 : 0.75}
                          roughness={0.16}
                          metalness={0.08}
                        />
                      </mesh>
                      <mesh scale={hoveredCorner === `${obj.id}:${i}` ? 1.75 : 1.42}>
                        <sphereGeometry args={[0.07, 20, 20]} />
                        <meshBasicMaterial
                          color="#a588ef"
                          transparent
                          opacity={hoveredCorner === `${obj.id}:${i}` ? 0.15 : 0.08}
                          depthWrite={false}
                          blending={THREE.AdditiveBlending}
                        />
                      </mesh>
                    </group>
                  ))}
                </>
              )}
            </mesh>
          )

          return <group key={obj.id}>{meshNode}</group>
        })}

        {selectedMesh && !pov && (
          <>
            <BoundingBoxHelper object={selectedMesh} />
            <TransformControls
              key={transformMode}
              object={selectedMesh}
              mode={transformMode}
              translationSnap={snapEnabled ? snapStep : undefined}
              rotationSnap={snapEnabled ? THREE.MathUtils.degToRad(15) : undefined}
              scaleSnap={snapEnabled ? snapStep : undefined}
              size={2.35}
              onMouseDown={() => {
                pushHistory()
                setIsTransformDragging(true)
                if (orbitRef.current) orbitRef.current.enabled = false
              }}
              onMouseUp={() => {
                setIsTransformDragging(false)
                if (orbitRef.current) orbitRef.current.enabled = true
              }}
              onObjectChange={handleTransformObjectChange}
            />
          </>
        )}

        {pov && supportsPointerLock && (
          <>
            <PointerLockControls selector="canvas, #enter-fps-create" />
            <CreateFPSController speed={3.2} colliders={fpsColliders} eyeHeight={1.0} />
          </>
        )}

        <Environment preset="city" />
        <OrbitControls ref={orbitRef} enableDamping dampingFactor={0.08} enabled={!isTransformDragging && (!pov || !supportsPointerLock)} makeDefault />
      </Canvas>

      {pov && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center z-20">
          <button
            id="enter-fps-create"
            className="pointer-events-auto rounded-md border border-white/10 bg-neutral-900/80 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-800"
            onClick={requestFpsCapture}
          >
            Click canvas to capture mouse (POV) — W/A/S/D move, Shift sprint, Space jump
          </button>
        </div>
      )}

      <AIChatPanel
        isOpen={aiPanelOpen}
        onClose={() => setAiPanelOpen(false)}
        onExecuteTool={handleAIToolExecution}
        currentObjects={objects}
      />
    </div>
  )
}

function BoundingBoxHelper({ object }: { object: THREE.Object3D }) {
  const box = useMemo(() => new THREE.Box3(), [])
  const points = useMemo(() => [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ], [])
  const geometry = useMemo(() => new THREE.BufferGeometry(), [])
  const material = useMemo(() => new THREE.LineBasicMaterial({ color: 0xbda2ff, depthTest: false, transparent: true, opacity: 0.7 }), [])
  
  useFrame(() => {
    box.setFromObject(object)
    const min = box.min
    const max = box.max
    points[0].set(min.x, min.y, min.z)
    points[1].set(max.x, min.y, min.z)
    points[2].set(max.x, max.y, min.z)
    points[3].set(min.x, max.y, min.z)
    points[4].set(min.x, min.y, max.z)
    points[5].set(max.x, min.y, max.z)
    points[6].set(max.x, max.y, max.z)
    points[7].set(min.x, max.y, max.z)
    const indices = [
      0,1, 1,2, 2,3, 3,0,
      4,5, 5,6, 6,7, 7,4,
      0,4, 1,5, 2,6, 3,7,
    ]
    const linePoints: number[] = []
    for (const i of indices) {
      linePoints.push(points[i].x, points[i].y, points[i].z)
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3))
  })
  return <lineSegments geometry={geometry} material={material} />
}

function CreateFPSController({ speed = 3.2, colliders = [], eyeHeight = 1.0 }: { speed?: number; colliders?: THREE.Mesh[]; eyeHeight?: number }) {
  const { camera, raycaster } = useThree()
  const keys = useRef<Record<string, boolean>>({})
  const velocity = useRef(new THREE.Vector3())
  const verticalVelocity = useRef(0)
  const grounded = useRef(true)
  const prevJumpPressed = useRef(false)
  const probeHeights = [0.2, 0.7, 0.95]
  const temp = useRef(new THREE.Vector3())

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { keys.current[e.code] = true }
    const onKeyUp = (e: KeyboardEvent) => { keys.current[e.code] = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useFrame((_, delta) => {
    const moveSpeed = keys.current['ShiftLeft'] || keys.current['ShiftRight'] ? speed * 1.75 : speed
    const jumpPressed = !!keys.current['Space']

    let forward = 0
    let strafe = 0
    if (keys.current['KeyW'] || keys.current['ArrowUp']) forward += 1
    if (keys.current['KeyS'] || keys.current['ArrowDown']) forward -= 1
    if (keys.current['KeyA'] || keys.current['ArrowLeft']) strafe -= 1
    if (keys.current['KeyD'] || keys.current['ArrowRight']) strafe += 1

    const moveDir = temp.current.set(strafe, 0, -forward)
    if (moveDir.lengthSq() > 0) {
      moveDir.normalize()
      moveDir.applyQuaternion(camera.quaternion)
      moveDir.y = 0
      moveDir.normalize()
    }

    const targetVel = moveDir.multiplyScalar(moveSpeed)
    velocity.current.lerp(targetVel, Math.min(delta * 10, 1))

    if (jumpPressed && !prevJumpPressed.current && grounded.current) {
      verticalVelocity.current = 4.8
      grounded.current = false
    }
    prevJumpPressed.current = jumpPressed

    verticalVelocity.current -= 12 * delta
    verticalVelocity.current = Math.max(verticalVelocity.current, -16)

    const deltaPos = velocity.current.clone().multiplyScalar(delta)
    const feetY = camera.position.y - eyeHeight
    let blockedX = false
    let blockedZ = false

    if (colliders.length > 0) {
      const moveX = new THREE.Vector3(deltaPos.x, 0, 0)
      const moveZ = new THREE.Vector3(0, 0, deltaPos.z)
      const tryAxis = (axisMove: THREE.Vector3) => {
        const dist = axisMove.length()
        if (dist <= 1e-5) return false
        const dir = axisMove.clone().normalize()
        const clearance = 0.2
        for (const h of probeHeights) {
          const origin = new THREE.Vector3(camera.position.x, feetY + h, camera.position.z)
          raycaster.set(origin, dir)
          const hit = raycaster.intersectObjects(colliders, true)[0]
          if (hit && hit.distance > 0.02 && hit.distance <= dist + clearance) return true
        }
        return false
      }

      blockedX = tryAxis(moveX)
      blockedZ = tryAxis(moveZ)
    }

    if (!blockedX) camera.position.x += deltaPos.x
    if (!blockedZ) camera.position.z += deltaPos.z

    // Grounding against scene surfaces (fallback to y=0)
    let targetGroundY = 0
    if (colliders.length > 0) {
      const origin = new THREE.Vector3(camera.position.x, camera.position.y + 0.6, camera.position.z)
      raycaster.set(origin, new THREE.Vector3(0, -1, 0))
      const hit = raycaster.intersectObjects(colliders, true)[0]
      if (hit && hit.distance < 6) targetGroundY = Math.max(0, hit.point.y)
    }

    const nextFeetY = feetY + verticalVelocity.current * delta
    if (nextFeetY <= targetGroundY) {
      camera.position.y = targetGroundY + eyeHeight
      verticalVelocity.current = 0
      grounded.current = true
    } else {
      camera.position.y = nextFeetY + eyeHeight
      grounded.current = false
    }
  })

  return null
}
