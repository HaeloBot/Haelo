import { useEffect, useMemo, useRef, useState } from "react";
import { Meta } from "../components/Meta.js";
import { sound } from "../audio/sound.js";
import { impact } from "../components/Impact.js";
import { loadMarket, type MarketBook } from "../sim/quotes.js";
import { DEMO_YAML, PRESETS } from "../sim/presets.js";
import { SCENARIOS } from "../sim/scenarios.js";
import { PlaygroundSession, type SessionSnapshot, type StepResult } from "../sim/session.js";
import type { Rung, Side } from "../../../src/types.js";

const LADDER: Rung[] = ["shadow", "paper", "propose", "micro", "standard"];

export default function Playground(): React.ReactElement {
  const sessionRef = useRef<PlaygroundSession | null>(null);
  const [yaml, setYaml] = useState(DEMO_YAML);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [symbol, setSymbol] = useState("BTC-USD");
  const [side, setSide] = useState<Side>("buy");
  const [notional, setNotional] = useState(150);
  const [market, setMarket] = useState<MarketBook | null>(null);
  const [tamper, setTamper] = useState<string | null>(null);
  const [last, setLast] = useState<StepResult | null>(null);

  const boot = (text: string): void => {
    try {
      const session = PlaygroundSession.create(text);
      if (market) session.setQuotes(market.quotes);
      sessionRef.current = session;
      setSnap(session.snapshot());
      setError(null);
      setTamper(null);
      setLast(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    try {
      const session = PlaygroundSession.create(DEMO_YAML);
      sessionRef.current = session;
      setSnap(session.snapshot());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    const ac = new AbortController();
    void loadMarket(ac.signal).then((book) => {
      setMarket(book);
      const session = sessionRef.current;
      if (!session) return;
      session.setQuotes(book.quotes);
      setSnap(session.snapshot());
    });
    return () => ac.abort();
  }, []);

  const publish = (result?: StepResult): void => {
    const session = sessionRef.current;
    if (!session) return;
    setSnap(session.snapshot());
    if (!result) return;
    setLast(result);
    if (result.moved) impact(result.moved.direction);
    else if (result.tone === "bad") {
      sound.block();
    } else if (result.tone === "ok") sound.fill();
    else sound.click();
  };

  const place = (): void => {
    const session = sessionRef.current;
    if (!session) return;
    publish(session.placeOrder({ symbol, side, notionalUsd: notional }));
  };

  const symbols = useMemo(() => ["BTC-USD", "ETH-USD", "SOL-USD", "AAPL"], []);

  return (
    <div className="pg">
      <Meta
        title="Playground — Haelo"
        description="Run Haelo's policy engine, autonomy ladder, and hash-chained audit log in the browser. Shadow mode only. No broker keys."
      />
      <section className="panel">
        <h2>Policy YAML</h2>
        <p className="banner">
          Parsed by the same <code>parseConfig</code> the CLI uses. Applying a new file resets the session. Secrets do not belong in this box, and the page will not ask for any.
        </p>
        <div className="presets" role="group" aria-label="Policy presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.blurb}
              onClick={() => {
                setYaml(p.yaml);
                boot(p.yaml);
                sound.click();
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label htmlFor="policy" className="kicker" style={{ display: "block", marginTop: 12 }}>
          haelo.yaml
        </label>
        <textarea id="policy" className="yaml" spellCheck={false} value={yaml} onChange={(e) => setYaml(e.target.value)} />
        {error ? <p className="err">{error}</p> : null}
        <div className="btn-row">
          <button className="btn" type="button" data-magnet onClick={() => boot(yaml)}>
            Apply policy
          </button>
          <button className="btn ghost" type="button" onClick={() => sessionRef.current && publish(sessionRef.current.advanceDays(1))}>
            Advance 1 day
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Ladder</h2>
        <p className="banner">
          This session never sends an order. Paper fills are shadow stand-ins. Live rungs stay refused. The CLI on your machine is the only path to a broker.
          {market ? ` Prices: ${market.source}. ${market.note}` : " Loading public prices…"}
        </p>
        <div className="prices" aria-live="polite">
          {market
            ? ["BTC-USD", "ETH-USD", "SOL-USD"].map((sym) => {
                const q = market.quotes[sym];
                return (
                  <span key={sym}>
                    {sym} {q ? q.mid.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
                  </span>
                );
              })
            : null}
        </div>
        <div className="rungs" aria-label="Autonomy ladder">
          {LADDER.map((rung) => (
            <div key={rung} className={snap?.rung === rung ? "rung on" : "rung"}>
              <b>{rung}</b>
              <span>{snap?.rung === rung ? "current" : ""}</span>
            </div>
          ))}
        </div>
        {snap ? (
          <>
            <p className="stats">
              <span>Equity {money(snap.equity)}</span>
              <span>Cash {money(snap.cash)}</span>
              <span>Drawdown {snap.drawdownPct.toFixed(2)}%</span>
              <span>
                Decisions {snap.stats.decisions} · breaches {snap.stats.breaches}
              </span>
              {snap.drift ? <span>Tool drift — orders frozen</span> : null}
              {snap.frozenUntil ? <span>Frozen until {snap.frozenUntil}</span> : null}
            </p>
            <ul className="checks">
              {snap.promotion.checks.map((c) => (
                <li key={c.name}>
                  <span className={c.ok ? "dot ok" : "dot"} aria-hidden="true" />
                  <span>
                    {c.ok ? "Pass" : "Hold"} — {c.detail}
                  </span>
                </li>
              ))}
              {snap.promotion.checks.length === 0 ? <li>Already at the top, or no criteria for this rung.</li> : null}
            </ul>
            <div className="btn-row">
              <button className="btn" type="button" data-magnet disabled={!snap.promotion.eligible} onClick={() => sessionRef.current && publish(sessionRef.current.promote(false))}>
                Promote
              </button>
              <button className="btn ghost" type="button" onClick={() => sessionRef.current && publish(sessionRef.current.promote(true))}>
                Force
              </button>
              <button className="btn danger" type="button" onClick={() => sessionRef.current && publish(sessionRef.current.panic())}>
                Panic
              </button>
              {snap.drift ? (
                <button className="btn ghost" type="button" onClick={() => sessionRef.current && publish(sessionRef.current.pinApprove())}>
                  Pin approve
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        <h2 style={{ marginTop: 18 }}>Order</h2>
        <form
          className="ticket"
          onSubmit={(e) => {
            e.preventDefault();
            place();
          }}
        >
          <label>
            Symbol
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {symbols.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Side
            <select value={side} onChange={(e) => setSide(e.target.value as Side)}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>
          <label>
            Notional USD
            <input
              type="number"
              min={1}
              step={1}
              value={notional}
              onChange={(e) => setNotional(Number(e.target.value))}
            />
          </label>
          <label>
            &nbsp;
            <button className="btn" type="submit" data-magnet>
              Place in shadow
            </button>
          </label>
        </form>

        <h2 style={{ marginTop: 18 }}>Scenarios</h2>
        <div className="scenarios">
          {SCENARIOS.map((sc) => (
            <button
              key={sc.id}
              type="button"
              title={sc.detail}
              onClick={() => {
                const session = sessionRef.current;
                if (!session) return;
                const steps = sc.run(session);
                const tail = steps.at(-1);
                setSnap(session.snapshot());
                if (tail) {
                  setLast(tail);
                  if (tail.moved) impact(tail.moved.direction);
                  else if (steps.some((s) => s.moved)) {
                    const moved = [...steps].reverse().find((s) => s.moved);
                    if (moved?.moved) impact(moved.moved.direction);
                  } else if (tail.tone === "bad") sound.block();
                  else sound.click();
                }
              }}
            >
              {sc.label}
            </button>
          ))}
        </div>
        {last ? (
          <div className={last.tone === "bad" ? "flash bad" : "flash"} aria-live="polite">
            <strong>{last.title}</strong>
            <p>{last.detail}</p>
            {last.checks.filter((c) => c.level !== "info").map((c) => (
              <p key={c.code}>
                {c.level}: {c.message}
              </p>
            ))}
          </div>
        ) : null}
        {snap && snap.proposals.filter((p) => p.status === "pending").length > 0 ? (
          <div className="flash">
            {snap.proposals
              .filter((p) => p.status === "pending")
              .map((p) => (
                <div key={p.id}>
                  <strong>
                    {p.id} · {String(p.intent["symbol"])} {String(p.intent["side"])} ${p.notionalUsd}
                  </strong>
                  <div className="btn-row">
                    <button type="button" className="btn" onClick={() => sessionRef.current && publish(sessionRef.current.decideProposal(p.id, true))}>
                      Approve
                    </button>
                    <button type="button" className="btn ghost" onClick={() => sessionRef.current && publish(sessionRef.current.decideProposal(p.id, false))}>
                      Decline
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h2>Tape</h2>
        <div className="tape">
          {snap?.tape.map((item) => (
            <article key={item.id} className={item.tone}>
              <strong>
                {item.rung} — {item.title}
              </strong>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
        <h2 style={{ marginTop: 16 }}>Audit chain</h2>
        <p className="stats">
          {snap?.verify.ok ? `Intact · ${snap.verify.entries} entries` : "Broken"} · head {snap?.verify.headHash.slice(0, 12)}
        </p>
        <div className="btn-row">
          <button
            className="btn"
            type="button"
            onClick={() => {
              const v = sessionRef.current?.verify();
              setTamper(v?.ok ? "verify: chain intact." : `verify failed: ${v?.reason ?? "unknown"}`);
              sound.verify();
            }}
          >
            Verify
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              const v = sessionRef.current?.tamperedVerify();
              setTamper(v && !v.ok ? `A copied entry was altered. verify failed at ${v.brokenAt ?? "?"}: ${v.reason}. The real chain was not touched.` : "Tamper check did not fail.");
              sound.block();
            }}
          >
            Tamper a copy
          </button>
        </div>
        {tamper ? <p className="flash">{tamper}</p> : null}
        <div className="audit" aria-label="Audit entries">
          {snap?.audit
            .slice()
            .reverse()
            .map((e) => (
              <div key={e.seq}>
                <span>{e.seq}</span>
                <span>
                  {e.type}
                  <div className="hash">{e.hash}</div>
                </span>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
