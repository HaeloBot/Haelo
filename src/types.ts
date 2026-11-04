/** What a tool call does to the world. Anything not classified is `unknown` and is blocked. */
export type Effect = "read" | "order_place" | "order_cancel" | "transfer" | "unknown";

/** The autonomy ladder, lowest to highest. */
export const RUNGS = ["shadow", "paper", "propose", "micro", "standard"] as const;
export type Rung = (typeof RUNGS)[number];

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type AssetClass = "equity" | "crypto" | "option" | "unknown";
export type BrokerMode = "paper" | "live";

export interface OrderIntent {
  symbol: string;
  side: Side;
  type: OrderType;
  qty?: number;
  notionalUsd?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: string;
  assetClass: AssetClass;
  /** Basis points of slippage the caller asked for. Policy refuses a value above `rails.maxSlippageBps`. */
  slippageBps?: number;
  /** Live Robinhood Chain swaps are refused unless this is true. */
  confirm?: boolean;
  /** Account the order targets, when the call names one. */
  account?: string;
  clientOrderId?: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  ts: string;
}

export interface BrokerAccount {
  id: string;
  equity: number;
  cash: number;
  buyingPower: number;
  currency: string;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  marketValue: number;
  assetClass: AssetClass;
}

export interface BrokerOrder {
  id: string;
  symbol: string;
  side: Side;
  type: string;
  status: string;
  qty?: number;
  notionalUsd?: number;
  filledQty: number;
  filledAvgPrice?: number;
  submittedAt?: string;
  filledAt?: string;
}

/** A fill, used by the household checks. */
export interface Fill {
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  ts: string;
  assetClass: AssetClass;
}

export interface TaxLot {
  symbol: string;
  qty: number;
  costBasisPerShare: number;
  acquiredAt: string;
}

/** One brokerage account the login can read. */
export interface HouseholdAccount {
  id: string;
  label?: string;
  /** True for the account the agent is allowed to trade in. */
  isAgentAccount: boolean;
  equity: number;
  positions: BrokerPosition[];
  fills: Fill[];
  lots?: TaxLot[];
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: string; [k: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type Args = Record<string, unknown>;

export function rungIndex(r: Rung): number {
  return RUNGS.indexOf(r);
}
