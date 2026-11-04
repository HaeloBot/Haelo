import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Meta } from "../components/Meta.js";
import { Intro } from "../components/Intro.js";
import { useReduced } from "../components/Chrome.js";

const HeroScene = lazy(() => import("../scene/HeroScene.js"));

gsap.registerPlugin(ScrollTrigger);

const RUNGS = [
  {
    kicker: "00  —  No capital",
    title: "Shadow",
    body: "Fills are simulated against live quotes, with slippage and fees. The broker never sees the order.",
  },
  {
    kicker: "01  —  Broker paper",
    title: "Paper",
    body: "Orders go to the broker's paper environment when it has one. Still not your money.",
  },
  {
    kicker: "02  —  A human reads it",
    title: "Propose",
    body: "Every order is held. The approval card is built from the order itself, not from the agent's story.",
  },
  {
    kicker: "03  —  Live, tiny",
    title: "Micro",
    body: "Live under a much tighter cap. The default is $25 an order, $100 a day, five orders. Live stays off until you opt in.",
  },
  {
    kicker: "04  —  Your rails",
    title: "Standard",
    body: "Live under the limits you wrote down. Not unlimited. The caps, the list, the audit chain — still on.",
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
        setActive((prev) => (prev === idx ? prev : idx));
      },
    });
    return () => trigger.kill();
  }, [reduced]);

  const rung = active >= 0 ? RUNGS[active] : undefined;

  return (
    <>
      <Meta
        title="Haelo — An autonomy ladder for AI trading agents"
        description="Haelo sits between an AI agent and a broker. Shadow first. Live only after rules you wrote down are kept."
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
                : "Haelo stands between the model and the brokerage. The agent starts in shadow. It climbs only by meeting criteria you locked first. Break one, and the rung drops itself."}
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

      <section className="band">
        <p className="kicker">What it actually does</p>
        <h2 className="display">
          A leash
          <br />
          that lengthens.
        </h2>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article key={f.n} className="card" data-magnet>
              <div className="idx">{f.n}</div>
              <h3>{f.t}</h3>
              <p>{f.d}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="band">
        <p className="kicker">Against a plain broker MCP</p>
        <h2 className="display">The agent is untrusted.</h2>
        <table className="compare">
          <thead>
            <tr>
              <th> </th>
              <th>Broker MCP, alone</th>
              <th>Haelo in front</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>First order</td>
              <td>Live, if the key is live</td>
              <td>Shadow. Live quotes, no send</td>
            </tr>
            <tr>
              <td>Size</td>
              <td>Whatever the model asks</td>
              <td>Caps per rung, fail closed if it cannot be sized</td>
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

      <section className="closing">
        <p className="kicker">Try the engine</p>
        <h2 className="display">
          Same rules.
          <br />
          <span className="lime">No keys.</span>
        </h2>
        <p className="lede">The playground runs the policy evaluator, the ladder, and the audit chain in the browser. It cannot place a broker order.</p>
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

function SceneFallback(): React.ReactElement {
  const base = import.meta.env.BASE_URL;
  return (
    <div className="scene-fallback">
      <img src={`${base}haelo-icon.png`} alt="Haelo robot with a lime halo" />
    </div>
  );
}
