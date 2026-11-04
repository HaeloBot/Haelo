/** Policies the playground can load. Parsed by Haelo's real `parseConfig`. */

export const DEMO_YAML = `# Playground policy. Short criteria so a session can climb.
# The CLI's example file is stricter (days, not minutes). See the Strict preset.
version: 1
stateDir: ~/.haelo
broker:
  type: solana
live:
  enabled: false
rails:
  maxOrderUsd: 500
  maxDailyUsd: 2000
  maxOrdersPerDay: 20
  maxOrdersPerMinute: 6
  allowSymbols: [SOL/USDC, JUP/USDC, BONK/USDC]
  blockSymbols: []
  allowOrderTypes: [market]
  allowAssetClasses: [crypto]
  allowShort: false
  maxPositionPct: 100
rungs:
  micro:
    maxOrderUsd: 25
    maxDailyUsd: 100
    maxOrdersPerDay: 5
ladder:
  start: shadow
  autoPromote:
    enabled: false
    maxRung: propose
  criteria:
    shadow:  { minDays: 0, minDecisions: 3, maxInvalidRate: 0.5, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 12 }
    paper:   { minDays: 0, minDecisions: 3, maxInvalidRate: 0.5, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 12 }
    propose: { minDays: 0, minDecisions: 2, maxInvalidRate: 0.5, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 12 }
    micro:   { minDays: 0, minDecisions: 2, maxInvalidRate: 0.34, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 8 }
  demotion:
    onBreach: shadow
    onDrawdown: one_rung
    onToolDrift: shadow
    onInjectionFollow: one_rung
    cancelOpenOrders: true
    cooldownHours: 0
  drawdown:
    maxPct: 8
shadow:
  startingCash: 10000
  slippageBps: 5
  feeBps: 1
injection:
  enabled: true
  windowCalls: 5
  windowSeconds: 900
  action: block_and_demote
household:
  enabled: true
  # 1% of the playground's sample household ($40k) so a $500 order trips it.
  # Real policies use something like 30. This is only so the demo can show the check.
  concentration: { maxPct: 1, block: true }
`;

export const STRICT_YAML = `# Close to haelo.example.yaml. Promotion takes real days.
version: 1
stateDir: ~/.haelo
broker:
  type: solana
live:
  enabled: false
rails:
  maxOrderUsd: 500
  maxDailyUsd: 2000
  maxOrdersPerDay: 20
  allowSymbols: []
  allowAssetClasses: [equity, crypto]
  allowOrderTypes: [market]
  allowShort: false
rungs:
  micro:
    maxOrderUsd: 25
    maxDailyUsd: 100
    maxOrdersPerDay: 5
ladder:
  start: shadow
  autoPromote:
    enabled: false
    maxRung: propose
  criteria:
    shadow:  { minDays: 7,  minDecisions: 20, maxInvalidRate: 0.10, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 10 }
    paper:   { minDays: 7,  minDecisions: 20, maxInvalidRate: 0.10, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 10 }
    propose: { minDays: 7,  minDecisions: 10, maxInvalidRate: 0.10, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 10 }
    micro:   { minDays: 14, minDecisions: 25, maxInvalidRate: 0.05, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 5 }
  demotion:
    onBreach: shadow
    onDrawdown: one_rung
    onToolDrift: shadow
    onInjectionFollow: one_rung
    cancelOpenOrders: true
    cooldownHours: 24
  drawdown:
    maxPct: 10
shadow:
  startingCash: 10000
  slippageBps: 5
  feeBps: 0
injection:
  enabled: true
  action: block_and_demote
household:
  enabled: true
  washSale: { enabled: true, windowDays: 30, block: false, includeCrypto: false }
  concentration: { maxPct: 30, block: true }
`;

export const HOUSEHOLD_YAML = `# Equity allowed, so the wash-sale preflight has something to say.
# Crypto wash-sale checks stay off, matching the repo default.
version: 1
stateDir: ~/.haelo
broker:
  type: solana
live:
  enabled: false
agent: {}
rails:
  maxOrderUsd: 2000
  maxDailyUsd: 5000
  maxOrdersPerDay: 20
  allowSymbols: [SOL/USDC, JUP/USDC]
  allowAssetClasses: [crypto]
  allowOrderTypes: [market]
  allowShort: false
ladder:
  start: shadow
  criteria:
    shadow: { minDays: 0, minDecisions: 3, maxInvalidRate: 0.5, maxBreaches: 0, maxInjectionFollows: 0, maxDrawdownPct: 20 }
  demotion:
    onBreach: shadow
    onDrawdown: one_rung
    onToolDrift: shadow
    onInjectionFollow: one_rung
    cooldownHours: 0
  drawdown:
    maxPct: 15
shadow:
  startingCash: 10000
  slippageBps: 5
household:
  enabled: true
  washSale: { enabled: true, windowDays: 30, block: false, includeCrypto: false }
  concentration: { maxPct: 25, block: true }
`;

export interface PolicyPreset {
  id: string;
  label: string;
  blurb: string;
  yaml: string;
}

export const LIVE_CHAIN_YAML = `# Live Solana. Your wallet signs. This page never sees a private key.
version: 1
stateDir: ~/.haelo
broker:
  type: solana
live:
  enabled: true
rails:
  maxOrderUsd: 100
  maxDailyUsd: 200
  maxOrdersPerDay: 10
  maxSlippageBps: 100
  allowSymbols: [SOL/USDC, JUP/USDC]
  allowOrderTypes: [market]
  allowAssetClasses: [crypto]
  allowShort: false
ladder:
  start: micro
household:
  enabled: false
`;

export const PRESETS: PolicyPreset[] = [
  { id: "short", label: "Short ladder", blurb: "Climbs in a few good orders. Live stays locked until you opt in.", yaml: DEMO_YAML },
  { id: "live", label: "Live Solana", blurb: "Starts on micro with live.enabled. A swap asks your Solana wallet to sign.", yaml: LIVE_CHAIN_YAML },
  { id: "strict", label: "Strict", blurb: "The shape of haelo.example.yaml. Days, not clicks.", yaml: STRICT_YAML },
  { id: "household", label: "Household", blurb: "Concentration checks across the agent wallet and a cold wallet.", yaml: HOUSEHOLD_YAML },
];
