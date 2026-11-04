import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Meta } from "../components/Meta.js";
import { Intro } from "../components/Intro.js";
import { useReduced } from "../components/Chrome.js";
import { sound } from "../audio/sound.js";

const HeroScene = lazy(() => import("../scene/HeroScene.js"));

gsap.registerPlugin(ScrollTrigger);

const RUNGS = [
  {
    kicker: "00. No capital",
    title: "Shadow",
    body: "Fills are simulated against live Jupiter prices, with slippage and fees. Nothing touches the chain.",
  },
  {
    kicker: "01. Real route, no signature",
    title: "Paper",
    body: "A real Jupiter route, and the real transaction simulated on chain. Nothing is signed. Still not your money.",
  },
  {
    kicker: "02. A human reads it",
    title: "Propose",
    body: "Every swap is held. The approval card is built from the order itself, not from the agent's story.",
  },
  {
    kicker: "03. Live, tiny",
    title: "Micro",
    body: "Signed on Solana under a much tighter cap: $25 a swap, $100 a day, five swaps. Every one is simulated before it is signed.",
  },
  {
    kicker: "04. Your rails",
    title: "Standard",
    body: "Signed under the limits you wrote down. Not unlimited. The caps, the token list, the simulation check and the audit chain stay on.",
  },
];

const FEATURES = [
  { n: "01", t: "Policy rails", d: "Per-order, per-day, per-minute, symbol lists, asset class, shorts. A rung can only tighten them." },
  { n: "02", t: "Automatic demotion", d: "A hard breach, a drawdown, tool drift, or an order after an injection flag. No one has to be watching." },
  { n: "03", t: "Human promotion", d: "The agent can ask. It cannot climb. Criteria are days, decisions, invalid rate, breaches, drawdown." },
  { n: "04", t: "Household preflight", d: "Concentration, a wash-sale tripwire, lot timing. Warnings, not tax advice." },
  { n: "05", t: "Hash-chained audit", d: "Each entry commits to the previous one. Editing a line breaks verify. Tamper-evident, not tamper-proof." },
  { n: "06", t: "Injection tripwire", d: "Regex plus hidden characters. A determined attack can evade it. The rails are the real wall." },
];

export default function Landing(): React.ReactElement {
  const reduced = useReduced();
  const sectionRef = useRef<HTMLElement>(null);
  const progress = useRef(0);
  const rungRef = useRef(-1);
  const [active, setActive] = useState(-1);
  const [intro, setIntro] = useState(false);

  useEffect(() => {
    if (reduced) return;
    try {
      if (!sessionStorage.getItem("haelo-intro")) setIntro(true);
    } catch {
      setIntro(true);
    }
  }, [reduced]);

  useEffect(() => {
    if (reduced) return;
    const el = sectionRef.current;
    if (!el) return;
    const trigger = ScrollTrigger.create({
      trigger: el,
      start: "top top",
      end: "bottom bottom",
      scrub: 0.65,
      onUpdate: (self) => {
        progress.current = self.progress;
        const idx = self.progress < 0.18 ? -1 : Math.min(4, Math.floor((self.progress - 0.18) / 0.164));
        if (idx === rungRef.current) return;
        const prev = rungRef.current;
        rungRef.current = idx;
        setActive(idx);
        if (idx < 0 || reduced) return;
        sound.bassHit();
        if (idx === 4) sound.levelUp();
        else sound.scrollRiser();
        const root = document.documentElement;
        root.classList.remove("shake-up", "shake-down");
        void root.offsetWidth;
        root.classList.add(idx > prev ? "shake-up" : "shake-down");
        window.setTimeout(() => root.classList.remove("shake-up", "shake-down"), 420);
      },
    });
    return () => trigger.kill();
  }, [reduced]);

  const rung = active >= 0 ? RUNGS[active] : undefined;

  return (
    <>
      <Meta
        title="Haelo: an autonomy ladder for AI trading agents"
        description="Haelo sits between an AI trading agent and a Solana wallet. Shadow first. Live swaps only after rules you wrote down are kept."
      />
      {intro ? (
        <Intro
          onDone={() => {
            try {
              sessionStorage.setItem("haelo-intro", "1");
            } catch {
              /* private mode */
            }
            setIntro(false);
          }}
        />
      ) : null}
      <section ref={sectionRef} className={reduced ? "stage stage-flat" : "stage"} aria-label="Autonomy ladder">
        <div className="stage-sticky">
          <Suspense fallback={<SceneFallback />}>
            <HeroScene progress={progress} reduced={reduced} active={Math.max(0, active)} />
          </Suspense>
          <div className="stage-copy">
            <p className="kicker">{rung ? rung.kicker : "MCP gateway"}</p>
            <h1 className="display">
              {rung ? (
                rung.title
              ) : (
                <>
                  Earn the
                  <br />
                  <span className="lime">next rung.</span>
                </>
              )}
            </h1>
            <p className="lede">
              {rung
                ? rung.body
                : "Haelo stands between the model and your Solana wallet. The agent starts in shadow. It climbs only by meeting criteria you locked first. Break one, and the rung drops itself."}
            </p>
            {active < 0 ? (
              <div className="btn-row">
                <Link className="btn" to="/playground" data-magnet>
                  Open the playground
                </Link>
                <Link className="btn ghost" to="/docs" data-magnet>
                  Quickstart
                </Link>
              </div>
            ) : null}
            {reduced ? null : <p className="scroll-hint">Scroll to descend the ladder</p>}
          </div>
        </div>
        {reduced ? (
          <div className="band">
            {RUNGS.map((r) => (
              <article key={r.title} className="card" style={{ marginBottom: 12 }}>
                <div className="idx">{r.kicker}</div>
                <h3>{r.title}</h3>
                <p>{r.body}</p>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <section className="band" data-fx="section">
        <p className="kicker">What it actually does</p>
        <h2 className="display" data-fx="head">
          A leash
          <br />
          that lengthens.
        </h2>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article key={f.n} className="card" data-magnet>
              <Count className="idx" to={Number(f.n)} reduced={reduced} />
              <h3>{f.t}</h3>
              <p>{f.d}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="band" data-fx="section">
        <p className="kicker">Against an agent holding a wallet key</p>
        <h2 className="display" data-fx="head">The agent is untrusted.</h2>
        <table className="compare">
          <thead>
            <tr>
              <th> </th>
              <th>Agent with a key, alone</th>
              <th>Haelo in front</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>First order</td>
              <td>Signed on mainnet</td>
              <td>Shadow. Live Jupiter prices, nothing signed</td>
            </tr>
            <tr>
              <td>Size</td>
              <td>Whatever the model asks</td>
              <td>Caps per rung, fail closed if it cannot be sized</td>
            </tr>
            <tr>
              <td>What gets signed</td>
              <td>Whatever the route returns</td>
              <td>Simulated first. Refused if the wallet would lose more than the order</td>
            </tr>
            <tr>
              <td>A bad day</td>
              <td>Keeps going</td>
              <td>Drawdown demotes. Breaches go back to shadow</td>
            </tr>
            <tr>
              <td>Tool list changes</td>
              <td>The agent sees the new tools</td>
              <td>Orders freeze until a human re-pins</td>
            </tr>
            <tr>
              <td>Prompt injection</td>
              <td>The model’s problem</td>
              <td>Tripwire, then the rails anyway</td>
            </tr>
            <tr>
              <td>Record</td>
              <td>Logs, if you keep them</td>
              <td>Hash chain. verify tells you if a line moved</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="closing" data-fx="level">
        <p className="kicker">Try the engine</p>
        <h2 className="display">
          Same rules.
          <br />
          <span className="lime">No keys.</span>
        </h2>
        <p className="lede">The playground runs the policy evaluator on live Jupiter prices on Solana. Shadow and paper are not signed. A live rung simulates the swap, then asks your wallet to sign.</p>
        <div className="btn-row">
          <Link className="btn" to="/playground" data-magnet>
            Run a shadow session
          </Link>
          <Link className="btn ghost" to="/security" data-magnet>
            Read the threat model
          </Link>
        </div>
      </section>
    </>
  );
}

function Count({ to, reduced, className }: { to: number; reduced: boolean; className?: string }): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(reduced ? to : 0);
  useEffect(() => {
    if (reduced) return;
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        let i = 0;
        timer = window.setInterval(() => {
          i += 1;
          setN(i);
          if (i >= to) window.clearInterval(timer);
        }, 70);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
    };
  }, [reduced, to]);
  return (
    <span ref={ref} className={className}>
      {String(n).padStart(2, "0")}
    </span>
  );
}

function SceneFallback(): React.ReactElement {
  const base = import.meta.env.BASE_URL;
  return (
    <div className="scene-fallback">
      <img src={`${base}haelo-icon.png`} alt="Haelo robot with a lime halo" />
    </div>
  );
}
