import { describe, expect, it } from "vitest";
import { householdChecks } from "../src/household.js";
import { applyRungChange, availableRungs, demotionTarget, evaluatePromotion, initialState, nextRung, prevRung } from "../src/ladder.js";
import { parseConfig } from "../src/policy/load.js";
import { ShadowLedger, newShadowState } from "../src/shadow.js";
import type { HouseholdAccount, OrderIntent, Quote } from "../src/types.js";

const cfg = (extra: Record<string, unknown> = {}) => parseConfig(JSON.stringify({ version: 1, broker: { type: "solana" }, ...extra }));
const q = (symbol: string, bid: number, ask: number): Quote => ({ symbol, bid, ask, mid: (bid + ask) / 2, ts: "2026-11-04T00:00:00Z" });
const intent = (o: Partial<OrderIntent> = {}): OrderIntent => ({ symbol: "AAPL", side: "buy", type: "market", assetClass: "equity", ...o });

describe("ShadowLedger", () => {
  const c = cfg().shadow;
  it("fills market buys at ask plus slippage and tracks cash and positions", () => {
    const l = new ShadowLedger(newShadowState(10_000), c);
    const r = l.submit(intent({ qty: 10 }), q("AAPL", 99.9, 100.1));
    expect(r.order.status).toBe("filled");
    expect(r.order.filledAvgPrice).toBeCloseTo(100.1 * 1.0005, 6);
    expect(l.snapshot.positions["AAPL"]?.qty).toBe(10);
    expect(l.snapshot.cash).toBeCloseTo(10_000 - 10 * 100.1 * 1.0005, 4);
  });

  it("sells at bid minus slippage and realises P&L", () => {
    const l = new ShadowLedger(newShadowState(10_000), c);
    l.submit(intent({ qty: 10 }), q("AAPL", 99.9, 100.1));
    l.submit(intent({ side: "sell", qty: 10 }), q("AAPL", 109.9, 110.1));
    expect(l.snapshot.positions["AAPL"]).toBeUndefined();
    expect(l.snapshot.realizedPnl).toBeGreaterThan(90);
  });

  it("rejects buys without cash and sells without a position", () => {
    const l = new ShadowLedger(newShadowState(100), c);
    expect(l.submit(intent({ qty: 10 }), q("AAPL", 99.9, 100.1)).order.status).toBe("rejected");
    expect(l.submit(intent({ side: "sell", qty: 1 }), q("AAPL", 99.9, 100.1)).order.status).toBe("rejected");
  });

  it("rests non-marketable limit orders and fills them when the quote crosses", () => {
    const l = new ShadowLedger(newShadowState(10_000), c);
    const r = l.submit(intent({ type: "limit", qty: 1, limitPrice: 95 }), q("AAPL", 99.9, 100.1));
    expect(r.order.status).toBe("open");
    expect(l.mark({ AAPL: q("AAPL", 96, 97) })).toHaveLength(0);
    const filled = l.mark({ AAPL: q("AAPL", 94, 94.8) });
    expect(filled).toHaveLength(1);
    expect(filled[0]?.filledAvgPrice).toBeLessThanOrEqual(95);
    expect(l.snapshot.positions["AAPL"]?.qty).toBe(1);
  });

  it("cancels open orders and computes drawdown from the high-water mark", () => {
    const l = new ShadowLedger(newShadowState(10_000), c);
    l.submit(intent({ type: "limit", qty: 1, limitPrice: 50 }), q("AAPL", 99.9, 100.1));
    expect(l.cancelAll()).toBe(1);
    l.submit(intent({ qty: 50 }), q("AAPL", 99.9, 100.1));
    expect(l.drawdownPct({ AAPL: 100 }).pct).toBeLessThan(1);
    const d = l.drawdownPct({ AAPL: 50 });
    expect(d.pct).toBeGreaterThan(20);
    expect(d.hwm).toBeGreaterThan(9_900);
  });

  it("does not simulate stop orders, and says so", () => {
    const l = new ShadowLedger(newShadowState(10_000), c);
    const r = l.submit(intent({ type: "stop", qty: 1, stopPrice: 90 }), q("AAPL", 99.9, 100.1));
    expect(r.order.status).toBe("rejected");
    expect(r.rejection).toMatch(/does not simulate/);
  });
});

describe("ladder rules", () => {
  const NOW = new Date("2026-11-04T10:00:00Z");
  const base = () => {
    const c = cfg({ ladder: { criteria: { shadow: { minDays: 7, minDecisions: 5, maxInvalidRate: 0.2, maxBreaches: 0 } } } });
    const s = initialState(c, new Date(NOW.getTime() - 10 * 86_400_000));
    return { c, s };
  };

  it("brokers without paper skip the paper rung", () => {
    expect(availableRungs(false)).toEqual(["shadow", "propose", "micro", "standard"]);
    expect(nextRung("shadow", false)).toBe("propose");
    expect(nextRung("shadow", true)).toBe("paper");
    expect(prevRung("propose", false)).toBe("shadow");
    expect(prevRung("propose", true)).toBe("paper");
  });

  it("every criterion is individually necessary", () => {
    const { c, s } = base();
    s.ladder.stats.decisions = 10;
    s.ladder.stats.accepted = 10;
    expect(evaluatePromotion(c, s, true, NOW, { toolDrift: false }).eligible).toBe(true);
    const mutate = (f: (x: typeof s) => void) => {
      const copy = structuredClone(s);
      f(copy);
      return evaluatePromotion(c, copy, true, NOW, { toolDrift: false });
    };
    expect(mutate((x) => (x.ladder.stats.decisions = 3)).eligible).toBe(false);
    expect(mutate((x) => (x.ladder.stats.breaches = 1)).eligible).toBe(false);
    expect(mutate((x) => (x.ladder.stats.injectionFollows = 1)).eligible).toBe(false);
    expect(mutate((x) => (x.ladder.stats.invalid = 5)).eligible).toBe(false);
    expect(mutate((x) => (x.ladder.stats.drawdownPct = 50)).eligible).toBe(false);
    expect(mutate((x) => (x.ladder.stats.startedAt = new Date(NOW.getTime() - 86_400_000).toISOString())).eligible).toBe(false);
    expect(mutate((x) => (x.ladder.frozenUntil = new Date(NOW.getTime() + 3600_000).toISOString())).eligible).toBe(false);
    expect(mutate((x) => (x.drift = { detectedAt: "", hash: "", added: [], removed: [], changed: [] })).eligible).toBe(false);
  });

  it("the top rung has nothing to promote to", () => {
    const { c, s } = base();
    s.ladder.rung = "standard";
    const r = evaluatePromotion(c, s, true, NOW, { toolDrift: false });
    expect(r.eligible).toBe(false);
    expect(r.to).toBeUndefined();
  });

  it("demotion never moves an agent up, and honours configured targets", () => {
    const c = cfg({ ladder: { demotion: { onBreach: "propose", onDrawdown: "one_rung" } } });
    expect(demotionTarget(c, "micro", "breach", true)).toBe("propose");
    expect(demotionTarget(c, "shadow", "breach", true)).toBe("shadow");
    expect(demotionTarget(c, "paper", "breach", true)).toBe("paper"); // propose is higher: stay
    expect(demotionTarget(c, "standard", "drawdown", true)).toBe("micro");
    expect(demotionTarget(c, "micro", "panic", true)).toBe("shadow");
    expect(demotionTarget(cfg({ ladder: { demotion: { onToolDrift: "paper" } } }), "micro", "tool_drift", false)).toBe("shadow"); // no paper rung here
  });

  it("a rung change resets stats and records history; demotion freezes promotion", () => {
    const { c, s } = base();
    s.ladder.stats.decisions = 99;
    applyRungChange(s, "propose", "test", "human", NOW);
    expect(s.ladder.rung).toBe("propose");
    expect(s.ladder.stats.decisions).toBe(0);
    expect(s.ladder.history).toHaveLength(1);
    applyRungChange(s, "shadow", "breach", "auto", NOW, { freezeHours: 24 });
    expect(Date.parse(s.ladder.frozenUntil as string)).toBe(NOW.getTime() + 24 * 3_600_000);
    void c;
  });
});

describe("household preflight", () => {
  const NOW = new Date("2026-11-04T10:00:00Z");
  const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const acct = (o: Partial<HouseholdAccount> = {}): HouseholdAccount => ({ id: "A1", isAgentAccount: true, equity: 10_000, positions: [], fills: [], ...o });
  const run = (accounts: HouseholdAccount[], i: OrderIntent, extra: Record<string, unknown> = {}, notional = 500, ref = 100) =>
    householdChecks({ config: cfg(extra), intent: i, notionalUsd: notional, refPrice: ref, accounts, now: NOW });

  it("warns when rebuying a symbol sold at a loss in ANOTHER account within 30 days", () => {
    const retirement = acct({
      id: "IRA",
      isAgentAccount: false,
      fills: [
        { symbol: "AAPL", side: "buy", qty: 10, price: 120, ts: day(60), assetClass: "equity" },
        { symbol: "AAPL", side: "sell", qty: 10, price: 100, ts: day(10), assetClass: "equity" },
      ],
    });
    const checks = run([acct(), retirement], intent());
    expect(checks.map((c) => c.code)).toContain("wash_sale_rebuy");
    expect(checks.find((c) => c.code === "wash_sale_rebuy")?.level).toBe("warn");
  });

  it("does not warn when the loss was more than 30 days ago", () => {
    const old = acct({
      fills: [
        { symbol: "AAPL", side: "buy", qty: 10, price: 120, ts: day(90), assetClass: "equity" },
        { symbol: "AAPL", side: "sell", qty: 10, price: 100, ts: day(45), assetClass: "equity" },
      ],
    });
    expect(run([old], intent()).map((c) => c.code)).not.toContain("wash_sale_rebuy");
  });

  it("can block wash-sale rebuys when configured", () => {
    const a = acct({
      fills: [
        { symbol: "AAPL", side: "buy", qty: 10, price: 120, ts: day(60), assetClass: "equity" },
        { symbol: "AAPL", side: "sell", qty: 10, price: 100, ts: day(5), assetClass: "equity" },
      ],
    });
    expect(run([a], intent(), { household: { washSale: { block: true } } }).find((c) => c.code === "wash_sale_rebuy")?.level).toBe("block");
  });

  it("warns when selling below cost shortly after buying more", () => {
    const a = acct({
      positions: [{ symbol: "AAPL", qty: 10, avgEntryPrice: 150, marketValue: 1000, assetClass: "equity" }],
      fills: [{ symbol: "AAPL", side: "buy", qty: 5, price: 150, ts: day(7), assetClass: "equity" }],
    });
    expect(run([a], intent({ side: "sell", qty: 5 }), {}, 500, 100).map((c) => c.code)).toContain("wash_sale_sell");
  });

  it("does not apply wash-sale logic to crypto unless enabled (rule applicability is unverified)", () => {
    const a = acct({
      fills: [
        { symbol: "BTC/USD", side: "buy", qty: 1, price: 70_000, ts: day(60), assetClass: "crypto" },
        { symbol: "BTC/USD", side: "sell", qty: 1, price: 60_000, ts: day(5), assetClass: "crypto" },
      ],
    });
    const i = intent({ symbol: "BTC/USD", assetClass: "crypto" });
    expect(run([a], i).map((c) => c.code)).not.toContain("wash_sale_rebuy");
    expect(run([a], i, { household: { washSale: { includeCrypto: true } } }).map((c) => c.code)).toContain("wash_sale_rebuy");
  });

  it("blocks concentration counted across ALL accounts", () => {
    const main = acct({ equity: 5000 });
    const ira = acct({ id: "IRA", isAgentAccount: false, equity: 5000, positions: [{ symbol: "AAPL", qty: 20, avgEntryPrice: 100, marketValue: 2800, assetClass: "equity" }] });
    const checks = run([main, ira], intent(), { household: { concentration: { maxPct: 30, block: true } } }, 500, 100);
    expect(checks.find((c) => c.code === "concentration")?.level).toBe("block");
    // The same order against only the agent account looks fine, which is the blind spot being closed.
    expect(run([main], intent(), { household: { concentration: { maxPct: 30, block: true } } }, 500, 100).map((c) => c.code)).not.toContain("concentration");
  });

  it("blocks when the login's agent account is not the configured one", () => {
    const checks = run([acct({ id: "OTHER" })], intent(), { agent: { accountId: "A1" } });
    expect(checks.find((c) => c.code === "account_wall")?.level).toBe("block");
    expect(run([acct()], intent(), { agent: { accountId: "A1" } }).map((c) => c.code)).not.toContain("account_wall");
  });

  it("notes lots that are close to long-term treatment", () => {
    const a = acct({ lots: [{ symbol: "AAPL", qty: 4, costBasisPerShare: 80, acquiredAt: day(340) }], positions: [{ symbol: "AAPL", qty: 4, avgEntryPrice: 80, marketValue: 400, assetClass: "equity" }] });
    const checks = run([a], intent({ side: "sell", qty: 4 }), {}, 400, 100);
    const lot = checks.find((c) => c.code === "lot_short_term");
    expect(lot?.message).toMatch(/long-term in 25 day/);
  });

  it("does nothing when disabled", () => {
    expect(run([acct({ id: "X" })], intent(), { household: { enabled: false }, agent: { accountId: "A1" } })).toEqual([]);
  });
});
