# Solana swaps

Haelo trades spot tokens on Solana mainnet-beta through the [Jupiter Swap API V2](https://developers.jup.ag/docs/swap/order-and-execute). Quotes, shadow and paper need no key. A live swap needs `live.enabled: true` in the locked policy, `confirm: true` on the order, and a signing key on the machine that runs Haelo. The website never sees a key.

## How one live swap runs

1. **Policy first.** The order is parsed (`SOL`, `SOL/USDC`, `jup-usdc` all become `BASE/QUOTE`), sized from a live quote, and checked against the rung's rails, the daily totals and the household checks. A refusal never reaches Jupiter.
2. **Route.** `GET /order` with `inputMint`, `outputMint`, `amount` (base units), `taker` (the wallet) and `slippageBps`. Jupiter returns an unsigned transaction and a `requestId`.
3. **Guard.** Before anything is signed, Haelo:
   - decodes the transaction and checks this wallet must sign it,
   - reads the wallet's SOL and the input/output token accounts,
   - **simulates the exact transaction** against your RPC and reads the same accounts after it,
   - refuses unless the wallet loses at most the SOL being sold plus `maxFeeSol`, spends at most the input amount ordered, and receives at least the quote minus slippage.
4. **Sign.** The transaction is signed locally. The key never leaves the process.
5. **Land.** `POST /execute` with the signed transaction and `requestId`. Jupiter submits it and returns the signature and the settled amounts. Haelo records the signature and a Solscan link in the audit log.

If `/execute` fails, Haelo reports the error and does not retry. `maxConsecutiveErrors` failures in a row (default 3) drop the agent to shadow.

## What each rung does on Solana

| Rung | What a swap does | Signs? |
|---|---|---|
| shadow | Fills on a virtual book at Jupiter prices | No |
| paper | Real Jupiter route and quote. When a wallet address is known (`HAELO_ADDRESS` or a key), the real transaction is also simulated and the result attached as `onchainSimulation` | No |
| propose | Held until a human approves; then runs exactly as micro/standard | Only after approval |
| micro | Live under tiny caps (default $25 an order, $100 a day, `SOL/USDC` only) | Yes |
| standard | Live under your rails | Yes |

Solana has no separate paper account, so "paper" means a real route and a real dry run, with nothing signed.

## Tokens

Built in: `SOL` (wrapped SOL mint, Jupiter wraps and unwraps), `USDC`, `JUP`, `BONK`. Add others by mint:

```yaml
broker:
  type: solana
  tokens:
    WIF: EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm
```

On connect, Haelo checks the RPC's genesis hash is mainnet-beta and reads every mint's decimals and token program (classic or Token-2022) from chain. A wrong mint fails at start, not mid-trade. Orders are quoted in USDC: a buy takes `notional_usd` (USDC to spend), a sell takes `qty` (tokens to sell). Limit orders are refused; Jupiter swaps are market exact-input swaps.

## Keys

Use a **dedicated wallet** holding only what the agent may trade. Never import your main wallet.

| Where | How |
|---|---|
| OS keychain (recommended) | `haelo key import --file ~/.config/solana/id.json` (the file must be `chmod 600`). `haelo key show` prints the address; `haelo key forget` removes it |
| Environment | `HAELO_PRIVATE_KEY`: a base58 secret key (Phantom export) or a JSON byte array |
| File | `HAELO_KEYPAIR`: path to a `chmod 600` Solana CLI keypair file |
| Watch only | `HAELO_ADDRESS`: balances and paper simulation, no signing |

At most one of `HAELO_PRIVATE_KEY` and `HAELO_KEYPAIR` may be set. Haelo prints the address, never the key, and scrubs key-shaped text from errors.

## RPC and Jupiter

| Setting | Default | Note |
|---|---|---|
| `broker.rpcUrl` | `https://api.mainnet-beta.solana.com` | Public and rate limited. For live use set `HAELO_RPC_URL` to a private RPC; its URL is never printed |
| `broker.jupiterBaseUrl` | `https://api.jup.ag/swap/v2` | |
| `HAELO_JUPITER_API_KEY` | unset | Optional. Without it the keyless tier applies |
| `broker.reserveSol` | `0.02` | SOL a sell must leave behind for fees |
| `broker.maxFeeSol` | `0.01` | Most SOL a swap may cost beyond the SOL it sells, enforced by simulation |

`haelo quote SOL/USDC` checks Jupiter and the RPC in one line. `haelo doctor` checks the cluster, every mint, a Jupiter quote, the key and the balances, and never builds a swap.

## What has been verified

| Path | How |
|---|---|
| Order parsing, policy, ladder, audit | Unit and integration tests (`npm test`) |
| Jupiter `/order` and `/execute`, RPC reads, simulation, signing | Against a local fake cluster that builds real v0 transactions, checks ed25519 signatures on `/execute`, and simulates balance changes (`test/helpers/fake-solana.ts`). Includes a route that drains extra SOL and one that underpays; the guard refuses both |
| API shapes | Taken from Jupiter's published Swap API V2 documentation and Solana's JSON-RPC specification |

No swap has been sent to mainnet by the author. Run `haelo doctor --live`, then make your first live swap a few dollars from a dedicated wallet.
