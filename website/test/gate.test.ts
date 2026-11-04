import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/policy/load.js";
import { gateOrder } from "../src/chain/gate.js";

const yaml = `version: 1
broker: { type: robinhood-chain }
live: { enabled: true }
rails:
  maxOrderUsd: 100
  maxDailyUsd: 200
  maxSlippageBps: 50
  allowSymbols: [WETH/USDG]
  allowAssetClasses: [crypto]
`;

const usage = { ordersToday: 0, notionalToday: 0, recentOrderTimes: [], lastOrderBySymbol: {} };

describe("client policy gate", () => {
  const config = parseConfig(yaml);

  it("blocks an order over the cap before any wallet prompt", () => {
    const result = gateOrder({
      config,
      rung: "micro",
      symbol: "WETH/USDG",
      side: "buy",
      notionalUsd: 500,
      slippageBps: 30,
      usage,
      nowMs: Date.now(),
      live: true,
      fundsAck: true,
      chainId: 4663,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/per-order cap|exceeds/);
  });

  it("blocks a token that is not on the allow list", () => {
    const result = gateOrder({
      config,
      rung: "shadow",
      symbol: "DOGE/USDG",
      side: "buy",
      notionalUsd: 10,
      slippageBps: 30,
      usage,
      nowMs: Date.now(),
      live: false,
      fundsAck: false,
      chainId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/allow list/);
  });

  it("blocks live sends until the real-funds toggle and the right chain", () => {
    const base = {
      config,
      rung: "micro" as const,
      symbol: "WETH/USDG",
      side: "buy" as const,
      notionalUsd: 10,
      slippageBps: 30,
      usage,
      nowMs: Date.now(),
      live: true,
    };
    expect(gateOrder({ ...base, fundsAck: false, chainId: 4663 }).reason).toMatch(/real funds/);
    expect(gateOrder({ ...base, fundsAck: true, chainId: 1 }).reason).toMatch(/4663/);
    expect(gateOrder({ ...base, fundsAck: true, chainId: 4663 }).ok).toBe(true);
  });

  it("lets shadow pass without a wallet", () => {
    const result = gateOrder({
      config,
      rung: "shadow",
      symbol: "WETH/USDG",
      side: "buy",
      notionalUsd: 10,
      slippageBps: 30,
      usage,
      nowMs: Date.now(),
      live: false,
      fundsAck: false,
      chainId: null,
    });
    expect(result.ok).toBe(true);
  });
});
