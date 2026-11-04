import type { Args, AssetClass, Effect, OrderIntent, OrderType, Side, ToolDef } from "./types.js";
import { num } from "./util.js";

const tokens = (name: string): string[] =>
  name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const TRANSFER = new Set(["transfer", "withdraw", "withdrawal", "deposit", "ach", "wire", "stake", "unstake", "lend", "journal", "payout", "send"]);
const PREVIEW = new Set(["preview", "estimate", "simulate", "dry", "validate", "review", "quote", "check"]);
const ACTION = new Set(["place", "submit", "create", "execute", "replace", "modify", "amend", "exercise", "buy", "sell", "liquidate"]);
const ORDER_NOUN = new Set(["order", "orders", "trade", "trades", "option", "options", "spread", "position", "exercise", "buy", "sell", "liquidate"]);
const READ_VERB = new Set(["get", "list", "search", "find", "fetch", "read", "view", "show", "lookup", "describe", "query", "preview", "estimate", "calculate", "scan", "quote", "check", "explain", "history", "retrieve", "summarize"]);
const UNTRUSTED = new Set(["news", "filing", "filings", "sec", "transcript", "transcripts", "note", "notes", "analyst", "analysts", "article", "articles", "description", "earnings", "social", "comment", "comments", "rss", "headline", "headlines", "memo", "search", "research"]);

export interface Classification {
  effect: Effect;
  /** True when the tool returns text written by third parties (news, filings, notes). */
  untrustedText: boolean;
  reason: string;
}

export type EffectOverride = "read" | "order_place" | "order_cancel" | "transfer" | "blocked";

/**
 * Classify an upstream tool by name. Annotations are advisory hints from the server and are NOT trusted:
 * a name that looks like an order always wins over `readOnlyHint`. Anything unmatched is `unknown` (blocked).
 */
export function classifyTool(tool: Pick<ToolDef, "name" | "annotations">, overrides: Record<string, EffectOverride> = {}): Classification {
  const t = tokens(tool.name);
  const set = new Set(t);
  const untrustedText = t.some((x) => UNTRUSTED.has(x));
  const ov = overrides[tool.name];
  if (ov) return { effect: ov === "blocked" ? "unknown" : ov, untrustedText, reason: `override for ${tool.name}` };

  if (t.some((x) => TRANSFER.has(x))) return { effect: "transfer", untrustedText, reason: "name mentions a money-movement verb" };
  if (set.has("cancel")) return { effect: "order_cancel", untrustedText, reason: "name contains cancel" };
  if ((set.has("close") || set.has("open")) && (set.has("position") || set.has("positions"))) {
    return { effect: "order_place", untrustedText, reason: "name opens or closes a position" };
  }
  const isPreview = t.some((x) => PREVIEW.has(x));
  if (!isPreview && t.some((x) => ACTION.has(x)) && t.some((x) => ORDER_NOUN.has(x))) {
    return { effect: "order_place", untrustedText, reason: "name looks like order placement" };
  }
  if (t[0] && READ_VERB.has(t[0])) return { effect: "read", untrustedText, reason: `read verb "${t[0]}"` };
  if (isPreview && t.some((x) => READ_VERB.has(x) || PREVIEW.has(x))) return { effect: "read", untrustedText, reason: "preview/estimate tool" };
  return { effect: "unknown", untrustedText, reason: "name did not match any known pattern; blocked by default" };
}

// ---- Order intent extraction (best effort for upstream tools whose argument names are undocumented) ----

const SYMBOL_KEYS = ["symbol", "ticker", "instrument", "instrument_symbol", "asset", "pair", "currency_pair", "symbol_pair", "underlying", "underlying_symbol", "asset_code"];
const SIDE_KEYS = ["side", "direction", "action", "transaction_type"];
const QTY_KEYS = ["quantity", "qty", "shares", "asset_quantity", "size", "contracts", "amount_of_asset"];
const NOTIONAL_KEYS = ["notional", "notional_usd", "dollar_amount", "dollars", "quote_amount", "cash_amount", "usd", "amount_usd", "amount"];
const TYPE_KEYS = ["type", "order_type"];
const LIMIT_KEYS = ["limit_price", "price", "limit"];
const STOP_KEYS = ["stop_price", "stop"];
const ACCOUNT_KEYS = ["account_number", "account", "account_id", "account_no"];
const TIF_KEYS = ["time_in_force", "tif"];

/** Depth-first search for the first value under any of `keys`, including nested `*_order_config` objects. */
function findKey(obj: unknown, keys: string[], depth = 0): unknown {
  if (depth > 4 || !obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  const lower = new Map(Object.keys(rec).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k);
    if (real !== undefined && rec[real] !== undefined && rec[real] !== null) return rec[real];
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") {
      const r = findKey(v, keys, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function firstString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (Array.isArray(v) && typeof v[0] === "string") return v[0].trim();
  return undefined;
}

export function normaliseSide(v: unknown): Side | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["buy", "bid", "long", "buy_to_open", "buy_to_close"].includes(s)) return "buy";
  if (["sell", "ask", "short", "sell_to_open", "sell_to_close"].includes(s)) return "sell";
  return undefined;
}

function normaliseType(v: unknown): OrderType {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/[-\s]/g, "_") : "market";
  if (s === "limit") return "limit";
  if (s === "stop" || s === "stop_loss" || s === "stop_market") return "stop";
  if (s === "stop_limit") return "stop_limit";
  return s === "market" || s === "" ? "market" : "stop_limit";
}

export function detectAssetClass(name: string, args: Args, symbol: string): AssetClass {
  const n = name.toLowerCase();
  if (n.includes("option") || findKey(args, ["strike", "strike_price", "expiration", "expiration_date", "option_id", "option_type"]) !== undefined) return "option";
  if (n.includes("crypto") || symbol.includes("/") || /-USD[CT]?$/i.test(symbol)) return "crypto";
  if (n.includes("equity") || n.includes("stock")) return "equity";
  return symbol ? "equity" : "unknown";
}

/** Extract an order intent from a tool call. Returns undefined when the call has no readable symbol and side. */
export function extractIntent(name: string, args: Args): OrderIntent | undefined {
  const symbol = firstString(findKey(args, SYMBOL_KEYS));
  const side = normaliseSide(findKey(args, SIDE_KEYS));
  if (!symbol || !side) return undefined;
  const sym = symbol.toUpperCase();
  const intent: OrderIntent = {
    symbol: sym,
    side,
    type: normaliseType(findKey(args, TYPE_KEYS)),
    assetClass: detectAssetClass(name, args, sym),
  };
  const qty = num(findKey(args, QTY_KEYS));
  const notional = num(findKey(args, NOTIONAL_KEYS));
  const limit = num(findKey(args, LIMIT_KEYS));
  const stop = num(findKey(args, STOP_KEYS));
  if (qty !== undefined) intent.qty = qty;
  if (notional !== undefined) intent.notionalUsd = notional;
  if (limit !== undefined) intent.limitPrice = limit;
  if (stop !== undefined) intent.stopPrice = stop;
  const tif = findKey(args, TIF_KEYS);
  if (typeof tif === "string") intent.timeInForce = tif;
  const acct = findKey(args, ACCOUNT_KEYS);
  if (typeof acct === "string" || typeof acct === "number") intent.account = String(acct);
  const coid = findKey(args, ["client_order_id", "client_id"]);
  if (typeof coid === "string") intent.clientOrderId = coid;
  return intent;
}
