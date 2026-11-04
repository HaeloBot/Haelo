import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateOrder, effectiveRails, type UsageSnapshot } from "../src/policy/evaluate.js";
import { parseConfig } from "../src/policy/load.js";
import type { OrderIntent, Rung } from "../src/types.js";

const cfg = (extra: Record<string, unknown> = {}) => parseConfig(JSON.stringify({ version: 1, broker: { type: "alpaca" }, ...extra }));
const usage = (u: Partial<UsageSnapshot> = {}): UsageSnapshot => ({ ordersToday: 0, notionalToday: 0, recentOrderTimes: [], lastOrderBySymbol: {}, ...u });
const buy = (o: Partial<OrderIntent> = {}): OrderIntent => ({ symbol: "AAPL", side: "buy", type: "market", assetClass: "equity", ...o });
const NOW = 1_000_000_000_000;

describe("evaluateOrder", () => {
  it("allows a small, well-formed order", () => {
    const r = evaluateOrder({ config: cfg(), rung: "standard", intent: buy(), notionalUsd: 100, usage: usage(), nowMs: NOW });
    expect(r.verdict).toBe("allow");
  });

  it("refuses an order whose size is unknown (fail closed)", () => {
    const r = evaluateOrder({ config: cfg(), rung: "standard", intent: buy(), notionalUsd: undefined, usage: usage(), nowMs: NOW });
    expect(r.verdict).toBe("block");
    expect(r.violations.map((v) => v.code)).toContain("unsizable");
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY * 0])("refuses a non-positive or NaN notional (%s)", (n) => {
    const r = evaluateOrder({ config: cfg(), rung: "standard", intent: buy(), notionalUsd: n, usage: usage(), nowMs: NOW });
    expect(r.verdict).toBe("block");
  });

  it("enforces block and allow lists case-insensitively", () => {
    const c = cfg({ rails: { blockSymbols: ["gme"], allowSymbols: ["AAPL", "gme", "MSFT"] } });
    expect(evaluateOrder({ config: c, rung: "standard", intent: buy({ symbol: "GME" }), notionalUsd: 10, usage: usage(), nowMs: NOW }).violations.map((v) => v.code)).toContain("symbol_blocked");
    expect(evaluateOrder({ config: c, rung: "standard", intent: buy({ symbol: "TSLA" }), notionalUsd: 10, usage: usage(), nowMs: NOW }).violations.map((v) => v.code)).toContain("symbol_not_allowed");
    expect(evaluateOrder({ config: c, rung: "standard", intent: buy({ symbol: "msft" }), notionalUsd: 10, usage: usage(), nowMs: NOW }).verdict).toBe("allow");
  });

  it("rate limits and cools down per symbol", () => {
    const c = cfg({ rails: { maxOrdersPerMinute: 2, symbolCooldownSeconds: 30 } });
    const recent = usage({ recentOrderTimes: [NOW - 5000, NOW - 10_000], lastOrderBySymbol: { AAPL: NOW - 10_000 } });
    const codes = evaluateOrder({ config: c, rung: "standard", intent: buy(), notionalUsd: 10, usage: recent, nowMs: NOW }).violations.map((v) => v.code);
    expect(codes).toContain("rate_limit");
    expect(codes).toContain("symbol_cooldown");
    // These are soft violations: they do not count as hard breaches.
    expect(evaluateOrder({ config: c, rung: "standard", intent: buy(), notionalUsd: 10, usage: recent, nowMs: NOW }).violations.every((v) => v.kind === "soft")).toBe(true);
  });

  it("blocks selling more than held when shorting is off, and when position is unknown", () => {
    const c = cfg();
    const sell = buy({ side: "sell", qty: 5 });
    expect(evaluateOrder({ config: c, rung: "standard", intent: sell, notionalUsd: 100, usage: usage(), nowMs: NOW, positionQty: 2 }).violations.map((v) => v.code)).toContain("short_not_allowed");
    expect(evaluateOrder({ config: c, rung: "standard", intent: sell, notionalUsd: 100, usage: usage(), nowMs: NOW }).violations.map((v) => v.code)).toContain("position_unknown");
    expect(evaluateOrder({ config: c, rung: "standard", intent: sell, notionalUsd: 100, usage: usage(), nowMs: NOW, positionQty: 5 }).verdict).toBe("allow");
    expect(evaluateOrder({ config: cfg({ rails: { allowShort: true } }), rung: "standard", intent: sell, notionalUsd: 100, usage: usage(), nowMs: NOW }).verdict).toBe("allow");
  });

  it("blocks options unless explicitly allowed", () => {
    const r = evaluateOrder({ config: cfg(), rung: "standard", intent: buy({ assetClass: "option" }), notionalUsd: 10, usage: usage(), nowMs: NOW });
    expect(r.violations.map((v) => v.code)).toContain("asset_class_not_allowed");
  });

  it("rung overrides only ever tighten the standard rails", () => {
    const c = cfg({ rails: { maxOrderUsd: 300 }, rungs: { micro: { maxOrderUsd: 1000, maxDailyUsd: 50 } } });
    const micro = effectiveRails(c, "micro");
    expect(micro.maxOrderUsd).toBe(300); // asked for 1000, capped at the standard rail
    expect(micro.maxDailyUsd).toBe(50);
    expect(effectiveRails(c, "standard").maxDailyUsd).toBe(2000);
  });

  it("micro allowlist is intersected with the global allowlist", () => {
    const c = cfg({ rails: { allowSymbols: ["AAPL", "MSFT"] }, rungs: { micro: { allowSymbols: ["MSFT", "TSLA"] } } });
    expect(effectiveRails(c, "micro").allowSymbols).toEqual(["MSFT"]);
  });
});

describe("property tests", () => {
  const rungs: Rung[] = ["shadow", "paper", "propose", "micro", "standard"];

  it("no order above the per-order cap ever passes, on any rung", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...rungs),
        fc.double({ min: 0.01, max: 1e7, noNaN: true }),
        fc.double({ min: 1, max: 5000, noNaN: true }),
        (rung, notional, cap) => {
          const c = cfg({ rails: { maxOrderUsd: cap, maxDailyUsd: 1e9 } });
          const r = evaluateOrder({ config: c, rung, intent: buy(), notionalUsd: notional, usage: usage(), nowMs: NOW });
          const rail = effectiveRails(c, rung).maxOrderUsd;
          if (notional > rail) expect(r.verdict).toBe("block");
        },
      ),
      { numRuns: 500 },
    );
  });

  it("the daily total can never be pushed over the daily cap", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 5000, noNaN: true }), fc.double({ min: 0.01, max: 5000, noNaN: true }), (already, next) => {
        const c = cfg({ rails: { maxOrderUsd: 1e9, maxDailyUsd: 2000 } });
        const r = evaluateOrder({ config: c, rung: "standard", intent: buy(), notionalUsd: next, usage: usage({ notionalToday: already }), nowMs: NOW });
        if (already + next > 2000) expect(r.verdict).toBe("block");
      }),
      { numRuns: 500 },
    );
  });

  it("evaluation is deterministic", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 1000, noNaN: true }), (n) => {
        const args = { config: cfg(), rung: "micro" as const, intent: buy(), notionalUsd: n, usage: usage(), nowMs: NOW };
        expect(JSON.stringify(evaluateOrder(args))).toBe(JSON.stringify(evaluateOrder(args)));
      }),
    );
  });
});

describe("config validation", () => {
  it("rejects unknown broker types and bad numbers with readable errors", () => {
    expect(() => parseConfig("version: 1\nbroker: { type: nope }")).toThrow(/Invalid leash config/);
    expect(() => parseConfig(JSON.stringify({ version: 1, broker: { type: "alpaca" }, rails: { maxOrderUsd: -1 } }))).toThrow(/maxOrderUsd/);
  });
  it("requires exactly one of url or command for an upstream", () => {
    expect(() => parseConfig("version: 1\nbroker: { type: mcp-upstream }")).toThrow(/url.*command/);
    expect(() => parseConfig("version: 1\nbroker: { type: mcp-upstream, url: 'http://x.test', command: node }")).toThrow(/only one/);
  });
});
