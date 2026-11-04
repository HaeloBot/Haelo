import type { Quote } from "../../../src/types.js";

export function makeQuote(symbol: string, mid: number, ts = new Date().toISOString()): Quote {
  const spread = Math.max(mid * 0.0004, 0.01);
  const bid = mid - spread / 2;
  const ask = mid + spread / 2;
  return { symbol, bid, ask, mid, ts };
}

/** Used when a public ticker cannot be reached. Labelled as offline in the UI. */
export const OFFLINE_MIDS: Record<string, number> = {
  "BTC-USD": 100_000,
  "ETH-USD": 3_500,
  "SOL-USD": 180,
  AAPL: 220,
};

export function offlineQuotes(ts?: string): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  for (const [symbol, mid] of Object.entries(OFFLINE_MIDS)) out[symbol] = makeQuote(symbol, mid, ts);
  return out;
}

export type PriceSource = "coinbase" | "kraken" | "offline";

export interface MarketBook {
  quotes: Record<string, Quote>;
  source: PriceSource;
  fetchedAt: string;
  note: string;
}

const PAIRS: Array<{ symbol: string; coinbase: string; kraken: string }> = [
  { symbol: "BTC-USD", coinbase: "BTC-USD", kraken: "XBTUSD" },
  { symbol: "ETH-USD", coinbase: "ETH-USD", kraken: "ETHUSD" },
  { symbol: "SOL-USD", coinbase: "SOL-USD", kraken: "SOLUSD" },
];

async function fromCoinbase(signal: AbortSignal): Promise<Record<string, Quote>> {
  const quotes: Record<string, Quote> = {};
  await Promise.all(
    PAIRS.map(async (pair) => {
      const res = await fetch(`https://api.exchange.coinbase.com/products/${pair.coinbase}/ticker`, { signal });
      if (!res.ok) throw new Error(`Coinbase ${pair.coinbase} ${res.status}`);
      const body = (await res.json()) as { bid?: string; ask?: string; price?: string; time?: string };
      const bid = Number(body.bid);
      const ask = Number(body.ask);
      const mid = Number(body.price);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
        if (!Number.isFinite(mid) || mid <= 0) throw new Error(`Coinbase ${pair.coinbase} had no price`);
        quotes[pair.symbol] = makeQuote(pair.symbol, mid, body.time);
        return;
      }
      quotes[pair.symbol] = { symbol: pair.symbol, bid, ask, mid: (bid + ask) / 2, ts: body.time ?? new Date().toISOString() };
    }),
  );
  quotes["AAPL"] = makeQuote("AAPL", OFFLINE_MIDS["AAPL"] ?? 220);
  return quotes;
}

async function fromKraken(signal: AbortSignal): Promise<Record<string, Quote>> {
  const query = PAIRS.map((p) => p.kraken).join(",");
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${query}`, { signal });
  if (!res.ok) throw new Error(`Kraken ${res.status}`);
  const body = (await res.json()) as { error?: string[]; result?: Record<string, { a?: string[]; b?: string[]; c?: string[] }> };
  if (body.error && body.error.length > 0) throw new Error(body.error.join(", "));
  const result = body.result ?? {};
  const quotes: Record<string, Quote> = {};
  for (const pair of PAIRS) {
    const row =
      result[pair.kraken] ??
      Object.entries(result).find(([k]) => k.includes(pair.kraken.replace("XBT", "XBT")) || k.endsWith(pair.kraken.slice(-3)))?.[1];
    const found = result[pair.kraken] ?? findKraken(result, pair.kraken);
    if (!found && !row) throw new Error(`Kraken missing ${pair.kraken}`);
    const ticker = found ?? row;
    if (!ticker) throw new Error(`Kraken missing ${pair.kraken}`);
    const bid = Number(ticker.b?.[0]);
    const ask = Number(ticker.a?.[0]);
    const last = Number(ticker.c?.[0]);
    const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : last;
    if (!Number.isFinite(mid) || mid <= 0) throw new Error(`Kraken bad price for ${pair.kraken}`);
    quotes[pair.symbol] =
      Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? { symbol: pair.symbol, bid, ask, mid, ts: new Date().toISOString() }
        : makeQuote(pair.symbol, mid);
  }
  quotes["AAPL"] = makeQuote("AAPL", OFFLINE_MIDS["AAPL"] ?? 220);
  return quotes;
}

function findKraken(
  result: Record<string, { a?: string[]; b?: string[]; c?: string[] }>,
  pair: string,
): { a?: string[]; b?: string[]; c?: string[] } | undefined {
  if (result[pair]) return result[pair];
  const want = pair.replace("XBT", "XXBT").replace("USD", "ZUSD");
  return result[want] ?? result[`X${pair}`] ?? Object.entries(result).find(([k]) => k.includes(pair.slice(0, 3)))?.[1];
}

export async function loadMarket(signal?: AbortSignal): Promise<MarketBook> {
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), 6000);
  const linked = signal ?? own.signal;
  try {
    try {
      const quotes = await fromCoinbase(linked);
      return {
        quotes,
        source: "coinbase",
        fetchedAt: new Date().toISOString(),
        note: "Bid/ask from the Coinbase Exchange public ticker. No key, no account.",
      };
    } catch {
      const quotes = await fromKraken(linked);
      return {
        quotes,
        source: "kraken",
        fetchedAt: new Date().toISOString(),
        note: "Bid/ask from the Kraken public ticker. No key, no account.",
      };
    }
  } catch {
    return {
      quotes: offlineQuotes(),
      source: "offline",
      fetchedAt: new Date().toISOString(),
      note: "Public tickers were unreachable. These are labelled offline marks, not live quotes. Shadow fills still run.",
    };
  } finally {
    clearTimeout(timer);
  }
}
