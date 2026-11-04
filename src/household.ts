import type { HaeloConfig } from "./policy/schema.js";
import type { Fill, HouseholdAccount, OrderIntent } from "./types.js";

export type CheckLevel = "info" | "warn" | "block";

export interface PreflightCheck {
  code: string;
  level: CheckLevel;
  message: string;
}

const DAY_MS = 86_400_000;

export interface HouseholdInput {
  config: HaeloConfig;
  intent: OrderIntent;
  notionalUsd: number | undefined;
  /** Price used to value the order and judge gain or loss on a sell. */
  refPrice: number | undefined;
  accounts: HouseholdAccount[];
  now: Date;
}

/**
 * Household-aware preflight. These checks use data from every account the login can read, not just the
 * agent account. They are warnings and optional blocks, NOT tax advice: wash-sale rules have exceptions
 * and apply per taxpayer, and this code only sees the accounts the broker exposes.
 *
 * Limits worth knowing: the "after" half of the 30-day wash-sale window is in the future, so for a sale at a
 * loss we can only warn about purchases already made; for a purchase we warn about losses already realised.
 */
export function householdChecks(input: HouseholdInput): PreflightCheck[] {
  const { config, intent, accounts, now } = input;
  const cfg = config.household;
  const out: PreflightCheck[] = [];
  if (!cfg.enabled) return out;
  const nowMs = now.getTime();
  const symbol = intent.symbol.toUpperCase();

  // Account wall.
  const agentAcct = accounts.find((a) => a.isAgentAccount);
  // (An order that names another account is refused by the gateway itself, even with household checks off.)
  if (config.agent.accountId && !intent.account && agentAcct && agentAcct.id !== config.agent.accountId) {
    out.push({ code: "account_wall", level: "block", message: "The configured agent account does not match the account this login trades in." });
  }

  // Concentration across the household.
  const totalEquity = accounts.reduce((s, a) => s + a.equity, 0);
  if (totalEquity > 0 && input.notionalUsd !== undefined) {
    const held = accounts.reduce((s, a) => s + a.positions.filter((p) => p.symbol.toUpperCase() === symbol).reduce((x, p) => x + p.marketValue, 0), 0);
    const after = intent.side === "buy" ? held + input.notionalUsd : Math.max(0, held - input.notionalUsd);
    const pct = (after / totalEquity) * 100;
    if (intent.side === "buy" && pct > cfg.concentration.maxPct) {
      out.push({
        code: "concentration",
        level: cfg.concentration.block ? "block" : "warn",
        message: `${symbol} would be ${pct.toFixed(1)}% of household equity across ${accounts.length} account(s), above the ${cfg.concentration.maxPct}% limit.`,
      });
    } else if (pct > cfg.concentration.maxPct * 0.8) {
      out.push({ code: "concentration_near", level: "info", message: `${symbol} would be ${pct.toFixed(1)}% of household equity.` });
    }
  }

  const washApplies = cfg.washSale.enabled && (intent.assetClass !== "crypto" || cfg.washSale.includeCrypto) && intent.assetClass !== "unknown";
  const windowMs = cfg.washSale.windowDays * DAY_MS;
  const allFills: Array<Fill & { account: string }> = accounts.flatMap((a) => a.fills.map((f) => ({ ...f, account: a.id })));
  const sameSymbol = allFills.filter((f) => f.symbol.toUpperCase() === symbol && nowMs - Date.parse(f.ts) <= windowMs && Date.parse(f.ts) <= nowMs);

  if (washApplies && intent.side === "buy") {
    const losses = realisedLossSells(accounts, symbol, nowMs, windowMs);
    if (losses.length > 0) {
      out.push({
        code: "wash_sale_rebuy",
        level: cfg.washSale.block ? "block" : "warn",
        message: `${symbol} was sold at a loss within the last ${cfg.washSale.windowDays} days (${losses.map((l) => `${l.account}: ${l.qty} @ ${l.price}`).join("; ")}). Buying again may disallow that loss (wash sale).`,
      });
    }
  }
  if (washApplies && intent.side === "sell" && input.refPrice !== undefined) {
    const cost = avgCost(accounts, symbol);
    const recentBuys = sameSymbol.filter((f) => f.side === "buy");
    if (cost !== undefined && input.refPrice < cost && recentBuys.length > 0) {
      out.push({
        code: "wash_sale_sell",
        level: cfg.washSale.block ? "block" : "warn",
        message: `Selling ${symbol} below average cost ($${input.refPrice.toFixed(2)} vs $${cost.toFixed(2)}) after buying it within ${cfg.washSale.windowDays} days. The loss may be disallowed. Do not repurchase for ${cfg.washSale.windowDays} days.`,
      });
    } else if (cost !== undefined && input.refPrice < cost) {
      out.push({
        code: "loss_sale_no_rebuy",
        level: "info",
        message: `This sale realises a loss on ${symbol}. Avoid repurchasing in any account for ${cfg.washSale.windowDays} days to keep the loss.`,
      });
    }
  }

  // Lot awareness: a sale at a gain on a lot close to the 1-year mark.
  if (intent.side === "sell") {
    const lots = accounts.flatMap((a) => a.lots ?? []).filter((l) => l.symbol.toUpperCase() === symbol);
    for (const lot of lots) {
      const ageDays = (nowMs - Date.parse(lot.acquiredAt)) / DAY_MS;
      const daysLeft = Math.ceil(365 - ageDays);
      if (daysLeft > 0 && daysLeft <= cfg.lots.warnDaysToLongTerm && input.refPrice !== undefined && input.refPrice > lot.costBasisPerShare) {
        out.push({
          code: "lot_short_term",
          level: "info",
          message: `A ${lot.qty}-share lot of ${symbol} bought ${lot.acquiredAt.slice(0, 10)} would be a short-term gain; it turns long-term in ${daysLeft} day(s).`,
        });
      }
    }
  }
  return out;
}

function realisedLossSells(accounts: HouseholdAccount[], symbol: string, nowMs: number, windowMs: number): Array<{ account: string; qty: number; price: number }> {
  const res: Array<{ account: string; qty: number; price: number }> = [];
  for (const a of accounts) {
    const buys = a.fills.filter((f) => f.symbol.toUpperCase() === symbol && f.side === "buy");
    const cost = buys.length ? buys.reduce((s, f) => s + f.price * f.qty, 0) / buys.reduce((s, f) => s + f.qty, 0) : undefined;
    const pos = a.positions.find((p) => p.symbol.toUpperCase() === symbol);
    const basis = cost ?? pos?.avgEntryPrice;
    for (const f of a.fills) {
      if (f.symbol.toUpperCase() !== symbol || f.side !== "sell") continue;
      const t = Date.parse(f.ts);
      if (t > nowMs || nowMs - t > windowMs) continue;
      if (basis !== undefined && f.price < basis) res.push({ account: a.id, qty: f.qty, price: f.price });
    }
  }
  return res;
}

function avgCost(accounts: HouseholdAccount[], symbol: string): number | undefined {
  let qty = 0;
  let cost = 0;
  for (const a of accounts) {
    for (const p of a.positions) {
      if (p.symbol.toUpperCase() === symbol && p.qty > 0) {
        qty += p.qty;
        cost += p.qty * p.avgEntryPrice;
      }
    }
  }
  return qty > 0 ? cost / qty : undefined;
}
