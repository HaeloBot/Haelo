import { type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { erc20Abi, ROBINHOOD_MAINNET } from "../../../src/chain/uniswap.js";
import { publicChain } from "./quotes.js";
import { isUserRejected, type SwapPlan } from "./swap.js";

export interface SendOutcome {
  ok: boolean;
  hash?: Hex;
  reason: string;
}

async function broadcast(
  wallet: WalletClient,
  publicClient: PublicClient,
  account: Address,
  to: Address,
  data: Hex,
): Promise<Hex> {
  await publicClient.call({ to, data, account });
  const hash = await wallet.sendTransaction({ account, chain: wallet.chain, to, data, value: 0n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}

/**
 * Simulate, approve the exact amount if needed, then send the swap.
 * The caller has already passed the policy gate.
 */
export async function sendPlannedSwap(opts: {
  plan: SwapPlan;
  wallet: WalletClient;
  account: Address;
  publicClient?: PublicClient;
}): Promise<SendOutcome> {
  const client = opts.publicClient ?? publicChain;
  const chainId = await client.getChainId();
  if (chainId !== ROBINHOOD_MAINNET.chainId) {
    return { ok: false, reason: `Wallet is on chain ${chainId}. Switch to Robinhood Chain (${ROBINHOOD_MAINNET.chainId}).` };
  }
  try {
    const balance = await client.readContract({
      address: opts.plan.tokenIn,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [opts.account],
    });
    if (balance < opts.plan.amountIn) {
      return { ok: false, reason: "Insufficient token balance for this swap. Nothing was sent." };
    }
    const allowance = await client.readContract({
      address: opts.plan.tokenIn,
      abi: erc20Abi,
      functionName: "allowance",
      args: [opts.account, opts.plan.router],
    });
    if (allowance < opts.plan.amountIn) {
      await broadcast(opts.wallet, client, opts.account, opts.plan.tokenIn, opts.plan.approveData);
    }
    const hash = await broadcast(opts.wallet, client, opts.account, opts.plan.router, opts.plan.swapData);
    return { ok: true, hash, reason: "Swap confirmed." };
  } catch (error) {
    if (isUserRejected(error)) return { ok: false, reason: "The wallet rejected the signature. Nothing was sent." };
    const message = error instanceof Error ? error.message : String(error);
    if (/reverted/i.test(message)) return { ok: false, reason: message };
    return { ok: false, reason: message };
  }
}
