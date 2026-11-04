import { Meta } from "../components/Meta.js";

const ROWS = [
  { t: "Oversized orders", m: "Pure policy evaluator. Caps per order, day, minute, symbol. Unsized orders are refused.", r: "Caps bound the loss. They do not make a trade good." },
  { t: "Moving money", m: "Transfer-like tools are hidden and blocked. Unknown tools are treated the same. Annotations are not trusted.", r: "Classification is by name. Odd upstream names need toolOverrides." },
  { t: "Prompt injection", m: "Tool text is scanned. A flag opens a window where orders are blocked and can demote.", r: "A tripwire, not a wall. A determined injection can evade the regexes." },
  { t: "Tool rug-pull", m: "The tool list is hashed and pinned. On change, orders freeze and the agent is demoted.", r: "First use is trusted unless you turn that off." },
  { t: "Self-promotion", m: "No agent tool can promote, approve, or edit the file. The policy hash is locked at serve.", r: "Only if the agent cannot run haelo as the same OS user." },
  { t: "Audit edits", m: "Hash-chained JSONL or SQLite. verify detects edits, deletions, and reordering.", r: "Tamper-evident, not tamper-proof. Someone who rewrites the whole file can recompute it." },
];

export default function Security(): React.ReactElement {
  return (
    <article className="page">
      <Meta title="Security: Haelo" description="What Haelo defends against, and the risks it does not remove. The agent is assumed untrusted." />
      <p className="kicker">Threat model</p>
      <h1 className="display">
        Assume the
        <br />
        <span className="lime">agent is hostile.</span>
      </h1>
      <p className="lede">Haelo exists because an agent with a brokerage login can be wrong, manipulated, or compromised. These are the controls, and the holes next to them.</p>
      <div className="card-grid">
        {ROWS.map((row) => (
          <article key={row.t} className="card">
            <h3>{row.t}</h3>
            <p>{row.m}</p>
            <p>{row.r}</p>
          </article>
        ))}
      </div>
      <section className="prose">
        <h2>Keep the controls out of reach</h2>
        <p>
          Run Haelo as a different OS user, or in a container, from the agent. The state directory is <code>0700</code>. Give the agent the MCP endpoint, not a shell as that user. A keychain protects tokens at rest from other users. It does not protect them from a process running as you.
        </p>
        <h2>Keys</h2>
        <p>
          Broker credentials come from environment variables. They are not written to the policy, the audit log, or this website. The playground has no field for a private key. A live Robinhood Chain swap is signed by the connected wallet after the policy gate. OAuth tokens prefer the OS keychain, with a <code>0600</code> file fallback. <code>live.enabled</code> defaults to false, and while it is false no code path sends a live order.
        </p>
        <p>
          Report a vulnerability in private on the GitHub security tab. Do not open a public issue. The full note is <code>SECURITY.md</code> in the repository.
        </p>
      </section>
    </article>
  );
}
