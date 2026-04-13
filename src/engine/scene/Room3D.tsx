export function Room3DView() {
  return null;
}

export default Room3DView;
export function Room3DView(){
  return null;
}

export default Room3DView;
"use client";
import * as React from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, OrbitControls, TransformControls, PointerLockControls, Line, useTexture, Billboard } from "@react-three/drei";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { useProjectStore, getWallSegments } from "@/engine/state/projectStore";
import { useSelectionStore } from "@/engine/state/selectionStore";
import { useUIStore } from "@/engine/state/uiStore";
import { GLTFSafe } from "@/engine/components/GLTFSafe";

// [File content truncated in explanation: copied full implementation from home-designer with small adjustments]
// The entire Room3D.tsx from the designer app is included below, with Canvas style height tweaked to 64px header.

function WallsAndFloor() {
  const points = useProjectStore((s) => s.points);
  const wallHeight = useProjectStore((s) => s.wallHeight);
  const wallThickness = useProjectStore((s) => s.wallThickness);
  const openings = useProjectStore((s) => s.openings);
  const setWallHeight = useProjectStore((s) => s.setWallHeight);
  const setPoints = useProjectStore((s)=> s.setPoints);
  const showRoof = useUIStore(s=>s.showRoof);
  const addOpening = useProjectStore((s)=> s.addOpening);
  const { selected, setSelection } = useSelectionStore();
  const toolDoor = useUIStore(s=>s.toolDoor);
  const toolWindow = useUIStore(s=>s.toolWindow);
  const snap = useUIStore(s=>s.snap);
  const transformMode = useUIStore(s=>s.transformMode);
  const drawWalls = useUIStore(s=>s.drawWalls);

  const group = React.useRef<THREE.Group>(null);
  const [hoverWall, setHoverWall] = React.useState<string|null>(null);

  const segments = React.useMemo(() => getWallSegments(points), [points]);

  const floorShape = React.useMemo(() => {
    const shape = new THREE.Shape(points.map((p, i) => new THREE.Vector2(p.x, p.z)));
    return shape;
  }, [points]);

  return (
    <group ref={group}>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[floorShape]} />
        <meshStandardMaterial color="#6b7280" roughness={0.9} metalness={0.0} />
      </mesh>

      {/* Walls - split panels by openings */}
      {segments.map((seg, i) => {
        const list = openings[seg.id] || [];
        const runs: { start: number; end: number }[] = [];
        // Start with full segment [0,len]
        let cursor = 0;
        const sorted = [...list].sort((a,b)=>a.offsetAlongWall-b.offsetAlongWall);
        for (const o of sorted) {
          const oStart = THREE.MathUtils.clamp(o.offsetAlongWall, 0, seg.length);
          const oEnd = THREE.MathUtils.clamp(oStart + o.width, 0, seg.length);
          if (oStart > cursor) runs.push({ start: cursor, end: oStart });
          cursor = Math.max(cursor, oEnd);
        }
        if (cursor < seg.length) runs.push({ start: cursor, end: seg.length });

        return (
          <group key={seg.id}
            position={[seg.mid.x, wallHeight/2, seg.mid.z]}
            rotation={[0, seg.rotY, 0]}
            onPointerDown={(e)=>{
              e.stopPropagation();
              // add door/window opening when a tool is active
              if (toolDoor || toolWindow){
                const hit = e.point.clone();
                const a = new THREE.Vector3(seg.a.x, 0, seg.a.z);
                const b = new THREE.Vector3(seg.b.x, 0, seg.b.z);
                const ab = new THREE.Vector3().subVectors(b, a);
                const len = ab.length();
                const dir = ab.normalize();
                const ah = new THREE.Vector3().subVectors(hit, a);
                let offset = THREE.MathUtils.clamp(ah.dot(dir), 0.05, len - 0.05);
                const opening = toolDoor
                  ? { offsetAlongWall: offset, width: 0.9, height: 2.1, sill: 0.0 }
                  : { offsetAlongWall: offset, width: 1.2, height: 1.1, sill: 0.9 };
                addOpening(seg.id, opening);
                setSelection({ kind: 'wall', id: seg.id });
                return;
              }
              setSelection({ kind: 'wall', id: seg.id });
            }}>
            {runs.map((r, idx)=>{
              const len = (r.end - r.start);
              const localMid = (r.start + r.end)/2 - seg.length/2;
              return (
                <mesh key={`w-${i}-${idx}`} position={[localMid, 0, 0]}>
                  <boxGeometry args={[len, wallHeight, wallThickness]} />
                  <meshStandardMaterial color={ (selected?.kind==='wall' && selected.id === seg.id) ? "#66ccff" : "#9ca3af" } />
                </mesh>
              );
            })}
            {/* Opening vertical cuts (top/bottom caps) */}
            {sorted.map((o, oi) => {
              const oStart = THREE.MathUtils.clamp(o.offsetAlongWall, 0, seg.length);
              const oEnd = THREE.MathUtils.clamp(oStart + o.width, 0, seg.length);
              const oMid = (oStart + oEnd)/2 - seg.length/2;
              const oLen = (oEnd - oStart);
              const bottomH = Math.max(0, Math.min(o.sill, wallHeight));
              const topH = Math.max(0, wallHeight - Math.max(0, Math.min(wallHeight, o.sill + o.height)));
              return (
                <group key={`oc-${i}-${oi}`} position={[oMid, 0, 0]}>
                  {bottomH > 0 && (
                    <mesh position={[0, bottomH/2, 0]} castShadow receiveShadow>
                      <boxGeometry args={[oLen, bottomH, wallThickness]} />
                      <meshStandardMaterial color="#9ca3af" />
                    </mesh>
                  )}
                  {topH > 0 && (
                    <mesh position={[0, wallHeight - topH/2, 0]} castShadow receiveShadow>
                      <boxGeometry args={[oLen, topH, wallThickness]} />
                      <meshStandardMaterial color="#9ca3af" />
                    </mesh>
                  )}
                </group>
              );
            })}
            {/* Opening draggable center handles (move along wall) */}
            {sorted.map((o, oi) => (
              <OpeningHandle key={`oh-${i}-${oi}`} segId={seg.id} segLength={seg.length} wallHeight={wallHeight} wallThickness={wallThickness}
                openingIndex={oi} opening={o} snap={snap} />
            ))}
            {/* Top-edge handle (TransformControls Y) visible when selected */}
            {selected?.kind === 'wall' && selected.id === seg.id && (
              <WallHeightHandle xLen={seg.length} wallHeight={wallHeight} onChange={(y)=> setWallHeight(Math.max(1, y))} />
            )}
            <WallProxy
              seg={seg}
              wallHeight={wallHeight}
              wallThickness={wallThickness}
              selected={selected?.kind==='wall' && selected.id===seg.id}
              hoverWall={hoverWall}
              setHoverWall={setHoverWall}
              transformMode={transformMode}
              toolDoor={toolDoor}
              toolWindow={toolWindow}
              drawWalls={drawWalls}
              snap={snap}
              setSelection={setSelection}
            />
          </group>
        );
      })}
      {/* Flat roof toggle */}
      {showRoof && (
        <mesh rotation={[-Math.PI/2,0,0]} position={[0, wallHeight, 0]}>
          <shapeGeometry args={[floorShape]} />
          <meshStandardMaterial color="#9b7d58" roughness={1.0} metalness={0.0} />
        </mesh>
      )}

function AddPointHandle({ index, position }:{ index:number; position:[number,number,number] }){
  const addPoint = useProjectStore(s=> s.addPoint);
  const onClick = (e:any)=>{ e.stopPropagation(); addPoint({ x: position[0], z: position[2] }, index); };
  return (
    <mesh position={position} onClick={onClick} onPointerDown={(e)=> e.stopPropagation()}>
      <boxGeometry args={[0.12, 0.04, 0.12]} />
      <meshBasicMaterial color="#22c55e" />
    </mesh>
  );
}

function Furniture({ e, selected }:{ e: ReturnType<typeof useProjectStore>['entities'][number]; selected:boolean }){
  const group = React.useRef<THREE.Group>(null);
  const updateEntityData = useProjectStore(s=>s.updateEntityData);
  const drawWalls = useUIStore(s=>s.drawWalls);
  const toolDoor = useUIStore(s=>s.toolDoor);
  const toolWindow = useUIStore(s=>s.toolWindow);
  const doorsRef = React.useRef<Array<{ hinge: THREE.Object3D; open: boolean; openAngle: number }>>([]);
  const setupDoors = React.useCallback((scene: THREE.Object3D)=>{
    if (e.type !== 'house') return;
    doorsRef.current = [];
    scene.traverse((obj:any)=>{
      if (obj.isMesh && obj.name && /door/i.test(obj.name)){
        const mesh: THREE.Mesh = obj;
        mesh.geometry?.computeBoundingBox?.();
        const bb = mesh.geometry?.boundingBox?.clone();
        if (!bb) return;
        const pivotLocal = new THREE.Vector3(bb.min.x, (bb.min.y+bb.max.y)/2, (bb.min.z+bb.max.z)/2);
        mesh.updateWorldMatrix(true, false);
        const worldPivot = mesh.localToWorld(pivotLocal.clone());
        const parent = mesh.parent as THREE.Object3D | null;
        if (!parent) return;
        const hinge = new THREE.Group();
        hinge.name = `${mesh.name}_hinge`;
        parent.add(hinge);
        const parentLocal = parent.worldToLocal(worldPivot.clone());
        hinge.position.copy(parentLocal);
        (hinge as any).attach(mesh);
        (mesh as any).userData.doorHinge = hinge;
        const rec = { hinge, open: false, openAngle: 1.35 } as { hinge: THREE.Object3D; open: boolean; openAngle: number };
        (hinge as any).userData.toggle = ()=>{ rec.open = !rec.open; };
        doorsRef.current.push(rec);
      }
    });
  },[e.type]);
  useFrame((_, dt)=>{ if (e.type !== 'house') return; for (const d of doorsRef.current){ const target = d.open ? d.openAngle : 0; const current = d.hinge.rotation.y; const next = THREE.MathUtils.damp(current, target, 6, dt); d.hinge.rotation.y = next; } });
  const onPointerDown = (evt:any)=>{
    evt.stopPropagation();
    useSelectionStore.getState().setSelection({kind: e.type==='house'?'house':'entity', id:e.id});
    if (drawWalls || toolDoor || toolWindow) return;
    if (e.type === 'house' && evt.object){
      let obj: THREE.Object3D | null = evt.object as THREE.Object3D;
      let hinge: THREE.Object3D | undefined;
      while (obj){ if ((obj as any).userData?.doorHinge){ hinge = (obj as any).userData.doorHinge; break; } obj = obj.parent as THREE.Object3D | null; }
      if (hinge){ const d = doorsRef.current.find(x=> x.hinge === hinge); if (d){ d.open = !d.open; } }
    }
  };
  React.useEffect(()=>{ if (group.current){ group.current.position.set(...e.transform.position); group.current.rotation.set(...e.transform.rotation); group.current.scale.set(...e.transform.scale); } },[e]);
  return (
    <group ref={group} onPointerDown={onPointerDown}>
      <GLTFSafe url={e.data.url || ""} onLoaded={(info)=>{ updateEntityData(e.id, { bounds: info.bounds }); setupDoors(info.scene); }} />
      {selected && (
        <mesh>
          <boxGeometry args={[1.2, 1.2, 1.2]} />
          <meshBasicMaterial color="#66ccff" wireframe transparent opacity={0.3} />
        </mesh>
      )}
    </group>
  );
}

      {/* Vertex drag handles */}
      {points.map((p, idx)=> (
        <VertexHandle key={`vh-${idx}`} index={idx} p={p} snap={snap} />
      ))}
      {/* Add point handles at segment midpoints */}
      {segments.map((seg, i)=> (
        <AddPointHandle key={`ap-${i}`} index={seg.index+1} position={[seg.mid.x, 0.05, seg.mid.z]} />
      ))}
    </group>
  );
}

function GrassGround({ onClear }: { onClear: () => void }){
  const diffuse = useTexture('https://threejs.org/examples/textures/terrain/grasslight-big.jpg') as unknown as THREE.Texture;
  React.useMemo(()=>{
    if (!diffuse) return;
    diffuse.wrapS = diffuse.wrapT = THREE.RepeatWrapping;
    diffuse.repeat.set(1200, 1200);
    diffuse.anisotropy = 16;
    (diffuse as any).colorSpace = (THREE as any).SRGBColorSpace;
  }, [diffuse]);
  return (
    <mesh rotation={[-Math.PI/2,0,0]} position={[0,-0.015,0]} onPointerDown={onClear}>
      <planeGeometry args={[5000,5000]} />
      <meshStandardMaterial map={diffuse} color="#4f8836" roughness={0.99} metalness={0.0} envMapIntensity={0.25} />
    </mesh>
  );
}

function WallHeightHandle({ xLen, wallHeight, onChange }:{ xLen:number; wallHeight:number; onChange:(y:number)=>void }){
  const handleRef = React.useRef<THREE.Mesh>(null!);
  React.useEffect(()=>{ if (handleRef.current) handleRef.current.position.set(0, wallHeight, 0); },[wallHeight]);
  return (
    <TransformControls mode="translate" showX={false} showZ={false} showY={true} translationSnap={0.05}
      onObjectChange={()=>{ if(handleRef.current) onChange(handleRef.current.position.y); }}>
      <mesh ref={handleRef}>
        <boxGeometry args={[Math.max(0.5, Math.min(2, xLen*0.1)), 0.1, 0.1]} />
        <meshBasicMaterial color="#ffd166" />
      </mesh>
    </TransformControls>
  );
}

function OpeningHandle({ segId, segLength, wallHeight, wallThickness, openingIndex, opening, snap }:{
  segId: string; segLength: number; wallHeight: number; wallThickness: number; openingIndex: number;
  opening: { offsetAlongWall: number; width: number; height: number; sill: number }; snap: boolean;
}){
  const ref = React.useRef<THREE.Object3D>(null!);
  const openings = useProjectStore(s=> s.openings);
  const updateOpenings = useProjectStore(s=> s.updateOpenings);
  const oStart = THREE.MathUtils.clamp(opening.offsetAlongWall, 0, segLength);
  const oEnd = THREE.MathUtils.clamp(oStart + opening.width, 0, segLength);
  const oMid = (oStart + oEnd)/2 - segLength/2;
  React.useEffect(()=>{ if (ref.current){ ref.current.position.set(oMid, wallHeight*0.5, 0); }}, [oMid, wallHeight]);
  const onObjectChange = ()=>{
    if (!ref.current) return;
    let cx = ref.current.position.x; if (snap){ cx = Math.round(cx/0.05)*0.05; }
    let newOffset = cx + segLength/2 - opening.width/2;
    newOffset = THREE.MathUtils.clamp(newOffset, 0, segLength - opening.width);
    const list = [...(openings[segId]||[])];
    list[openingIndex] = { ...opening, offsetAlongWall: newOffset } as any;
    updateOpenings(segId, list);
  };
  return (
    <TransformControls mode="translate" showX showY={false} showZ={false} space="local" translationSnap={snap?0.05:undefined}
      onObjectChange={onObjectChange}>
      <object3D ref={ref}>
        <mesh position={[0,0,0]} onPointerDown={(e)=> e.stopPropagation()}>
          <boxGeometry args={[0.1, 0.1, wallThickness*1.5]} />
          <meshBasicMaterial color="#ffd166" />
        </mesh>
      </object3D>
    </TransformControls>
  );
}

function VertexHandle({ index, p, snap }:{ index:number; p:{x:number; z:number}; snap:boolean }){
  const ref = React.useRef<THREE.Object3D>(null!);
  const movePoint = useProjectStore(s=> s.movePoint);
  React.useEffect(()=>{ if(ref.current){ ref.current.position.set(p.x, 0.05, p.z); }}, [p.x, p.z]);
  const onObjectChange = ()=>{
    if (!ref.current) return;
    let x = ref.current.position.x; let z = ref.current.position.z;
    if (snap){ x = Math.round(x/0.25)*0.25; z = Math.round(z/0.25)*0.25; }
    movePoint(index, { x, z });
  };
  return (
    <TransformControls mode="translate" showX showZ showY={false} space="world" translationSnap={snap?0.25:undefined}
      onObjectChange={onObjectChange}>
      <object3D ref={ref}>
        <mesh onPointerDown={(e)=> e.stopPropagation()}>
          <sphereGeometry args={[0.08, 12, 12]} />
          <meshBasicMaterial color="#ff6b6b" />
        </mesh>
      </object3D>
    </TransformControls>
  );
}

type SegInfo = { id: string; index:number; length:number; a:{x:number; z:number}; b:{x:number; z:number}; rotY:number; mid:{x:number; z:number} };
function WallProxy({ seg, wallHeight, wallThickness, selected, hoverWall, setHoverWall, transformMode, toolDoor, toolWindow, drawWalls, snap, setSelection }:{
  seg: SegInfo; wallHeight: number; wallThickness: number; selected: boolean; hoverWall: string|null; setHoverWall: (id:string|null)=>void; transformMode: string; toolDoor: boolean; toolWindow: boolean; drawWalls: boolean; snap: boolean; setSelection: (s: any)=>void; }){
  const [dragging, setDragging] = React.useState(false);
  const last = React.useRef(new THREE.Vector3());
  const started = React.useRef(false);
  const { camera, gl } = useThree();
  const raycaster = React.useMemo(()=> new THREE.Raycaster(), []);
  const plane = React.useMemo(()=> new THREE.Plane(new THREE.Vector3(0,1,0),0),[]);
  const setPointsDirect = useProjectStore(s=> s.setPointsDirect);
  const beginAction = useProjectStore(s=> s.beginAction);
  const dragWallId = useUIStore(s=> s.dragWallId);
  const setDragWallId = useUIStore(s=> s.setDragWallId);
  const worldFromEvent = (evt:any)=>{
    if (evt.point){ return new THREE.Vector3(evt.point.x, 0, evt.point.z); }
    const rect = gl.domElement.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
    const ndc = new THREE.Vector2(x, y);
    raycaster.setFromCamera(ndc, camera as THREE.Camera);
    const hit = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, hit);
    return hit;
  };
  const onDown = (e:any)=>{
    e.stopPropagation();
    setSelection({ kind:'wall', id: seg.id });
    if (transformMode==='translate' && !(toolDoor||toolWindow||drawWalls)){
      setDragWallId(seg.id);
      started.current = false;
      last.current.copy(worldFromEvent(e));
      beginAction();
      setDragging(true);
    }
  };
  React.useEffect(()=>{
    if (!dragging) return;
    const move = (ev: PointerEvent)=>{
      if (dragWallId && dragWallId !== seg.id) return;
      const cur = worldFromEvent(ev);
      let dx = cur.x - last.current.x; let dz = cur.z - last.current.z;
      if (!started.current){ if (Math.hypot(dx,dz) < 0.02) return; started.current = true; }
      if (snap){ dx = Math.round(dx/0.25)*0.25; dz = Math.round(dz/0.25)*0.25; }
      const pts = useProjectStore.getState().points;
      const i = seg.index; const j = (seg.index+1) % pts.length;
      const next = pts.map((p, idx)=> (idx===i||idx===j) ? { x: p.x + dx, z: p.z + dz } : p);
      setPointsDirect(next);
      last.current.add(new THREE.Vector3(dx,0,dz));
    };
    const stop = ()=>{ setDragging(false); setDragWallId(null); started.current=false; };
    window.addEventListener('pointermove', move as any);
    window.addEventListener('mouseup', stop as any);
    window.addEventListener('pointercancel', stop as any);
    window.addEventListener('blur', stop as any);
    document.addEventListener('visibilitychange', stop as any);
    return ()=>{
      window.removeEventListener('pointermove', move as any);
      window.removeEventListener('mouseup', stop as any);
      window.removeEventListener('pointercancel', stop as any);
      window.removeEventListener('blur', stop as any);
      document.removeEventListener('visibilitychange', stop as any);
    };
  }, [dragging, snap, seg.index, setPointsDirect, dragWallId]);
  const isHover = hoverWall===seg.id || selected;
  return (
    <mesh position={[0,0,0]}
      onPointerOver={(e)=>{ e.stopPropagation(); if (!dragWallId) setHoverWall(seg.id); }}
      onPointerOut={(e)=>{ e.stopPropagation(); if (!dragWallId && hoverWall===seg.id) setHoverWall(null); }}
      onPointerDown={onDown}>
      <boxGeometry args={[seg.length, wallHeight, wallThickness*1.5]} />
      <meshBasicMaterial color={ isHover ? '#66ccff' : '#000'} transparent opacity={ isHover ? 0.12 : 0.0 } depthWrite={false} />
    </mesh>
  );
}

function useId(prefix:string){ return React.useMemo(()=> prefix+"-"+Math.random().toString(36).slice(2,8),[]); }

function SceneEnv(){
  const { gl, scene } = useThree();
  React.useEffect(()=>{
    const pmrem = new THREE.PMREMGenerator(gl);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const prev = scene.environment; scene.environment = envTex; pmrem.dispose();
    return ()=>{ scene.environment = prev; };
  }, [gl, scene]);
  return null;
}

function CameraFill({ intensity = 2.0 }: { intensity?: number }){
  const { camera, scene } = useThree();
  const light = React.useMemo(()=> new THREE.PointLight(0xffffff, intensity, 50, 2), [intensity]);
  React.useEffect(()=>{ (camera as any).add(light); scene.add(camera as any); return ()=>{ (camera as any).remove(light); }; }, [camera, scene, light]);
  return null;
}

function CloudLayer(){
  const tex = React.useMemo(()=>{
    const size = 256; const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0,0,size,size); ctx.globalCompositeOperation = 'source-over'; const rnd = (a:number,b:number)=> a + Math.random()*(b-a);
    const blobs = [ {x: rnd(95,115), y: rnd(120,140), r: rnd(60,82)}, {x: rnd(120,155), y: rnd(105,130), r: rnd(52,74)}, {x: rnd(70,95), y: rnd(110,138), r: rnd(48,70)}, {x: rnd(110,145), y: rnd(135,155), r: rnd(42,62)}, {x: rnd(80,125), y: rnd(100,120), r: rnd(36,54)} ];
    for(const b of blobs){ const grd = ctx.createRadialGradient(b.x, b.y, b.r*0.15, b.x, b.y, b.r); grd.addColorStop(0.0, 'rgba(255,255,255,1.0)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.9)'); grd.addColorStop(1.0, 'rgba(255,255,255,0.0)'); ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI*2); ctx.fill(); }
    const tex = new THREE.CanvasTexture(canvas); tex.anisotropy = 8; tex.generateMipmaps = true; (tex as any).colorSpace = (THREE as any).SRGBColorSpace; (tex as any).premultiplyAlpha = true; tex.needsUpdate = true; return tex as THREE.Texture; }, []);
  const group = React.useRef<THREE.Group>(null!); const { camera } = useThree();
  const clouds = React.useMemo(()=>{ const ring: Array<{p:[number,number,number]; s:number; o:number}> = []; const makeRing = (radius:number, alt:number, steps:number)=> { const arr: Array<{p:[number,number,number]; s:number; o:number}> = []; for(let i=0;i<steps;i++){ const deg = (i/steps)*360; const rad = THREE.MathUtils.degToRad(deg); const x = Math.cos(rad) * radius; const z = Math.sin(rad) * radius; const s = 200 + (Math.abs(Math.sin(rad))*120); const o = 0.6 + (Math.abs(Math.cos(rad))*0.12); arr.push({ p: [x, alt, z] as [number,number,number], s, o }); } return arr; }; ring.push(...makeRing(900, 300, 9)); ring.push(...makeRing(1400, 360, 11)); return ring; },[]);
  useFrame((_, dt)=>{ if(!group.current) return; group.current.position.set((camera as any).position.x, 0, (camera as any).position.z); group.current.position.x += 6*dt; });
  return (<group ref={group}>{clouds.map((c, i)=>(<Billboard key={i} position={c.p as any} follow><mesh scale={[c.s, c.s*0.6, 1]}><planeGeometry args={[1,1]} /><meshBasicMaterial map={tex} transparent opacity={c.o} depthWrite={false} depthTest alphaTest={0.05} color="#ffffff" /></mesh></Billboard>))}</group>);
}

function EntitiesLayer(){
  const ents = useProjectStore(s=>s.entities); const updateEntity = useProjectStore(s=>s.updateEntity); const sel = useSelectionStore(s=>s.selected); const snap = useUIStore(s=>s.snap); const elevate = useUIStore(s=>s.elevate); const mode = useUIStore(s=>s.transformMode); const drawWalls = useUIStore(s=>s.drawWalls); const toolDoor = useUIStore(s=>s.toolDoor); const toolWindow = useUIStore(s=>s.toolWindow);
  const selectedEntity = sel ? ents.find(e=>e.id===sel.id) : undefined; const ref = React.useRef<THREE.Object3D>(null!);
  React.useEffect(()=>{ if (selectedEntity){ ref.current.position.set(...selectedEntity.transform.position); ref.current.rotation.set(...selectedEntity.transform.rotation); ref.current.scale.set(...selectedEntity.transform.scale); } },[selectedEntity]);
  const onChange = ()=>{ if (!ref.current || !selectedEntity) return; const p = ref.current.position; const r = ref.current.rotation; const s = ref.current.scale; const newPos: [number,number,number] = [p.x,p.y,p.z]; if (!elevate) newPos[1] = 0; if (snap){ newPos[0] = Math.round(newPos[0]/0.25)*0.25; newPos[2] = Math.round(newPos[2]/0.25)*0.25; } updateEntity(selectedEntity.id, { position: newPos, rotation: [r.x, r.y, r.z], scale: [s.x, s.y, s.z] }); };
  return (<group>{ents.map(e=> <Furniture key={e.id} e={e} selected={!!sel && sel.id===e.id} />)}{selectedEntity && !(drawWalls || toolDoor || toolWindow) && (<><TransformControls mode={mode} translationSnap={snap?0.25:undefined} rotationSnap={snap?Math.PI/12:undefined} showY={elevate} onObjectChange={onChange}><object3D ref={ref} /></TransformControls></>)}</group>);
}

function Placement(){
  const placing = useUIStore(s=>s.placing); const setPlacing = useUIStore(s=>s.setPlacing); const addEntity = useProjectStore(s=>s.addEntity); const snap = useUIStore(s=>s.snap); const { camera, gl } = useThree(); const raycaster = React.useMemo(()=> new THREE.Raycaster(), []); const plane = React.useMemo(()=> new THREE.Plane(new THREE.Vector3(0,1,0),0),[]); const hover = React.useRef(new THREE.Vector3()); const id = useId('ent');
  const updateFromEvent = (clientX:number, clientY:number)=>{ const rect = gl.domElement.getBoundingClientRect(); const x = ((clientX - rect.left) / rect.width) * 2 - 1; const y = -((clientY - rect.top) / rect.height) * 2 + 1; const ndc = new THREE.Vector2(x, y); raycaster.setFromCamera(ndc, camera as THREE.Camera); raycaster.ray.intersectPlane(plane, hover.current); };
  const onCanvasMove = (e: PointerEvent)=>{ if (placing){ updateFromEvent(e.clientX, e.clientY); } };
  const onCanvasClick = (e: MouseEvent)=>{ if (!placing) return; updateFromEvent(e.clientX, e.clientY); const p: [number,number,number] = [hover.current.x, 0, hover.current.z]; if (snap){ p[0] = Math.round(p[0]/0.25)*0.25; p[2] = Math.round(p[2]/0.25)*0.25; } addEntity({ id, type:'furniture', transform:{ position:p, rotation:[0,0,0], scale:[1,1,1] }, data:{ name: placing.name, url: placing.url }}); setPlacing(null); };
  const onKeyDown = (e:KeyboardEvent)=>{ if(e.key==='Escape') setPlacing(null); };
  React.useEffect(()=>{ window.addEventListener('keydown', onKeyDown); const el = gl.domElement; el.addEventListener('pointermove', onCanvasMove as any, { passive: true }); el.addEventListener('click', onCanvasClick as any); return ()=>{ window.removeEventListener('keydown', onKeyDown); el.removeEventListener('pointermove', onCanvasMove as any); el.removeEventListener('click', onCanvasClick as any); }; },[gl, placing, snap]);
  if (!placing) return null; return (<group><mesh position={[hover.current.x, 0.01, hover.current.z]}><boxGeometry args={[1, 0.02, 1]} /><meshBasicMaterial color="#00ffaa" transparent opacity={0.6} /></mesh></group>);
}

function WallDrawing3D(){
  const drawWalls = useUIStore(s=>s.drawWalls); const snap = useUIStore(s=>s.snap); const wallDraft = useUIStore(s=>s.wallDraft); const setWallDraft = useUIStore(s=>s.setWallDraft); const setPoints = useProjectStore(s=>s.setPoints); const { camera, gl } = useThree(); const raycaster = React.useMemo(()=> new THREE.Raycaster(), []); const plane = React.useMemo(()=> new THREE.Plane(new THREE.Vector3(0,1,0),0),[]); const hover = React.useRef(new THREE.Vector3());
  React.useEffect(()=>{ if (!drawWalls) return; const onKey = (e: KeyboardEvent)=>{ if (e.key==='Enter' && wallDraft.length>=3){ setPoints(wallDraft); setWallDraft([]); } if (e.key==='Escape'){ setWallDraft([]); } if (e.key==='Backspace'){ setWallDraft(wallDraft.slice(0,-1)); } }; window.addEventListener('keydown', onKey); return ()=> window.removeEventListener('keydown', onKey); }, [drawWalls, wallDraft, setPoints, setWallDraft]);
  const draftPoints = React.useMemo(()=>{ const pts = wallDraft.map(p=> new THREE.Vector3(p.x, 0.02, p.z)); pts.push(new THREE.Vector3(hover.current.x, 0.02, hover.current.z)); return pts; }, [wallDraft]);
  const updateFromEvent = (clientX:number, clientY:number)=>{ const rect = gl.domElement.getBoundingClientRect(); const x = ((clientX - rect.left) / rect.width) * 2 - 1; const y = -((clientY - rect.top) / rect.height) * 2 + 1; const ndc = new THREE.Vector2(x, y); raycaster.setFromCamera(ndc, camera as THREE.Camera); raycaster.ray.intersectPlane(plane, hover.current); };
  const onCanvasMove = (e: PointerEvent)=>{ updateFromEvent(e.clientX, e.clientY); };
  const onCanvasClick = (e: MouseEvent)=>{ updateFromEvent(e.clientX, e.clientY); const p = { x: hover.current.x, z: hover.current.z }; if (snap){ p.x = Math.round(p.x/0.25)*0.25; p.z = Math.round(p.z/0.25)*0.25; } setWallDraft([...wallDraft, p]); };
  React.useEffect(()=>{ if (!drawWalls) return; const el = gl.domElement; el.addEventListener('pointermove', onCanvasMove as any, { passive: true }); el.addEventListener('click', onCanvasClick as any); return ()=>{ el.removeEventListener('pointermove', onCanvasMove as any); el.removeEventListener('click', onCanvasClick as any); }; }, [gl, drawWalls, wallDraft, snap]);
  if (!drawWalls) return null; return (<group>{wallDraft.map((p,i)=>(<mesh key={i} position={[p.x, 0.03, p.z]}><sphereGeometry args={[0.06, 12, 12]} /><meshBasicMaterial color="#00ffaa" /></mesh>))}{draftPoints.length>=2 && <Line points={draftPoints} color="#00ffaa" lineWidth={2} dashed />}<mesh position={[hover.current.x, 0.01, hover.current.z]}><boxGeometry args={[0.4, 0.02, 0.4]} /><meshBasicMaterial color="#00ffaa" transparent opacity={0.4} /></mesh></group>);
}

function FPBoundsClamp(){
  const points = useProjectStore(s=>s.points);
  const house = useProjectStore(s=> s.entities.find(e=> e.type==='house' && e.data.bounds));
  const showRoom = useUIStore(s=>s.showRoom);
  const { camera } = useThree();
  const bounds = React.useMemo(()=>{
    const padHouse = 3.0; const padRoom = 5.0;
    if (!showRoom && house && house.data.bounds){
      const [px,py,pz] = house.transform.position;
      const b = house.data.bounds; const cx = (b.min[0]+b.max[0])/2 + px; const cz = (b.min[2]+b.max[2])/2 + pz;
      return { minX: cx - (b.max[0]-b.min[0])/2 - padHouse, maxX: cx + (b.max[0]-b.min[0])/2 + padHouse, minZ: cz - (b.max[2]-b.min[2])/2 - padHouse, maxZ: cz + (b.max[2]-b.min[2])/2 + padHouse };
    }
    if (points.length===0){ return { minX:-20, maxX:20, minZ:-20, maxZ:20 }; }
    let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity; for(const p of points){ minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minZ=Math.min(minZ,p.z); maxZ=Math.max(maxZ,p.z); }
    return { minX: minX - padRoom, maxX: maxX + padRoom, minZ: minZ - padRoom, maxZ: maxZ + padRoom };
  },[points, house, showRoom]);
  useFrame(()=>{ const obj = (camera as any); if (obj && obj.position){ obj.position.y = 1.7; obj.position.x = THREE.MathUtils.clamp(obj.position.x, bounds.minX+0.2, bounds.maxX-0.2); obj.position.z = THREE.MathUtils.clamp(obj.position.z, bounds.minZ+0.2, bounds.maxZ-0.2); } });
  return null;
}

function Flashlight(){
  const { camera, scene } = useThree();
  const lightRef = React.useRef<THREE.SpotLight>(null!);
  React.useEffect(()=>{ if (lightRef.current) { scene.add(lightRef.current.target); } },[scene]);
  useFrame(()=>{ if (!lightRef.current) return; const cam = camera as THREE.PerspectiveCamera; const dir = new THREE.Vector3(); cam.getWorldDirection(dir); lightRef.current.position.copy(cam.position); const targetPos = new THREE.Vector3().copy(cam.position).add(dir.multiplyScalar(2)); lightRef.current.target.position.copy(targetPos); lightRef.current.target.updateMatrixWorld(); });
  return (<spotLight ref={lightRef} color={0xffffff} intensity={8} distance={35} angle={Math.PI/6} penumbra={0.4} castShadow />);
}

function HouseDropper(){
  const addEntity = useProjectStore(s=>s.addEntity);
  const setShowRoom = useUIStore(s=>s.setShowRoom);
  const setMode = useProjectStore(s=>s.setMode);
  const { gl } = useThree();
  React.useEffect(()=>{ const el = gl.domElement; const onDragOver = (e: DragEvent)=>{ e.preventDefault(); }; const onDrop = (e: DragEvent)=>{ e.preventDefault(); const file = e.dataTransfer?.files?.[0]; if (!file) return; const name = file.name.toLowerCase(); if (!(name.endsWith('.glb') || name.endsWith('.gltf'))) return; const url = URL.createObjectURL(file); const id = `house-${Date.now()}`; addEntity({ id, type:'house', transform:{ position:[0,0,0], rotation:[0,0,0], scale:[1,1,1] }, data:{ name: file.name, url } }); setShowRoom(false); setMode('3D'); }; el.addEventListener('dragover', onDragOver as any); el.addEventListener('drop', onDrop as any); return ()=>{ el.removeEventListener('dragover', onDragOver as any); el.removeEventListener('drop', onDrop as any); }; }, [gl]);
  return null;
}

function HouseAutoFrame(){
  const house = useProjectStore(s=> s.entities.find(e=> e.type==='house' && e.data.bounds));
  const { camera, controls } = useThree() as any;
  React.useEffect(()=>{ if (!house || !house.data.bounds) return; const b = house.data.bounds; const [px, , pz] = house.transform.position; const cx = (b.min[0]+b.max[0])/2 + px; const cy = (b.min[1]+b.max[1])/2 + 1.0; const cz = (b.min[2]+b.max[2])/2 + pz; const sx = (b.max[0]-b.min[0]); const sy = (b.max[1]-b.min[1]); const sz = (b.max[2]-b.min[2]); const radius = Math.max(sx, sy, sz); const dist = radius * 1.8; camera.position.set(cx + dist, cy + dist*0.5, cz + dist); controls?.target?.set(cx, cy, cz); controls?.update?.(); }, [house, camera, controls]);
  return null;
}

export function Room3DView() {
  const fp = useUIStore(s=>s.fp);
  const setSelection = useSelectionStore(s=>s.setSelection);
  const showRoom = useUIStore(s=>s.showRoom);
  const ambient = useUIStore(s=>s.ambient);
  const flashlight = useUIStore(s=>s.flashlight);
  return (
    <Canvas
      dpr={[1, 1.5]}
      gl={(canvas) => {
        const htmlCanvas = canvas as unknown as HTMLCanvasElement;
        try {
          const ctx = htmlCanvas.getContext('webgl2', { antialias: false, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
          if (ctx) {
            const renderer = new THREE.WebGLRenderer({ canvas: htmlCanvas, context: ctx });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
            (renderer as any).outputColorSpace = (THREE as any).SRGBColorSpace;
            (renderer as any).toneMapping = (THREE as any).ACESFilmicToneMapping;
            (renderer as any).toneMappingExposure = 1.8;
            return renderer as any;
          }
        } catch {}
        const fallback = new THREE.WebGLRenderer({ canvas: htmlCanvas, antialias: false, alpha: true, powerPreference: 'high-performance' as any });
        fallback.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        (fallback as any).outputColorSpace = (THREE as any).SRGBColorSpace;
        (fallback as any).toneMapping = (THREE as any).ACESFilmicToneMapping;
        (fallback as any).toneMappingExposure = 1.8;
        return fallback as any;
      }}
      camera={{ position: [6, 6, 8], fov: 50, far: 3000 }}
      style={{ height: "calc(100vh - 64px)" }}
    >
      <SceneEnv />
      <CameraFill intensity={2.5} />
      <color attach="background" args={["#7EC8FF"]} />
      <CloudLayer />
      <ambientLight intensity={ambient} />
      <hemisphereLight args={[0xdfe8ff, 0x3a404d, 1.8]} />
      <group name="LightRig">
        <directionalLight position={[8, 10, 6]} intensity={4.0} />
        <directionalLight position={[-6, 6, -8]} intensity={2.0} />
        <directionalLight position={[0, 12, -2]} intensity={1.2} />
      </group>
      <group onPointerMissed={() => setSelection(null)}>
        {showRoom && <WallsAndFloor />}
        <GrassGround onClear={()=> setSelection(null)} />
        <EntitiesLayer />
        <Placement />
        <WallDrawing3D />
      </group>
      <HouseDropper />
      <HouseAutoFrame />
      {!fp && <OrbitControls makeDefault />}
      {fp && <>
        <PointerLockControls />
        <FPWASD />
        <FPBoundsClamp />
        {flashlight && <Flashlight />}
      </>}
      <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
        <GizmoViewport axisColors={["#ff6b6b", "#6bff95", "#6bb1ff"]} labelColor="#000" />
      </GizmoHelper>
    </Canvas>
  );
}

function FPWASD(){
  const { camera } = useThree();
  const keys = React.useRef<{[k:string]:boolean}>({});
  React.useEffect(()=>{ const down = (e:KeyboardEvent)=>{ keys.current[e.code] = true; }; const up = (e:KeyboardEvent)=>{ keys.current[e.code] = false; }; window.addEventListener('keydown', down); window.addEventListener('keyup', up); return ()=>{ window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); }; },[]);
  useFrame((_, dt)=>{ const speed = (keys.current['ShiftLeft']||keys.current['ShiftRight']) ? 6.0 : 3.5; const forward = (keys.current['KeyW']||keys.current['ArrowUp']) ? 1 : (keys.current['KeyS']||keys.current['ArrowDown']) ? -1 : 0; const strafe = (keys.current['KeyD']||keys.current['ArrowRight']) ? 1 : (keys.current['KeyA']||keys.current['ArrowLeft']) ? -1 : 0; if (forward!==0 || strafe!==0){ const dir = new THREE.Vector3(); camera.getWorldDirection(dir); dir.y = 0; dir.normalize(); const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0,1,0)).normalize(); const move = new THREE.Vector3().addScaledVector(dir, forward).addScaledVector(right, strafe).normalize().multiplyScalar(speed*dt); (camera as any).position.add(move); } });
  return null;
}

export default Room3DView;
