import { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";

const RING_Z = [-8, -14, -20, -26, -32];

function Robot({ reduced }: { reduced: boolean }): React.ReactElement {
  const group = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (!reduced && group.current) group.current.position.y = Math.sin(t * 1.15) * 0.07;
    if (!reduced && halo.current) halo.current.rotation.z = t * 0.45;
  });
  return (
    <group ref={group} position={[1.15, 0.15, 0]}>
      <RoundedBox args={[2.3, 2.02, 0.7]} radius={0.48} smoothness={8}>
        <meshBasicMaterial color="#ccff00" />
      </RoundedBox>
      <RoundedBox args={[1.62, 0.7, 0.22]} radius={0.32} position={[0, -0.08, 0.4]}>
        <meshBasicMaterial color="#050605" />
      </RoundedBox>
      {[-0.38, 0.38].map((x) => (
        <mesh key={x} position={[x, -0.08, 0.52]} scale={[0.62, 1.15, 0.45]}>
          <sphereGeometry args={[0.16, 28, 28]} />
          <meshBasicMaterial color="#ccff00" />
        </mesh>
      ))}
      <mesh ref={halo} position={[0, 1.58, 0]} rotation={[1.18, 0, 0]}>
        <torusGeometry args={[0.98, 0.045, 24, 90]} />
        <meshBasicMaterial color="#ccff00" />
      </mesh>
      <mesh position={[0, 1.58, 0]} rotation={[1.18, 0, 0]}>
        <torusGeometry args={[0.98, 0.16, 16, 64]} />
        <meshBasicMaterial color="#ccff00" transparent opacity={0.22} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Rings({ active }: { active: number }): React.ReactElement {
  return (
    <>
      {RING_Z.map((z, i) => {
        const on = active === i;
        return (
          <group key={z} position={[1.15, 0, z]}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[2.15, on ? 0.035 : 0.018, 16, 80]} />
              <meshBasicMaterial color={on ? "#ccff00" : "#3d5c12"} />
            </mesh>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <ringGeometry args={[1.7, 2.05, 64]} />
              <meshBasicMaterial color="#ccff00" transparent opacity={on ? 0.16 : 0.04} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

function Dust({ reduced }: { reduced: boolean }): React.ReactElement {
  const ref = useRef<THREE.Points>(null);
  const geo = useMemo(() => {
    const positions = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 12;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 7;
      positions[i * 3 + 2] = -Math.random() * 40;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, []);
  useFrame(({ clock }) => {
    if (reduced || !ref.current) return;
    ref.current.rotation.y = clock.elapsedTime * 0.015;
  });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial color="#ccff00" size={0.03} transparent opacity={0.5} sizeAttenuation depthWrite={false} />
    </points>
  );
}

function Rig({ progress, reduced }: { progress: { current: number }; reduced: boolean }): null {
  const { camera } = useThree();
  useFrame(() => {
    const t = reduced ? 0 : progress.current;
    const z = 6.6 - t * 36;
    camera.position.set(Math.sin(t * Math.PI) * 0.4, 0.25, z);
    camera.lookAt(1.15, 0.1, z - 5.5);
  });
  return null;
}

function Glow({ enabled }: { enabled: boolean }): React.ReactElement | null {
  if (!enabled) return null;
  return (
    <EffectComposer enableNormalPass={false} multisampling={0}>
      <Bloom intensity={0.85} luminanceThreshold={0.25} mipmapBlur radius={0.55} />
    </EffectComposer>
  );
}

export default function HeroScene({
  progress,
  reduced,
  active,
}: {
  progress: { current: number };
  reduced: boolean;
  active: number;
}): React.ReactElement {
  const glow = !reduced && typeof window !== "undefined" && window.innerWidth > 800;
  return (
    <Canvas
      className="webgl"
      dpr={[1, 1.5]}
      camera={{ position: [0, 0.25, 6.6], fov: 42, near: 0.1, far: 80 }}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
    >
      <color attach="background" args={["#050605"]} />
      <fog attach="fog" args={["#050605", 12, 42]} />
      <ambientLight intensity={0.35} />
      <pointLight position={[3, 3.2, 5]} intensity={50} color="#e8ff9a" distance={18} />
      <pointLight position={[-3, -1, 3]} intensity={12} color="#00c805" distance={14} />
      <spotLight position={[1, 6, 4]} intensity={40} angle={0.55} penumbra={0.85} color="#ffffff" />
      <Robot reduced={reduced} />
      <Rings active={active} />
      <Dust reduced={reduced} />
      <Rig progress={progress} reduced={reduced} />
      <Glow enabled={glow} />
    </Canvas>
  );
}
