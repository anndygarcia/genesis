import React from 'react'
import MetalInteractiveInline from './MetalInteractiveInline'

interface LogoSpinnerProps {
  size?: number | string // e.g. 96 or '6rem'
  className?: string
  speedMs?: number // animation duration override
  src?: string // optional alternate logo source
}

const toSizeClass = (size?: number | string) => {
  if (!size) return 'h-16 w-16'
  if (typeof size === 'number') return `h-[${size}px] w-[${size}px]`
  return `h-[${size}] w-[${size}]`
}

const LogoSpinner: React.FC<LogoSpinnerProps> = ({ size, className = '', speedMs, src }) => {
  const style = speedMs ? ({ animationDuration: `${speedMs}ms` } as React.CSSProperties) : undefined
  const cls = `logo-spinner inline-flex ${className}`
  const dim = toSizeClass(size)
  const logoSrc = src || '/media/genesis-logo.png'
  return (
    <div className={cls} style={style} aria-label="Loading">
      <MetalInteractiveInline mode="image" maskSrc={logoSrc}>
        <img
          src={logoSrc}
          alt="Genesis AI logo"
          draggable={false}
          className={`${dim} select-none`}
        />
      </MetalInteractiveInline>
    </div>
  )
}

export default LogoSpinner
