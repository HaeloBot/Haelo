import { useState } from "react";
import { Meta } from "../components/Meta.js";

const TABS = [
  {
    id: "claude",
    label: "Claude Desktop",
    code: `{
  "mcpServers": {
    "haelo": {
      "command": "npx",
      "args": ["-y", "haelo-solana", "serve", "--stdio", "--config", "/ABSOLUTE/PATH/TO/haelo.yaml"]
    }
  }
}`,
  },
  {
    id: "cursor",
    label: "Cursor stdio",
    code: `{
  "mcpServers": {
    "haelo": {
      "command": "npx",
      "args": ["-y", "haelo-solana", "serve", "--stdio", "--config", "/ABSOLUTE/PATH/TO/haelo.yaml"]
    }
  }
}`,
  },
  {
    id: "http",
    label: "Cursor HTTP",
    code: `{
  "mcpServers": {
    "haelo": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer \${env:HAELO_HTTP_TOKEN}" }
    }
  }
}`,
  },
];

export default function Docs(): React.ReactElement {
  const [tab, setTab] = useState(TABS[0]?.id ?? "claude");
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <article className="page prose">
      <Meta title="Docs: Haelo" description="Install Haelo for Solana and connect Claude Desktop or Cursor. Live swaps are signed on your own machine." />
      <p className="kicker">Quickstart</p>
      <h1 className="display">Install it locally.</h1>
      <p>These commands are the real gateway. Node 22.13 or newer. No key is needed until you go live.</p>
      <pre className="code">{`npm i -g haelo-solana

haelo init                 # Solana mainnet-beta, Jupiter, live off
haelo quote SOL/USDC       # live Jupiter price
haelo policy lock
haelo doctor
haelo serve --stdio`}</pre>
      <h2>Going live, later</h2>
      <p>Use a dedicated wallet with only what the agent may trade. The key goes in your OS keychain, never in the YAML, and this website will never ask for it.</p>
      <pre className="code">{`haelo key import --file agent-wallet.json
export HAELO_RPC_URL=https://your-private-rpc...
haelo doctor --live`}</pre>
      <h2>Connect an agent</h2>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-pressed={t.id === tab} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <pre className="code">{current?.code}</pre>
      <p>
        The same files live in the repo: <code>examples/claude-desktop.stdio.json</code>, <code>examples/cursor.mcp.json</code>, <code>examples/cursor.mcp.http.json</code>. HTTP mode prints a bearer token into the state directory. Do not paste it into a chat.
      </p>
      <h2>What the agent is allowed to call</h2>
      <p>
        <code>get_quote</code>, <code>get_account</code>, <code>get_positions</code>, <code>place_order</code>, and a short list of <code>haelo_*</code> tools: status, preflight, propose, explain a block, shadow report, request promotion, and a kill switch that drops the agent to shadow. There is no tool that promotes, approves, transfers, or edits policy. How a live swap is simulated before it is signed is in <code>docs/SOLANA.md</code>.
      </p>
      <h2>The human's commands</h2>
      <pre className="code">{`haelo key import | show | forget
haelo status | report
haelo promote [--force]
haelo demote | panic
haelo proposals
haelo approve <id> | decline <id>
haelo doctor [--live]
haelo pin status | approve
haelo audit verify | tail | export
haelo policy lock | check | show`}</pre>
      <p>
        Every field of the policy file is in <code>docs/POLICY.md</code>. Going live is a separate, deliberate edit. Read <code>docs/GO_LIVE.md</code> and run <code>haelo doctor --live</code> before <code>live.enabled: true</code>.
      </p>
    </article>
  );
}
