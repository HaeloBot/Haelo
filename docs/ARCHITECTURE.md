# Architecture

```
src/
  cli.ts, cli-main.ts      CLI (human-only controls). cli-main is testable: run(argv, io)
  server/                  gateway.ts (per-request McpServer factory), http.ts, stdio.ts
  core.ts                  HaeloCore: the pipeline every tool call goes through
  classify.ts              tool name -> effect; tolerant order-intent extraction
  policy/                  schema.ts (zod), load.ts, evaluate.ts (pure)
  ladder.ts                rungs, promotion criteria, demotion targets
  shadow.ts                simulated ledger
  household.ts             account wall, concentration, wash-sale and lot checks
  injection.ts             tripwire rules, taint window
  state.ts, audit.ts       lock-dir JSON store; hash-chained JSONL log
  adapters/                solana.ts (the venue), rest-base.ts (native tool set), http.ts
  solana/                  rpc.ts (JSON-RPC reads + simulate), jupiter.ts (Swap API V2 order/execute),
                           guard.ts (pre-sign simulation check), signer.ts (env, file or keychain key)
```

## One call, step by step (`HaeloCore.callTool`)

1. `haelo_*` tools are handled locally (status, preflight, propose, explain, rationale, shadow report, request promotion).
2. Refresh the tool list (dynamic adapters only; the Solana venue's tools are fixed), compare its hash with the pin. Drift → freeze orders, demote, and serve the *pinned* definitions.
3. Classify the tool: `read`, `order_place`, `order_cancel`, `transfer`, `unknown`. Transfer and unknown are blocked (and were never listed).
4. **Read**: shadow rung returns the shadow ledger's account/positions/orders (so the agent's view is consistent with what it did); otherwise pass through. Text from third-party-text tools is scanned for injection; a hit opens a taint window and the result is wrapped with a warning.
5. **Order**: extract an `OrderIntent` (fail closed). If the session is tainted, block and count a follow-through (demote per policy). Size it with a live quote. Run the pure policy evaluator for the rung's effective rails. Run household checks. Then route: `shadow` → virtual book at Jupiter prices, `paper` → real Jupiter route and on-chain simulation, unsigned, `propose` → create a proposal, `micro`/`standard` → guard, sign, Jupiter `/execute`.
6. Every verdict is appended to the audit log with the canonical intent and reasons. Ladder stats update. Hard breaches demote immediately; drawdown is checked after accepted orders.

## Why these choices

* **Pure evaluator.** `evaluateOrder` takes data and returns a verdict with `breach` (counts toward demotion) vs `soft` (counts as invalid) violations. Easy to test exhaustively and with property tests.
* **Stateless MCP factory.** The v2 SDK builds an `McpServer` per request. Session-like state (the taint window) is keyed per transport and held in `HaeloCore`.
* **State is files, re-read every time.** The gateway and the CLI are separate processes. A lock directory (`state.lock`) serialises read-modify-write; the audit log re-reads its tail on append so both processes extend one chain.
* **Rails only tighten down the ladder.** `effectiveRails()` takes the min of the rung override and the standard rail, so a typo cannot make `micro` looser than `standard`.
* **Annotations are not trusted.** A server can label anything `readOnlyHint: true`.
* **Human controls are CLI-only.** Not exposed over MCP.

## Deviations from the original design

- **Storage:** SQLite is the default, through Node's built-in `node:sqlite`, so there is no native dependency. JSONL/JSON is kept as an alternative and as the export format.
- **Approvals:** the local web approval UI and the CLI are implemented. There is no Telegram bot.
- **Venue:** Solana only. Swaps go through Jupiter Swap API V2. Paper has no separate account on Solana, so it means "real route, real simulation, nothing signed".
- **Key storage:** the OS keychain is used, with a 0600 file fallback.

## Storage and secrets

```
src/storage/index.ts     openStorage(backend): sqlite (default) or jsonl; one-time JSONL -> SQLite import
src/storage/sqlite.ts    SqliteAuditLog (same hashes as JSONL), SqliteStateStore (BEGIN IMMEDIATE updates)
src/secrets.ts           SecretStore: KeychainSecretStore (@napi-rs/keyring, probed) | FileSecretStore (0600)
src/doctor.ts            read-only preflight
src/server/approvals-ui.ts  local web approvals
```
