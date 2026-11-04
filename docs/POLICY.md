# Policy reference (`haelo.yaml`)

Secrets never go here. Config names the **environment variables** that hold them. Unknown or invalid fields are rejected with a readable error (`haelo policy check` / startup). `haelo policy lock` pins the file's SHA-256.

```yaml
version: 1
stateDir: ~/.haelo             # haelo.db (or audit.jsonl + state.json), policy.lock, http-token, secrets/
```

## `live`

`enabled` (false): the opt-in for live trading. While false, `ladder.start` and `autoPromote.maxRung` cannot be live rungs, promotion to `micro`/`standard` is refused (even with `--force`), and approving a proposal does not send it. See [GO_LIVE.md](GO_LIVE.md).

## `storage`

`backend`: `sqlite` (default) or `jsonl`.
- `sqlite` writes `<stateDir>/haelo.db` (WAL; append-only triggers on the audit table).
- `jsonl` writes `state.json` + `audit.jsonl`.
- Switching from `jsonl` to `sqlite` imports the existing chain once.
- `haelo audit export` writes JSONL from either backend.

## `secrets`

`store`: `auto` (OS keychain if usable, else 0600 files), `keychain` (fail if none), `file`.

## `broker`

One venue: `type: solana`. See [SOLANA.md](SOLANA.md).

| Field | Default | Meaning |
|---|---|---|
| `rpcUrl` | `https://api.mainnet-beta.solana.com` | Mainnet-beta RPC. Overridden by the env var named in `rpcUrlEnv` |
| `rpcUrlEnv` | `HAELO_RPC_URL` | Env var for a private RPC URL (its value is never printed) |
| `jupiterBaseUrl` | `https://api.jup.ag/swap/v2` | Jupiter Swap API V2 |
| `jupiterApiKeyEnv` | `HAELO_JUPITER_API_KEY` | Optional API key; keyless tier otherwise |
| `privateKeyEnv` | `HAELO_PRIVATE_KEY` | Base58 secret key or JSON byte array |
| `keypairFileEnv` | `HAELO_KEYPAIR` | Path to a `chmod 600` keypair file |
| `addressEnv` | `HAELO_ADDRESS` | Watch-only wallet for balances and paper simulation |
| `reserveSol` | 0.02 | SOL a sell must leave for fees |
| `maxFeeSol` | 0.01 | Most SOL a swap may cost beyond the SOL it sells, enforced by simulation |
| `paperSimulate` | true | Paper orders also simulate the real transaction when a wallet is known |
| `maxConsecutiveErrors` | 3 | Failed live swaps in a row before an automatic drop to shadow |
| `tokens` | `{}` | Extra SPL tokens, symbol to mint. `SOL`, `USDC`, `JUP`, `BONK` are built in |

## `agent`

`accountId`: the agent wallet's address. `haelo doctor` fails if the loaded key belongs to another wallet.

## `rails` (standard rung) and `rungs.<rung>` (tighter only)

| Field | Default | Meaning |
|---|---|---|
| `maxOrderUsd` | 500 | per-order notional |
| `maxDailyUsd` | 2000 | total notional per UTC day |
| `maxOrdersPerDay` / `maxOrdersPerMinute` | 20 / 5 | frequency |
| `symbolCooldownSeconds` | 0 | min gap between orders in one symbol |
| `allowSymbols` / `blockSymbols` | `[]` | empty allow = any not blocked |
| `allowOrderTypes` | `[market, limit]` | |
| `allowAssetClasses` | `[crypto]` | every Solana swap is crypto |
| `allowShort` | false | selling more than held is blocked |
| `maxPositionPct` | 100 | single-symbol share of equity after the order |
| `maxSlippageBps` | 100 | largest slippage a swap may request. Above this is a breach |

`rungs.micro` defaults to `maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 5`. A rung override can never exceed the standard rail; `allowSymbols` overrides intersect with the global list.

Violations are `breach` (hard rule: counts toward demotion) or `soft` (rate limit, cooldown, unknown position: counts as an invalid attempt).

## `ladder`

* `start`: initial rung (default `shadow`).
* `autoPromote: { enabled: false, maxRung: propose }`: optional automatic promotion, never above `maxRung`.
* `criteria.<rung>` (to leave that rung): `minDays`, `minDecisions`, `maxInvalidRate`, `maxBreaches`, `maxInjectionFollows`, `maxDrawdownPct`. All must hold; also no unresolved tool drift and not frozen.
* `demotion`: `onBreach` (`shadow`), `onDrawdown` (`one_rung`), `onToolDrift` (`shadow`), `onInjectionFollow` (`one_rung`), `cancelOpenOrders` (true), `cooldownHours` (24). Demotion never moves an agent *up*; Solana provides every rung, so targets map directly.
* `drawdown.maxPct` (10): measured on the shadow ledger at `shadow`, on the wallet's USDC value (USDC plus tokens priced through Jupiter) otherwise.

## `shadow`

`startingCash` (10000), `slippageBps` (5), `feeBps` (0), `fallbackSpreadBps` (10). Stop orders are not simulated and are rejected, not silently filled.

## `approvals`

`ttlSeconds` (900): proposals expire. `web: { host: 127.0.0.1, port: 8790 }`: the `haelo approvals-ui` listener (loopback only).

## `injection`

`enabled`, `windowCalls` (5), `windowSeconds` (900), `action` (`block` or `block_and_demote`).

## `tools`

`trustOnFirstUse` (true; false = a human must `haelo pin approve` before orders), `recheckSeconds` (0 = check the upstream list before every order).

## `household`

`enabled`; `washSale: { enabled, windowDays: 30, block: false, includeCrypto: false }`; `concentration: { maxPct: 30, block: true }`; `lots.warnDaysToLongTerm: 45`; `requireData: false` (true = refuse orders when household data cannot be loaded). Warnings only, not tax advice.

## `http`

`host` (`127.0.0.1`), `port` (8787). The token comes from `HAELO_HTTP_TOKEN` or `<stateDir>/http-token`.
