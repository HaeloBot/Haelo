# Changelog

## 0.1.0 (Solana)

First release of Haelo for Solana, built from the Haelo autonomy ladder.

* **Venue: Solana only.** Spot swaps through the Jupiter Swap API V2 (`/order`, `/execute`). Built-in tokens SOL, USDC, JUP and BONK; more by mint under `broker.tokens`. On connect, the RPC must be mainnet-beta and every mint's decimals are read from chain.
* **Pre-sign guard.** Every live swap is decoded, checked to need this wallet's signature, and simulated against the RPC. Haelo refuses to sign if the wallet would lose more SOL than the order plus `maxFeeSol`, spend more than ordered, or receive less than the quote minus slippage.
* **Paper on Solana.** A real Jupiter route and quote, plus an on-chain simulation of the real transaction when a wallet address is known. Nothing is signed.
* **Keys.** `haelo key import` stores the keypair in the OS keychain (0600 file fallback). `HAELO_PRIVATE_KEY` (base58 or JSON bytes) and `HAELO_KEYPAIR` (chmod 600 file) also work. The address is printed, never the key.
* **CLI.** New `haelo quote <pair>` and `haelo key import | show | forget`. `haelo doctor` checks the cluster, mints, a Jupiter quote, the key, SOL for fees and USDC, and never builds a swap.
* **Kept from Haelo:** the five-rung ladder, hard rails, automatic demotion (breach, drawdown, prompt injection, tool drift, repeated failed sends), human approvals in the CLI and local web UI, the hash-chained audit log in SQLite or JSONL, and the MCP server over stdio and HTTP.
* **Removed:** Alpaca, Robinhood Crypto, the upstream MCP adapter with OAuth, and Robinhood Chain.
* **Dependencies.** `jayson` (pulled in by `@solana/web3.js`) is overridden to patched `uuid` and `stream-json`. web3.js only loads jayson's browser client, which uses neither of the affected code paths; `npm audit --omit=dev` is clean.
