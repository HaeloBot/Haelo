import { useEffect } from "react";
import { sound } from "../audio/sound.js";

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

const bits: Bit[] = [];
let raf = 0;
let canvas: HTMLCanvasElement | null = null;

function frame(): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    if (!b) continue;
    b.x += b.vx;
    b.y += b.vy;
    b.vy += 0.05;
    b.life -= 0.018;
    if (b.life <= 0) {
      bits.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = Math.max(0, b.life);
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (bits.length > 0) raf = requestAnimationFrame(frame);
  else raf = 0;
}

export function impact(direction: "up" | "down"): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (direction === "up") sound.promote();
  else sound.demote();
  const root = document.documentElement;
  if (!reduced) {
    root.classList.remove("shake-up", "shake-down");
    void root.offsetWidth;
    root.classList.add(direction === "up" ? "shake-up" : "shake-down");
    window.setTimeout(() => root.classList.remove("shake-up", "shake-down"), 520);
    const color = direction === "up" ? "#ccff00" : "#ff3b5c";
    const cx = window.innerWidth * 0.5;
    const cy = window.innerHeight * 0.45;
    const n = direction === "up" ? 70 : 56;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 2 + Math.random() * (direction === "up" ? 9 : 7);
      bits.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - (direction === "up" ? 2 : 0),
        life: 1,
        color,
        size: 1.5 + Math.random() * 3.5,
      });
    }
    if (!raf) raf = requestAnimationFrame(frame);
  }
}

export function ImpactLayer(): React.ReactElement {
  useEffect(() => {
    canvas = document.getElementById("bursts") as HTMLCanvasElement | null;
    return () => {
      canvas = null;
    };
  }, []);
  return <canvas id="bursts" aria-hidden="true" />;
}
