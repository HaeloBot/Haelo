import { afterEach, describe, expect, it } from "vitest";
import { solanaHarness, textOf, type Harness } from "./helpers/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});
const sc = (r: { structuredContent?: Record<string, unknown> }): Record<string, unknown> => r.structuredContent ?? {};

describe("Haelo's own agent tools", () => {
  it("haelo_status, haelo_shadow_report and haelo_preflight describe the situation without side effects", async () => {
    h = await solanaHarness({ rails: { maxOrderUsd: 100 } });
    const st = sc(await h.core.callTool("haelo_status"));
    expect(st["rung"]).toBe("shadow");
    expect(st["injection_lock"]).toEqual({ active: false });
    const pre = sc(await h.core.callTool("haelo_preflight", { tool: "place_order", args: { symbol: "SOL", side: "buy", confirm: true, notional_usd: 500 } }));
    expect(pre["verdict"]).toBe("block");
    expect(pre["would_happen"]).toBe("refused");
    const ok = sc(await h.core.callTool("haelo_preflight", { tool: "place_order", args: { symbol: "SOL", side: "buy", confirm: true, notional_usd: 50 } }));
    expect(ok["would_happen"]).toBe("simulated fill");
    expect(sc(await h.core.callTool("haelo_preflight", { tool: "get_quote", args: {} }))["verdict"]).toBe("allow");
    expect((await h.core.callTool("haelo_preflight", { tool: "nope" })).isError).toBe(true);
    expect(h.core.status().stats.decisions).toBe(0); // preflight is not a decision
    const rep = sc(await h.core.callTool("haelo_shadow_report"));
    expect(rep["starting_cash"]).toBe(10_000);
  });

  it("haelo_explain_block and haelo_record_rationale work from a decision id", async () => {
    h = await solanaHarness({ rails: { maxOrderUsd: 100 } });
    const r = await h.core.callTool("place_order", { symbol: "SOL", side: "buy", confirm: true, notional_usd: 500 });
    const id = String(sc(r)["decision_id"] ?? /decision_id[":= ]+([0-9a-f-]{36})/.exec(textOf(r))?.[1]);
    const why = sc(await h.core.callTool("haelo_explain_block", { decision_id: id }));
    expect(why["verdict"]).toBe("block");
    expect((await h.core.callTool("haelo_explain_block", { decision_id: "x" })).isError).toBe(true);
    expect(sc(await h.core.callTool("haelo_record_rationale", { decision_id: id, rationale: "testing caps" }))["recorded"]).toBe(true);
    expect((await h.core.callTool("haelo_record_rationale", {})).isError).toBe(true);
    expect((await h.core.callTool("haelo_nope")).isError).toBe(true);
  });

  it("haelo_propose_order forces a proposal; haelo_get_proposal reports it", async () => {
    h = await solanaHarness({ ladder: { start: "propose" } });
    const r = sc(await h.core.callTool("haelo_propose_order", { symbol: "SOL", side: "buy", confirm: true, notional_usd: 20, rationale: "why not" }));
    expect(r["status"]).toBe("pending_approval");
    const g = sc(await h.core.callTool("haelo_get_proposal", { proposal_id: r["proposal_id"] }));
    expect(g["status"]).toBe("pending");
    expect((await h.core.callTool("haelo_get_proposal", { proposal_id: "nope" })).isError).toBe(true);
    await h.core.declineProposal(String(r["proposal_id"]));
    await expect(h.core.approveProposal(String(r["proposal_id"]))).rejects.toThrow(/not pending/);
  });

  it("proposals expire", async () => {
    h = await solanaHarness({ ladder: { start: "propose" }, approvals: { ttlSeconds: 60 } });
    const r = sc(await h.core.callTool("place_order", { symbol: "SOL", side: "buy", confirm: true, notional_usd: 20 }));
    h.clock.advance(120_000);
    await expect(h.core.approveProposal(String(r["proposal_id"]))).rejects.toThrow(/expired/);
    expect(h.executed()).toBe(0);
  });

  it("an approved proposal is re-checked against the rails at approval time", async () => {
    h = await solanaHarness({ ladder: { start: "propose" }, rails: { maxDailyUsd: 50, maxOrderUsd: 40 } });
    const a = sc(await h.core.callTool("place_order", { symbol: "SOL", side: "buy", confirm: true, notional_usd: 30 }));
    h.clock.advance(61_000);
    const b = sc(await h.core.callTool("place_order", { symbol: "JUP", side: "buy", confirm: true, notional_usd: 30 }));
    expect((await h.core.approveProposal(String(a["proposal_id"]))).status).toBe("executed");
    const second = await h.core.approveProposal(String(b["proposal_id"]));
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/Re-check failed/);
    expect(h.executed()).toBe(1);
  });
});

describe("live opt-in", () => {
  it("is off by default: live rungs cannot be configured, promoted into or executed", async () => {
    h = await solanaHarness({ live: { enabled: false }, ladder: { start: "propose", criteria: { propose: { minDays: 0, minDecisions: 0 } } } });
    const r = sc(await h.core.callTool("place_order", { symbol: "SOL", side: "buy", confirm: true, notional_usd: 20 }));
    const out = await h.core.approveProposal(String(r["proposal_id"]));
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/live.enabled: false/);
    const p = await h.core.promote({ force: true });
    expect(p.promoted).toBe(false);
    expect(p.checks.find((c) => c.name === "live_enabled")?.ok).toBe(false);
    expect(h.core.status().rung).toBe("propose");
    expect(h.executed()).toBe(0);
  });

  it("rejects a config that starts on a live rung without opting in", async () => {
    await expect(solanaHarness({ live: { enabled: false }, ladder: { start: "micro" } })).rejects.toThrow(/live.enabled/);
    await expect(solanaHarness({ live: { enabled: false }, ladder: { autoPromote: { enabled: true, maxRung: "standard" } } })).rejects.toThrow(/live.enabled/);
  });

  it("with opt-in, promotion to micro still needs the criteria", async () => {
    h = await solanaHarness({ ladder: { start: "propose" } });
    const rep = await h.core.promotionReport();
    expect(rep.checks.find((c) => c.name === "live_enabled")?.ok).toBe(true);
    expect(rep.eligible).toBe(false);
  });
});

describe("other ladder controls", () => {
  it("demote, panic and cancels at shadow are recorded", async () => {
    h = await solanaHarness({ ladder: { start: "propose" } });
    expect(await h.core.demote("manual", "test", "human")).toMatchObject({ from: "propose", to: "paper" });
    expect(await h.core.panic()).toMatchObject({ to: "shadow" });
    expect(await h.core.panic()).toBeUndefined();
    const limit = await h.core.callTool("place_order", { symbol: "SOL", side: "buy", type: "limit", qty: 1, limit_price: 1 });
    expect(limit.isError).toBe(true); // Jupiter swaps are market only; the policy refuses limits
    const c = sc(await h.core.callTool("cancel_all_orders"));
    expect(c["simulated"]).toBe(true);
    expect(c["cancelled"]).toBe(0);
    expect(sc(await h.core.callTool("cancel_order", { order_id: "nope" }))["cancelled"]).toBe(0);
  });

  it("cancels go to the venue above shadow, where swaps have already settled", async () => {
    h = await solanaHarness({ ladder: { start: "propose" } });
    await h.core.demote("manual", "to paper", "human");
    await h.core.callTool("place_order", { symbol: "SOL", side: "buy", notional_usd: 10 });
    expect(h.broker.orders("paper")).toHaveLength(1);
    const r = await h.core.callTool("cancel_all_orders");
    expect(r.isError).toBeFalsy();
    expect(sc(r)["cancelled"]).toBe(0);
  });

  it("a sell at paper checks the broker position (no shorting)", async () => {
    h = await solanaHarness({ ladder: { start: "propose" } });
    await h.core.demote("manual", "to paper", "human");
    const r = await h.core.callTool("place_order", { symbol: "JUP", side: "sell", qty: 1 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/short|position/i);
  });

  it("a broker error at paper counts as invalid, not as a breach", async () => {
    h = await solanaHarness({ ladder: { start: "propose" } });
    await h.core.demote("manual", "to paper", "human");
    h.fake.state.failOrders = "No routes found";
    const r = await h.core.callTool("place_order", { symbol: "SOL", side: "buy", confirm: true, notional_usd: 10 });
    expect(r.isError).toBe(true);
    expect(h.core.status().stats.invalid).toBe(1);
    expect(h.core.status().stats.breaches).toBe(0);
  });

  it("unknown tools are refused and an unexpected error never becomes an order", async () => {
    h = await solanaHarness();
    expect((await h.core.callTool("no_such_tool")).isError).toBe(true);
    h.fake.state.failOrders = "upstream down";
    const r = await h.core.callTool("get_quote", { symbol: "SOL" });
    expect(r.isError).toBe(true);
  });
});

describe("fixed tool set", () => {
  it("lists only the native swap tools and Haelo's own, and never a transfer", async () => {
    h = await solanaHarness();
    const names = h.core.toolDefs().map((t) => t.name);
    expect(names).toContain("place_order");
    expect(names).toContain("haelo_status");
    expect(names.some((n) => /transfer|withdraw|send/.test(n))).toBe(false);
    expect(h.core.status().toolDrift).toBeUndefined();
  });
});
