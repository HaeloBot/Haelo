import { useEffect, useState, type RefObject } from "react";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { gateOrder } from "../chain/gate.js";
import { KNOWN_TOKENS, quoteToken, readToken, type ChainToken, type PairQuote } from "../chain/quotes.js";
import { sendPlannedSwap } from "../chain/send.js";
import { explorerTx, planSwap } from "../chain/swap.js";
import { initAppKit } from "../wallet/appkit.js";
import { useSiteConfig } from "./SiteConfig.js";
import type { PlaygroundSession, StepResult } from "../sim/session.js";
import type { Side } from "../../../src/types.js";
import { ROBINHOOD_MAINNET } from "../../../src/chain/uniswap.js";

const AUDIT_KEY = "haelo.browser.audit";

export function ChainOrder({
  sessionRef,
  publish,
  onAudit,
}: {
  sessionRef: RefObject<PlaygroundSession | null>;
  publish: (result?: StepResult) => void;
  onAudit: () => void;
}): React.ReactElement {
  const site = useSiteConfig();
  const account = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { switchChainAsync } = useSwitchChain();
  const { data: wallet } = useWalletClient();
  const [tokens, setTokens] = useState<ChainToken[]>(KNOWN_TOKENS);
  const [token, setToken] = useState<ChainToken>(KNOWN_TOKENS[0]!);
  const [custom, setCustom] = useState("");
  const [side, setSide] = useState<Side>("buy");
  const [notional, setNotional] = useState(25);
  const [slippage, setSlippage] = useState(50);
  const [quote, setQuote] = useState<PairQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [fundsAck, setFundsAck] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setQuote(null);
    setQuoteError(null);
    void quoteToken(token)
      .then((next) => {
        if (ac.signal.aborted) return;
        setQuote(next);
        const session = sessionRef.current;
        if (!session) return;
        session.setQuotes({
          [next.label]: { symbol: next.label, bid: next.bid, ask: next.ask, mid: next.mid, ts: next.ts },
        });
      })
      .catch((error: unknown) => {
        if (!ac.signal.aborted) setQuoteError(error instanceof Error ? error.message : String(error));
      });
    return () => ac.abort();
  }, [token, sessionRef]);

  const addCustom = (): void => {
    void readToken(custom)
      .then((next) => {
        setTokens((list) => (list.some((t) => t.address === next.address) ? list : [...list, next]));
        setToken(next);
        setCustom("");
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
      symbol: quote.label,
      side,
      notionalUsd: notional,
      slippageBps: slippage,
      usage: { ordersToday: snap.usage.ordersToday, notionalToday: snap.usage.notionalToday, recentOrderTimes: [], lastOrderBySymbol: {} },
      nowMs: Date.now(),
      live,
      fundsAck,
      chainId: account.isConnected ? chainId : null,
    });
    if (!gate.ok) {
      setNote(gate.reason);
      setTx(null);
      return;
    }
    const result = session.placeOrder({ symbol: quote.label, side, notionalUsd: notional });
    publish(result);
    onAudit();
    if (!result.readyForWallet) {
      setNote(result.detail);
      return;
    }
    if (!account.isConnected || !account.address) {
      setNote("Policy passed. Connect a wallet on Robinhood Chain. Nothing has been signed.");
      void initAppKit(site.reown.projectId).appkit.open();
      return;
    }
    if (chainId !== ROBINHOOD_MAINNET.chainId) {
      setNote(`Switching to Robinhood Chain (${ROBINHOOD_MAINNET.chainId}).`);
      try {
        await switchChainAsync({ chainId: ROBINHOOD_MAINNET.chainId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setNote(reason);
        session.recordBroadcast({ ok: false, detail: reason, symbol: quote.label, notionalUsd: notional });
        onAudit();
        return;
      }
    }
    if (!wallet || !publicClient) {
      setNote("The wallet is connected but not ready to sign.");
      return;
    }
    setBusy(true);
    try {
      const plan = await planSwap({
        base: token,
        side,
        notionalUsd: notional,
        slippageBps: slippage,
        recipient: account.address,
      });
      const sent = await sendPlannedSwap({ plan, wallet, account: account.address, publicClient });
      setNote(sent.reason);
      setTx(sent.hash ?? null);
      session.recordBroadcast({
        ok: sent.ok,
        ...(sent.hash ? { hash: sent.hash } : {}),
        detail: sent.reason,
        symbol: quote.label,
        notionalUsd: notional,
      });
      publish();
      onAudit();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 style={{ marginTop: 18 }}>Robinhood Chain</h2>
      <p className="banner">
        Quotes are Uniswap v3 QuoterV2 on chain {ROBINHOOD_MAINNET.chainId}. Shadow and paper are not signed. A live rung asks the connected wallet to sign after the policy gate. This page never asks for a private key.
        {quote ? ` ${quote.label} mid ${quote.mid.toLocaleString(undefined, { maximumFractionDigits: 4 })} (fee ${quote.fee}).` : quoteError ? ` ${quoteError}` : " Loading the on-chain quote…"}
      </p>
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
            value={token.address}
            onChange={(event) => {
              const next = tokens.find((item) => item.address === event.target.value);
              if (next) setToken(next);
            }}
          >
            {tokens.map((item) => (
              <option key={item.address} value={item.address}>
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
          Notional USD
          <input aria-label="Notional USD" type="number" min={1} step={1} value={notional} onChange={(event) => setNotional(Number(event.target.value))} />
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
        <input aria-label="ERC-20 address" placeholder="Paste an ERC-20 address" value={custom} onChange={(event) => setCustom(event.target.value)} />
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
          <a href={explorerTx(tx)} target="_blank" rel="noreferrer">
            {tx}
          </a>
        </p>
      ) : null}
    </>
  );
}

export function persistAudit(json: string): void {
  localStorage.setItem(AUDIT_KEY, json);
}

export function readPersistedAudit(): string | null {
  return localStorage.getItem(AUDIT_KEY);
}
