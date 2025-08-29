import React, { useEffect, useRef, useState } from 'react'
import { useApp, screenToWorld, worldToScreen } from '../store'
import type { Vec2, Wall, Room } from '../types'

// geometry helpers (module-scope)
function dist(a: Vec2, b: Vec2) { return Math.hypot(a.x - b.x, a.y - b.y) }
function projPointOnSeg(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; dist: number } {
  const ab = { x: b.x - a.x, y: b.y - a.y }
  const ap = { x: p.x - a.x, y: p.y - a.y }
  const len2 = ab.x * ab.x + ab.y * ab.y || 1
  const t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / len2))
  const point = { x: a.x + ab.x * t, y: a.y + ab.y * t }
  return { point, t, dist: dist(p, point) }
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, zoom: number, offsetX: number, offsetY: number) {
  ctx.save()
  ctx.clearRect(0, 0, width, height)
  // background
  ctx.fillStyle = '#0b0d12'
  ctx.fillRect(0, 0, width, height)

  const major = 100 * zoom // 1m grid
  const minor = 20 * zoom // 20cm grid

  const startX = -((offsetX % minor) + minor) % minor
  const startY = -((offsetY % minor) + minor) % minor

  ctx.lineWidth = 1
  for (let x = startX; x < width; x += minor) {
    ctx.strokeStyle = (Math.round((x - offsetX) / major) % 5 === 0) ? '#1f2838' : '#141a26'
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke()
  }
  for (let y = startY; y < height; y += minor) {
    ctx.strokeStyle = (Math.round((y - offsetY) / major) % 5 === 0) ? '#1f2838' : '#141a26'
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke()
  }
  ctx.restore()
}

function drawHandles(ctx: CanvasRenderingContext2D, viewportZoom: number, pts: Vec2[]) {
  ctx.save()
  const size = Math.max(4, 6 * viewportZoom * 0.5)
  ctx.fillStyle = '#22c55e'
  pts.forEach((p) => {
    ctx.beginPath()
    ctx.rect(p.x - size / 2, p.y - size / 2, size, size)
    ctx.fill()
  })
  ctx.restore()
}

function drawWalls(ctx: CanvasRenderingContext2D, walls: Wall[], zoom: number, offsetX: number, offsetY: number, selectedId?: string, selectedSet?: Set<string>) {
  for (const w of walls) {
    const a = { x: w.a.x * zoom + offsetX, y: w.a.y * zoom + offsetY }
    const b = { x: w.b.x * zoom + offsetX, y: w.b.y * zoom + offsetY }
    const isSel = (selectedSet ? selectedSet.has(w.id) : false) || w.id === selectedId
    ctx.strokeStyle = isSel ? '#22c55e' : '#cbd5e1'
    ctx.lineWidth = Math.max(2, w.thickness * zoom * 0.1)
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
  }
}

function drawRooms(ctx: CanvasRenderingContext2D, rooms: Room[], zoom: number, offsetX: number, offsetY: number, selectedId?: string, selectedSet?: Set<string>) {
  ctx.save()
  for (const r of rooms) {
    if (r.points.length < 3) continue
    ctx.beginPath()
    r.points.forEach((p, i) => {
      const sp = { x: p.x * zoom + offsetX, y: p.y * zoom + offsetY }
      if (i === 0) ctx.moveTo(sp.x, sp.y)
      else ctx.lineTo(sp.x, sp.y)
    })
    ctx.closePath()
    const isSel = (selectedSet ? selectedSet.has(r.id) : false) || r.id === selectedId
    ctx.fillStyle = isSel ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.12)'
    ctx.strokeStyle = isSel ? '#22c55e' : '#60a5fa'
    ctx.lineWidth = 1.5
    ctx.fill(); ctx.stroke()

    // label
    if (r.name) {
      const cx = r.points.reduce((s, p) => s + p.x, 0) / r.points.length
      const cy = r.points.reduce((s, p) => s + p.y, 0) / r.points.length
      const sp = { x: cx * zoom + offsetX, y: cy * zoom + offsetY }
      ctx.fillStyle = '#cbd5e1'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'
      ctx.fillText(r.name, sp.x, sp.y)
    }
  }
  ctx.restore()
}

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 300, h: 200 })
  const { plan, viewport, setViewport, tool, addWall, setSelection, selection } = useApp()

  const selectedId = selection.type && selection.type !== 'multi' ? selection.id : undefined
  const selectedSet = selection.type === 'multi' ? new Set(selection.items.map((i) => i.id)) : undefined

  // snapping helpers (in world units) — need access to current plan
  const SNAP_TOL = 15 // cm
  function collectSnapVertices(exclude?: { type: 'wall' | 'room'; id: string }): Vec2[] {
    const verts: Vec2[] = []
    for (const w of plan.walls) {
      if (exclude && exclude.type === 'wall' && exclude.id === w.id) continue
      verts.push(w.a, w.b)
    }
    for (const r of plan.rooms) {
      if (exclude && exclude.type === 'room' && exclude.id === r.id) continue
      verts.push(...r.points)
    }
    return verts
  }
  function collectSnapSegments(exclude?: { type: 'wall' | 'room'; id: string }): Array<{ a: Vec2; b: Vec2 }> {
    const segs: Array<{ a: Vec2; b: Vec2 }> = []
    for (const w of plan.walls) {
      if (exclude && exclude.type === 'wall' && exclude.id === w.id) continue
      segs.push({ a: w.a, b: w.b })
    }
    for (const r of plan.rooms) {
      if (exclude && exclude.type === 'room' && exclude.id === r.id) continue
      for (let i = 0; i < r.points.length; i++) {
        const a = r.points[i]
        const b = r.points[(i + 1) % r.points.length]
        segs.push({ a, b })
      }
    }
    return segs
  }
  function snapPoint(p: Vec2, exclude?: { type: 'wall' | 'room'; id: string }): Vec2 {
    let best: { d: number; point: Vec2 } | null = null
    // vertices first
    for (const v of collectSnapVertices(exclude)) {
      const d = dist(p, v)
      if (d <= SNAP_TOL && (!best || d < best.d)) best = { d, point: v }
    }
    // then segments (projection)
    for (const s of collectSnapSegments(exclude)) {
      const { point, dist: d } = projPointOnSeg(p, s.a, s.b)
      if (d <= SNAP_TOL && (!best || d < best.d)) best = { d, point }
    }
    return best ? best.point : p
  }

  useEffect(() => {
    const el = canvasRef.current!
    const resize = () => {
      const rect = el.parentElement!.getBoundingClientRect()
      setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) })
    }
    resize()
    const obs = new ResizeObserver(resize)
    obs.observe(el.parentElement as Element)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const el = canvasRef.current!
    el.width = size.w
    el.height = size.h
    const ctx = el.getContext('2d')!
    drawGrid(ctx, size.w, size.h, viewport.zoom, viewport.offset.x, viewport.offset.y)
    drawRooms(ctx, plan.rooms, viewport.zoom, viewport.offset.x, viewport.offset.y, selectedId, selectedSet)
    drawWalls(ctx, plan.walls, viewport.zoom, viewport.offset.x, viewport.offset.y, selectedId, selectedSet)
    // persistent handles on selection
    if (selection.type === 'wall' && selection.id) {
      const w = plan.walls.find((x) => x.id === selection.id)
      if (w) {
        const sa = worldToScreen(w.a, viewport)
        const sb = worldToScreen(w.b, viewport)
        drawHandles(ctx, viewport.zoom, [sa, sb])
      }
    } else if (selection.type === 'room' && selection.id) {
      const r = plan.rooms.find((x) => x.id === selection.id)
      if (r) {
        const spts = r.points.map((p) => worldToScreen(p, viewport))
        drawHandles(ctx, viewport.zoom, spts)
      }
    }
  }, [size, plan, viewport, selectedId, selection])

  // interaction
  type DragState =
    | { type: 'pan'; start: Vec2; last: Vec2 }
    | { type: 'wall-create'; start: Vec2; last: Vec2 }
    | { type: 'room-create'; start: Vec2; last: Vec2 }
    | { type: 'move-wall'; id: string; start: Vec2; last: Vec2; orig: { a: Vec2; b: Vec2 } }
    | { type: 'move-wall-end'; id: string; end: 'a' | 'b'; start: Vec2; last: Vec2; orig: { a: Vec2; b: Vec2 } }
    | { type: 'move-room'; id: string; start: Vec2; last: Vec2; orig: Vec2[] }
    | { type: 'move-room-vertex'; id: string; index: number; start: Vec2; last: Vec2; orig: Vec2[] }
    | { type: 'rotate'; id: string; entity: 'wall' | 'room'; center: Vec2; startAngle: number; lastAngle: number; orig: { a?: Vec2; b?: Vec2; points?: Vec2[] } }
    | { type: 'select'; start: Vec2; last: Vec2 }
  const dragging = useRef<DragState | null>(null)

  const onWheel: React.WheelEventHandler<HTMLCanvasElement> = (e) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      // zoom at cursor
      const mouse = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }
      const before = screenToWorld(mouse, viewport)
      const nextZoom = Math.min(5, Math.max(0.2, viewport.zoom * (e.deltaY < 0 ? 1.1 : 0.9)))
      const after = { x: before.x, y: before.y }
      const nextOffset = {
        x: mouse.x - after.x * nextZoom,
        y: mouse.y - after.y * nextZoom,
      }
      setViewport({ zoom: nextZoom, offset: nextOffset })
    } else {
      // pan
      setViewport({ offset: { x: viewport.offset.x - e.deltaX, y: viewport.offset.y - e.deltaY } })
    }
  }

  const hitTest = (p: Vec2): { type: 'wall' | 'room'; id: string } | null => {
    // simple hit test: rooms first
    for (const r of plan.rooms) {
      // point-in-polygon
      let inside = false
      for (let i = 0, j = r.points.length - 1; i < r.points.length; j = i++) {
        const xi = r.points[i].x, yi = r.points[i].y
        const xj = r.points[j].x, yj = r.points[j].y
        const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
        if (intersect) inside = !inside
      }
      if (inside) return { type: 'room', id: r.id }
    }
    // walls as thick lines
    const tol = 10 // cm
    const tol2 = tol * tol
    for (const w of plan.walls) {
      const ax = w.a.x, ay = w.a.y, bx = w.b.x, by = w.b.y
      const dx = bx - ax, dy = by - ay
      const len2 = dx * dx + dy * dy
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2))
      const cx = ax + t * dx, cy = ay + t * dy
      const dist2 = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy)
      if (dist2 <= tol2) return { type: 'wall', id: w.id }
    }
    return null
  }

  const onMouseDown: React.MouseEventHandler<HTMLCanvasElement> = (e) => {
    const mouse = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }
    const world = screenToWorld(mouse, viewport)
    if (tool === 'pan' || e.button === 1) {
      dragging.current = { type: 'pan', start: mouse, last: mouse }
      return
    }
    if (tool === 'wall') {
      dragging.current = { type: 'wall-create', start: world, last: world }
      return
    }
    // select/room
    if (tool === 'select') {
      // prefer manipulating selected entity if clicked on handle/body
      if (selection.type === 'wall' && selection.id) {
        const w = plan.walls.find((x) => x.id === selection.id)
        if (w) {
          const handleTol = 12
          const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= handleTol
          if (near(world, w.a)) { dragging.current = { type: 'move-wall-end', id: w.id, end: 'a', start: world, last: world, orig: { a: { ...w.a }, b: { ...w.b } } }; return }
          if (near(world, w.b)) { dragging.current = { type: 'move-wall-end', id: w.id, end: 'b', start: world, last: world, orig: { a: { ...w.a }, b: { ...w.b } } }; return }
          // click on wall body
          const tol = 10; const ax = w.a.x, ay = w.a.y, bx = w.b.x, by = w.b.y
          const dx = bx - ax, dy = by - ay; const len2 = dx * dx + dy * dy
          const t = Math.max(0, Math.min(1, ((world.x - ax) * dx + (world.y - ay) * dy) / len2))
          const cx = ax + t * dx, cy = ay + t * dy
          if ((world.x - cx) ** 2 + (world.y - cy) ** 2 <= tol * tol) {
            dragging.current = { type: 'move-wall', id: w.id, start: world, last: world, orig: { a: { ...w.a }, b: { ...w.b } } }
            return
          }
        }
      } else if (selection.type === 'room' && selection.id) {
        const r = plan.rooms.find((x) => x.id === selection.id)
        if (r) {
          const handleTol = 12
          const idx = r.points.findIndex((p) => Math.hypot(p.x - world.x, p.y - world.y) <= handleTol)
          if (idx >= 0) { dragging.current = { type: 'move-room-vertex', id: r.id, index: idx, start: world, last: world, orig: r.points.map((p) => ({ ...p })) }; return }
          // inside polygon => move whole room
          let inside = false
          for (let i = 0, j = r.points.length - 1; i < r.points.length; j = i++) {
            const xi = r.points[i].x, yi = r.points[i].y
            const xj = r.points[j].x, yj = r.points[j].y
            const intersect = yi > world.y !== yj > world.y && world.x < ((xj - xi) * (world.y - yi)) / (yj - yi) + xi
            if (intersect) inside = !inside
          }
          if (inside) { dragging.current = { type: 'move-room', id: r.id, start: world, last: world, orig: r.points.map((p) => ({ ...p })) }; return }
        }
      }
      // regular hit selection
      const hit = hitTest(world)
      if (hit) setSelection({ type: hit.type, id: hit.id })
      else setSelection({ type: null })
      dragging.current = { type: 'select', start: world, last: world }
    }
    if (tool === 'rotate') {
      if (selection.type !== 'wall' && selection.type !== 'room') return
      const selId = selection.id!
      if (selection.type === 'wall') {
        const w = plan.walls.find((x) => x.id === selId)
        if (!w) return
        const center = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }
        const startAngle = Math.atan2(world.y - center.y, world.x - center.x)
        dragging.current = { type: 'rotate', id: w.id, entity: 'wall', center, startAngle, lastAngle: startAngle, orig: { a: { ...w.a }, b: { ...w.b } } }
        return
      } else if (selection.type === 'room') {
        const r = plan.rooms.find((x) => x.id === selId)
        if (!r) return
        const cx = r.points.reduce((s, p) => s + p.x, 0) / r.points.length
        const cy = r.points.reduce((s, p) => s + p.y, 0) / r.points.length
        const center = { x: cx, y: cy }
        const startAngle = Math.atan2(world.y - center.y, world.x - center.x)
        dragging.current = { type: 'rotate', id: r.id, entity: 'room', center, startAngle, lastAngle: startAngle, orig: { points: r.points.map((p) => ({ ...p })) } }
        return
      }
    }
    if (tool === 'room') {
      // click-drag to create rect
      dragging.current = { type: 'room-create', start: world, last: world }
    }
  }

  const onMouseMove: React.MouseEventHandler<HTMLCanvasElement> = (e) => {
    const mouse = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }
    const world = screenToWorld(mouse, viewport)
    const d = dragging.current
    if (!d) return
    if (d.type === 'pan') {
      const dx = mouse.x - d.last.x
      const dy = mouse.y - d.last.y
      d.last = mouse
      setViewport({ offset: { x: viewport.offset.x + dx, y: viewport.offset.y + dy } })
    } else if (d.type === 'wall-create') {
      d.last = world
      // draw preview
      const el = canvasRef.current!
      const ctx = el.getContext('2d')!
      drawGrid(ctx, el.width, el.height, viewport.zoom, viewport.offset.x, viewport.offset.y)
      drawRooms(ctx, plan.rooms, viewport.zoom, viewport.offset.x, viewport.offset.y, selectedId, selectedSet)
      drawWalls(ctx, plan.walls, viewport.zoom, viewport.offset.x, viewport.offset.y, selectedId, selectedSet)
      // preview line
      ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2
      const a = worldToScreen(d.start, viewport); const b = worldToScreen(d.last, viewport)
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
    } else if (d.type === 'room-create') {
      d.last = world
      const el = canvasRef.current!
      const ctx = el.getContext('2d')!
      drawGrid(ctx, el.width, el.height, viewport.zoom, viewport.offset.x, viewport.offset.y)
      drawRooms(ctx, plan.rooms, viewport.zoom, viewport.offset.x, viewport.offset.y, selectedId, selectedSet)
      drawWalls(ctx, plan.walls, viewport.zoom, viewport.offset.x, viewport.offset.y, selectedId, selectedSet)
      const a = worldToScreen(d.start, viewport); const b = worldToScreen(d.last, viewport)
      ctx.fillStyle = 'rgba(59,130,246,0.12)'; ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.fill(); ctx.stroke()
    } else if (d.type === 'move-wall' || d.type === 'move-wall-end' || d.type === 'move-room' || d.type === 'move-room-vertex' || d.type === 'rotate' || d.type === 'select') {
      // live preview without mutating store
      const el = canvasRef.current!
      const ctx = el.getContext('2d')!
      drawGrid(ctx, el.width, el.height, viewport.zoom, viewport.offset.x, viewport.offset.y)
      drawRooms(ctx, plan.rooms, viewport.zoom, viewport.offset.x, viewport.offset.y, selectedId, selectedSet)
      drawWalls(ctx, plan.walls, viewport.zoom, viewport.offset.x, viewport.offset.y, selectedId, selectedSet)
      if (d.type !== 'rotate' && d.type !== 'select') {
        // track last only for move operations
        const dx = world.x - d.last.x
        const dy = world.y - d.last.y
        d.last = world
      }

      ctx.save()
      ctx.strokeStyle = '#22c55e'
      ctx.lineWidth = 2
      if (d.type === 'select') {
        d.last = world
        const a = worldToScreen(d.start, viewport); const b = worldToScreen(d.last, viewport)
        ctx.fillStyle = 'rgba(34,197,94,0.10)'
        ctx.strokeStyle = '#22c55e'
        ctx.beginPath(); ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.fill(); ctx.stroke()
      } else if (d.type === 'move-wall' || d.type === 'move-wall-end') {
        let a = { ...d.orig.a }, b = { ...d.orig.b }
        if (d.type === 'move-wall') {
          a = { x: a.x + (world.x - d.start.x), y: a.y + (world.y - d.start.y) }
          b = { x: b.x + (world.x - d.start.x), y: b.y + (world.y - d.start.y) }
          // optional: snap translation so closest endpoint sticks
          const snapA = snapPoint(a, { type: 'wall', id: d.id })
          const snapB = snapPoint(b, { type: 'wall', id: d.id })
          // if either snapped adjust both by same delta to keep wall rigid
          const da = { x: snapA.x - a.x, y: snapA.y - a.y }
          const db = { x: snapB.x - b.x, y: snapB.y - b.y }
          const use = Math.hypot(da.x, da.y) < Math.hypot(db.x, db.y) ? da : db
          if (Math.hypot(use.x, use.y) <= SNAP_TOL) { a = { x: a.x + use.x, y: a.y + use.y }; b = { x: b.x + use.x, y: b.y + use.y } }
        } else if (d.end === 'a') {
          const next = { x: a.x + (world.x - d.start.x), y: a.y + (world.y - d.start.y) }
          a = snapPoint(next, { type: 'wall', id: d.id })
        } else {
          const next = { x: b.x + (world.x - d.start.x), y: b.y + (world.y - d.start.y) }
          b = snapPoint(next, { type: 'wall', id: d.id })
        }
        const sa = worldToScreen(a, viewport), sb = worldToScreen(b, viewport)
        ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke()
        // handles
        drawHandles(ctx, viewport.zoom, [sa, sb])
      } else if (d.type === 'move-room' || d.type === 'move-room-vertex') {
        const pts = d.orig.map((p: Vec2, i: number) => {
          if (d.type === 'move-room') return { x: p.x + (world.x - d.start.x), y: p.y + (world.y - d.start.y) }
          if (i === d.index) {
            const moved = { x: p.x + (world.x - d.start.x), y: p.y + (world.y - d.start.y) }
            return snapPoint(moved, { type: 'room', id: d.id })
          }
          return { ...p }
        })
        // draw preview polygon
        ctx.beginPath()
        pts.forEach((p: Vec2, i: number) => {
          const sp = worldToScreen(p, viewport)
          if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y)
        })
        ctx.closePath(); ctx.stroke()
        // handles
        const spts = pts.map((p: Vec2) => worldToScreen(p, viewport))
        drawHandles(ctx, viewport.zoom, spts)
      } else if (d.type === 'rotate') {
        const angle = Math.atan2(world.y - d.center.y, world.x - d.center.x)
        const delta = angle - d.startAngle
        if (d.entity === 'wall' && d.orig.a && d.orig.b) {
          const rot = (p: Vec2): Vec2 => {
            const x = p.x - d.center.x, y = p.y - d.center.y
            const c = Math.cos(delta), s = Math.sin(delta)
            return { x: d.center.x + x * c - y * s, y: d.center.y + x * s + y * c }
          }
          const a = rot(d.orig.a), b = rot(d.orig.b)
          const sa = worldToScreen(a, viewport), sb = worldToScreen(b, viewport)
          ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke()
          drawHandles(ctx, viewport.zoom, [sa, sb])
        } else if (d.entity === 'room' && d.orig.points) {
          const rot = (p: Vec2): Vec2 => {
            const x = p.x - d.center.x, y = p.y - d.center.y
            const c = Math.cos(delta), s = Math.sin(delta)
            return { x: d.center.x + x * c - y * s, y: d.center.y + x * s + y * c }
          }
          const pts = d.orig.points.map(rot)
          ctx.beginPath()
          pts.forEach((p, i) => {
            const sp = worldToScreen(p, viewport)
            if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y)
          })
          ctx.closePath(); ctx.stroke()
          const spts = pts.map((p) => worldToScreen(p, viewport))
          drawHandles(ctx, viewport.zoom, spts)
        }
      }
      ctx.restore()
    }
  }

  const onMouseUp: React.MouseEventHandler<HTMLCanvasElement> = (e) => {
    const mouse = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }
    const world = screenToWorld(mouse, viewport)
    const d = dragging.current
    dragging.current = null
    if (!d) return
    if (d.type === 'wall-create') {
      addWall(d.start, world)
    } else if (d.type === 'room-create') {
      const x0 = Math.min(d.start.x, world.x), x1 = Math.max(d.start.x, world.x)
      const y0 = Math.min(d.start.y, world.y), y1 = Math.max(d.start.y, world.y)
      const points = [ { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 } ]
      useApp.getState().addRoom(points, 'Room')
    } else if (d.type === 'move-wall') {
      const dx = world.x - d.start.x, dy = world.y - d.start.y
      // snap translation as used in preview
      let a = { x: d.orig.a.x + dx, y: d.orig.a.y + dy }
      let b = { x: d.orig.b.x + dx, y: d.orig.b.y + dy }
      const snapA = snapPoint(a, { type: 'wall', id: d.id })
      const snapB = snapPoint(b, { type: 'wall', id: d.id })
      const da = { x: snapA.x - a.x, y: snapA.y - a.y }
      const db = { x: snapB.x - b.x, y: snapB.y - b.y }
      const use = Math.hypot(da.x, da.y) < Math.hypot(db.x, db.y) ? da : db
      if (Math.hypot(use.x, use.y) <= SNAP_TOL) { a = { x: a.x + use.x, y: a.y + use.y }; b = { x: b.x + use.x, y: b.y + use.y } }
      useApp.getState().updateWall(d.id, { a, b })
      setSelection({ type: 'wall', id: d.id })
    } else if (d.type === 'move-wall-end') {
      const delta = { x: world.x - d.start.x, y: world.y - d.start.y }
      const a = d.end === 'a' ? snapPoint({ x: d.orig.a.x + delta.x, y: d.orig.a.y + delta.y }, { type: 'wall', id: d.id }) : d.orig.a
      const b = d.end === 'b' ? snapPoint({ x: d.orig.b.x + delta.x, y: d.orig.b.y + delta.y }, { type: 'wall', id: d.id }) : d.orig.b
      useApp.getState().updateWall(d.id, { a, b })
      setSelection({ type: 'wall', id: d.id })
    } else if (d.type === 'move-room') {
      const dx = world.x - d.start.x, dy = world.y - d.start.y
      const next = d.orig.map((p) => ({ x: p.x + dx, y: p.y + dy }))
      useApp.getState().updateRoom(d.id, { points: next })
      setSelection({ type: 'room', id: d.id })
    } else if (d.type === 'move-room-vertex') {
      const dx = world.x - d.start.x, dy = world.y - d.start.y
      const moved = snapPoint({ x: d.orig[d.index].x + dx, y: d.orig[d.index].y + dy }, { type: 'room', id: d.id })
      const next = d.orig.map((p, i) => (i === d.index ? moved : p))
      useApp.getState().updateRoom(d.id, { points: next })
      setSelection({ type: 'room', id: d.id })
    } else if (d.type === 'rotate') {
      const angle = Math.atan2(world.y - d.center.y, world.x - d.center.x)
      const delta = angle - d.startAngle
      const rot = (p: Vec2): Vec2 => {
        const x = p.x - d.center.x, y = p.y - d.center.y
        const c = Math.cos(delta), s = Math.sin(delta)
        return { x: d.center.x + x * c - y * s, y: d.center.y + x * s + y * c }
      }
      if (d.entity === 'wall' && d.orig.a && d.orig.b) {
        const a = rot(d.orig.a)
        const b = rot(d.orig.b)
        useApp.getState().updateWall(d.id, { a, b })
        setSelection({ type: 'wall', id: d.id })
      } else if (d.entity === 'room' && d.orig.points) {
        const pts = d.orig.points.map(rot)
        useApp.getState().updateRoom(d.id, { points: pts })
        setSelection({ type: 'room', id: d.id })
      }
    } else if (d.type === 'select') {
      // commit marquee selection
      const dx = Math.abs(world.x - d.start.x)
      const dy = Math.abs(world.y - d.start.y)
      const minWorld = 2
      // trigger if either dimension exceeds threshold (horizontal or vertical drags)
      if (dx > minWorld || dy > minWorld) {
        const x0 = Math.min(d.start.x, world.x), x1 = Math.max(d.start.x, world.x)
        const y0 = Math.min(d.start.y, world.y), y1 = Math.max(d.start.y, world.y)
        const insideRect = (minx: number, miny: number, maxx: number, maxy: number) => minx >= x0 && maxx <= x1 && miny >= y0 && maxy <= y1
        const items: { type: 'wall' | 'room'; id: string }[] = []
        for (const w of plan.walls) {
          const minx = Math.min(w.a.x, w.b.x), maxx = Math.max(w.a.x, w.b.x)
          const miny = Math.min(w.a.y, w.b.y), maxy = Math.max(w.a.y, w.b.y)
          if (insideRect(minx, miny, maxx, maxy)) items.push({ type: 'wall', id: w.id })
        }
        for (const r of plan.rooms) {
          const xs = r.points.map((p) => p.x), ys = r.points.map((p) => p.y)
          const minx = Math.min(...xs), maxx = Math.max(...xs)
          const miny = Math.min(...ys), maxy = Math.max(...ys)
          if (insideRect(minx, miny, maxx, maxy)) items.push({ type: 'room', id: r.id })
        }
        if (items.length > 0) setSelection({ type: 'multi', items })
        else setSelection({ type: null })
      }
    }
  }

  return (
    <div className="canvas-wrap">
      <canvas ref={canvasRef} width={size.w} height={size.h}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
    </div>
  )
}
