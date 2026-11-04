# Robinhood Chain swaps

Haelo can quote and, only after you opt in, send Uniswap v3 swaps on Robinhood Chain mainnet (chain id 4663). The website never sees a key. The playground still cannot send.

## What is deployed

Robinhood lists Uniswap as the public DEX on [docs.robinhood.com/chain](https://docs.robinhood.com/chain/). The router and quoter addresses are Uniswap's own deployment for chain 4663:

- [Uniswap v3 Robinhood Chain deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments)
- [Uniswap/contracts deployments/4663.md](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md)

| Contract | Address |
|---|---|
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| WETH (L2 WETH from [Robinhood's contract list](https://docs.robinhood.com/chain/protocol-contracts/)) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG (Paxos stablecoin; `symbol()` is USDG, 6 decimals, read on the mainnet RPC) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

RPC `https://rpc.mainnet.chain.robinhood.com`. Explorer `https://robinhoodchain.blockscout.com`.

Testnet is chain id 46630, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com` ([deploy docs](https://docs.robinhood.com/chain/deploy-smart-contracts/)). Those docs publish a testnet WETH and no Uniswap router. On 2026-11-04 the mainnet router address had no code on testnet. Haelo does not invent a testnet router, and it will not send a testnet swap until Uniswap publishes one.

## Setup

```bash
haelo init --broker robinhood-chain
# edit haelo.yaml, then:
haelo policy lock
haelo doctor
```

Quotes need no key. `haelo doctor` checks the chain id, that SwapRouter02 has code, and that a small WETH to USDG quote returns.

## Keys

Set exactly one of these in the environment of the process that runs `haelo serve`. Do not put them in `haelo.yaml`, the website, or a chat.

| Variable | Meaning |
|---|---|
| `HAELO_PRIVATE_KEY` | 32-byte hex private key (`0x` plus 64 hex characters) |
| `HAELO_KEYSTORE` | Path to a mode `0600` file. The file is either that hex key, or JSON `{"privateKey":"0x..."}` |
| `HAELO_ADDRESS` | Address to read balances when you have no signer. Quotes do not need it |

A host can also pass an external signer to `RobinhoodChainBroker` (address plus `send`). Haelo never logs the key. Errors strip 32-byte hex strings.

## Live opt-in

Live sends stay off until all of these are true:

1. `live.enabled: true` in `haelo.yaml`, then `haelo policy lock`.
2. The agent is on `micro` or `standard` (or a human approved a `propose` order).
3. The tool call includes `confirm: true`.
4. A signer is configured.

The paper rung calls the same QuoterV2 and does not sign or broadcast. Shadow uses those quotes inside the simulated ledger.

Every live order still runs the existing rails: per-order and daily notional caps, symbol allow and deny lists, order type, and `rails.maxSlippageBps` (default 100, which is 1%). A larger `slippage_bps` is a breach. The router is approved for the exact `amountIn` of that swap, never unlimited. The swap is simulated with `eth_call` before it is broadcast. The transaction hash is stored on the order and in the audit chain.

`broker.maxConsecutiveErrors` (default 3) drops the agent to shadow after that many live send failures in a row. Drawdown demotion still applies. `haelo panic` and the MCP tool `haelo_kill_switch` drop the agent to shadow. A Uniswap swap that has already been mined cannot be cancelled.

## Tool call

```json
{
  "name": "place_order",
  "arguments": {
    "symbol": "WETH/USDG",
    "side": "buy",
    "type": "market",
    "notional_usd": 25,
    "slippage_bps": 50,
    "confirm": true,
    "rationale": "example"
  }
}
```

Sells take `qty` of the base token. Buys take `notional_usd` of USDG. Other symbols can be added under `broker.tokens` as symbol-to-address pairs you have checked yourself.

## Risks

- This sends real tokens on mainnet once you opt in. A bad quote, a thin pool, or a token you added yourself can lose money.
- The public RPC is rate limited. A failed simulation does not broadcast, but a successful simulation can still revert if the pool moves before inclusion.
- Testnet is not a rehearsal for this path until Uniswap publishes testnet addresses.
- Haelo does not wrap ETH, route through a prop AMM, or place limit orders on this chain.
