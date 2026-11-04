import type { Args, BrokerAccount, BrokerMode, BrokerOrder, BrokerPosition, HouseholdAccount, OrderIntent, Quote, ToolDef, ToolResult } from "../types.js";
import type { Classification } from "../classify.js";
import { extractIntent } from "../classify.js";
import type { BrokerAdapter } from "./types.js";
import { BrokerError } from "./types.js";
import { errorMessage } from "../util.js";

/** The native tool set every REST broker exposes. Names are the same across brokers so agents are portable. */
export const NATIVE_TOOLS: ToolDef[] = [
  {
    name: "get_account",
    description: "Get the trading account summary: equity, cash and buying power.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_positions",
    description: "List open positions with quantity, average entry price and market value.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_quote",
    description: "Get the latest bid and ask for a symbol (for example AAPL, BTC/USD or BTC-USD depending on broker).",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_orders",
    description: "List recent orders and their status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "place_order",
    description:
      "Place an order. Orders are routed through the Haelo autonomy ladder: depending on the current rung they may be simulated, sent to a paper account, held for human approval, or sent live under caps. Give either qty or notional_usd, not both.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        type: { type: "string", enum: ["market", "limit"], default: "market" },
        qty: { type: "number", exclusiveMinimum: 0 },
        notional_usd: { type: "number", exclusiveMinimum: 0 },
        limit_price: { type: "number", exclusiveMinimum: 0 },
        time_in_force: { type: "string", enum: ["day", "gtc"] },
        slippage_bps: { type: "number", minimum: 0, description: "Max slippage in basis points. Refused when it exceeds rails.maxSlippageBps." },
        confirm: { type: "boolean", description: "Required true to broadcast a live Robinhood Chain swap. Ignored by other brokers." },
        rationale: { type: "string", description: "Why you are placing this order. Stored in the audit log and shown to the human." },
      },
      required: ["symbol", "side"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "cancel_order",
    description: "Cancel an open order by id.",
    inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "cancel_all_orders",
    description: "Cancel every open order.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

export function jsonResult(data: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/** What a concrete REST broker has to provide. */
export interface RestBroker {
  readonly id: string;
  readonly supportsPaper: boolean;
  readonly shadowReadTools?: { account?: string; positions?: string; orders?: string };
  getQuote(symbol: string): Promise<Quote>;
  getAccount(mode: BrokerMode): Promise<BrokerAccount>;
  getPositions(mode: BrokerMode): Promise<BrokerPosition[]>;
  listOrders(mode: BrokerMode): Promise<BrokerOrder[]>;
  placeOrder(mode: BrokerMode, intent: OrderIntent): Promise<BrokerOrder>;
  cancelOrder(mode: BrokerMode, orderId: string): Promise<void>;
  cancelAll(mode: BrokerMode): Promise<number>;
  householdView(mode: BrokerMode): Promise<HouseholdAccount[]>;
}

/** Wraps a REST broker with the native tool set so it satisfies BrokerAdapter. */
export class RestAdapter implements BrokerAdapter {
  readonly dynamicTools = false;
  readonly shadowReadTools = { account: "get_account", positions: "get_positions", orders: "list_orders" };

  constructor(private readonly broker: RestBroker) {}

  get id(): string {
    return this.broker.id;
  }
  get supportsPaper(): boolean {
    return this.broker.supportsPaper;
  }

  async connect(): Promise<void> {
    /* REST brokers are stateless; credentials are checked on first call. */
  }
  async close(): Promise<void> {
    /* nothing to release */
  }

  async listTools(): Promise<ToolDef[]> {
    return NATIVE_TOOLS;
  }

  classify(tool: ToolDef): Classification {
    switch (tool.name) {
      case "place_order":
        return { effect: "order_place", untrustedText: false, reason: "native order tool" };
      case "cancel_order":
      case "cancel_all_orders":
        return { effect: "order_cancel", untrustedText: false, reason: "native cancel tool" };
      case "get_account":
      case "get_positions":
      case "get_quote":
      case "list_orders":
        return { effect: "read", untrustedText: false, reason: "native read tool" };
      default:
        return { effect: "unknown", untrustedText: false, reason: "not a native tool" };
    }
  }

  async callRead(name: string, args: Args, mode: BrokerMode): Promise<ToolResult> {
    try {
      switch (name) {
        case "get_account":
          return jsonResult(await this.broker.getAccount(mode));
        case "get_positions":
          return jsonResult({ positions: await this.broker.getPositions(mode) });
        case "list_orders":
          return jsonResult({ orders: await this.broker.listOrders(mode) });
        case "get_quote": {
          const symbol = typeof args["symbol"] === "string" ? args["symbol"] : "";
          if (!symbol) return jsonResult({ error: "symbol is required" }, true);
          return jsonResult(await this.broker.getQuote(symbol));
        }
        default:
          return jsonResult({ error: `unknown read tool ${name}` }, true);
      }
    } catch (e) {
      return brokerFailure(e);
    }
  }

  parseOrder(name: string, args: Args): OrderIntent | undefined {
    if (name !== "place_order") return extractIntent(name, args);
    const intent = extractIntent(name, args);
    if (!intent) return undefined;
    // Native tool argument names are known, so take them exactly rather than by search.
    const qty = typeof args["qty"] === "number" ? args["qty"] : undefined;
    const notional = typeof args["notional_usd"] === "number" ? args["notional_usd"] : undefined;
    delete intent.qty;
    delete intent.notionalUsd;
    if (qty !== undefined) intent.qty = qty;
    if (notional !== undefined) intent.notionalUsd = notional;
    if (qty !== undefined && notional !== undefined) return undefined; // ambiguous: refuse
    intent.type = args["type"] === "limit" ? "limit" : "market";
    if (typeof args["limit_price"] === "number") intent.limitPrice = args["limit_price"];
    else delete intent.limitPrice;
    if (typeof args["slippage_bps"] === "number") intent.slippageBps = args["slippage_bps"];
    intent.confirm = args["confirm"] === true;
    delete intent.stopPrice;
    return intent;
  }

  async executeOrder(_name: string, _args: Args, intent: OrderIntent, mode: BrokerMode): Promise<ToolResult> {
    try {
      return jsonResult(await this.broker.placeOrder(mode, intent));
    } catch (e) {
      return brokerFailure(e);
    }
  }

  async executeCancel(name: string, args: Args, mode: BrokerMode): Promise<ToolResult> {
    try {
      if (name === "cancel_all_orders") return jsonResult({ cancelled: await this.broker.cancelAll(mode) });
      const id = typeof args["order_id"] === "string" ? args["order_id"] : "";
      if (!id) return jsonResult({ error: "order_id is required" }, true);
      await this.broker.cancelOrder(mode, id);
      return jsonResult({ cancel_requested: id });
    } catch (e) {
      return brokerFailure(e);
    }
  }

  quote(symbol: string): Promise<Quote> {
    return this.broker.getQuote(symbol);
  }
  async getAccount(mode: BrokerMode): Promise<BrokerAccount | undefined> {
    return this.broker.getAccount(mode);
  }
  getPositions(mode: BrokerMode): Promise<BrokerPosition[]> {
    return this.broker.getPositions(mode);
  }
  listOrders(mode: BrokerMode): Promise<BrokerOrder[]> {
    return this.broker.listOrders(mode);
  }
  householdView(mode: BrokerMode): Promise<HouseholdAccount[]> {
    return this.broker.householdView(mode);
  }
  cancelAllOpen(mode: BrokerMode): Promise<number> {
    return this.broker.cancelAll(mode);
  }
}

function brokerFailure(e: unknown): ToolResult {
  if (e instanceof BrokerError) return jsonResult({ error: e.message, status: e.status, detail: e.body }, true);
  return jsonResult({ error: errorMessage(e) }, true);
}
