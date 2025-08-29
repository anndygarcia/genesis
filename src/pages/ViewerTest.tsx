import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, StatsGl } from '@react-three/drei'
import * as THREE from 'three'
import { useRef } from 'react'

function SpinningCube() {
  const ref = useRef<THREE.Mesh>(null!)
  useFrame((_, dt) => {
    if (!ref.current) return
    ref.current.rotation.x += dt * 0.6
    ref.current.rotation.y += dt * 0.8
  })
  return (
    <mesh ref={ref} position={[0, 1, 0]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#ff7f50" />
    </mesh>
  )
}

export default function ViewerTest() {
  return (
    <div className="fixed inset-x-0 top-16 bottom-0">
      <Canvas shadows camera={{ position: [3, 2, 5], fov: 60 }} gl={{ antialias: true }}>
        <color attach="background" args={[0x181818]} />
        <hemisphereLight intensity={0.7} groundColor={0x333333} />
        <directionalLight position={[5, 8, 5]} intensity={1.4} castShadow />

        <gridHelper args={[20, 20, '#888', '#444']} position={[0, 0, 0]} />
        <axesHelper args={[3]} />
        <SpinningCube />

        <OrbitControls enableDamping dampingFactor={0.08} />
        <StatsGl className="!fixed !left-2 !top-20" />
      </Canvas>
    </div>
  )
}
