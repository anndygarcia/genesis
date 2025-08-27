import React from 'react'

type Mode = 'default' | 'text' | 'image'

const MetalInteractiveInline: React.FC<{
  className?: string
  children: React.ReactNode
  mode?: Mode
  maskSrc?: string
}> = ({ className = '', children, mode = 'default', maskSrc }) => {
  const ref = React.useRef<HTMLDivElement>(null)
  const last = React.useRef({ mx: 0.5, my: 0.5, ang: 90, rx: 0, ry: 0, shine: 0.35 })
  const raf = React.useRef<number | null>(null)

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const { left, top, width, height } = el.getBoundingClientRect()
    const x = Math.min(Math.max(e.clientX - left, 0), width)
    const y = Math.min(Math.max(e.clientY - top, 0), height)
    const px = x / width
    const py = y / height

    const ry = (px - 0.5) * 6
    const rx = -(py - 0.5) * 6
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
    const angDeg = 90 + clamp(ry * 1.6 + rx * 1.2, -20, 20)

    let bias = Math.min(1, Math.abs(px - 0.5) * 2)
    bias = Math.pow(bias, 0.6)
    const edgeTargetX = px < 0.5 ? 0.06 : 0.94
    const mx = (1 - 0.45 * bias) * px + (0.45 * bias) * edgeTargetX
    const my = clamp(py, 0.08, 0.92)

    const dx0 = px - 0.5
    const dy0 = py - 0.5
    const dist = Math.hypot(dx0, dy0) / Math.SQRT1_2
    const shine = Math.max(0.22, Math.min(0.5, 0.22 + 0.30 * dist))

    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t
      const currentAng = last.current.ang
      let delta = angDeg - currentAng
      if (delta > 180) delta -= 360
      if (delta < -180) delta += 360
      const smAng = currentAng + delta * 0.12
      const smMx = lerp(last.current.mx, mx, 0.16)
      const smMy = lerp(last.current.my, my, 0.16)
      const smRx = lerp(last.current.rx, rx, 0.16)
      const smRy = lerp(last.current.ry, ry, 0.16)
      const smShine = lerp(last.current.shine, shine, 0.12)
      last.current = { mx: smMx, my: smMy, ang: smAng, rx: smRx, ry: smRy, shine: smShine }

      el.style.setProperty('--mx', `${(smMx * 100).toFixed(3)}%`)
      el.style.setProperty('--my', `${(smMy * 100).toFixed(3)}%`)
      const dx = (smMx - 0.5) * 2 * width
      const dy = (smMy - 0.5) * 1.6 * height
      el.style.setProperty('--dx', `${dx.toFixed(3)}px`)
      el.style.setProperty('--dy', `${dy.toFixed(3)}px`)
      el.style.setProperty('--rx', `${smRx.toFixed(2)}deg`)
      el.style.setProperty('--ry', `${smRy.toFixed(2)}deg`)
      el.style.setProperty('--ang', `${smAng.toFixed(2)}deg`)
      el.style.setProperty('--shine', smShine.toFixed(3))
    })
  }

  const handleLeave = () => {
    const el = ref.current
    if (!el) return
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      el.style.setProperty('--mx', '50%')
      el.style.setProperty('--my', '50%')
      el.style.setProperty('--dx', '0px')
      el.style.setProperty('--dy', '0px')
      el.style.setProperty('--rx', '0deg')
      el.style.setProperty('--ry', '0deg')
      el.style.setProperty('--ang', '90deg')
      el.style.setProperty('--shine', '0.30')
    })
  }

  const modeClass = mode === 'text' ? 'text-only' : mode === 'image' ? 'icon-mask' : ''
  const style = maskSrc ? ({ ['--mask-url' as any]: `url('${maskSrc}')` } as React.CSSProperties) : undefined

  return (
    <div
      ref={ref}
      className={`metal-interactive metal-inline ${modeClass} ${className}`}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={style}
    >
      {children}
    </div>
  )
}

export default MetalInteractiveInline
