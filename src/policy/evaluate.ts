import type { LeashConfig, Rails } from "./schema.js";
import type { OrderIntent, Rung } from "../types.js";

/** Counters the evaluator needs. Supplied by the caller so evaluation stays a pure function. */
export interface UsageSnapshot {
  ordersToday: number;
  notionalToday: number;
  /** Epoch ms of recent accepted orders. */
  recentOrderTimes: number[];
  /** Epoch ms of the last accepted order per symbol. */
  lastOrderBySymbol: Record<string, number>;
}

export interface EvalInput {
  config: LeashConfig;
  rung: Rung;
  intent: OrderIntent;
  /** Order value in USD. Undefined means it could not be sized, which is refused. */
  notionalUsd: number | undefined;
  usage: UsageSnapshot;
  nowMs: number;
  /** Current position quantity in the order's symbol (agent account), if known. */
  positionQty?: number;
}

export type ViolationKind = "breach" | "soft";

export interface Violation {
  code: string;
  kind: ViolationKind;
  message: string;
}

export interface EvalResult {
  verdict: "allow" | "block";
  violations: Violation[];
  effectiveRails: Rails;
}

/** Rails for a rung: the standard rails, tightened (never loosened) by the rung's overrides. */
export function effectiveRails(config: LeashConfig, rung: Rung): Rails {
  const base = config.rails;
  const ov = rung === "standard" ? {} : (config.rungs[rung] ?? {});
  const minDef = (a: number, b: number | undefined): number => (b === undefined ? a : Math.min(a, b));
  const allow =
    "allowSymbols" in ov && ov.allowSymbols && ov.allowSymbols.length > 0
      ? base.allowSymbols.length > 0
        ? ov.allowSymbols.filter((s) => base.allowSymbols.includes(s))
        : ov.allowSymbols
      : base.allowSymbols;
  return {
    ...base,
    maxOrderUsd: minDef(base.maxOrderUsd, ov.maxOrderUsd),
    maxDailyUsd: minDef(base.maxDailyUsd, ov.maxDailyUsd),
    maxOrdersPerDay: minDef(base.maxOrdersPerDay, ov.maxOrdersPerDay),
    maxOrdersPerMinute: minDef(base.maxOrdersPerMinute, ov.maxOrdersPerMinute),
    maxPositionPct: minDef(base.maxPositionPct, ov.maxPositionPct),
    allowSymbols: allow,
  };
}

const norm = (s: string): string => s.trim().toUpperCase();

/**
 * Pure policy evaluation. No I/O, no clock, no randomness: the same input always yields the same verdict.
 * Every rule fails closed. An order that cannot be sized, or whose symbol is empty, is refused.
 */
export function evaluateOrder(input: EvalInput): EvalResult {
  const { config, rung, intent, notionalUsd, usage, nowMs } = input;
  const rails = effectiveRails(config, rung);
  const v: Violation[] = [];
  const add = (code: string, kind: ViolationKind, message: string): void => {
    v.push({ code, kind, message });
  };

  const symbol = norm(intent.symbol);
  if (!symbol) add("no_symbol", "soft", "Order has no symbol.");

  if (!rails.allowAssetClasses.includes(intent.assetClass as "equity" | "crypto" | "option")) {
    add("asset_class_not_allowed", "breach", `Asset class "${intent.assetClass}" is not allowed by policy.`);
  }
  if (!rails.allowOrderTypes.includes(intent.type)) {
    add("order_type_not_allowed", "breach", `Order type "${intent.type}" is not allowed by policy.`);
  }

  const blocked = rails.blockSymbols.map(norm);
  if (symbol && blocked.includes(symbol)) add("symbol_blocked", "breach", `${symbol} is on the block list.`);
  const allowed = rails.allowSymbols.map(norm);
  if (symbol && allowed.length > 0 && !allowed.includes(symbol)) {
    add("symbol_not_allowed", "breach", `${symbol} is not on the allow list for the ${rung} rung.`);
  }

  if (notionalUsd === undefined || !Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    add("unsizable", "soft", "Order value could not be determined, so it is refused (fail closed).");
  } else {
    if (notionalUsd > rails.maxOrderUsd) {
      add("max_order_usd", "breach", `Order value $${notionalUsd.toFixed(2)} exceeds the $${rails.maxOrderUsd} per-order cap at the ${rung} rung.`);
    }
    if (usage.notionalToday + notionalUsd > rails.maxDailyUsd) {
      add(
        "max_daily_usd",
        "breach",
        `Order would take today's total to $${(usage.notionalToday + notionalUsd).toFixed(2)}, over the $${rails.maxDailyUsd} daily cap.`,
      );
    }
  }

  if (usage.ordersToday + 1 > rails.maxOrdersPerDay) {
    add("max_orders_per_day", "breach", `Daily order count cap of ${rails.maxOrdersPerDay} reached.`);
  }
  const lastMinute = usage.recentOrderTimes.filter((t) => nowMs - t < 60_000).length;
  if (lastMinute + 1 > rails.maxOrdersPerMinute) {
    add("rate_limit", "soft", `More than ${rails.maxOrdersPerMinute} orders in one minute.`);
  }
  if (rails.symbolCooldownSeconds > 0 && symbol) {
    const last = usage.lastOrderBySymbol[symbol];
    if (last !== undefined && nowMs - last < rails.symbolCooldownSeconds * 1000) {
      add("symbol_cooldown", "soft", `${symbol} is in a ${rails.symbolCooldownSeconds}s cooldown.`);
    }
  }

  if (intent.side === "sell" && !rails.allowShort) {
    const held = input.positionQty;
    const qty = intent.qty;
    if (held === undefined) {
      add("position_unknown", "soft", "Sell refused: current position is unknown and short selling is not allowed.");
    } else if (qty !== undefined && qty > held + 1e-9) {
      add("short_not_allowed", "breach", `Selling ${qty} ${symbol} but only ${held} held, and short selling is not allowed.`);
    } else if (qty === undefined && held <= 0) {
      add("short_not_allowed", "breach", `No ${symbol} position to sell, and short selling is not allowed.`);
    }
  }

  return { verdict: v.length === 0 ? "allow" : "block", violations: v, effectiveRails: rails };
}

export function isBreach(r: EvalResult): boolean {
  return r.violations.some((x) => x.kind === "breach");
}
