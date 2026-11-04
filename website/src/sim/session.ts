/**
 * Browser shadow session.
 *
 * Order decisions, promotion, demotion, household preflight, injection taint and the
 * hash chain all call the same modules as the CLI (`evaluateOrder`, `ShadowLedger`,
 * `evaluatePromotion`, `demotionTarget`, `householdChecks`, `scanText`, `nextEntry`,
 * `verifyEntries`). Nothing here reimplements those rules.
 *
 * What the browser will not do, on purpose:
 * - read or store a private key
 * - sign a swap itself
 *
 * Shadow and paper fill against quotes in this process and do not broadcast.
 * A live rung that passes policy returns readyForWallet. The page then asks the
 * connected wallet to sign. live.enabled false still refuses the send.
 */
import { nextEntry, verifyEntries, type AuditEntry, type VerifyResult } from "../../../src/audit.js";
import { householdChecks, type PreflightCheck } from "../../../src/household.js";
import { flag, isTainted, newTaint, scanText, type InjectionMatch, type TaintState } from "../../../src/injection.js";
import { applyRungChange, demotionTarget, evaluatePromotion, initialState, type DemotionTrigger, type PromotionReport } from "../../../src/ladder.js";
import { evaluateOrder, isBreach, type UsageSnapshot, type Violation } from "../../../src/policy/evaluate.js";
import { parseConfig } from "../../../src/policy/load.js";
import type { HaeloConfig } from "../../../src/policy/schema.js";
import { ShadowLedger } from "../../../src/shadow.js";
import type { HouseholdAccount, OrderIntent, Quote, Rung, Side } from "../../../src/types.js";
import { rungIndex } from "../../../src/types.js";
import type { PersistedState, Proposal } from "../../../src/state.js";
import { isoDay, round } from "../../../src/util.js";
import { offlineQuotes } from "./quotes.js";

export interface TapeItem {
  id: number;
  ts: string;
  title: string;
  detail: string;
  tone: "ok" | "warn" | "bad" | "info";
  rung: Rung;
}

export interface RungMove {
  from: Rung;
  to: Rung;
  direction: "up" | "down";
}

export interface StepResult {
  title: string;
  detail: string;
  tone: TapeItem["tone"];
  rung: Rung;
  moved?: RungMove;
  checks: PreflightCheck[];
  violations: Violation[];
  /** Policy passed on a live rung. The page may open the wallet. Nothing has been broadcast. */
  readyForWallet?: boolean;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  notionalUsd: number;
}

export interface SessionSnapshot {
  version: number;
  yamlOk: true;
  rung: Rung;
  since: string;
  stats: PersistedState["ladder"]["stats"];
  frozenUntil?: string;
  frozenReason?: string;
  cash: number;
  equity: number;
  hwm: number;
  drawdownPct: number;
  positions: Array<{ symbol: string; qty: number; avgPrice: number; mark: number }>;
  promotion: PromotionReport;
  audit: AuditEntry[];
  verify: VerifyResult;
  tape: TapeItem[];
  proposals: Proposal[];
  drift: boolean;
  usage: { ordersToday: number; notionalToday: number };
  railsLabel: string;
}

const AGENT_ACCOUNT = "agent-browser";

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** A small household the preflight can see. Not a brokerage login. */
export function sampleHousehold(now: Date): HouseholdAccount[] {
  return [
    {
      id: AGENT_ACCOUNT,
      label: "Agent",
      isAgentAccount: true,
      equity: 20_000,
      positions: [],
      fills: [],
    },
    {
      id: "taxable-joint",
      label: "Taxable",
      isAgentAccount: false,
      equity: 20_000,
      positions: [{ symbol: "AAPL", qty: 10, avgEntryPrice: 200, marketValue: 1800, assetClass: "equity" }],
      fills: [
        { symbol: "AAPL", side: "buy", qty: 10, price: 200, ts: daysAgo(now, 12), assetClass: "equity" },
        { symbol: "AAPL", side: "sell", qty: 4, price: 150, ts: daysAgo(now, 4), assetClass: "equity" },
      ],
    },
  ];
}

function move(from: Rung, to: Rung): RungMove | undefined {
  if (from === to) return undefined;
  return { from, to, direction: rungIndex(to) > rungIndex(from) ? "up" : "down" };
}

export class PlaygroundSession {
  readonly config: HaeloConfig;
  readonly state: PersistedState;
  readonly audit: AuditEntry[] = [];
  readonly tape: TapeItem[] = [];
  taint: TaintState = newTaint();
  now: Date;
  quotes: Record<string, Quote>;
  private seq = 0;
  private version = 1;

  private constructor(config: HaeloConfig, now: Date) {
    this.config = config;
    this.now = now;
    this.state = initialState(config, now);
    this.quotes = offlineQuotes(now.toISOString());
    this.append("session_start", {
      rung: this.state.ladder.rung,
      note: "Browser shadow session. No broker credentials are present or accepted.",
      liveEnabled: config.live.enabled,
    });
  }

  static create(yaml: string, now = new Date()): PlaygroundSession {
    const config = parseConfig(yaml);
    return new PlaygroundSession(config, now);
  }

  setQuotes(quotes: Record<string, Quote>): void {
    this.quotes = { ...this.quotes, ...quotes };
    this.touch();
  }

  /** Replace the in-memory chain with a previously verified log. */
  adoptAudit(entries: AuditEntry[]): boolean {
    const verdict = verifyEntries(entries);
    if (!verdict.ok || entries.length === 0) return false;
    this.audit.splice(0, this.audit.length, ...entries.map((e) => ({ ...e, data: { ...e.data } })));
    this.touch();
    return true;
  }

  recordBroadcast(input: { hash?: string; detail: string; ok: boolean; symbol: string; notionalUsd: number }): void {
    this.append(input.ok ? "live_order" : "wallet_result", {
      ...(input.hash ? { txHash: input.hash, explorer: `https://robinhoodchain.blockscout.com/tx/${input.hash}` } : {}),
      detail: input.detail,
      ok: input.ok,
      symbol: input.symbol,
    });
    if (input.ok) {
      this.state.ladder.stats.decisions += 1;
      this.state.ladder.stats.accepted += 1;
      this.bumpUsage(input.symbol, input.notionalUsd);
    }
    this.touch();
  }

  exportAudit(): string {
    return JSON.stringify(this.audit, null, 2);
  }

  snapshot(): SessionSnapshot {
    const marks = this.marks();
    const ledger = new ShadowLedger(this.state.shadow, this.config.shadow, () => this.now);
    const dd = ledger.drawdownPct(marks);
    const promotion = this.promotionReport();
    const positions = Object.entries(this.state.shadow.positions).map(([symbol, p]) => ({
      symbol,
      qty: p.qty,
      avgPrice: p.avgPrice,
      mark: marks[symbol] ?? p.avgPrice,
    }));
    return {
      version: this.version,
      yamlOk: true,
      rung: this.state.ladder.rung,
      since: this.state.ladder.since,
      stats: { ...this.state.ladder.stats },
      ...(this.state.ladder.frozenUntil ? { frozenUntil: this.state.ladder.frozenUntil } : {}),
      ...(this.state.ladder.frozenReason ? { frozenReason: this.state.ladder.frozenReason } : {}),
      cash: this.state.shadow.cash,
      equity: dd.equity,
      hwm: dd.hwm,
      drawdownPct: this.state.ladder.stats.drawdownPct,
      positions,
      promotion,
      audit: this.audit.map((e) => ({ ...e, data: { ...e.data } })),
      verify: verifyEntries(this.audit),
      tape: this.tape.map((t) => ({ ...t })),
      proposals: this.state.proposals.map((p) => ({ ...p })),
      drift: Boolean(this.state.drift),
      usage: { ordersToday: this.state.usage.ordersToday, notionalToday: this.state.usage.notionalToday },
      railsLabel: `$${this.config.rails.maxOrderUsd} / order`,
    };
  }

  promotionReport(): PromotionReport {
    const report = evaluatePromotion(this.config, this.state, true, this.now, { toolDrift: Boolean(this.state.drift) });
    if (report.to === "micro" || report.to === "standard") {
      const ok = this.config.live.enabled;
      report.checks.push({
        name: "live_enabled",
        ok,
        detail: ok
          ? "live.enabled is true. A live rung asks the connected wallet to sign. This page never asks for a private key."
          : "live.enabled is false in the policy; live rungs are locked, even with force.",
      });
      if (!ok) report.eligible = false;
    }
    return report;
  }

  advanceMinutes(minutes: number): void {
    this.now = new Date(this.now.getTime() + minutes * 60_000);
  }

  advanceDays(days: number): StepResult {
    this.now = new Date(this.now.getTime() + days * 86_400_000);
    this.append("clock", {
      advancedDays: days,
      now: this.now.toISOString(),
      note: "Playground clock only. The CLI uses the real wall clock.",
    });
    return this.note("info", "Clock moved", `${days} day(s). Promotion's minimum-days check uses this clock.`);
  }

  ingestText(text: string): StepResult {
    this.taint.callsSince += 1;
    const matches = this.config.injection.enabled ? scanText(text) : [];
    if (matches.length === 0) {
      this.append("read", { untrusted: true, flagged: false });
      return this.note("info", "Tool text scanned", "No injection rule matched. The tripwire is a regex, not a wall.");
    }
    flag(this.taint, this.now.getTime(), matches);
    this.append("injection_flag", {
      rules: matches.map((m) => m.rule),
      excerpts: matches.map((m) => m.excerpt),
    });
    return this.note(
      "warn",
      "Injection tripwire",
      `Flagged: ${matches.map((m) => m.rule).join(", ")}. Orders in this window are follow-through.`,
    );
  }

  placeOrder(req: OrderRequest): StepResult {
    this.taint.callsSince += 1;
    const symbol = req.symbol.trim().toUpperCase();
    const intent: OrderIntent = {
      symbol,
      side: req.side,
      type: "market",
      notionalUsd: req.notionalUsd,
      assetClass: symbol.includes("-") || symbol.includes("/") ? "crypto" : "equity",
    };
    const quote = this.quotes[symbol];
    const usage = this.usageSnapshot();
    const held = this.state.shadow.positions[symbol]?.qty;
    const violations: Violation[] = [];
    if (this.state.drift) {
      violations.push({
        code: "tool_drift",
        kind: "soft",
        message: "Upstream tools changed and have not been re-approved. Orders are frozen until a human runs haelo pin approve.",
      });
    }
    const evaluated = evaluateOrder({
      config: this.config,
      rung: this.state.ladder.rung,
      intent,
      notionalUsd: req.notionalUsd,
      usage,
      nowMs: this.now.getTime(),
      ...(held !== undefined ? { positionQty: held } : req.side === "sell" ? { positionQty: 0 } : {}),
    });
    violations.push(...evaluated.violations);

    const px = quote ? (intent.side === "buy" ? quote.ask : quote.bid) : undefined;
    const checks = householdChecks({
      config: this.config,
      intent,
      notionalUsd: req.notionalUsd,
      refPrice: px,
      accounts: sampleHousehold(this.now),
      now: this.now,
    });
    for (const c of checks) {
      if (c.level === "block") violations.push({ code: c.code, kind: "breach", message: c.message });
    }

    let injectionFollow = false;
    if (
      this.config.injection.enabled &&
      isTainted(this.taint, this.now.getTime(), this.config.injection.windowCalls, this.config.injection.windowSeconds)
    ) {
      injectionFollow = true;
      violations.push({
        code: "injection_follow",
        kind: "breach",
        message: `An order was attempted shortly after a tool result that looked like an injection (${this.taint.rules.join(", ")}).`,
      });
    }

    if (violations.length > 0) {
      const breach = isBreach({ verdict: "block", violations, effectiveRails: evaluated.effectiveRails });
      this.state.ladder.stats.decisions += 1;
      if (injectionFollow) this.state.ladder.stats.injectionFollows += 1;
      if (breach) this.state.ladder.stats.breaches += 1;
      else this.state.ladder.stats.invalid += 1;
      this.append("decision", {
        verdict: "block",
        symbol,
        side: req.side,
        notionalUsd: req.notionalUsd,
        rung: this.state.ladder.rung,
        violations: violations.map((v) => ({ code: v.code, kind: v.kind, message: v.message })),
        checks,
      });
      if (injectionFollow) this.taint = newTaint();
      let moved: RungMove | undefined;
      if (injectionFollow && this.config.injection.action === "block_and_demote") {
        moved = this.demote("injection_follow", "an order followed a flagged tool result");
      } else if (breach && !injectionFollow) {
        moved = this.demote("breach", `hard rail breached: ${violations.filter((v) => v.kind === "breach").map((v) => v.code).join(", ")}`);
      }
      const title = moved ? `Blocked · demoted to ${this.state.ladder.rung}` : "Order blocked";
      return this.finish(moved ? "bad" : "warn", title, violations.map((v) => v.message).join(" "), checks, violations, moved);
    }

    const rung = this.state.ladder.rung;
    if (rung === "propose") {
      return this.holdProposal(intent, req.notionalUsd, checks);
    }
    if (rung === "micro" || rung === "standard") {
      if (!this.config.live.enabled) {
        this.append("decision", {
          verdict: "block",
          reason: "live trading is disabled (live.enabled: false)",
          symbol,
          notionalUsd: req.notionalUsd,
          rung,
        });
        return this.finish("warn", "Live send refused", "Live trading is disabled in the policy (live.enabled: false). Nothing was sent.", checks, [], undefined);
      }
      this.append("decision", {
        verdict: "awaiting_signature",
        symbol,
        side: req.side,
        notionalUsd: req.notionalUsd,
        rung,
      });
      const result = this.finish(
        "info",
        "Policy passed",
        "The connected wallet can sign this Robinhood Chain swap. Nothing is broadcast until you approve it.",
        checks,
        [],
        undefined,
      );
      result.readyForWallet = true;
      return result;
    }

    if (!quote || !px) {
      this.state.ladder.stats.decisions += 1;
      this.state.ladder.stats.invalid += 1;
      this.append("decision", { verdict: "block", reason: "no quote to simulate against", symbol, rung });
      return this.finish("warn", "No quote", `${symbol} has no mark, so the shadow fill was refused (fail closed).`, checks, [], undefined);
    }

    const ledger = new ShadowLedger(this.state.shadow, this.config.shadow, () => this.now);
    const qty = req.notionalUsd / px;
    const filled = ledger.submit(intent, quote, qty);
    this.state.ladder.stats.decisions += 1;
    if (filled.order.status === "rejected") {
      this.state.ladder.stats.invalid += 1;
      this.append("decision", { verdict: "shadow_rejected", reason: filled.rejection, symbol, rung, simulated: true });
      return this.finish("warn", "Shadow reject", filled.rejection ?? "The shadow ledger rejected the order.", checks, [], undefined);
    }
    this.state.ladder.stats.accepted += 1;
    this.bumpUsage(symbol, req.notionalUsd);
    const standIn = rung === "paper";
    this.append("decision", {
      verdict: standIn ? "paper_quote" : "shadow_fill",
      symbol,
      side: req.side,
      qty: filled.order.filledQty,
      price: filled.order.filledAvgPrice,
      notionalUsd: req.notionalUsd,
      rung,
      simulated: true,
      ...(standIn ? { note: "Paper quote fill. Not signed. Nothing was broadcast." } : {}),
    });
    const dd = this.checkDrawdown();
    const auto = dd.moved ? undefined : this.maybeAutoPromote();
    const moved = dd.moved ?? auto;
    const pxLabel = filled.order.filledAvgPrice?.toFixed(2) ?? "?";
    const detail = standIn
      ? `Paper quote fill ${filled.order.filledQty.toFixed(6)} ${symbol} @ ${pxLabel}. Not signed. Nothing was broadcast.`
      : `Shadow fill ${filled.order.filledQty.toFixed(6)} ${symbol} @ ${pxLabel}. Nothing was signed.`;
    const extra = moved ? ` Then ${moved.direction === "down" ? "demoted" : "promoted"} to ${moved.to}.` : "";
    return this.finish(moved?.direction === "down" ? "bad" : "ok", standIn ? "Paper quote" : "Shadow fill", detail + extra, checks, [], moved);
  }

  promote(force = false): StepResult {
    const report = this.promotionReport();
    if (!report.to) return this.note("info", "Top rung", "There is no rung above this one.");
    if (report.checks.some((c) => c.name === "live_enabled" && !c.ok)) {
      this.append("promotion_refused", { to: report.to, reason: "live.enabled is false" });
      return this.note("warn", "Live rung locked", "Promotion into micro or standard needs live.enabled, and force cannot override it.");
    }
    if (!report.eligible && !force) {
      const missing = report.checks.filter((c) => !c.ok).map((c) => c.detail);
      return this.note("info", "Not eligible", missing.join(" "));
    }
    const from = this.state.ladder.rung;
    const to = report.to;
    applyRungChange(
      this.state,
      to,
      force && !report.eligible ? "promoted by human (criteria overridden)" : "criteria met",
      "human",
      this.now,
    );
    this.append("promotion", {
      from,
      to,
      by: "human",
      forced: Boolean(force && !report.eligible),
      checks: report.checks,
    });
    return this.finish("ok", `Promoted to ${to}`, force && !report.eligible ? "Forced. The audit log says so." : "Criteria met.", [], [], move(from, to));
  }

  panic(): StepResult {
    this.append("panic", { by: "human" });
    const moved = this.demote("panic", "human pressed panic", "human");
    if (!moved) {
      new ShadowLedger(this.state.shadow, this.config.shadow, () => this.now).cancelAll();
      return this.note("warn", "Already in shadow", "Open shadow orders were cancelled.");
    }
    return this.finish("bad", "Panic", `Straight to ${moved.to}. Open orders cancelled.`, [], [], moved);
  }

  tripToolDrift(): StepResult {
    const hash = "browser-unpinned";
    const first = !this.state.drift;
    this.state.drift = {
      detectedAt: this.now.toISOString(),
      hash,
      added: ["place_order_v2"],
      removed: [],
      changed: ["place_order"],
      reason: "upstream tool definitions changed since they were pinned",
    };
    this.append("tool_drift", { hash, added: ["place_order_v2"], removed: [], changed: ["place_order"] });
    const moved = first ? this.demote("tool_drift", "upstream tools changed (+1 -0 ~1)") : undefined;
    return this.finish(
      "bad",
      "Tool drift",
      "The pinned tool list no longer matches. Orders freeze until pin approve. This playground records the same demotion the gateway does.",
      [],
      [],
      moved,
    );
  }

  pinApprove(): StepResult {
    delete this.state.drift;
    this.append("tools_pin_approved", { by: "human", note: "Browser stand-in for haelo pin approve." });
    return this.note("ok", "Tools re-pinned", "Drift cleared. Orders can be assessed again.");
  }

  /** Crash or lift a mark, then run the same drawdown check the gateway runs after a fill. */
  remark(symbol: string, mid: number): StepResult {
    const sym = symbol.trim().toUpperCase();
    const prev = this.quotes[sym]?.mid;
    this.quotes[sym] = {
      symbol: sym,
      bid: mid * 0.9998,
      ask: mid * 1.0002,
      mid,
      ts: this.now.toISOString(),
    };
    this.append("mark", { symbol: sym, mid, previous: prev, note: "Playground mark. At shadow the CLI uses broker quotes the same way." });
    const dd = this.checkDrawdown();
    return this.finish(
      dd.moved ? "bad" : "info",
      dd.moved ? `Drawdown ${dd.pct.toFixed(2)}%` : `Marked ${sym}`,
      dd.moved
        ? `Drawdown ${dd.pct.toFixed(2)}% exceeded ${this.config.ladder.drawdown.maxPct}%. Demoted to ${dd.moved.to}.`
        : `Mark ${mid}. Session drawdown is ${dd.pct.toFixed(2)}% (limit ${this.config.ladder.drawdown.maxPct}%).`,
      [],
      [],
      dd.moved,
    );
  }

  decideProposal(id: string, approve: boolean): StepResult {
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p || p.status !== "pending") return this.note("warn", "No pending proposal", "That card is not waiting.");
    p.decidedAt = this.now.toISOString();
    p.decidedBy = "human";
    if (!approve) {
      p.status = "declined";
      this.append("proposal_declined", { proposal_id: id });
      return this.note("info", "Declined", `${id} will not be sent.`);
    }
    p.status = "failed";
    p.error = this.config.live.enabled
      ? "Browser playground never transmits orders. Use the local CLI."
      : "Live trading is disabled in the Haelo policy (live.enabled: false). Nothing was sent.";
    this.append("proposal_failed", { proposal_id: id, error: p.error });
    return this.note("warn", "Approval did not send", p.error);
  }

  verify(): VerifyResult {
    return verifyEntries(this.audit);
  }

  /** A copy of the chain with one entry mutated, so the UI can show a failed verify without damaging the real log. */
  tamperedVerify(): VerifyResult {
    if (this.audit.length === 0) return verifyEntries(this.audit);
    const copy = this.audit.map((e) => ({ ...e, data: { ...e.data } }));
    const target = copy[copy.length - 1];
    if (target) target.data["tampered"] = true;
    return verifyEntries(copy);
  }

  private holdProposal(intent: OrderIntent, notionalUsd: number, checks: PreflightCheck[]): StepResult {
    const id = `prop-${this.audit.length + 1}`;
    const createdAt = this.now.toISOString();
    const expires = new Date(this.now.getTime() + this.config.approvals.ttlSeconds * 1000).toISOString();
    const proposal: Proposal = {
      id,
      createdAt,
      expiresAt: expires,
      status: "pending",
      tool: "place_order",
      args: { symbol: intent.symbol, side: intent.side, notionalUsd },
      intent: { ...intent },
      notionalUsd,
      rungAtCreation: "propose",
      checks,
    };
    this.state.proposals.push(proposal);
    this.state.ladder.stats.decisions += 1;
    this.state.ladder.stats.accepted += 1;
    this.append("decision", { verdict: "hold_for_approval", proposal_id: id, symbol: intent.symbol, notionalUsd, rung: "propose" });
    return this.finish("info", "Held for approval", `proposal ${id}. Approving here still does not reach a broker.`, checks, [], undefined);
  }

  private checkDrawdown(): { moved?: RungMove; pct: number } {
    const ledger = new ShadowLedger(this.state.shadow, this.config.shadow, () => this.now);
    const d = ledger.drawdownPct(this.marks());
    this.state.ladder.stats.drawdownPct = Math.max(this.state.ladder.stats.drawdownPct, d.pct);
    if (d.pct > this.config.ladder.drawdown.maxPct) {
      this.append("drawdown_breach", {
        rung: this.state.ladder.rung,
        equity: d.equity,
        drawdown_pct: d.pct,
        limit_pct: this.config.ladder.drawdown.maxPct,
        note: "Measured on the shadow ledger. Above shadow, the CLI measures broker equity.",
      });
      return {
        pct: d.pct,
        moved: this.demote("drawdown", `drawdown ${d.pct.toFixed(2)}% exceeded ${this.config.ladder.drawdown.maxPct}%`),
      };
    }
    return { pct: d.pct };
  }

  private maybeAutoPromote(): RungMove | undefined {
    const ap = this.config.ladder.autoPromote;
    if (!ap.enabled) return undefined;
    const report = this.promotionReport();
    if (!report.eligible || !report.to) return undefined;
    if (rungIndex(report.to) > rungIndex(ap.maxRung)) return undefined;
    const from = this.state.ladder.rung;
    applyRungChange(this.state, report.to, "criteria met", "auto", this.now);
    this.append("promotion", { from, to: report.to, by: "auto", forced: false, checks: report.checks });
    return move(from, report.to);
  }

  private demote(trigger: DemotionTrigger, reason: string, by: "auto" | "human" = "auto"): RungMove | undefined {
    const from = this.state.ladder.rung;
    const to = demotionTarget(this.config, from, trigger, true);
    if (to === from) return undefined;
    applyRungChange(this.state, to, `${trigger}: ${reason}`, by, this.now, { freezeHours: this.config.ladder.demotion.cooldownHours });
    if (rungIndex(to) < rungIndex("propose")) {
      for (const p of this.state.proposals) {
        if (p.status === "pending") {
          p.status = "expired";
          p.error = `agent demoted to ${to}`;
        }
      }
    }
    if (this.config.ladder.demotion.cancelOpenOrders || trigger === "panic") {
      new ShadowLedger(this.state.shadow, this.config.shadow, () => this.now).cancelAll();
    }
    this.append("demotion", { from, to, trigger, reason, by });
    return move(from, to);
  }

  private usageSnapshot(): UsageSnapshot {
    const today = isoDay(this.now);
    if (this.state.usage.day !== today) {
      this.state.usage = {
        day: today,
        ordersToday: 0,
        notionalToday: 0,
        recentOrderTimes: this.state.usage.recentOrderTimes,
        lastOrderBySymbol: this.state.usage.lastOrderBySymbol,
      };
    }
    return {
      ordersToday: this.state.usage.ordersToday,
      notionalToday: this.state.usage.notionalToday,
      recentOrderTimes: this.state.usage.recentOrderTimes,
      lastOrderBySymbol: this.state.usage.lastOrderBySymbol,
    };
  }

  private bumpUsage(symbol: string, notional: number): void {
    const today = isoDay(this.now);
    if (this.state.usage.day !== today) {
      this.state.usage = {
        day: today,
        ordersToday: 0,
        notionalToday: 0,
        recentOrderTimes: this.state.usage.recentOrderTimes,
        lastOrderBySymbol: this.state.usage.lastOrderBySymbol,
      };
    }
    const nowMs = this.now.getTime();
    this.state.usage.ordersToday += 1;
    this.state.usage.notionalToday = round(this.state.usage.notionalToday + notional, 4);
    this.state.usage.recentOrderTimes = [...this.state.usage.recentOrderTimes.filter((t) => nowMs - t < 3_600_000), nowMs];
    this.state.usage.lastOrderBySymbol[symbol.toUpperCase()] = nowMs;
  }

  private marks(): Record<string, number> {
    const marks: Record<string, number> = {};
    for (const symbol of Object.keys(this.state.shadow.positions)) {
      const q = this.quotes[symbol];
      if (q) marks[symbol] = q.mid;
    }
    return marks;
  }

  private append(type: string, data: Record<string, unknown>): AuditEntry {
    const entry = nextEntry(this.audit.at(-1), this.now.toISOString(), type, data);
    this.audit.push(entry);
    return entry;
  }

  private note(tone: TapeItem["tone"], title: string, detail: string): StepResult {
    return this.finish(tone, title, detail, [], [], undefined);
  }

  private finish(
    tone: TapeItem["tone"],
    title: string,
    detail: string,
    checks: PreflightCheck[],
    violations: Violation[],
    moved: RungMove | undefined,
  ): StepResult {
    this.seq += 1;
    this.tape.unshift({ id: this.seq, ts: this.now.toISOString(), title, detail, tone, rung: this.state.ladder.rung });
    if (this.tape.length > 40) this.tape.pop();
    this.touch();
    return { title, detail, tone, rung: this.state.ladder.rung, checks, violations, ...(moved ? { moved } : {}) };
  }

  private touch(): void {
    this.version += 1;
  }
}

export function matchesOf(text: string): InjectionMatch[] {
  return scanText(text);
}
