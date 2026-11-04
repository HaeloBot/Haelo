/** Solana mainnet-beta facts Haelo checks against at connect time. */
export const SOLANA_MAINNET = {
  /** Genesis hash of mainnet-beta. A different value means the RPC is another cluster. */
  genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  rpcUrl: "https://api.mainnet-beta.solana.com",
  explorerTx: "https://solscan.io/tx/",
} as const;

/** Jupiter Swap API V2 (order then execute). A key is optional: the keyless tier is rate limited. */
export const JUPITER = {
  baseUrl: "https://api.jup.ag/swap/v2",
} as const;

export const PROGRAMS = {
  system: "11111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
} as const;

export interface TokenInfo {
  symbol: string;
  mint: string;
  decimals: number;
}

/** Native SOL is traded through the wrapped SOL mint; Jupiter wraps and unwraps it. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Built-in token book. Decimals are re-checked on chain at connect time. */
export const DEFAULT_TOKENS: TokenInfo[] = [
  { symbol: "SOL", mint: WSOL_MINT, decimals: 9 },
  { symbol: "USDC", mint: USDC_MINT, decimals: 6 },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6 },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5 },
];

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Base58 public key: 32 to 44 characters from the bitcoin alphabet. */
export const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Exact decimal to integer base units without floating point drift. */
export function toUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be a positive number.");
  const [whole, frac = ""] = amount.toFixed(decimals).split(".");
  return BigInt((whole ?? "0") + frac.padEnd(decimals, "0").slice(0, decimals));
}

export function fromUnits(units: bigint, decimals: number): number {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const n = Number(whole) + Number(frac) / Number(base);
  return neg ? -n : n;
}

/** Strip anything that looks like a secret key from text before it is logged or returned. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\[(\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g, "[redacted key bytes]")
    .replace(/[1-9A-HJ-NP-Za-km-z]{80,90}/g, "[redacted key]");
}
