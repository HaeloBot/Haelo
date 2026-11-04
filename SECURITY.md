# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository. Include the version (`leash --version`), what you did, and what you expected. Expect an acknowledgement within a few days. This is a volunteer project; there is no bounty.

Supported versions: the latest release only.

## What Leash defends against, and what it does not

Leash exists because an AI agent with broker access can lose money by being wrong, by being manipulated, or by being compromised. It assumes **the agent is untrusted**.

### Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Agent places oversized or excessive orders | Pure policy evaluator with per-rung caps (per order, per day, per minute, per symbol cooldown, symbol allow/block lists, asset-class and order-type limits). Orders that cannot be parsed or sized are **refused**. | Caps bound the loss; they do not make trades good |
| Agent tries to move money | Transfer/withdraw-like tools are hidden from `tools/list` **and** blocked if called by name. Unknown tools are treated the same. Tool annotations (`readOnlyHint`) are never trusted. | Classification is name-based; use `toolOverrides` if an upstream names things oddly |
| Prompt injection via tool results (news, filings) | Results from third-party-text tools are scanned (regex rules + hidden Unicode); a flagged result opens a window in which orders are blocked and counted against the ladder. Agent instructions tell it to treat tool text as data. | **A tripwire, not a wall.** A determined injection can evade regexes. The rails are the real defence |
| Upstream "rug pull" (tool descriptions/schemas change after you reviewed them) | Tool list is hashed and pinned. On change, orders freeze, the agent is demoted, and the **pinned** definitions are served until a human runs `leash pin approve` | First-use trust (TOFU) unless `tools.trustOnFirstUse: false` |
| Agent promotes itself or edits policy | No agent-facing tool can promote, demote, approve, or change config. Policy file hash is locked; `serve` refuses to start if it changed | Only holds if the agent cannot run `leash` or write files as the same OS user (below) |
| Agent forges its own approval card text | The card is built from canonical order fields. The agent's rationale is shown separately and labelled untrusted. Everything is re-checked at approval time | A human who approves without reading |
| Approval UI abuse (CSRF, clickjacking, XSS from agent text) | Loopback only, with a Host check. Sign-in exchanges the token for an HttpOnly, SameSite=Strict cookie. POSTs need a per-session CSRF token and a same-origin Origin header, and the proposal id must be typed back. All agent text is HTML-escaped. A strict CSP with `frame-ancestors 'none'` is set | The login URL contains the token, so do not paste it anywhere |
| Local web pages attacking the HTTP port (DNS rebinding / CSRF) | Loopback bind by default; Host and Origin validation; mandatory bearer token (≥ 16 chars, constant-time compare); refuses non-loopback bind without `--allow-remote` | Token on disk is mode 600; anyone who can read it can use the gateway |
| Secrets leaking into logs | Broker credentials come only from environment variables. Audit entries are redacted by key name (`key`, `secret`, `token`, `authorization`, ...) | Redaction is by key name; do not put secrets in free-text fields |
| Audit log tampering | Hash-chained entries in SQLite (with triggers that refuse UPDATE/DELETE) or JSONL. `leash audit verify` detects edits, deletions and reordering. `leash audit export` writes a JSONL copy that verifies on its own | **Tamper-evident, not tamper-proof.** Whoever can rewrite the entire file can recompute the chain. Anchor `leash status`'s head hash elsewhere |
| Duplicate orders from retries | HTTP POSTs are never retried. Only idempotent GETs retry on 429/5xx | A request that times out may or may not have been placed; Leash reports it as an error, check the broker |
| Stale state across processes | State store uses a lock directory and re-reads on every access, so the gateway and CLI share one truth | Not designed for many concurrent writers |

### Run it so the agent cannot reach the controls

The single most important deployment rule: **the agent must not be able to run `leash promote` or edit the state directory.**

* Run Leash under a **different OS user** (or in a container) from the agent; make the state directory (`~/.leash` by default) `0700` and owned by that user.
* Give the agent only the MCP endpoint (stdio launched by its client, or HTTP with the bearer token).
* Do not give the agent a shell tool as the same user.

### Credentials

* Broker keys live in environment variables and are never written to `leash.yaml`, the audit log, or the state file.
* OAuth tokens for an upstream MCP are stored in the **OS keychain** through `@napi-rs/keyring` (an optional dependency) when one is usable: macOS Keychain, Windows Credential Manager, or Linux Secret Service/keyutils. Otherwise they go in `<stateDir>/secrets/*.json` with mode `0600` (`secrets.store: auto`). Set `secrets.store: keychain` to refuse the file fallback. `leash doctor` reports which store is in use. Older plain token files are migrated into the store and then deleted.
* A keychain protects tokens at rest and from other users. It does **not** protect them from processes running as the same user, which is why the agent must run as a different user.
* Live trading needs `live.enabled: true` in the locked policy. While it is false, no code path sends a live order.
* Prefer paper keys while evaluating. Use broker-side limits too (API keys scoped to trading only, no withdrawals).

### Not covered

Leash does not protect against a compromised broker, a compromised host, a malicious dependency, market risk, or you approving something you did not read. It is not a substitute for broker-side controls, and nothing in it is financial or tax advice.
