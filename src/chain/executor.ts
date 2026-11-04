import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { BrokerError } from "../adapters/types.js";
import { errorMessage } from "../util.js";
import type { ExternalSigner } from "./signer.js";
import {
  ROBINHOOD_MAINNET,
  V3_FEES,
  amountOutMinimum,
  assertExactApproval,
  erc20Abi,
  quoterV2Abi,
  redactSecrets,
  swapRouter02Abi,
} from "./uniswap.js";

export interface QuoteSingle {
  fee: number;
  amountOut: bigint;
}

export interface SwapRequest {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
  recipient: Address;
  deadline: bigint;
}

export interface ChainReader {
  getChainId(): Promise<number>;
  getBytecode(address: Address): Promise<Hex | undefined>;
  quoteExactInputSingle(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  balanceOf(token: Address, owner: Address): Promise<bigint>;
  decimals(token: Address): Promise<number>;
  symbol(token: Address): Promise<string>;
  ethBalance(owner: Address): Promise<bigint>;
  /** eth_call the swap or approval. Throws if the node rejects it. Does not broadcast. */
  simulate(to: Address, data: Hex, account: Address): Promise<void>;
}

export interface ChainSender {
  readonly address: Address;
  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
  wait(hash: Hex): Promise<{ status: "success" | "reverted"; transactionHash: Hex; blockNumber: bigint }>;
}

const chain = defineChain({
  id: ROBINHOOD_MAINNET.chainId,
  name: ROBINHOOD_MAINNET.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_MAINNET.rpc] } },
  blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_MAINNET.explorer } },
});

function fail(e: unknown): never {
  throw new BrokerError(redactSecrets(errorMessage(e)));
}

/** viem public client. Reads and simulations only. */
export function viemReader(rpcUrl: string, chainId = ROBINHOOD_MAINNET.chainId): ChainReader {
  const client = createPublicClient({
    chain: { ...chain, id: chainId, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  }) as PublicClient;
  return {
    async getChainId() {
      return client.getChainId();
    },
    async getBytecode(address) {
      const code = await client.getBytecode({ address });
      return code;
    },
    async quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee) {
      try {
        const result = await client.simulateContract({
          address: ROBINHOOD_MAINNET.quoterV2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        return result.result[0];
      } catch (e) {
        fail(e);
      }
    },
    async allowance(token, owner, spender) {
      return client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    },
    async balanceOf(token, owner) {
      return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    },
    async decimals(token) {
      return client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    },
    async symbol(token) {
      return client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" });
    },
    async ethBalance(owner) {
      return client.getBalance({ address: owner });
    },
    async simulate(to, data, account) {
      try {
        await client.call({ to, data, account });
      } catch (e) {
        fail(e);
      }
    },
  };
}

export function viemSender(rpcUrl: string, account: PrivateKeyAccount, chainId = ROBINHOOD_MAINNET.chainId): ChainSender {
  const wallet = createWalletClient({
    account,
    chain: { ...chain, id: chainId, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  }) as WalletClient;
  const reader = createPublicClient({
    chain: { ...chain, id: chainId, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  }) as PublicClient;
  return {
    address: account.address,
    async send(tx) {
      try {
        return await wallet.sendTransaction({ account, chain: wallet.chain, to: tx.to, data: tx.data, value: tx.value ?? 0n });
      } catch (e) {
        fail(e);
      }
    },
    async wait(hash) {
      const receipt = await reader.waitForTransactionReceipt({ hash });
      return { status: receipt.status, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
    },
  };
}

export function externalSender(signer: ExternalSigner, wait: ChainSender["wait"]): ChainSender {
  return {
    address: signer.address,
    send: (tx) => signer.send(tx),
    wait,
  };
}

/** Best v3 quote across the standard fee tiers. Fails closed when every tier reverts. */
export async function bestQuote(reader: ChainReader, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<QuoteSingle> {
  let best: QuoteSingle | undefined;
  const errors: string[] = [];
  for (const fee of V3_FEES) {
    try {
      const amountOut = await reader.quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee);
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) best = { fee, amountOut };
    } catch (e) {
      errors.push(redactSecrets(errorMessage(e)));
    }
  }
  if (!best) throw new BrokerError(`No Uniswap v3 quote for this pair. ${errors[0] ?? "Every fee tier reverted."}`);
  return best;
}

export function encodeSwap(req: SwapRequest): Hex {
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        fee: req.fee,
        recipient: req.recipient,
        deadline: req.deadline,
        amountIn: req.amountIn,
        amountOutMinimum: req.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

export function encodeApprove(tokenSpender: Address, amount: bigint): Hex {
  assertExactApproval(amount);
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [tokenSpender, amount] });
}

export interface PreparedSwap {
  fee: number;
  amountIn: bigint;
  quotedOut: bigint;
  amountOutMinimum: bigint;
  approveTxHash?: Hex;
  swapTxHash: Hex;
}

/**
 * Quote, approve the exact amountIn (never unlimited), simulate, then broadcast.
 * The caller has already decided this is a live send.
 */
export async function executeSwap(opts: {
  reader: ChainReader;
  sender: ChainSender;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  deadline: bigint;
}): Promise<PreparedSwap> {
  const quote = await bestQuote(opts.reader, opts.tokenIn, opts.tokenOut, opts.amountIn);
  const minOut = amountOutMinimum(quote.amountOut, opts.slippageBps);
  const allowance = await opts.reader.allowance(opts.tokenIn, opts.sender.address, opts.router);
  let approveTxHash: Hex | undefined;
  if (allowance < opts.amountIn) {
    if (allowance > 0n) {
      // Some tokens refuse changing a non-zero allowance to another non-zero value.
      // Reset to zero first. Zero is not an unlimited grant; the following approval is the exact amountIn.
      const zeroData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [opts.router, 0n] });
      await opts.reader.simulate(opts.tokenIn, zeroData, opts.sender.address);
      const zeroHash = await opts.sender.send({ to: opts.tokenIn, data: zeroData });
      const zeroReceipt = await opts.sender.wait(zeroHash);
      if (zeroReceipt.status !== "success") throw new BrokerError(`Approval reset reverted: ${zeroHash}`);
    }
    const data = encodeApprove(opts.router, opts.amountIn);
    await opts.reader.simulate(opts.tokenIn, data, opts.sender.address);
    approveTxHash = await opts.sender.send({ to: opts.tokenIn, data });
    const receipt = await opts.sender.wait(approveTxHash);
    if (receipt.status !== "success") throw new BrokerError(`Exact approval reverted: ${approveTxHash}`);
  }
  const swap = encodeSwap({
    tokenIn: opts.tokenIn,
    tokenOut: opts.tokenOut,
    fee: quote.fee,
    amountIn: opts.amountIn,
    amountOutMinimum: minOut,
    recipient: opts.sender.address,
    deadline: opts.deadline,
  });
  await opts.reader.simulate(opts.router, swap, opts.sender.address);
  const swapTxHash = await opts.sender.send({ to: opts.router, data: swap });
  const receipt = await opts.sender.wait(swapTxHash);
  if (receipt.status !== "success") throw new BrokerError(`Swap reverted: ${swapTxHash}`);
  return { fee: quote.fee, amountIn: opts.amountIn, quotedOut: quote.amountOut, amountOutMinimum: minOut, ...(approveTxHash ? { approveTxHash } : {}), swapTxHash };
}
