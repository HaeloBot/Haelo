import { createPublicClient, getAddress, http, isAddress, type Address } from "viem";
import { amountOutMinimum, decimalToUnits, erc20Abi, quoterV2Abi, ROBINHOOD_MAINNET, unitsToNumber, V3_FEES } from "../../../src/chain/uniswap.js";
import { robinhoodChain } from "../wallet/robinhood.js";

export interface ChainToken {
  symbol: string;
  address: Address;
  decimals: number;
}

export const KNOWN_TOKENS: ChainToken[] = [
  { symbol: "WETH", address: ROBINHOOD_MAINNET.weth, decimals: 18 },
  { symbol: "USDG", address: ROBINHOOD_MAINNET.usdg, decimals: 6 },
];

export const publicChain = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_MAINNET.rpc),
});

export interface PairQuote {
  label: string;
  base: ChainToken;
  quote: ChainToken;
  bid: number;
  ask: number;
  mid: number;
  fee: number;
  ts: string;
}

export async function readToken(address: string): Promise<ChainToken> {
  if (!isAddress(address)) throw new Error("That is not an ERC-20 address.");
  const token = getAddress(address);
  const [symbol, decimals] = await Promise.all([
    publicChain.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    publicChain.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { symbol, address: token, decimals };
}

async function quoteExact(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<{ amountOut: bigint; fee: number }> {
  let best: { amountOut: bigint; fee: number } | undefined;
  for (const fee of V3_FEES) {
    try {
      const result = await publicChain.simulateContract({
        address: ROBINHOOD_MAINNET.quoterV2,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      });
      const amountOut = result.result[0];
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) best = { amountOut, fee };
    } catch {
      /* this fee tier has no pool */
    }
  }
  if (!best) throw new Error("No Uniswap v3 pool quoted this pair.");
  return best;
}

/** Bid/ask for base/USDG (or base/WETH when the base is USDG) from QuoterV2. */
export async function quoteToken(base: ChainToken): Promise<PairQuote> {
  const quote = base.symbol === "USDG" ? KNOWN_TOKENS[0]! : KNOWN_TOKENS[1]!;
  if (base.address === quote.address) throw new Error("Pick a token other than the quote asset.");
  const one = 10n ** BigInt(base.decimals);
  const sold = await quoteExact(base.address, quote.address, one);
  const bid = unitsToNumber(sold.amountOut, quote.decimals);
  const spend = decimalToUnits(Math.max(bid, 1 / 10 ** quote.decimals), quote.decimals);
  const bought = await quoteExact(quote.address, base.address, spend);
  const baseOut = unitsToNumber(bought.amountOut, base.decimals);
  const ask = baseOut > 0 ? bid / baseOut : bid;
  return {
    label: `${base.symbol}/${quote.symbol}`,
    base,
    quote,
    bid,
    ask,
    mid: (bid + ask) / 2,
    fee: sold.fee,
    ts: new Date().toISOString(),
  };
}

export function minOut(amountOut: bigint, slippageBps: number): bigint {
  return amountOutMinimum(amountOut, slippageBps);
}
