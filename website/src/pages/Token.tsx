import { lazy, Suspense, useState } from "react";
import { Meta } from "../components/Meta.js";
import { useReduced } from "../components/Chrome.js";
import { useSiteConfig } from "../components/SiteConfig.js";
import { sound } from "../audio/sound.js";
import { buyUrl, isCaSet, truncateCa } from "../site-config.js";

const CoinScene = lazy(() => import("../scene/CoinScene.js"));

export default function Token(): React.ReactElement {
  const cfg = useSiteConfig();
  const reduced = useReduced();
  const ca = cfg.token.ca.trim();
  const ready = isCaSet(ca);
  const href = ready ? buyUrl(cfg.token.buyUrlTemplate, ca) : null;
  const [copied, setCopied] = useState(false);
  const symbol = cfg.token.symbol || "HAELO";

  async function copy(): Promise<void> {
    if (!ready) return;
    try {
      await navigator.clipboard.writeText(ca);
      setCopied(true);
      sound.click();
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="token">
      <Meta
        title={`$${symbol}: Haelo`}
        description={`$${symbol} is the community token for the Haelo project. It is launching on ponsfamily.com. Not financial advice.`}
      />
      <section className="token-hero" data-fx="level" aria-label={`${symbol} token`}>
        <div className="token-stage">
          <Suspense fallback={<div className="scene-fallback" />}>
            <CoinScene reduced={reduced} />
          </Suspense>
        </div>
        <div className="token-copy">
          <p className="kicker">Community token</p>
          <h1 className="display glitch" data-text={`$${symbol}`}>
            ${symbol}
          </h1>
          <p className="lede">The community token for the Haelo project. Launching on ponsfamily.com.</p>
        </div>
      </section>

      <section className="band token-about" data-fx="section">
        <h2 className="display" data-fx="head">About ${symbol}</h2>
        <p>
          ${symbol} is a community token for the people around Haelo, the MCP gateway that puts trading agents on an autonomy ladder. It is launching on{" "}
          <a href="https://ponsfamily.com">ponsfamily.com</a>. It does not unlock the software, it is not equity in the project, and it is not a promise of a price.
        </p>

        <div className={copied ? "ca-card copied" : "ca-card"}>
          <p className="kicker">Contract address</p>
          {ready ? (
            <>
              <p className="ca-big">{truncateCa(ca)}</p>
              <p className="ca-full">{ca}</p>
              <button className="btn" type="button" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy address"}
              </button>
            </>
          ) : (
            <>
              <p className="ca-big">CA coming soon</p>
              <p className="ca-full">The contract address will show here when it is published in config.json.</p>
              <button className="btn" type="button" disabled>
                Copy address
              </button>
            </>
          )}
        </div>

        <div className="btn-row">
          {href ? (
            <a className="btn" href={href} target="_blank" rel="noreferrer">
              Buy ${symbol}
            </a>
          ) : (
            <button className="btn" type="button" disabled>
              Buy ${symbol}
            </button>
          )}
          <a className="btn ghost" href="https://ponsfamily.com" target="_blank" rel="noreferrer">
            ponsfamily.com
          </a>
        </div>
        <p className="token-note">Memecoin. High risk. Not financial advice.</p>
      </section>
    </article>
  );
}
