import { evaluateOrder, type UsageSnapshot } from "../../../src/policy/evaluate.js";
import type { HaeloConfig } from "../../../src/policy/schema.js";
import type { Rung, Side } from "../../../src/types.js";

export interface GateInput {
  config: HaeloConfig;
  rung: Rung;
  symbol: string;
  side: Side;
  notionalUsd: number;
  slippageBps: number;
  usage: UsageSnapshot;
  nowMs: number;
  /** True when this order would be signed by the connected wallet. */
  live: boolean;
  fundsAck: boolean;
  walletConnected: boolean;
}

export interface GateResult {
  ok: boolean;
  reason: string;
  /** The policy passed but a wallet still has to be connected. */
  needsWallet?: boolean;
}

/**
 * Client-side gate, the same evaluator the CLI uses. Call it before any wallet prompt.
 * A block returns the reason and must not open a signature request.
 */
export function gateOrder(input: GateInput): GateResult {
  const symbol = input.symbol.trim().toUpperCase();
  const evaluated = evaluateOrder({
    config: input.config,
    rung: input.rung,
    intent: { symbol, side: input.side, type: "market", notionalUsd: input.notionalUsd, assetClass: "crypto", slippageBps: input.slippageBps },
    notionalUsd: input.notionalUsd,
    usage: input.usage,
    nowMs: input.nowMs,
  });
  if (evaluated.verdict === "block") return { ok: false, reason: evaluated.violations[0]?.message ?? "Policy blocked the order." };
  if (!input.live) return { ok: true, reason: "Shadow or paper. Nothing will be signed." };
  if (!input.config.live.enabled) return { ok: false, reason: "Live trading is disabled in the policy (live.enabled: false). Nothing was sent." };
  if (!input.fundsAck) return { ok: false, reason: "Tick I understand this uses real funds. Nothing was sent." };
  if (input.slippageBps > input.config.rails.maxSlippageBps) {
    return { ok: false, reason: `Slippage ${input.slippageBps} bps exceeds the ${input.config.rails.maxSlippageBps} bps cap.` };
  }
  if (!input.walletConnected) return { ok: false, needsWallet: true, reason: "Policy passed. Connect a Solana wallet to sign. Nothing has been signed." };
  return { ok: true, reason: "Policy passed. Your wallet may sign this swap." };
}
