# Policy reference (`leash.yaml`)

Secrets never go here. Config names the **environment variables** that hold them. Unknown or invalid fields are rejected with a readable error (`leash policy check` / startup). `leash policy lock` pins the file's SHA-256.

```yaml
version: 1
stateDir: ~/.leash             # audit.jsonl, state.json, policy.lock, http-token, oauth/
```

## `live`

`enabled` (false): the opt-in for live trading. While false, `ladder.start` and `autoPromote.maxRung` cannot be live rungs, promotion to `micro`/`standard` is refused (even with `--force`), and approving a proposal does not send it. See [GO_LIVE.md](GO_LIVE.md).

## `storage`

`backend`: `sqlite` (default) or `jsonl`.
- `sqlite` writes `<stateDir>/leash.db` (WAL; append-only triggers on the audit table).
- `jsonl` writes `state.json` + `audit.jsonl`.
- Switching from `jsonl` to `sqlite` imports the existing chain once.
- `leash audit export` writes JSONL from either backend.

## `secrets`

`store`: `auto` (OS keychain if usable, else 0600 files), `keychain` (fail if none), `file`.

## `broker`

| `type` | Fields |
|---|---|
| `alpaca` | `paperKeyIdEnv`, `paperSecretEnv`, `liveKeyIdEnv`, `liveSecretEnv` (env var names), `feed` (`iex`/`sip`/`delayed_sip`), `paperBaseUrl`, `liveBaseUrl`, `dataBaseUrl` |
| `robinhood-crypto` | `apiKeyEnv`, `privateKeyEnv` (base64 Ed25519 seed), `apiVersion` (`v1`/`v2`), `baseUrl` |
| `mcp-upstream` | exactly one of `url` / `command` (+`args`, `passEnv`); `bearerTokenEnv` (else OAuth for URLs, via `leash auth`); `oauthPort`; `quoteTools.{equity,crypto}`, `accountTool`, `positionsTool`, `ordersTool`, `taxLotsTool`, `cancelAllTool`; `toolOverrides: { tool: read\|order_place\|order_cancel\|transfer\|blocked }` |

## `agent`

`accountId`: the only account the agent may trade. Orders naming another account are blocked.

## `rails` (standard rung) and `rungs.<rung>` (tighter only)

| Field | Default | Meaning |
|---|---|---|
| `maxOrderUsd` | 500 | per-order notional |
| `maxDailyUsd` | 2000 | total notional per UTC day |
| `maxOrdersPerDay` / `maxOrdersPerMinute` | 20 / 5 | frequency |
| `symbolCooldownSeconds` | 0 | min gap between orders in one symbol |
| `allowSymbols` / `blockSymbols` | `[]` | empty allow = any not blocked |
| `allowOrderTypes` | `[market, limit]` | |
| `allowAssetClasses` | `[equity, crypto]` | options are off unless added |
| `allowShort` | false | selling more than held is blocked |
| `maxPositionPct` | 100 | single-symbol share of equity after the order |

`rungs.micro` defaults to `maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 5`. A rung override can never exceed the standard rail; `allowSymbols` overrides intersect with the global list.

Violations are `breach` (hard rule: counts toward demotion) or `soft` (rate limit, cooldown, unknown position: counts as an invalid attempt).

## `ladder`

* `start`: initial rung (default `shadow`).
* `autoPromote: { enabled: false, maxRung: propose }`: optional automatic promotion, never above `maxRung`.
* `criteria.<rung>` (to leave that rung): `minDays`, `minDecisions`, `maxInvalidRate`, `maxBreaches`, `maxInjectionFollows`, `maxDrawdownPct`. All must hold; also no unresolved tool drift and not frozen.
* `demotion`: `onBreach` (`shadow`), `onDrawdown` (`one_rung`), `onToolDrift` (`shadow`), `onInjectionFollow` (`one_rung`), `cancelOpenOrders` (true), `cooldownHours` (24). Demotion never moves an agent *up*; a target the broker cannot provide (paper on a broker without paper) maps to the next lower rung.
* `drawdown.maxPct` (10): measured on the shadow ledger at `shadow`, on broker equity otherwise.

## `shadow`

`startingCash` (10000), `slippageBps` (5), `feeBps` (0), `fallbackSpreadBps` (10). Stop orders are not simulated and are rejected, not silently filled.

## `approvals`

`ttlSeconds` (900): proposals expire. `web: { host: 127.0.0.1, port: 8790 }`: the `leash approvals-ui` listener (loopback only).

## `injection`

`enabled`, `windowCalls` (5), `windowSeconds` (900), `action` (`block` or `block_and_demote`).

## `tools`

`trustOnFirstUse` (true; false = a human must `leash pin approve` before orders), `recheckSeconds` (0 = check the upstream list before every order).

## `household`

`enabled`; `washSale: { enabled, windowDays: 30, block: false, includeCrypto: false }`; `concentration: { maxPct: 30, block: true }`; `lots.warnDaysToLongTerm: 45`; `requireData: false` (true = refuse orders when household data cannot be loaded). Warnings only, not tax advice.

## `http`

`host` (`127.0.0.1`), `port` (8787). The token comes from `LEASH_HTTP_TOKEN` or `<stateDir>/http-token`.
