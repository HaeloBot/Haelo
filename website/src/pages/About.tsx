import { Meta } from "../components/Meta.js";

const FAQ = [
  {
    q: "Is this financial advice?",
    a: "No. Haelo reduces how badly an agent can hurt you. It does not make trading safe or profitable. Shadow results are weak evidence about live results.",
  },
  {
    q: "Does the playground trade?",
    a: "Shadow and paper quote live Jupiter routes on Solana and do not sign. A live rung, after you opt in and tick the real-funds box, simulates the swap and asks your connected wallet to sign. The page never asks for a private key.",
  },
  {
    q: "Why is demotion automatic and promotion human?",
    a: "A breach should not wait for someone to notice. A promotion spends trust you have not finished earning. The agent can request it. The command that grants it is not in the agent's tool list.",
  },
  {
    q: "What does the halo mean?",
    a: "The mark is a robot with a ring of light. The ring is the point: the agent is visible, bounded, and not yet trusted with the account.",
  },
  {
    q: "Who wrote it?",
    a: "Kavindu Diluka. The source is MIT licensed at github.com/HaeloBot/haelo-solana. RepoScan notes live in docs/ZAUTH.md. The repository does not invent contributors to look older than it is.",
  },
];

export default function About(): React.ReactElement {
  return (
    <article className="page">
      <Meta title="About: Haelo" description="Haelo is an MCP gateway: an autonomy ladder between an AI trading agent and a Solana wallet." />
      <p className="kicker">About</p>
      <h1 className="display">
        A gateway,
        <br />
        not a guru.
      </h1>
      <p className="lede">
        Haelo is an MCP server. Claude, Cursor, or your own client speaks MCP. Haelo classifies the call, evaluates it against a locked policy, and either simulates it, holds it, or forwards it only after you opt in. The ladder is the product.
      </p>
      <div className="faq">
        {FAQ.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </article>
  );
}
