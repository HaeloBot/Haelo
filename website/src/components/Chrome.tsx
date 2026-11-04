import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { initAppKit, type WalletKit } from "../wallet/appkit.js";
import { NavLink, Outlet } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation } from "react-router-dom";
import { sound, type SoundState } from "../audio/sound.js";
import { ImpactLayer } from "./Impact.js";
import { Kinetic } from "./Kinetic.js";
import { useSiteConfig } from "./SiteConfig.js";

const WalletButton = lazy(() => import("./WalletButton.js"));

const LINKS = [
  { to: "/", label: "Ladder", end: true },
  { to: "/token", label: "$HAELO" },
  { to: "/playground", label: "Playground" },
  { to: "/docs", label: "Docs" },
  { to: "/security", label: "Security" },
  { to: "/pricing", label: "Pricing" },
  { to: "/about", label: "About" },
];

export function useSoundState(): SoundState {
  const [state, setState] = useState<SoundState>(sound.state);
  useEffect(() => sound.subscribe(setState), []);
  return state;
}

export function Chrome(): React.ReactElement {
  const audio = useSoundState();
  const site = useSiteConfig();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const reduced = useReduced();
  const base = import.meta.env.BASE_URL;
  const kit: WalletKit | null = (() => {
    try {
      return initAppKit(site.reown.projectId);
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches && !reduced;
    document.body.classList.toggle("fine", fine);
    if (!fine) return;
    const ring = document.querySelector<HTMLElement>(".cursor");
    const dot = document.querySelector<HTMLElement>(".cursor-dot");
    if (!ring || !dot) return;
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let tx = x;
    let ty = y;
    let frame = 0;
    const move = (e: PointerEvent): void => {
      tx = e.clientX;
      ty = e.clientY;
      const magnets = document.querySelectorAll<HTMLElement>("[data-magnet]");
      magnets.forEach((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist < 90) {
          const pull = (1 - dist / 90) * 10;
          el.style.transform = `translate(${(dx / dist) * pull || 0}px, ${(dy / dist) * pull || 0}px)`;
        } else el.style.transform = "";
      });
    };
    const loop = (): void => {
      x += (tx - x) * 0.22;
      y += (ty - y) * 0.22;
      ring.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      dot.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
      const trails = document.querySelectorAll<HTMLElement>(".trail");
      trails.forEach((el, i) => {
        const k = (i + 1) * 0.18;
        const px = x + (tx - x) * (1 - k);
        const py = y + (ty - y) * (1 - k);
        el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      });
      frame = requestAnimationFrame(loop);
    };
    window.addEventListener("pointermove", move);
    frame = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, [reduced]);

  const frame = (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="grain" aria-hidden="true" />
      <div className="scan" aria-hidden="true" />
      <div className="cursor" aria-hidden="true" />
      <div className="cursor-dot" aria-hidden="true" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="trail" aria-hidden="true" />
      ))}
      <Kinetic reduced={reduced} />
      <ImpactLayer />
      <header className="nav">
        <NavLink to="/" className="brand" data-magnet>
          <img src={`${base}haelo-icon.png`} alt="" width={36} height={36} />
          Haelo
        </NavLink>
        <button className="menu-btn" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Menu"}
        </button>
        <nav className={open ? "nav-links open" : "nav-links"} aria-label="Primary">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end ?? false}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="nav-spacer" />
        {kit ? (
          <Suspense
            fallback={
              <button className="wallet" type="button" disabled aria-label="Connect wallet">
                <span className="wallet-long">Connect wallet</span>
                <span className="wallet-short">Connect</span>
              </button>
            }
          >
            <WalletButton projectId={site.reown.projectId} />
          </Suspense>
        ) : (
          <button className="wallet" type="button" disabled aria-label="Connect wallet">
            <span className="wallet-long">Connect wallet</span>
            <span className="wallet-short">Connect</span>
          </button>
        )}
        <a className="x-link" href={site.social.x} target="_blank" rel="noreferrer" aria-label="Haelo on X" data-magnet>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M4 4h4.2l3.8 5.1L16.2 4H20l-6.3 7.2L20.2 20h-4.2l-4.1-5.5L7.6 20H4l6.6-7.5L4 4z" />
          </svg>
        </a>
        <button
          className={audio.waiting ? "sound waiting" : "sound"}
          type="button"
          data-magnet
          aria-pressed={audio.on}
          aria-label={audio.on ? (audio.waiting ? "Sound is armed and starts on your next gesture. Activate to mute." : "Mute sound") : "Enable sound"}
          onClick={() => {
            void sound.toggle();
          }}
        >
          <span className="eq" aria-hidden="true">
            <i /><i /><i />
          </span>
          {audio.on ? "Sound on" : "Sound off"}
        </button>
      </header>
      <div className="shell">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            className="page-enter"
            id="content"
            initial={reduced ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -12 }}
            transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
        <footer className="footer">
          <span>Not financial advice. Haelo limits damage. It does not promise profit.</span>
          <a href="https://github.com/HaeloBot/Haelo">GitHub</a>
        </footer>
      </div>
    </>
  );
  if (!kit) return frame;
  return (
    <WagmiProvider config={kit.wagmiConfig}>
      <QueryClientProvider client={kit.queryClient}>{frame}</QueryClientProvider>
    </WagmiProvider>
  );
}

export function useReduced(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (): void => {
      setReduced(mq.matches);
      sound.setReduced(mq.matches);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}
