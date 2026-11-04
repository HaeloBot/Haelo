const COMMON = `
# LIVE TRADING IS OFF until you opt in here. While false, nothing is ever signed:
# micro/standard cannot be configured or promoted into, and approved proposals are not executed.
# Before turning it on, read docs/GO_LIVE.md and run \`haelo doctor --live\`.
live:
  enabled: false

storage:
  backend: sqlite           # sqlite (<stateDir>/haelo.db) or jsonl (state.json + audit.jsonl)

secrets:
  store: auto               # where \`haelo key import\` keeps the key: OS keychain if available, else a 0600 file

# Hard rails. These apply at the standard rung; lower rungs can only tighten them.
rails:
  maxOrderUsd: 500
  maxDailyUsd: 2000
  maxOrdersPerDay: 20
  maxOrdersPerMinute: 5
  symbolCooldownSeconds: 0
  allowSymbols: []          # empty = any pair not blocked, e.g. [SOL/USDC, JUP/USDC]
  blockSymbols: []
  allowOrderTypes: [market] # Jupiter swaps are market exact-input swaps
  allowAssetClasses: [crypto]
  allowShort: false
  maxPositionPct: 100       # max share of total equity in one symbol after an order
  maxSlippageBps: 100       # 1% cap. A larger slippage_bps is refused

# Tighter caps for rungs below standard.
rungs:
  micro:
    maxOrderUsd: 25
    maxDailyUsd: 100
    maxOrdersPerDay: 5
    allowSymbols: [SOL/USDC] # keep the first live rung on the deepest pair

ladder:
  start: shadow
  autoPromote:
    enabled: false          # humans promote. Turn on only to auto-promote through non-live rungs.
    maxRung: propose
  # Criteria to LEAVE each rung (all must hold). Written down before the agent runs.
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

approvals:
  ttlSeconds: 900
  web: { host: 127.0.0.1, port: 8790 }   # \`haelo approvals-ui\`

injection:
  enabled: true
  windowCalls: 5
  windowSeconds: 900
  action: block_and_demote

tools:
  trustOnFirstUse: true     # pin the tool list on first start
  recheckSeconds: 0         # 0 = verify the tool list before every order

household:
  enabled: true
  washSale: { enabled: false, windowDays: 30, block: false, includeCrypto: false }
  concentration: { maxPct: 30, block: true }
  lots: { warnDaysToLongTerm: 45 }
  requireData: false

http:
  host: 127.0.0.1
  port: 8787
`;

const BROKER = `broker:
  type: solana
  # Solana mainnet-beta. The public RPC is rate limited; for live use put a private RPC URL in HAELO_RPC_URL.
  rpcUrl: https://api.mainnet-beta.solana.com
  # Jupiter Swap API V2. HAELO_JUPITER_API_KEY is optional (keyless tier otherwise).
  jupiterBaseUrl: https://api.jup.ag/swap/v2
  reserveSol: 0.02          # SOL kept for fees when selling SOL
  maxFeeSol: 0.01           # most SOL a swap may cost beyond the SOL it sells (checked by simulation)
  paperSimulate: true       # paper orders also simulate the real transaction when a wallet is known
  maxConsecutiveErrors: 3   # failed live sends in a row before an automatic drop to shadow
  tokens: {}                # extra SPL tokens, e.g. { WIF: EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm }
`;

export function configTemplate(opts: { stateDir?: string } = {}): string {
  return `# Haelo policy. Read docs/POLICY.md for every field.
# Lock it once you are happy: \`haelo policy lock\`. The gateway then refuses to start if this file changes.
version: 1
stateDir: ${opts.stateDir ?? "~/.haelo"}

${BROKER}
# The only wallet the agent may trade from; orders naming another account are blocked.
# Set it like:  agent: { accountId: "<your wallet address>" }
agent: {}
${COMMON}`;
}
