import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/policy/load.js";
import { gateOrder, type GateInput } from "../src/solana/gate.js";

const usage = { ordersToday: 0, notionalToday: 0, recentOrderTimes: [], lastOrderBySymbol: {} };
const live = parseConfig("version: 1\nbroker: { type: solana }\nlive: { enabled: true }\nrails: { maxOrderUsd: 100, allowSymbols: [SOL/USDC], maxSlippageBps: 100 }\nladder: { start: micro }\n");
const off = parseConfig("version: 1\nbroker: { type: solana }\nrails: { maxOrderUsd: 100 }\n");
const base: GateInput = { config: live, rung: "micro", symbol: "SOL/USDC", side: "buy", notionalUsd: 20, slippageBps: 50, usage, nowMs: Date.now(), live: true, fundsAck: true, walletConnected: true };

describe("browser policy gate", () => {
  it("passes a small live swap on the allow-list with a connected wallet", () => {
    expect(gateOrder(base).ok).toBe(true);
  });
  it("blocks before any wallet prompt when the policy says no", () => {
    expect(gateOrder({ ...base, notionalUsd: 500 }).ok).toBe(false);
    expect(gateOrder({ ...base, symbol: "BONK/USDC" }).reason).toMatch(/allow/i);
    expect(gateOrder({ ...base, slippageBps: 500 }).ok).toBe(false);
  });
  it("needs live.enabled, the real-funds tick, and a wallet", () => {
    expect(gateOrder({ ...base, config: off, rung: "standard" }).reason).toContain("live.enabled");
    expect(gateOrder({ ...base, fundsAck: false }).reason).toContain("real funds");
    const r = gateOrder({ ...base, walletConnected: false });
    expect(r.ok).toBe(false);
    expect(r.needsWallet).toBe(true);
  });
  it("never needs a wallet below the live rungs", () => {
    expect(gateOrder({ ...base, live: false, walletConnected: false, fundsAck: false }).ok).toBe(true);
  });
});
