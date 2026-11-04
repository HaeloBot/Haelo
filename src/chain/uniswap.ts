import { getAddress } from "viem";

/**
 * Robinhood Chain + the Uniswap v3 deployment Haelo will actually call.
 *
 * Sources, checked before these constants were written:
 * - Robinhood names Uniswap as the public DEX: https://docs.robinhood.com/chain/
 * - Network ids and RPCs: https://docs.robinhood.com/chain/deploy-smart-contracts/
 * - L2 WETH (mainnet and testnet): https://docs.robinhood.com/chain/protocol-contracts/
 * - Uniswap v3 addresses for chain 4663:
 *   https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
 *   https://github.com/Uniswap/contracts/blob/main/deployments/4663.md
 * - USDG (symbol USDG, 6 decimals) is the Paxos stablecoin Robinhood lists as the chain stablecoin.
 *   The address is the one 1inch documents for chain 4663
 *   (https://help.1inch.com/en/articles/15618946-robinhood-chain) and was read back on
 *   https://rpc.mainnet.chain.robinhood.com: symbol() == "USDG", decimals() == 6.
 *
 * On 2026-11-04, eth_call against that mainnet RPC showed:
 * - SwapRouter02.factory() == UniswapV3Factory
 * - SwapRouter02.WETH9() == the L2 WETH above
 * - QuoterV2.factory() == the same factory
 * - bytecode present at factory, router, and quoter
 * Testnet (chain 46630) has the documented WETH and no bytecode at the mainnet router,
 * quoter, or factory. There is no official testnet Uniswap address list. Do not invent one.
 */
export const ROBINHOOD_MAINNET = {
  chainId: 4663,
  name: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  factory: getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
  swapRouter02: getAddress("0xcaf681a66d020601342297493863e78c959e5cb2"),
  quoterV2: getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  usdg: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
} as const;

export const ROBINHOOD_TESTNET = {
  chainId: 46630,
  name: "Robinhood Chain Testnet",
  rpc: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  /** Official L2 WETH. Not a Uniswap contract. */
  weth: getAddress("0x7943e237c7F95DA44E0301572D358911207852Fa"),
} as const;

/** Fee tiers SwapRouter02 / QuoterV2 understand. The executor tries each and keeps the best quote. */
export const V3_FEES = [100, 500, 3000, 10_000] as const;

export const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

export const swapRouter02Abi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

/** Strip 32-byte hex secrets from an error string. Addresses (20 bytes) stay. */
export function redactSecrets(message: string): string {
  return message.replace(/0x[0-9a-fA-F]{64}\b/g, "0x[redacted]");
}

/** Convert a positive decimal to integer units without going through a float multiply. */
export function decimalToUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Amount must be a positive finite number.");
  const fixed = value.toFixed(decimals);
  const [whole, frac = ""] = fixed.split(".");
  if (!whole || whole.startsWith("-")) throw new Error("Amount must be positive.");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0").slice(0, decimals));
}

export function unitsToNumber(amount: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;
  const text = `${whole}.${frac.toString().padStart(decimals, "0")}`;
  return Number(text);
}

/** amountOut * (1 - slippage). Refuses a floor of zero and a slippage outside 0..9999 bps. */
export function amountOutMinimum(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error("Slippage must be an integer number of basis points from 0 to 9999.");
  }
  const min = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (min <= 0n) throw new Error("Slippage leaves a zero minimum output. Refusing the swap.");
  return min;
}

const MAX_UINT256 = 2n ** 256n - 1n;

export function assertExactApproval(amount: bigint): void {
  if (amount <= 0n) throw new Error("Approval amount must be positive.");
  if (amount >= MAX_UINT256) throw new Error("Refusing an unlimited token approval.");
}
