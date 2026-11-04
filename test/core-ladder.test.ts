import { afterEach, describe, expect, it } from "vitest";
import { solanaHarness, textOf, type Harness } from "./helpers/harness.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const buy = (symbol: string, usd: number, extra: Record<string, unknown> = {}) => ({ symbol, side: "buy", notional_usd: usd, confirm: true, ...extra });

describe("autonomy ladder on Solana (fake cluster and Jupiter)", () => {
  it("starts at shadow: swaps are simulated and never touch the chain", async () => {
    h = await solanaHarness();
    const r = await h.core.callTool("place_order", buy("SOL/USDC", 100));
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.["simulated"]).toBe(true);
    expect(r.structuredContent?.["status"]).toBe("filled");
    expect(h.executed()).toBe(0);
    expect(h.broker.placed).toHaveLength(0);
    // The agent sees its shadow account, not the broker's.
    const acct = await h.core.callTool("get_account");
    expect(acct.structuredContent?.["id"]).toBe("haelo-shadow");
    expect(Number(acct.structuredContent?.["cash"])).toBeCloseTo(9900, 0);
    const pos = await h.core.callTool("get_positions");
    expect((pos.structuredContent?.["positions"] as unknown[]).length).toBe(1);
  });

  it("refuses an order over the per-order cap, counts it as a breach and stays in shadow", async () => {
    h = await solanaHarness({ rails: { maxOrderUsd: 200 } });
    const r = await h.core.callTool("place_order", buy("SOL", 900));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("per-order cap");
    expect(h.core.status().stats.breaches).toBe(1);
    expect(h.core.status().rung).toBe("shadow");
  });

  it("enforces the daily cap across orders", async () => {
    h = await solanaHarness({ rails: { maxOrderUsd: 400, maxDailyUsd: 600 } });
    expect((await h.core.callTool("place_order", buy("SOL", 350))).isError).toBeFalsy();
    h.clock.advance(61_000);
    const r = await h.core.callTool("place_order", buy("SOL", 350));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("daily cap");
  });

  it("fails closed when the order cannot be understood or sized", async () => {
    h = await solanaHarness();
    const noSize = await h.core.callTool("place_order", { symbol: "SOL", side: "buy" });
    expect(noSize.isError).toBe(true);
    const both = await h.core.callTool("place_order", { symbol: "SOL", side: "buy", qty: 1, notional_usd: 100 });
    expect(both.isError).toBe(true);
    const unknownSymbol = await h.core.callTool("place_order", { symbol: "ZZZZ", side: "buy", qty: 1 });
    expect(unknownSymbol.isError).toBe(true);
  });

  it("will not let the agent short sell", async () => {
    h = await solanaHarness();
    const r = await h.core.callTool("place_order", { symbol: "SOL", side: "sell", qty: 5 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/short|position/i);
  });

  it("promotes only when criteria are met, then routes the paper rung through Jupiter without signing", async () => {
    h = await solanaHarness();
    // Not eligible yet: no time and no decisions.
    expect((await h.core.promote()).promoted).toBe(false);
    await h.core.callTool("place_order", buy("SOL", 50));
    h.clock.advance(61_000);
    await h.core.callTool("place_order", buy("JUP", 50));
    h.clock.days(2);
    const req = await h.core.callTool("haelo_request_promotion");
    expect(req.structuredContent?.["eligible"]).toBe(true);
    expect(req.structuredContent?.["auto_promoted"]).toBe(false); // the agent can ask, never promote
    expect(h.core.status().rung).toBe("shadow");
    const p = await h.core.promote();
    expect(p.promoted).toBe(true);
    expect(h.core.status().rung).toBe("paper");

    const r = await h.core.callTool("place_order", buy("SOL", 75));
    expect(r.isError).toBeFalsy();
    expect(h.broker.orders("paper")).toHaveLength(1);
    expect(r.structuredContent?.["signed"]).toBe(false);
    expect(h.executed()).toBe(0);
  });

  it("holds orders for human approval at the propose rung and re-checks before sending live", async () => {
    h = await solanaHarness();
    await climbTo(h, "propose");
    const before = h.executed();
    const r = await h.core.callTool("place_order", buy("SOL", 120, { rationale: "momentum" }));
    expect(r.structuredContent?.["status"]).toBe("pending_approval");
    expect(h.executed()).toBe(before);
    const id = r.structuredContent?.["proposal_id"] as string;
    const polled = await h.core.callTool("haelo_get_proposal", { proposal_id: id });
    expect(polled.structuredContent?.["status"]).toBe("pending");
    const done = await h.core.approveProposal(id);
    expect(done.status).toBe("executed");
    expect(h.executed()).toBe(before + 1);
    const after = await h.core.callTool("haelo_get_proposal", { proposal_id: id });
    expect(after.structuredContent?.["status"]).toBe("executed");
  });

  it("expires proposals and refuses to approve them late", async () => {
    h = await solanaHarness({ approvals: { ttlSeconds: 60 } });
    await climbTo(h, "propose");
    const before = h.executed();
    const r = await h.core.callTool("place_order", buy("SOL", 100));
    const id = r.structuredContent?.["proposal_id"] as string;
    h.clock.advance(120_000);
    await expect(h.core.approveProposal(id)).rejects.toThrow(/expired/);
    expect(h.executed()).toBe(before);
  });

  it("declined proposals never execute", async () => {
    h = await solanaHarness();
    await climbTo(h, "propose");
    const before = h.executed();
    const r = await h.core.callTool("place_order", buy("SOL", 100));
    const id = r.structuredContent?.["proposal_id"] as string;
    await h.core.declineProposal(id);
    await expect(h.core.approveProposal(id)).rejects.toThrow(/declined/);
    expect(h.executed()).toBe(before);
  });

  it("applies micro-rung caps, which are tighter than standard", async () => {
    h = await solanaHarness({ rungs: { micro: { maxOrderUsd: 25 } } });
    await climbTo(h, "micro");
    const big = await h.core.callTool("place_order", buy("SOL", 100));
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain("$25");
    // A breach at micro demotes (to shadow by default).
    expect(h.core.status().rung).toBe("shadow");
  });

  it("signs and sends at micro under the cap, then demotes on a breach", async () => {
    h = await solanaHarness({ rungs: { micro: { maxOrderUsd: 25 } }, ladder: { demotion: { onBreach: "propose" } } });
    await climbTo(h, "micro");
    const before = h.executed();
    h.clock.advance(61_000);
    const ok = await h.core.callTool("place_order", buy("SOL", 20));
    expect(ok.isError).toBeFalsy();
    expect(String(ok.structuredContent?.["signature"])).not.toBe("");
    expect(h.executed()).toBe(before + 1);
    const bad = await h.core.callTool("place_order", buy("SOL", 500));
    expect(bad.isError).toBe(true);
    expect(h.core.status().rung).toBe("propose");
    expect(h.core.status().frozenUntil).toBeDefined();
    // Promotion is frozen during the cooldown even if criteria were met.
    expect((await h.core.promote()).promoted).toBe(false);
  });

  it("demotes automatically on drawdown of the live wallet", async () => {
    h = await solanaHarness({ ladder: { drawdown: { maxPct: 5 } } });
    await climbTo(h, "micro");
    expect(h.core.status().rung).toBe("micro");
    h.clock.advance(61_000);
    await h.core.callTool("place_order", buy("SOL", 20)); // sets the high-water mark from live equity
    h.broker.equityOverride = 10_000; // ~10% below the high-water mark (10 SOL + 10,000 USDC)
    h.clock.advance(61_000);
    await h.core.callTool("place_order", buy("JUP", 10));
    expect(h.core.status().rung).toBe("propose"); // one rung down
    expect(h.core.audit.entries().some((e) => e.type === "drawdown_breach")).toBe(true);
  });

  it("refuses a live swap without confirm: true", async () => {
    h = await solanaHarness();
    await climbTo(h, "micro");
    const before = h.executed();
    h.clock.advance(61_000);
    const r = await h.core.callTool("place_order", { symbol: "SOL", side: "buy", notional_usd: 10 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("confirm: true");
    expect(h.executed()).toBe(before);
  });

  it("drops to shadow after repeated failed live sends", async () => {
    h = await solanaHarness({ broker: { maxConsecutiveErrors: 2 } });
    await climbTo(h, "micro");
    h.fake.state.failExecute = "blockhash expired";
    for (let i = 0; i < 2; i++) {
      h.clock.advance(61_000);
      await h.core.callTool("place_order", buy("SOL", 10));
    }
    expect(h.core.status().rung).toBe("shadow");
  });

  it("panic drops to shadow", async () => {
    h = await solanaHarness();
    await climbTo(h, "micro");
    const moved = await h.core.panic();
    expect(moved?.to).toBe("shadow");
  });

  it("has no tool the agent can use to promote, demote, approve or change policy", async () => {
    h = await solanaHarness();
    const names = h.core.toolDefs().map((t) => t.name);
    for (const banned of ["promote", "demote", "approve", "set_policy", "panic", "haelo_promote", "haelo_approve", "haelo_set_policy"]) {
      expect(names).not.toContain(banned);
    }
    const r = await h.core.callTool("haelo_promote");
    expect(r.isError).toBe(true);
  });

  it("blocks an order placed right after text that looks like an injection", async () => {
    h = await solanaHarness();
    await climbTo(h, "propose"); // demotion target one_rung so we can see it
    // Quotes carry no third-party text, so taint the session the way a poisoned tool result would.
    const session = h.core.session("default");
    session.taint.flaggedAtMs = h.clock.now().getTime();
    session.taint.callsSince = 0;
    session.taint.rules = ["ignore_previous"];
    const r = await h.core.callTool("place_order", buy("SOL", 50));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("injection");
    expect(h.core.status().rung).toBe("paper"); // propose -> one rung down
  });

  it("audit log is verifiable after all of this", async () => {
    h = await solanaHarness();
    await h.core.callTool("place_order", buy("SOL", 50));
    await h.core.callTool("place_order", buy("SOL", 5000));
    const v = h.core.audit.verify();
    expect(v.ok).toBe(true);
    expect(v.entries).toBeGreaterThanOrEqual(3);
  });
});

async function climbTo(h: Harness, target: "paper" | "propose" | "micro" | "standard"): Promise<void> {
  const order = ["shadow", "paper", "propose", "micro", "standard"];
  for (let guard = 0; guard < 6 && h.core.status().rung !== target; guard++) {
    const rung = h.core.status().rung;
    // Generate two decisions per rung, then wait out the minimum time.
    for (let i = 0; i < 2; i++) {
      h.clock.advance(61_000);
      const r = await h.core.callTool("place_order", { symbol: "SOL", side: "buy", notional_usd: 10, confirm: true });
      if (rung === "propose" && r.structuredContent?.["proposal_id"]) await h.core.approveProposal(r.structuredContent["proposal_id"] as string);
    }
    h.clock.days(2);
    const res = await h.core.promote();
    if (!res.promoted) throw new Error(`could not leave ${rung}: ${JSON.stringify(res.checks.filter((c) => !c.ok))}`);
    if (order.indexOf(h.core.status().rung) <= order.indexOf(rung)) throw new Error("did not climb");
  }
}
