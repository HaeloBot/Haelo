import { afterEach, describe, expect, it } from "vitest";
import { alpacaHarness, textOf, type Harness } from "./helpers/harness.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const buy = (symbol: string, usd: number, extra: Record<string, unknown> = {}) => ({ symbol, side: "buy", notional_usd: usd, ...extra });

describe("autonomy ladder on Alpaca (mock servers)", () => {
  it("starts at shadow: orders are simulated and never reach the broker", async () => {
    h = await alpacaHarness();
    const r = await h.core.callTool("place_order", buy("AAPL", 100));
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.["simulated"]).toBe(true);
    expect(r.structuredContent?.["status"]).toBe("filled");
    expect(h.live?.state.orders).toHaveLength(0);
    expect(h.paper?.state.orders).toHaveLength(0);
    // The agent sees its shadow account, not the broker's.
    const acct = await h.core.callTool("get_account");
    expect(acct.structuredContent?.["id"]).toBe("leash-shadow");
    expect(Number(acct.structuredContent?.["cash"])).toBeCloseTo(9900, 0);
    const pos = await h.core.callTool("get_positions");
    expect((pos.structuredContent?.["positions"] as unknown[]).length).toBe(1);
  });

  it("refuses an order over the per-order cap, counts it as a breach and stays in shadow", async () => {
    h = await alpacaHarness({ rails: { maxOrderUsd: 200 } });
    const r = await h.core.callTool("place_order", buy("AAPL", 900));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("per-order cap");
    expect(h.core.status().stats.breaches).toBe(1);
    expect(h.core.status().rung).toBe("shadow");
  });

  it("enforces the daily cap across orders", async () => {
    h = await alpacaHarness({ rails: { maxOrderUsd: 400, maxDailyUsd: 600 } });
    expect((await h.core.callTool("place_order", buy("AAPL", 350))).isError).toBeFalsy();
    h.clock.advance(61_000);
    const r = await h.core.callTool("place_order", buy("AAPL", 350));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("daily cap");
  });

  it("fails closed when the order cannot be understood or sized", async () => {
    h = await alpacaHarness();
    const noSize = await h.core.callTool("place_order", { symbol: "AAPL", side: "buy" });
    expect(noSize.isError).toBe(true);
    const both = await h.core.callTool("place_order", { symbol: "AAPL", side: "buy", qty: 1, notional_usd: 100 });
    expect(both.isError).toBe(true);
    const unknownSymbol = await h.core.callTool("place_order", { symbol: "ZZZZ", side: "buy", qty: 1 });
    expect(unknownSymbol.isError).toBe(true);
  });

  it("will not let the agent short sell", async () => {
    h = await alpacaHarness();
    const r = await h.core.callTool("place_order", { symbol: "AAPL", side: "sell", qty: 5 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/short|position/i);
  });

  it("promotes only when criteria are met, then routes the paper rung to the paper account", async () => {
    h = await alpacaHarness();
    // Not eligible yet: no time and no decisions.
    expect((await h.core.promote()).promoted).toBe(false);
    await h.core.callTool("place_order", buy("AAPL", 50));
    h.clock.advance(61_000);
    await h.core.callTool("place_order", buy("MSFT", 50));
    h.clock.days(2);
    const req = await h.core.callTool("leash_request_promotion");
    expect(req.structuredContent?.["eligible"]).toBe(true);
    expect(req.structuredContent?.["auto_promoted"]).toBe(false); // the agent can ask, never promote
    expect(h.core.status().rung).toBe("shadow");
    const p = await h.core.promote();
    expect(p.promoted).toBe(true);
    expect(h.core.status().rung).toBe("paper");

    const r = await h.core.callTool("place_order", buy("AAPL", 75));
    expect(r.isError).toBeFalsy();
    expect(h.paper?.state.orders).toHaveLength(1);
    expect(h.live?.state.orders).toHaveLength(0);
  });

  it("holds orders for human approval at the propose rung and re-checks before sending live", async () => {
    h = await alpacaHarness();
    await climbTo(h, "propose");
    const r = await h.core.callTool("place_order", buy("AAPL", 120, { rationale: "momentum" }));
    expect(r.structuredContent?.["status"]).toBe("pending_approval");
    expect(h.live?.state.orders).toHaveLength(0);
    const id = r.structuredContent?.["proposal_id"] as string;
    const polled = await h.core.callTool("leash_get_proposal", { proposal_id: id });
    expect(polled.structuredContent?.["status"]).toBe("pending");
    const done = await h.core.approveProposal(id);
    expect(done.status).toBe("executed");
    expect(h.live?.state.orders).toHaveLength(1);
    const after = await h.core.callTool("leash_get_proposal", { proposal_id: id });
    expect(after.structuredContent?.["status"]).toBe("executed");
  });

  it("expires proposals and refuses to approve them late", async () => {
    h = await alpacaHarness({ approvals: { ttlSeconds: 60 } });
    await climbTo(h, "propose");
    const r = await h.core.callTool("place_order", buy("AAPL", 100));
    const id = r.structuredContent?.["proposal_id"] as string;
    h.clock.advance(120_000);
    await expect(h.core.approveProposal(id)).rejects.toThrow(/expired/);
    expect(h.live?.state.orders).toHaveLength(0);
  });

  it("declined proposals never execute", async () => {
    h = await alpacaHarness();
    await climbTo(h, "propose");
    const r = await h.core.callTool("place_order", buy("AAPL", 100));
    const id = r.structuredContent?.["proposal_id"] as string;
    await h.core.declineProposal(id);
    await expect(h.core.approveProposal(id)).rejects.toThrow(/declined/);
    expect(h.live?.state.orders).toHaveLength(0);
  });

  it("applies micro-rung caps, which are tighter than standard", async () => {
    h = await alpacaHarness({ rungs: { micro: { maxOrderUsd: 25 } } });
    await climbTo(h, "micro");
    const big = await h.core.callTool("place_order", buy("AAPL", 100));
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain("$25");
    // A breach at micro demotes (to shadow by default).
    expect(h.core.status().rung).toBe("shadow");
  });

  it("goes live automatically at micro under the cap, then demotes on a breach", async () => {
    h = await alpacaHarness({ rungs: { micro: { maxOrderUsd: 25 } }, ladder: { demotion: { onBreach: "propose" } } });
    await climbTo(h, "micro");
    const before = h.live!.state.orders.length;
    h.clock.advance(61_000);
    const ok = await h.core.callTool("place_order", buy("AAPL", 20));
    expect(ok.isError).toBeFalsy();
    expect(h.live?.state.orders).toHaveLength(before + 1);
    const bad = await h.core.callTool("place_order", buy("AAPL", 500));
    expect(bad.isError).toBe(true);
    expect(h.core.status().rung).toBe("propose");
    expect(h.core.status().frozenUntil).toBeDefined();
    // Promotion is frozen during the cooldown even if criteria were met.
    expect((await h.core.promote()).promoted).toBe(false);
  });

  it("demotes automatically on drawdown and cancels open orders", async () => {
    h = await alpacaHarness({ ladder: { drawdown: { maxPct: 5 } } });
    await climbTo(h, "micro");
    expect(h.core.status().rung).toBe("micro");
    await h.core.callTool("place_order", buy("AAPL", 20)); // sets the high-water mark from live equity
    // A resting limit order that should be cancelled on demotion.
    await h.core.callTool("place_order", { symbol: "AAPL", side: "buy", type: "limit", qty: 0.05, limit_price: 100 });
    expect(h.live?.state.orders.some((o) => o.status === "new")).toBe(true);
    h.live!.state.equityOverride = 9_000; // ~10% below the high-water mark
    await h.core.callTool("place_order", buy("MSFT", 10));
    expect(h.core.status().rung).toBe("propose"); // one rung down
    expect(h.live?.state.orders.some((o) => o.status === "new")).toBe(false);
    expect(h.core.audit.entries().some((e) => e.type === "drawdown_breach")).toBe(true);
  });

  it("panic drops to shadow and cancels open orders", async () => {
    h = await alpacaHarness();
    await climbTo(h, "micro");
    await h.core.callTool("place_order", { symbol: "AAPL", side: "buy", type: "limit", qty: 0.05, limit_price: 100 });
    const moved = await h.core.panic();
    expect(moved?.to).toBe("shadow");
    expect(h.live?.state.orders.some((o) => o.status === "new")).toBe(false);
  });

  it("has no tool the agent can use to promote, demote, approve or change policy", async () => {
    h = await alpacaHarness();
    const names = h.core.toolDefs().map((t) => t.name);
    for (const banned of ["promote", "demote", "approve", "set_policy", "panic", "leash_promote", "leash_approve", "leash_set_policy"]) {
      expect(names).not.toContain(banned);
    }
    const r = await h.core.callTool("leash_promote");
    expect(r.isError).toBe(true);
  });

  it("blocks an order placed right after text that looks like an injection", async () => {
    h = await alpacaHarness();
    await climbTo(h, "propose"); // demotion target one_rung so we can see it
    h.live!.state.quotes["AAPL"] = h.live!.state.quotes["AAPL"]!;
    // Reads whose results contain injection text: use a custom read through get_quote on a symbol is not text-bearing,
    // so simulate via the session taint directly using a poisoned read tool result.
    const session = h.core.session("default");
    session.taint.flaggedAtMs = h.clock.now().getTime();
    session.taint.callsSince = 0;
    session.taint.rules = ["ignore_previous"];
    const r = await h.core.callTool("place_order", buy("AAPL", 50));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("injection");
        expect(h.core.status().rung).toBe("paper"); // propose -> one rung down (paper exists on Alpaca)
  });

  it("audit log is verifiable after all of this", async () => {
    h = await alpacaHarness();
    await h.core.callTool("place_order", buy("AAPL", 50));
    await h.core.callTool("place_order", buy("AAPL", 5000));
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
      const r = await h.core.callTool("place_order", { symbol: "AAPL", side: "buy", notional_usd: 10 });
      if (rung === "propose" && r.structuredContent?.["proposal_id"]) await h.core.approveProposal(r.structuredContent["proposal_id"] as string);
    }
    h.clock.days(2);
    const res = await h.core.promote();
    if (!res.promoted) throw new Error(`could not leave ${rung}: ${JSON.stringify(res.checks.filter((c) => !c.ok))}`);
    if (order.indexOf(h.core.status().rung) <= order.indexOf(rung)) throw new Error("did not climb");
  }
}
