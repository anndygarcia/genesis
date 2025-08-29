import React, { useRef, useState } from 'react'
import { useApp } from '../store'

export function IOBar() {
  const { exportJSON, importJSON } = useApp()
  const [show, setShow] = useState(false)
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const handleCopy = async () => {
    const data = exportJSON()
    await navigator.clipboard.writeText(data)
  }

  const handleDownload = () => {
    const data = exportJSON()
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'plan.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') importJSON(reader.result)
    }
    reader.readAsText(file)
  }

  return (
    <div className="iobar">
      <button className="button" onClick={handleCopy}>Copy JSON</button>
      <button className="button" onClick={handleDownload}>Download</button>
      <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => e.target.files && handleFile(e.target.files[0])} />
      <button className="button" onClick={() => fileRef.current?.click()}>Import File</button>
      <button className="button" onClick={() => { setText(exportJSON()); setShow((s) => !s) }}>
        {show ? 'Hide JSON' : 'Show JSON'}
      </button>
      {show && (
        <textarea style={{ flex: 1, height: 120, background: '#0f1219', color: 'var(--text)', border: '1px solid #252a36', borderRadius: 6, padding: 8 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => importJSON(text)}
        />
      )}
    </div>
  )
}
