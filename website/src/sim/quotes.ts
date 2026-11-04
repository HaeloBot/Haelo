import type { Quote } from "../../../src/types.js";
import { JupiterClient } from "../../../src/solana/jupiter.js";
import { DEFAULT_TOKENS, fromUnits, toUnits, type TokenInfo } from "../../../src/solana/constants.js";

export function makeQuote(symbol: string, mid: number, ts = new Date().toISOString()): Quote {
  const spread = Math.max(mid * 0.0004, 1e-9);
  const bid = mid - spread / 2;
  const ask = mid + spread / 2;
  return { symbol, bid, ask, mid, ts };
}

/** `SOL`, `sol-usdc` and `SOL/USDC` all become `SOL/USDC`, the same rule as the CLI's Solana venue. */
export function normalizePair(symbol: string): string {
  const raw = symbol.trim().toUpperCase().replace(/[-_]/g, "/");
  const [base, quote] = raw.includes("/") ? raw.split("/") : [raw, "USDC"];
  return `${base}/${quote}`;
}

/** Used when Jupiter cannot be reached. Labelled as offline in the UI. */
export const OFFLINE_MIDS: Record<string, number> = {
  "SOL/USDC": 150,
  "JUP/USDC": 0.5,
  "BONK/USDC": 0.00002,
};

export function offlineQuotes(ts?: string): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  for (const [symbol, mid] of Object.entries(OFFLINE_MIDS)) out[symbol] = makeQuote(symbol, mid, ts);
  return out;
}

export type PriceSource = "jupiter" | "offline";

export interface MarketBook {
  quotes: Record<string, Quote>;
  source: PriceSource;
  fetchedAt: string;
  note: string;
}

const USDC = DEFAULT_TOKENS.find((t) => t.symbol === "USDC") as TokenInfo;

/** Bid and ask for base/USDC from two quote-only Jupiter orders, the same method as `haelo quote`. */
export async function jupiterQuote(jup: JupiterClient, base: TokenInfo): Promise<Quote> {
  const one = 10n ** BigInt(base.decimals);
  const sold = await jup.order({ inputMint: base.mint, outputMint: USDC.mint, amount: one });
  const bid = fromUnits(sold.outAmount, USDC.decimals);
  const spend = toUnits(Math.max(bid, 1 / 10 ** USDC.decimals), USDC.decimals);
  const bought = await jup.order({ inputMint: USDC.mint, outputMint: base.mint, amount: spend });
  const baseOut = fromUnits(bought.outAmount, base.decimals);
  const ask = Math.max(baseOut > 0 ? fromUnits(spend, USDC.decimals) / baseOut : bid, bid);
  return { symbol: `${base.symbol}/USDC`, bid, ask, mid: (bid + ask) / 2, ts: new Date().toISOString() };
}

export async function loadMarket(jup = new JupiterClient()): Promise<MarketBook> {
  const bases = DEFAULT_TOKENS.filter((t) => t.symbol !== "USDC");
  try {
    const quotes: Record<string, Quote> = {};
    for (const q of await Promise.all(bases.map((b) => jupiterQuote(jup, b)))) quotes[q.symbol] = q;
    return { quotes, source: "jupiter", fetchedAt: new Date().toISOString(), note: "Bid/ask from live Jupiter routes on Solana mainnet. No key, no account." };
  } catch {
    return {
      quotes: offlineQuotes(),
      source: "offline",
      fetchedAt: new Date().toISOString(),
      note: "Jupiter was unreachable. These are labelled offline marks, not live quotes. Shadow fills still run.",
    };
  }
}
