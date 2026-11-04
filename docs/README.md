# Haelo docs

The gateway is an MCP server. These notes match the code in `src/`.

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How a tool call is classified, checked, routed, and audited |
| [POLICY.md](POLICY.md) | Every field in `haelo.yaml` |
| [GO_LIVE.md](GO_LIVE.md) | The checklist before `live.enabled: true` |
| [ADAPTERS.md](ADAPTERS.md) | Alpaca, Robinhood Crypto, and an upstream MCP |
| [ZAUTH.md](ZAUTH.md) | What a repository scan can and cannot claim |
| [../SECURITY.md](../SECURITY.md) | Threat model and how to report a vulnerability |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Tests, fail-closed rules, pull requests |

The website in `website/` is a separate Vite app. It imports the policy engine so the playground matches the CLI. It does not hold broker keys. The contract address for the `$HAELO` page is `website/public/config.json`.
