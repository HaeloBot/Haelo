import { evaluateOrder, type UsageSnapshot } from "../../../src/policy/evaluate.js";
import type { HaeloConfig } from "../../../src/policy/schema.js";
import type { Rung, Side } from "../../../src/types.js";
import { ROBINHOOD_MAINNET } from "../../../src/chain/uniswap.js";

export interface GateInput {
  config: HaeloConfig;
  rung: Rung;
  symbol: string;
  side: Side;
  notionalUsd: number;
  slippageBps: number;
  usage: UsageSnapshot;
  nowMs: number;
  /** True when this order would be broadcast by the connected wallet. */
  live: boolean;
  fundsAck: boolean;
  chainId: number | null;
}

export interface GateResult {
  ok: boolean;
  reason: string;
}

/**
 * Client-side gate. Call this before any wallet prompt.
 * A block returns the reason and must not open a signature request.
 */
export function gateOrder(input: GateInput): GateResult {
  const symbol = input.symbol.trim().toUpperCase();
  const evaluated = evaluateOrder({
    config: input.config,
    rung: input.rung,
    intent: {
      symbol,
      side: input.side,
      type: "market",
      notionalUsd: input.notionalUsd,
      assetClass: "crypto",
      slippageBps: input.slippageBps,
    },
    notionalUsd: input.notionalUsd,
    usage: input.usage,
    nowMs: input.nowMs,
  });
  if (evaluated.verdict === "block") {
    return { ok: false, reason: evaluated.violations[0]?.message ?? "Policy blocked the order." };
  }
  if (!input.live) return { ok: true, reason: "Shadow or paper. Nothing will be signed." };
  if (!input.config.live.enabled) {
    return { ok: false, reason: "Live trading is disabled in the policy (live.enabled: false). Nothing was sent." };
  }
  if (!input.fundsAck) {
    return { ok: false, reason: "Tick I understand this uses real funds. Nothing was sent." };
  }
  if (input.chainId !== ROBINHOOD_MAINNET.chainId) {
    return { ok: false, reason: `Switch the wallet to Robinhood Chain (${ROBINHOOD_MAINNET.chainId}) before signing.` };
  }
  if (input.slippageBps > input.config.rails.maxSlippageBps) {
    return { ok: false, reason: `Slippage ${input.slippageBps} bps exceeds the ${input.config.rails.maxSlippageBps} bps cap.` };
  }
  return { ok: true, reason: "Policy passed. The wallet may sign this swap." };
}
