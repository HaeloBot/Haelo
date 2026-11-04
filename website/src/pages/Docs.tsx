import { useState } from "react";
import { Meta } from "../components/Meta.js";

const TABS = [
  {
    id: "claude",
    label: "Claude Desktop",
    code: `{
  "mcpServers": {
    "haelo": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/haelo/dist/cli.js", "serve", "--stdio", "--config", "/ABSOLUTE/PATH/TO/haelo.yaml"]
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
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/haelo/dist/cli.js", "serve", "--stdio", "--config", "/ABSOLUTE/PATH/TO/haelo.yaml"],
      "env": {
        "ALPACA_PAPER_KEY_ID": "PK...",
        "ALPACA_PAPER_SECRET_KEY": "..."
      }
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
      <Meta title="Docs: Haelo" description="Install Haelo and connect Claude Desktop or Cursor. Live trading stays on the local CLI." />
      <p className="kicker">Quickstart</p>
      <h1 className="display">Install it locally.</h1>
      <p>The website does not hold a broker session. These commands are the real gateway. Node 22.13 or newer.</p>
      <pre className="code">{`git clone https://github.com/HaeloBot/Haelo && cd Haelo
npm ci && npm run build

node dist/cli.js mock-upstream --port 8799 &
mkdir /tmp/haelo-demo && cd /tmp/haelo-demo
node /path/to/Haelo/dist/cli.js init --broker mock
node /path/to/Haelo/dist/cli.js policy lock
node /path/to/Haelo/dist/cli.js doctor
node /path/to/Haelo/dist/cli.js serve --http`}</pre>
      <h2>Alpaca paper</h2>
      <p>A free paper account is enough to leave the mock. Keys stay in the environment. They never go in the YAML, and this website will not take them.</p>
      <pre className="code">{`export ALPACA_PAPER_KEY_ID=PK... ALPACA_PAPER_SECRET_KEY=...
haelo init --broker alpaca && haelo policy lock
haelo doctor
haelo serve --stdio`}</pre>
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
        Read tools from the broker, a normalized order tool, and a short list of <code>haelo_*</code> tools: status, preflight, propose, explain a block, shadow report, request promotion. There is no tool that promotes, demotes, approves, or edits policy.
      </p>
      <h2>The human's commands</h2>
      <pre className="code">{`haelo status | report
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
