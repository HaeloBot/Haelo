# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository. Include the version (`haelo --version`), what you did, and what you expected. Expect an acknowledgement within a few days. This is a volunteer project; there is no bounty.

Supported versions: the latest release only.

## What Haelo defends against, and what it does not

Haelo exists because an AI agent with a Solana signing key can lose money by being wrong, by being manipulated, or by being compromised. It assumes **the agent is untrusted**.

### Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Agent places oversized or excessive orders | Pure policy evaluator with per-rung caps (per order, per day, per minute, per symbol cooldown, symbol allow/block lists, asset-class and order-type limits). Orders that cannot be parsed or sized are **refused**. | Caps bound the loss; they do not make trades good |
| Agent tries to move money | The agent only ever sees the native swap tools and Haelo's own. There is no transfer tool, and any unknown tool name is refused | None from tools; see the next row for the transaction itself |
| A route or API returns a transaction that does more than the swap | Before signing, Haelo decodes the Jupiter transaction, checks this wallet must sign it, and **simulates it against the RPC**. It refuses to sign if the wallet would lose more SOL than the order plus `maxFeeSol`, spend more of the input token than ordered, or receive less than the quote minus slippage | Simulation is against current state; the chain can move between simulation and landing, which slippage bounds |
| Prompt injection via tool results (news, filings) | Results from third-party-text tools are scanned (regex rules + hidden Unicode); a flagged result opens a window in which orders are blocked and counted against the ladder. Agent instructions tell it to treat tool text as data. | **A tripwire, not a wall.** A determined injection can evade regexes. The rails are the real defence |
| Tool definitions change after you reviewed them | Tool list is hashed and pinned. On change, orders freeze, the agent is demoted, and the **pinned** definitions are served until a human runs `haelo pin approve` | First-use trust (TOFU) unless `tools.trustOnFirstUse: false` |
| Agent promotes itself or edits policy | No agent-facing tool can promote, demote, approve, or change config. Policy file hash is locked; `serve` refuses to start if it changed | Only holds if the agent cannot run `haelo` or write files as the same OS user (below) |
| Agent forges its own approval card text | The card is built from canonical order fields. The agent's rationale is shown separately and labelled untrusted. Everything is re-checked at approval time | A human who approves without reading |
| Approval UI abuse (CSRF, clickjacking, XSS from agent text) | Loopback only, with a Host check. Sign-in exchanges the token for an HttpOnly, SameSite=Strict cookie. POSTs need a per-session CSRF token and a same-origin Origin header, and the proposal id must be typed back. All agent text is HTML-escaped. A strict CSP with `frame-ancestors 'none'` is set | The login URL contains the token, so do not paste it anywhere |
| Local web pages attacking the HTTP port (DNS rebinding / CSRF) | Loopback bind by default; Host and Origin validation; mandatory bearer token (≥ 16 chars, constant-time compare); refuses non-loopback bind without `--allow-remote` | Token on disk is mode 600; anyone who can read it can use the gateway |
| Secrets leaking into logs | The signing key comes only from the environment, a `chmod 600` keypair file or the OS keychain. Haelo prints the address, never the key; error text is scrubbed of anything shaped like a secret key, and audit entries are redacted by key name | Redaction is pattern and key-name based; do not put secrets in free-text fields |
| Audit log tampering | Hash-chained entries in SQLite (with triggers that refuse UPDATE/DELETE) or JSONL. `haelo audit verify` detects edits, deletions and reordering. `haelo audit export` writes a JSONL copy that verifies on its own | **Tamper-evident, not tamper-proof.** Whoever can rewrite the entire file can recompute the chain. Anchor `haelo status`'s head hash elsewhere |
| Duplicate swaps from retries | Jupiter `/execute` is never retried. Only reads retry on 429/5xx | An execute that times out may still land; Haelo reports it as an error, so check the wallet on an explorer before retrying |
| Wrong network | On connect, the RPC's genesis hash must match Solana mainnet-beta, and every token mint's decimals are read from chain | None known |
| Stale state across processes | State store uses a lock directory and re-reads on every access, so the gateway and CLI share one truth | Not designed for many concurrent writers |

### Run it so the agent cannot reach the controls

The single most important deployment rule: **the agent must not be able to run `haelo promote` or edit the state directory.**

* Run Haelo under a **different OS user** (or in a container) from the agent; make the state directory (`~/.haelo` by default) `0700` and owned by that user.
* Give the agent only the MCP endpoint (stdio launched by its client, or HTTP with the bearer token).
* Do not give the agent a shell tool as the same user.

### Credentials

* The signing key never goes in `haelo.yaml`, the audit log or the state file.
* The signing key imported with `haelo key import` is stored in the **OS keychain** through `@napi-rs/keyring` (an optional dependency) when one is usable: macOS Keychain, Windows Credential Manager, or Linux Secret Service/keyutils. Otherwise it goes in `<stateDir>/secrets/*.json` with mode `0600` (`secrets.store: auto`). Set `secrets.store: keychain` to refuse the file fallback. `haelo doctor` reports which store is in use. Keys set through `HAELO_PRIVATE_KEY` or `HAELO_KEYPAIR` are never written anywhere by Haelo.
* A keychain protects the key at rest and from other users. It does **not** protect them from processes running as the same user, which is why the agent must run as a different user.
* Live trading needs `live.enabled: true` in the locked policy **and** `confirm: true` on each order. While `live.enabled` is false, no code path signs anything.
* Use a **dedicated wallet** that holds only what the agent may trade. Never import your main wallet. Shadow and paper need no key at all.

### Not covered

Haelo does not protect against a compromised RPC that lies in simulation, a compromised host, a malicious dependency, market risk, token contract risk, or you approving something you did not read. Use an RPC you trust for live trading. Nothing in it is financial or tax advice.
