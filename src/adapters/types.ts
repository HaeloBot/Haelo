import type { Args, BrokerAccount, BrokerMode, BrokerOrder, BrokerPosition, HouseholdAccount, OrderIntent, Quote, ToolDef, ToolResult } from "../types.js";
import type { Classification } from "../classify.js";

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

/**
 * What the gateway needs from a broker. Two shapes implement it: REST brokers (Alpaca, Robinhood Crypto API),
 * which expose a small native tool set, and MCP upstreams, whose tools are passed through and classified.
 */
export interface BrokerAdapter {
  readonly id: string;
  /** True if the broker has a separate paper environment the paper rung can use. */
  readonly supportsPaper: boolean;
  /** True if the tool list comes from a remote server and can change (so it must be pinned). */
  readonly dynamicTools: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<ToolDef[]>;
  classify(tool: ToolDef): Classification;
  /** Run a read-only tool. `mode` selects paper or live data for brokers that have both. */
  callRead(name: string, args: Args, mode: BrokerMode): Promise<ToolResult>;
  /** Parse an order out of a tool call. Undefined when the call cannot be understood (the gateway then refuses it). */
  parseOrder(name: string, args: Args): OrderIntent | undefined;
  /** Send an order for real (paper or live). */
  executeOrder(name: string, args: Args, intent: OrderIntent, mode: BrokerMode): Promise<ToolResult>;
  /** Cancel one order or all open orders for the tool name given. */
  executeCancel(name: string, args: Args, mode: BrokerMode): Promise<ToolResult>;
  quote(symbol: string): Promise<Quote>;
  /** Account summary used for drawdown tracking. Undefined if this broker cannot supply it. */
  getAccount(mode: BrokerMode): Promise<BrokerAccount | undefined>;
  getPositions(mode: BrokerMode): Promise<BrokerPosition[]>;
  listOrders(mode: BrokerMode): Promise<BrokerOrder[]>;
  /** Every account this login can read. Used by the household checks. */
  householdView(mode: BrokerMode): Promise<HouseholdAccount[]>;
  /** Cancel every open order. Used on demotion and panic. Returns how many were cancelled. */
  cancelAllOpen(mode: BrokerMode): Promise<number>;
  /** Names of tools that read shadow-able account state (answered from the shadow ledger at the shadow rung). */
  readonly shadowReadTools: { account?: string; positions?: string; orders?: string };
}

/** Minimal fetch type so tests can inject a stub. */
export type FetchFn = typeof fetch;
