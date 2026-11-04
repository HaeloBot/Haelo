import { Link } from "react-router-dom";
import { Meta } from "../components/Meta.js";

export default function Pricing(): React.ReactElement {
  return (
    <article className="page">
      <Meta title="Pricing: Haelo" description="Haelo is MIT licensed and free. You pay network fees, if you trade. The project does not custody keys." />
      <p className="kicker">Open source</p>
      <h1 className="display">
        Zero.
        <br />
        <span className="lime">MIT.</span>
      </h1>
      <p className="lede">There is no hosted trading desk and no plan that holds your keys. The price of a higher rung is the criteria you already wrote down.</p>
      <div className="price-grid">
        <article className="card">
          <div className="idx">Shadow</div>
          <h3>$0</h3>
          <p>The playground quotes Jupiter on Solana in this browser. Shadow and paper are not signed. A live swap uses your connected wallet, and the page never asks for a private key.</p>
        </article>
        <article className="card">
          <div className="idx">Paper</div>
          <h3>Free</h3>
          <p>Paper on Solana is a real Jupiter route and an on-chain simulation, with nothing signed. You run the CLI and read <code>haelo doctor</code>. Haelo does not bill this.</p>
        </article>
        <article className="card">
          <div className="idx">Live</div>
          <h3>Your capital</h3>
          <p>
            Off until <code>live.enabled</code>. Micro defaults to $25 / $100 / 5 orders. Standard uses your rails. Still local. Still your loss if the trades are bad.
          </p>
        </article>
      </div>
      <section className="prose">
        <h2>What you are not buying</h2>
        <p>Signals, a managed account, a guarantee, or a place to paste an API secret. If a page asks for your private key or seed phrase, it is not this one.</p>
        <p>
          <Link to="/playground">Use the playground</Link> or clone the repo and run it.
        </p>
      </section>
    </article>
  );
}
