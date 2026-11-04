# Changelog

## 0.4.0

* Package `haelo-mcp` is prepared for npm (`haelo` and `haelo-mcp` bins). Publish is a GitHub release workflow. It is not published from a laptop without `NPM_TOKEN`.
* The website playground quotes Uniswap v3 on Robinhood Chain. Shadow and paper stay unsigned. A live rung can ask the connected wallet to sign a swap after the policy gate. The site never asks for a private key.
* Robinhood Chain mainnet swaps through Uniswap v3 SwapRouter02. Paper quotes on-chain and does not sign. Live sends need `live.enabled` and `confirm: true`, use an exact token approval, and record the transaction hash in the audit log. Testnet has no published Uniswap router.

## 0.3.0

* Website hosted at haelobot.com, including the in-browser shadow playground.
* `$HAELO` page at `/token`. Contract address and buy link come from `website/public/config.json`, fetched at runtime. An empty address shows "CA coming soon" and disables Buy. The page states that the token is a memecoin and not financial advice.
* Synthesized soundtrack, on by default after the first gesture, with a mute toggle remembered in the browser.
* X link in the site nav, from the same config file.

## 0.2.0

* **Live opt-in.** `live.enabled: false` by default. Without it, live rungs cannot be configured, promoted into or executed.
* **`haelo doctor [--live]`.** Read-only preflight covering config, policy lock, permissions, storage, the audit chain and the secret store. It also checks Alpaca paper/live accounts and market data, Robinhood Crypto signed requests, and upstream MCP connect/tools/configured names/OAuth state. New `docs/GO_LIVE.md` checklist.
* **SQLite storage** (default) for state and the audit chain via `node:sqlite`, with append-only triggers. It imports from JSONL once, and `haelo audit export` writes JSONL that `haelo audit verify --file` accepts.
* **OS keychain** token storage via `@napi-rs/keyring`, with a 0600 file fallback and migration from 0.1 token files.
* **Local web approvals UI** (`haelo approvals-ui`): loopback only, token login to an HttpOnly cookie, CSRF, typed confirmation, strict CSP.
* The account wall is now enforced even when household checks are off.
* `haelo mock-upstream --stdio`.
* Tests went from 160 to 240+. Coverage thresholds are enforced in CI (lines ≥ 90%). There is an end-to-end OAuth 2.1 + PKCE test against a local mock IdP.
* `npm audit` is clean, including dev dependencies (minimatch override). Node ≥ 22.13.

## 0.1.0

First release.

* MCP gateway over stdio and Streamable HTTP (official TypeScript SDK v2), per-request server factory.
* Autonomy ladder: shadow → paper → propose → micro → standard; criteria-gated human promotion; automatic demotion on breach, drawdown, tool-list drift and injection follow-through; cool-down.
* Pure policy evaluator with per-rung rails; household preflight (account wall, concentration, wash-sale and lot warnings).
* Shadow ledger with slippage and fees; prompt-injection tripwire; tool-list pinning; hash-chained audit log; policy lock.
* Adapters: Alpaca (paper + live), Robinhood Crypto Trading API (Ed25519-signed), upstream MCP proxy (OAuth 2.1 PKCE / bearer / stdio).
* CLI: init, policy, serve, status, report, promote, demote, panic, proposals, approve/decline, pin, audit, auth, mock-upstream.
* Known gaps: adapters not yet verified against the real Alpaca/Robinhood services (see README matrix); CLI-only approvals.
