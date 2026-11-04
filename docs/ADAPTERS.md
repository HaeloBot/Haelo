# Writing a broker adapter

There are two levels.

## REST brokers: implement `RestBroker`

`src/adapters/rest-base.ts` defines the interface and wraps any `RestBroker` in a `RestAdapter` that exposes the same native tools (`get_account`, `get_positions`, `get_quote`, `list_orders`, `place_order`, `cancel_order`, `cancel_all_orders`) for every broker, so agents are portable.

```ts
interface RestBroker {
  id: string;
  supportsPaper: boolean;                       // false => the paper rung is skipped
  getQuote(symbol): Promise<Quote>;             // bid/ask/mid
  getAccount(mode: "paper" | "live"): Promise<BrokerAccount>;
  getPositions(mode): Promise<BrokerPosition[]>;
  listOrders(mode): Promise<BrokerOrder[]>;
  placeOrder(mode, intent: OrderIntent): Promise<BrokerOrder>;
  cancelOrder(mode, id): Promise<void>;
  cancelAll(mode): Promise<number>;
  householdView(mode): Promise<HouseholdAccount[]>;   // for cross-account preflight
}
```

Rules: use `requestJson` (timeouts; GET-only retries; **never retry POST**), throw `BrokerError` with the status, round quantities to the venue's increments, and never log credentials. See `alpaca.ts` and `robinhood-crypto.ts`.

## Everything else: implement `BrokerAdapter`

`mcp-upstream.ts` is the reference: it lists the upstream's tools, classifies them, parses orders from the upstream's own argument shapes, and executes them.

## Register it

Add a variant to `brokerSchema` (`src/policy/schema.ts`), a case in `buildAdapter` (`src/factory.ts`), a template in `src/templates.ts`, then tests: a local mock server, retry/no-retry behaviour, paper/live separation, error mapping. State in the README matrix what is verified against the real service.
