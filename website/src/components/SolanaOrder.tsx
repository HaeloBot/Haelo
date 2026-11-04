import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { gateOrder } from "../solana/gate.js";
import { jupiterQuote, loadMarket } from "../sim/quotes.js";
import { useSiteConfig } from "./SiteConfig.js";
import type { PlaygroundSession, StepResult } from "../sim/session.js";
import type { Quote, Side } from "../../../src/types.js";
import { JupiterClient } from "../../../src/solana/jupiter.js";
import { SolanaRpc } from "../../../src/solana/rpc.js";
import { decodeTransaction, guardSwap, minOutAfterSlippage } from "../../../src/solana/guard.js";
import { BASE58_KEY, DEFAULT_TOKENS, PROGRAMS, SOLANA_MAINNET, USDC_MINT, toUnits, type TokenInfo } from "../../../src/solana/constants.js";

const AUDIT_KEY = "haelo.solana.audit";
const USDC = DEFAULT_TOKENS.find((t) => t.mint === USDC_MINT) as TokenInfo;
const BASES = DEFAULT_TOKENS.filter((t) => t.mint !== USDC_MINT);

/** An RPC that cannot be reached from the browser is not a reason to refuse; a failed simulation or a bad balance change is. */
function rpcUnavailable(e: unknown): boolean {
  return e instanceof Error && /^Solana RPC/.test(e.message);
}

export function SolanaOrder({
  sessionRef,
  publish,
  onAudit,
}: {
  sessionRef: RefObject<PlaygroundSession | null>;
  publish: (result?: StepResult) => void;
  onAudit: () => void;
}): React.ReactElement {
  const site = useSiteConfig();
  const wallet = useWallet();
  const modal = useWalletModal();
  const jup = useMemo(() => new JupiterClient(), []);
  const rpc = useMemo(() => new SolanaRpc(site.solana.rpcUrl), [site.solana.rpcUrl]);
  const [tokens, setTokens] = useState<TokenInfo[]>(BASES);
  const [token, setToken] = useState<TokenInfo>(BASES[0] as TokenInfo);
  const [custom, setCustom] = useState("");
  const [side, setSide] = useState<Side>("buy");
  const [notional, setNotional] = useState(25);
  const [slippage, setSlippage] = useState(50);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [fundsAck, setFundsAck] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<string>("Loading live Jupiter prices…");
  // The parent recreates publish on every render; keep the latest without re-running effects.
  const publishRef = useRef(publish);
  publishRef.current = publish;

  // Refresh every built-in pair once so scenarios and the shadow book mark against live prices.
  useEffect(() => {
    let cancel = false;
    void loadMarket(jup).then((book) => {
      if (cancel) return;
      sessionRef.current?.setQuotes(book.quotes);
      setSource(book.note);
      publishRef.current();
    });
    return () => {
      cancel = true;
    };
  }, [jup, sessionRef]);

  useEffect(() => {
    let cancel = false;
    setQuote(null);
    setQuoteError(null);
    void jupiterQuote(jup, token)
      .then((next) => {
        if (cancel) return;
        setQuote(next);
        sessionRef.current?.setQuotes({ [next.symbol]: next });
      })
      .catch((error: unknown) => {
        if (!cancel) setQuoteError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancel = true;
    };
  }, [token, jup, sessionRef]);

  const addCustom = (): void => {
    const mint = custom.trim();
    if (!BASE58_KEY.test(mint)) {
      setNote("That is not a Solana mint address.");
      return;
    }
    void rpc
      .getMint(mint)
      .then((info) => {
        const next = { symbol: mint.slice(0, 4).toUpperCase(), mint, decimals: info.decimals };
        setTokens((list) => (list.some((t) => t.mint === mint) ? list : [...list, next]));
        setToken(next);
        setCustom("");
        setNote(`Read ${mint} from chain: ${info.decimals} decimals. It is not on the allow-list unless your policy adds ${next.symbol}/USDC.`);
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)));
  };

  const place = async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || !quote) return;
    const snap = session.snapshot();
    const live = snap.rung === "micro" || snap.rung === "standard";
    const gate = gateOrder({
      config: session.config,
      rung: snap.rung,
      symbol: quote.symbol,
      side,
      notionalUsd: notional,
      slippageBps: slippage,
      usage: { ordersToday: snap.usage.ordersToday, notionalToday: snap.usage.notionalToday, recentOrderTimes: [], lastOrderBySymbol: {} },
      nowMs: Date.now(),
      live,
      fundsAck,
      walletConnected: wallet.connected && Boolean(wallet.publicKey),
    });
    if (!gate.ok) {
      setNote(gate.reason);
      setTx(null);
      if (gate.needsWallet) modal.setVisible(true);
      return;
    }
    const result = session.placeOrder({ symbol: quote.symbol, side, notionalUsd: notional });
    publish(result);
    onAudit();
    if (!result.readyForWallet) {
      setNote(result.detail);
      return;
    }
    const owner = wallet.publicKey?.toBase58();
    if (!owner || !wallet.signTransaction) {
      setNote("This wallet cannot sign transactions here. Nothing was signed.");
      return;
    }
    setBusy(true);
    setTx(null);
    try {
      const inToken = side === "buy" ? USDC : token;
      const outToken = side === "buy" ? token : USDC;
      const amount = side === "buy" ? toUnits(notional, USDC.decimals) : toUnits(notional / quote.bid, token.decimals);
      const order = await jup.order({ inputMint: inToken.mint, outputMint: outToken.mint, amount, taker: owner, slippageBps: slippage });
      const txn = decodeTransaction(order.transaction ?? "");
      try {
        await guardSwap(rpc, txn, {
          owner,
          inputMint: inToken.mint,
          outputMint: outToken.mint,
          inputProgram: PROGRAMS.token,
          outputProgram: PROGRAMS.token,
          amountIn: amount,
          minOut: minOutAfterSlippage(order.outAmount, slippage),
          maxFeeLamports: 10_000_000n,
        });
      } catch (e) {
        if (!rpcUnavailable(e)) throw e;
        setNote("The browser could not reach the RPC to simulate. Read the balance changes your wallet shows before you approve.");
      }
      const signed = await wallet.signTransaction(txn);
      const done = await jup.execute(Buffer.from(signed.serialize()).toString("base64"), order.requestId, order.lastValidBlockHeight);
      const ok = done.status === "Success" && Boolean(done.signature);
      const detail = ok ? `Swap landed. Signature ${done.signature}.` : `Jupiter execute failed (code ${done.code})${done.error ? `: ${done.error}` : ""}.`;
      setNote(detail);
      setTx(done.signature ?? null);
      session.recordBroadcast({ ok, ...(done.signature ? { hash: done.signature } : {}), detail, symbol: quote.symbol, notionalUsd: notional });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setNote(`${reason} Nothing was sent.`);
      session.recordBroadcast({ ok: false, detail: reason, symbol: quote.symbol, notionalUsd: notional });
    } finally {
      setBusy(false);
      publish();
      onAudit();
    }
  };

  return (
    <>
      <h2 style={{ marginTop: 18 }}>Solana</h2>
      <p className="banner">
        Quotes are live Jupiter routes on Solana mainnet. Shadow and paper are never signed. A live rung runs the policy gate and simulates the swap, then asks your connected wallet to sign. This page never asks for a private key.
        {quote ? ` ${quote.symbol} mid ${quote.mid.toLocaleString(undefined, { maximumSignificantDigits: 6 })}.` : quoteError ? ` ${quoteError}` : " Loading the Jupiter quote…"}
      </p>
      <p className="stats">{source}</p>
      <form
        className="ticket"
        onSubmit={(event) => {
          event.preventDefault();
          void place();
        }}
      >
        <label>
          Token
          <select
            aria-label="Token"
            value={token.mint}
            onChange={(event) => {
              const next = tokens.find((item) => item.mint === event.target.value);
              if (next) setToken(next);
            }}
          >
            {tokens.map((item) => (
              <option key={item.mint} value={item.mint}>
                {item.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          Side
          <select aria-label="Side" value={side} onChange={(event) => setSide(event.target.value as Side)}>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
        </label>
        <label>
          Notional USDC
          <input aria-label="Notional USDC" type="number" min={1} step={1} value={notional} onChange={(event) => setNotional(Number(event.target.value))} />
        </label>
        <label>
          Slippage bps
          <input aria-label="Slippage bps" type="number" min={1} max={9999} step={1} value={slippage} onChange={(event) => setSlippage(Number(event.target.value))} />
        </label>
        <label>
          &nbsp;
          <button className="btn" type="submit" data-magnet disabled={busy || !quote}>
            {busy ? "Waiting" : "Place order"}
          </button>
        </label>
      </form>
      <div className="btn-row">
        <input aria-label="SPL token mint" placeholder="Paste an SPL token mint" value={custom} onChange={(event) => setCustom(event.target.value)} />
        <button className="btn ghost" type="button" onClick={addCustom}>
          Read token
        </button>
      </div>
      <label className="banner">
        <input type="checkbox" checked={fundsAck} onChange={(event) => setFundsAck(event.target.checked)} /> I understand this uses real funds
      </label>
      {note ? <p className="flash">{note}</p> : null}
      {tx ? (
        <p className="flash">
          <a href={`${SOLANA_MAINNET.explorerTx}${tx}`} target="_blank" rel="noreferrer">
            View on Solscan
          </a>
        </p>
      ) : null}
    </>
  );
}

export function persistAudit(json: string): void {
  try {
    localStorage.setItem(AUDIT_KEY, json);
  } catch {
    /* storage may be blocked; the audit still exports */
  }
}

export function readPersistedAudit(): string | null {
  try {
    return localStorage.getItem(AUDIT_KEY);
  } catch {
    return null;
  }
}
