import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { sound } from "../audio/sound.js";

function shake(direction: "up" | "down"): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const root = document.documentElement;
  root.classList.remove("shake-up", "shake-down");
  void root.offsetWidth;
  root.classList.add(direction === "up" ? "shake-up" : "shake-down");
  window.setTimeout(() => root.classList.remove("shake-up", "shake-down"), 420);
}

/** Scroll, hover, and section cues. Sound methods no-op while muted. */
export function Kinetic({ reduced }: { reduced: boolean }): React.ReactElement {
  const location = useLocation();

  useEffect(() => {
    let lastY = window.scrollY;
    let lastT = performance.now();
    const seen = new Set<Element>();
    const onScroll = (): void => {
      const now = performance.now();
      const dy = Math.abs(window.scrollY - lastY);
      const dt = Math.max(16, now - lastT);
      sound.setScrollEnergy(Math.min(1, (dy / dt) * 0.45));
      lastY = window.scrollY;
      lastT = now;
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || seen.has(entry.target)) continue;
          seen.add(entry.target);
          const kind = (entry.target as HTMLElement).dataset.fx;
          if (kind === "section") sound.whoosh();
          if (kind === "head") sound.stutter();
          if (kind === "level") {
            sound.levelUp();
            shake("up");
          }
          if (!reduced) entry.target.classList.add("fx-in");
        }
      },
      { threshold: 0.4 },
    );
    document.querySelectorAll<HTMLElement>("[data-fx]").forEach((el) => io.observe(el));
    const onOver = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("button, a.btn, .card, .x-link")) sound.hover();
    };
    const onDown = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("button, a.btn, .card")) sound.click();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", onDown);
      io.disconnect();
    };
  }, [location.pathname, reduced]);

  if (reduced) return <></>;
  return <Parallax />;
}

function Parallax(): React.ReactElement {
  useEffect(() => {
    const canvas = document.getElementById("parallax") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dots = Array.from({ length: 70 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random() < 0.5 ? 0.25 : 0.6,
      s: 1 + Math.random() * 1.6,
    }));
    let frame = 0;
    const draw = (): void => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (canvas.width !== Math.floor(w * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const scroll = window.scrollY;
      for (const dot of dots) {
        const y = ((dot.y * h - scroll * dot.z) % h + h) % h;
        ctx.globalAlpha = dot.z;
        ctx.fillStyle = "#ccff00";
        ctx.fillRect(dot.x * w, y, dot.s, dot.s);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas id="parallax" aria-hidden="true" />;
}
