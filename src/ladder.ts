import type { Criteria, HaeloConfig } from "./policy/schema.js";
import { RUNGS, rungIndex, type Rung } from "./types.js";
import type { PersistedState, RungStats } from "./state.js";
import { newShadowState } from "./shadow.js";

export function freshStats(now: Date, equity?: number): RungStats {
  return {
    startedAt: now.toISOString(),
    decisions: 0,
    accepted: 0,
    invalid: 0,
    breaches: 0,
    injectionFollows: 0,
    drawdownPct: 0,
    ...(equity !== undefined ? { startEquity: equity, hwmEquity: equity } : {}),
  };
}

export function initialState(config: HaeloConfig, now: Date): PersistedState {
  return {
    version: 1,
    ladder: { rung: config.ladder.start, since: now.toISOString(), stats: freshStats(now), history: [] },
    shadow: newShadowState(config.shadow.startingCash),
    usage: { day: now.toISOString().slice(0, 10), ordersToday: 0, notionalToday: 0, recentOrderTimes: [], lastOrderBySymbol: {} },
    proposals: [],
  };
}

/** The rungs this broker can actually use. Brokers without a paper environment skip the paper rung. */
export function availableRungs(supportsPaper: boolean): Rung[] {
  return RUNGS.filter((r) => supportsPaper || r !== "paper");
}

export function nextRung(current: Rung, supportsPaper: boolean): Rung | undefined {
  const rungs = availableRungs(supportsPaper);
  const i = rungs.indexOf(current);
  return i >= 0 ? rungs[i + 1] : undefined;
}

export function prevRung(current: Rung, supportsPaper: boolean): Rung {
  const rungs = availableRungs(supportsPaper);
  const i = rungs.indexOf(current);
  return rungs[Math.max(0, i - 1)] ?? "shadow";
}

export interface PromotionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PromotionReport {
  from: Rung;
  to: Rung | undefined;
  eligible: boolean;
  checks: PromotionCheck[];
}

/**
 * Whether the agent has met the pre-committed criteria to leave its current rung. Pure. Criteria are
 * deliberately about behaviour (rule adherence, invalid rate, injection follow-through, drawdown), because
 * a good shadow return is weak evidence about future live results.
 */
export function evaluatePromotion(config: HaeloConfig, state: PersistedState, supportsPaper: boolean, now: Date, extra: { toolDrift: boolean }): PromotionReport {
  const from = state.ladder.rung;
  const to = nextRung(from, supportsPaper);
  const checks: PromotionCheck[] = [];
  if (!to) {
    return { from, to, eligible: false, checks: [{ name: "top_rung", ok: false, detail: "Already at the highest rung." }] };
  }
  const criteria: Criteria | undefined = from === "standard" ? undefined : config.ladder.criteria[from];
  if (!criteria) return { from, to, eligible: false, checks: [{ name: "criteria", ok: false, detail: "No criteria configured for this rung." }] };
  const st = state.ladder.stats;
  const days = (now.getTime() - Date.parse(st.startedAt)) / 86_400_000;
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  add("minimum_days", days >= criteria.minDays, `${days.toFixed(1)} of ${criteria.minDays} days at ${from}`);
  add("minimum_decisions", st.decisions >= criteria.minDecisions, `${st.decisions} of ${criteria.minDecisions} order decisions`);
  const invalidRate = st.decisions > 0 ? st.invalid / st.decisions : 0;
  add("invalid_rate", invalidRate <= criteria.maxInvalidRate, `${(invalidRate * 100).toFixed(1)}% invalid (max ${(criteria.maxInvalidRate * 100).toFixed(1)}%)`);
  add("hard_breaches", st.breaches <= criteria.maxBreaches, `${st.breaches} breach(es) (max ${criteria.maxBreaches})`);
  add("injection_follow_through", st.injectionFollows <= criteria.maxInjectionFollows, `${st.injectionFollows} order(s) after a flagged result (max ${criteria.maxInjectionFollows})`);
  add("drawdown", st.drawdownPct <= criteria.maxDrawdownPct, `${st.drawdownPct.toFixed(2)}% max drawdown (max ${criteria.maxDrawdownPct}%)`);
  add("tool_schema_stable", !extra.toolDrift && !state.drift, state.drift ? "upstream tools changed since they were pinned" : "no unreviewed upstream tool changes");
  const frozen = state.ladder.frozenUntil ? Date.parse(state.ladder.frozenUntil) > now.getTime() : false;
  add("not_frozen", !frozen, frozen ? `promotion frozen until ${state.ladder.frozenUntil} (${state.ladder.frozenReason ?? "demotion cooldown"})` : "no cooldown active");
  return { from, to, eligible: checks.every((c) => c.ok), checks };
}

export type DemotionTrigger = "breach" | "drawdown" | "tool_drift" | "injection_follow" | "manual" | "panic" | "live_errors";

/** Target rung for a demotion. Never moves the agent UP, and never below the first usable rung. */
export function demotionTarget(config: HaeloConfig, current: Rung, trigger: DemotionTrigger, supportsPaper: boolean): Rung {
  const d = config.ladder.demotion;
  let target: Rung;
  switch (trigger) {
    case "breach":
      target = d.onBreach;
      break;
    case "tool_drift":
      target = d.onToolDrift;
      break;
    case "drawdown":
      target = d.onDrawdown === "one_rung" ? prevRung(current, supportsPaper) : d.onDrawdown;
      break;
    case "injection_follow":
      target = d.onInjectionFollow === "one_rung" ? prevRung(current, supportsPaper) : d.onInjectionFollow;
      break;
    case "panic":
    case "live_errors":
      target = "shadow";
      break;
    case "manual":
      target = prevRung(current, supportsPaper);
      break;
  }
  if (!supportsPaper && target === "paper") target = "shadow";
  return rungIndex(target) < rungIndex(current) ? target : current;
}

/** Mutates `state` to apply a rung change. Caller persists it. */
export function applyRungChange(state: PersistedState, to: Rung, reason: string, by: "auto" | "human", now: Date, opts: { freezeHours?: number; equity?: number } = {}): void {
  const from = state.ladder.rung;
  state.ladder.history.push({ ts: now.toISOString(), from, to, reason, by });
  if (state.ladder.history.length > 500) state.ladder.history.splice(0, state.ladder.history.length - 500);
  state.ladder.rung = to;
  state.ladder.since = now.toISOString();
  state.ladder.stats = freshStats(now, opts.equity);
  if (opts.freezeHours && opts.freezeHours > 0) {
    state.ladder.frozenUntil = new Date(now.getTime() + opts.freezeHours * 3_600_000).toISOString();
    state.ladder.frozenReason = reason;
  } else if (by === "human") {
    delete state.ladder.frozenUntil;
    delete state.ladder.frozenReason;
  }
}
