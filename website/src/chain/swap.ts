import { encodeFunctionData, type Address, type Hex } from "viem";
import { amountOutMinimum, decimalToUnits, erc20Abi, quoterV2Abi, ROBINHOOD_MAINNET, swapRouter02Abi } from "../../../src/chain/uniswap.js";
import type { ChainToken } from "./quotes.js";
import { publicChain, quoteToken } from "./quotes.js";

export interface SwapPlan {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  amountOutMinimum: bigint;
  fee: number;
  approveData: Hex;
  swapData: Hex;
  router: Address;
}

export async function planSwap(opts: {
  base: ChainToken;
  side: "buy" | "sell";
  notionalUsd: number;
  qty?: number;
  slippageBps: number;
  recipient: Address;
  deadlineSeconds?: number;
}): Promise<SwapPlan> {
  const book = await quoteToken(opts.base);
  const tokenIn = opts.side === "buy" ? book.quote.address : book.base.address;
  const tokenOut = opts.side === "buy" ? book.base.address : book.quote.address;
  const amountIn =
    opts.side === "buy"
      ? decimalToUnits(opts.notionalUsd, book.quote.decimals)
      : decimalToUnits(opts.qty ?? opts.notionalUsd / Math.max(book.bid, 1e-12), book.base.decimals);
  const quoted = await publicChain.simulateContract({
    address: ROBINHOOD_MAINNET.quoterV2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee: book.fee, sqrtPriceLimitX96: 0n }],
  });
  const amountOut = quoted.result[0];
  const minimum = amountOutMinimum(amountOut, opts.slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 120));
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [ROBINHOOD_MAINNET.swapRouter02, amountIn],
  });
  const swapData = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn,
        tokenOut,
        fee: book.fee,
        recipient: opts.recipient,
        deadline,
        amountIn,
        amountOutMinimum: minimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  if (approveData.toLowerCase().includes("f".repeat(64))) throw new Error("Refusing an unlimited approval.");
  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    amountOutMinimum: minimum,
    fee: book.fee,
    approveData,
    swapData,
    router: ROBINHOOD_MAINNET.swapRouter02,
  };
}

export function explorerTx(hash: string): string {
  return `${ROBINHOOD_MAINNET.explorer}/tx/${hash}`;
}

export function isUserRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /user rejected|user denied|rejected the request/i.test(message);
}
