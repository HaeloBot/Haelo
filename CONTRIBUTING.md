# Contributing

Thanks for helping. Haelo is safety-critical in a narrow sense (it sits between an agent and money), so the bar is: **every behaviour has a test, and nothing claims to be verified unless it is.**

## Setup

```bash
git clone https://github.com/HaeloBot/haelo-solana && cd haelo
npm ci
npm run lint && npm run typecheck && npm test
npm run test:coverage   # CI fails below 90% lines
```

Node 22.13+ or 24 (`node:sqlite`). `npm test` builds `dist/` first (the stdio test spawns the compiled CLI).

## Ground rules

1. **The agent must never gain a way to promote itself, approve its own order, or change policy.** PRs that add an agent-facing tool will be checked against this.
2. **Fail closed.** If an order cannot be parsed, sized, or checked, refuse it.
3. **Policy logic stays pure** (`src/policy/evaluate.ts` takes data in and returns a verdict). Add a unit test, and a property test when there is an invariant ("no order above the cap ever passes").
4. **Honest docs.** If you add or change a broker adapter, say in the README's verification matrix what was checked against the real service and what only against a mock. Do not describe an assumption as a fact.
5. **No secrets** in code, tests, fixtures, logs or `.env.example`.
6. **No retries on order POSTs.**

## Adding a broker adapter

See [docs/SOLANA.md](docs/SOLANA.md). Venue code lives in `src/adapters/solana.ts` and `src/solana/`. Every change to signing or the pre-sign guard needs a test in `test/solana.test.ts` against the fake cluster in `test/helpers/fake-solana.ts`.

## Pull requests

Small, focused, with the checklist in the PR template. Commit messages in the imperative ("Block orders when household data is required but missing").
