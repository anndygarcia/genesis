import React, { useState } from 'react'
import { useApp } from '../store'
import type { GeneratorInput } from '../types'

export function Sidebar() {
  const { selection, plan, updateRoom, adminMode, generatePlan } = useApp()
  const [gen, setGen] = useState<GeneratorInput>({
    bedrooms: 3,
    bathrooms: 2,
    garageSpots: 2,
    sqft: 1800,
    style: 'modern',
  })

  const selectedRoom = selection.type === 'room' ? plan.rooms.find((r) => r.id === selection.id) : undefined

  return (
    <div className="sidebar">
      <div className="group">
        <h3>Generator</h3>
        <label>Bedrooms</label>
        <input type="number" min={0} value={gen.bedrooms} onChange={(e) => setGen({ ...gen, bedrooms: +e.target.value })} />
        <label>Bathrooms</label>
        <input type="number" min={0} value={gen.bathrooms} onChange={(e) => setGen({ ...gen, bathrooms: +e.target.value })} />
        <label>Garage Spots</label>
        <input type="number" min={0} value={gen.garageSpots} onChange={(e) => setGen({ ...gen, garageSpots: +e.target.value })} />
        <div className="row">
          <div>
            <label>Square Feet</label>
            <input type="number" min={200} step={50} value={gen.sqft} onChange={(e) => setGen({ ...gen, sqft: +e.target.value })} />
          </div>
          <div>
            <label>Style</label>
            <select value={gen.style} onChange={(e) => setGen({ ...gen, style: e.target.value as any })}>
              <option value="modern">Modern</option>
              <option value="traditional">Traditional</option>
              <option value="ranch">Ranch</option>
              <option value="colonial">Colonial</option>
            </select>
          </div>
        </div>
        <button className="button primary" onClick={() => generatePlan(gen)}>Generate Layout</button>
      </div>

      <div className="group">
        <h3>Selection</h3>
        {selection.type === null && <div className="badge">Nothing selected</div>}
        {selection.type === 'room' && selectedRoom && (
          <div>
            <label>Name</label>
            <input value={selectedRoom.name || ''} onChange={(e) => updateRoom(selectedRoom.id, { name: e.target.value })} />
            <div className="badge">Vertices: {selectedRoom.points.length}</div>
          </div>
        )}
        {selection.type === 'wall' && <div className="badge">Wall selected</div>}
      </div>

      {adminMode && (
        <div className="group">
          <h3>Admin Tools</h3>
          <div className="badge">Admin mode is ON</div>
          <p style={{ color: '#98a2b3', fontSize: 12 }}>
            Extra controls could be added here (snapping, constraints, heuristics, debug overlays).
          </p>
        </div>
      )}
    </div>
  )
}
