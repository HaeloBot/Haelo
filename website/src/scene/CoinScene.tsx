import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

function Coin({ reduced }: { reduced: boolean }): React.ReactElement {
  const group = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (reduced) return;
    const t = clock.elapsedTime;
    if (group.current) {
      group.current.rotation.y = t * 0.9;
      group.current.rotation.x = Math.sin(t * 0.55) * 0.35;
    }
    if (halo.current) halo.current.rotation.z = t * 0.6;
  });
  return (
    <group ref={group}>
      <mesh>
        <cylinderGeometry args={[1.2, 1.2, 0.18, 72]} />
        <meshBasicMaterial color="#ccff00" />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.72, 0.92, 48]} />
        <meshBasicMaterial color="#050605" side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={halo} rotation={[1.15, 0, 0]}>
        <torusGeometry args={[1.85, 0.045, 20, 90]} />
        <meshBasicMaterial color="#ccff00" />
      </mesh>
      <mesh rotation={[1.15, 0, 0]}>
        <torusGeometry args={[1.85, 0.16, 12, 64]} />
        <meshBasicMaterial color="#ccff00" transparent opacity={0.18} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Dust({ reduced }: { reduced: boolean }): React.ReactElement {
  const ref = useRef<THREE.Points>(null);
  const geo = useMemo(() => {
    const positions = new Float32Array(280 * 3);
    for (let i = 0; i < 280; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1.4 + Math.random() * 2.2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 1.6;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, []);
  useFrame(({ clock }) => {
    if (reduced || !ref.current) return;
    ref.current.rotation.y = clock.elapsedTime * 0.15;
  });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial color="#ccff00" size={0.035} transparent opacity={0.7} sizeAttenuation depthWrite={false} />
    </points>
  );
}

export default function CoinScene({ reduced }: { reduced: boolean }): React.ReactElement {
  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0.2, 4.4], fov: 42 }} gl={{ antialias: true, alpha: true }}>
      <ambientLight intensity={1} />
      <Coin reduced={reduced} />
      <Dust reduced={reduced} />
    </Canvas>
  );
}
