import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { BrokerAccount, BrokerMode, BrokerOrder, BrokerPosition, Fill, HouseholdAccount, OrderIntent, Quote } from "../types.js";
import { BrokerError, type FetchFn } from "./types.js";
import { requestJson } from "./http.js";
import type { RestBroker } from "./rest-base.js";
import { num, round, uuid } from "../util.js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface RobinhoodCryptoOptions {
  apiKey: string;
  /** Base64 of the 32-byte Ed25519 private key seed, as produced by the official docs' key script. */
  privateKeyBase64: string;
  apiVersion?: "v1" | "v2";
  baseUrl?: string;
  fetch?: FetchFn;
  now?: () => Date;
}

/** Build an Ed25519 private key from the base64 seed Robinhood's docs tell you to generate. */
export function privateKeyFromSeed(seedBase64: string): KeyObject {
  const seed = Buffer.from(seedBase64, "base64");
  if (seed.length !== 32) throw new Error("Robinhood private key must be a base64-encoded 32-byte Ed25519 seed.");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** Sign `message` with Ed25519 and return base64. This is the primitive behind the x-signature header. */
export function signMessage(key: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, "utf8"), key).toString("base64");
}

/** message = api_key + timestamp + path (including query) + method + body, per Robinhood's docs. */
export function buildSigningMessage(apiKey: string, timestamp: string | number, path: string, method: string, body: string): string {
  return `${apiKey}${timestamp}${path}${method}${body}`;
}

/**
 * Serialise like Python's json.dumps defaults (", " and ": " separators). Robinhood's official example
 * script signs `json.dumps(body)` and sends it with `requests`, so we sign and send exactly these bytes.
 */
export function pythonStyleJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonStyleJson).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}: ${pythonStyleJson(v)}`)
    .join(", ")}}`;
}

interface RhPage<T> {
  next?: string | null;
  results?: T[];
}

/**
 * Robinhood Crypto Trading API client (https://docs.robinhood.com/crypto/trading/), v1 and v2.
 * Signing is verified offline against the signature in the official docs (see test/robinhood-crypto.test.ts).
 * Everything else is verified only against a local mock server, because the API is US-only and needs a
 * funded Robinhood account. There is no paper environment, so this adapter has no paper rung.
 */
export class RobinhoodCryptoBroker implements RestBroker {
  readonly id = "robinhood-crypto";
  readonly supportsPaper = false;
  private readonly key: KeyObject;
  private readonly base: string;
  private readonly v: "v1" | "v2";
  private accountNumber: string | undefined;
  private pairs = new Map<string, { assetIncrement: number; quoteIncrement: number; minOrder?: number }>();

  constructor(private readonly o: RobinhoodCryptoOptions) {
    this.key = privateKeyFromSeed(o.privateKeyBase64);
    this.base = (o.baseUrl ?? "https://trading.robinhood.com").replace(/\/$/, "");
    this.v = o.apiVersion ?? "v1";
  }

  private async call(method: "GET" | "POST", path: string, bodyObj?: unknown): Promise<unknown> {
    const ts = String(Math.floor((this.o.now?.() ?? new Date()).getTime() / 1000));
    const body = bodyObj === undefined ? "" : pythonStyleJson(bodyObj);
    const signature = signMessage(this.key, buildSigningMessage(this.o.apiKey, ts, path, method, body));
    return requestJson(
      this.base + path,
      {
        method,
        headers: {
          "x-api-key": this.o.apiKey,
          "x-signature": signature,
          "x-timestamp": ts,
          "content-type": "application/json; charset=utf-8",
        },
        ...(body ? { body } : {}),
      },
      this.o.fetch ? { fetch: this.o.fetch } : {},
    );
  }

  private async paged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null | undefined = path;
    for (let i = 0; next && i < 20; i++) {
      const res = (await this.call("GET", next)) as RhPage<T>;
      out.push(...(res.results ?? []));
      next = res.next ? nextPath(res.next) : undefined;
    }
    return out;
  }

  private async account(): Promise<{ account_number?: string; buying_power?: string; buying_power_currency?: string; status?: string }> {
    if (this.v === "v1") return (await this.call("GET", "/api/v1/crypto/trading/accounts/")) as { account_number?: string; buying_power?: string };
    const rows = await this.paged<{ account_number?: string; buying_power?: string; buying_power_currency?: string; is_api_tradable?: boolean }>("/api/v2/crypto/trading/accounts/");
    const acct = rows.find((r) => r.is_api_tradable !== false) ?? rows[0];
    if (!acct) throw new BrokerError("No Robinhood crypto account returned");
    return acct;
  }

  private async acctNumber(): Promise<string> {
    if (this.accountNumber) return this.accountNumber;
    const a = await this.account();
    if (!a.account_number) throw new BrokerError("Robinhood did not return an account_number");
    this.accountNumber = a.account_number;
    return this.accountNumber;
  }

  static toPair(symbol: string): string {
    const s = symbol.trim().toUpperCase().replace("/", "-");
    return s.includes("-") ? s : `${s}-USD`;
  }

  async getQuote(symbolIn: string): Promise<Quote> {
    const symbol = RobinhoodCryptoBroker.toPair(symbolIn);
    const res = (await this.call("GET", `/api/${this.v}/crypto/marketdata/best_bid_ask/?symbol=${encodeURIComponent(symbol)}`)) as {
      results?: Array<Record<string, unknown>>;
    };
    const r = res.results?.[0];
    if (!r) throw new BrokerError(`No quote returned for ${symbol}`);
    const bid = num(r["bid_inclusive_of_sell_spread"]) ?? num(r["bid_price"]) ?? num(r["bid"]) ?? num(r["price"]);
    const ask = num(r["ask_inclusive_of_buy_spread"]) ?? num(r["ask_price"]) ?? num(r["ask"]) ?? num(r["price"]);
    if (!bid || !ask) throw new BrokerError(`Quote for ${symbol} has no usable bid/ask`);
    return { symbol, bid, ask, mid: round((bid + ask) / 2, 8), ts: String(r["timestamp"] ?? (this.o.now?.() ?? new Date()).toISOString()) };
  }

  async getAccount(_mode: BrokerMode): Promise<BrokerAccount> {
    const a = await this.account();
    const bp = num(a.buying_power) ?? 0;
    const holdings = await this.getPositions("live");
    const held = holdings.reduce((s, p) => s + p.marketValue, 0);
    return { id: a.account_number ?? "robinhood-crypto", equity: bp + held, cash: bp, buyingPower: bp, currency: a.buying_power_currency ?? "USD" };
  }

  async getPositions(_mode: BrokerMode): Promise<BrokerPosition[]> {
    const q = this.v === "v2" ? `?account_number=${encodeURIComponent(await this.acctNumber())}` : "";
    const rows = await this.paged<{ asset_code: string; total_quantity: string | number }>(`/api/${this.v}/crypto/trading/holdings/${q}`);
    const out: BrokerPosition[] = [];
    for (const h of rows) {
      const qty = num(h.total_quantity) ?? 0;
      if (qty <= 0) continue;
      let px = 0;
      try {
        px = (await this.getQuote(`${h.asset_code}-USD`)).mid;
      } catch {
        /* leave unpriced */
      }
      out.push({ symbol: `${h.asset_code}-USD`, qty, avgEntryPrice: 0, marketValue: qty * px, assetClass: "crypto" });
    }
    return out;
  }

  private async ordersRaw(): Promise<Array<Record<string, unknown>>> {
    const q = this.v === "v2" ? `?account_number=${encodeURIComponent(await this.acctNumber())}&created_at_start=${encodeURIComponent(new Date(((this.o.now?.() ?? new Date()).getTime()) - 70 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"))}` : "";
    return this.paged<Record<string, unknown>>(`/api/${this.v}/crypto/trading/orders/${q}`);
  }

  async listOrders(_mode: BrokerMode): Promise<BrokerOrder[]> {
    return (await this.ordersRaw()).slice(0, 50).map(toOrder);
  }

  private async pair(symbol: string): Promise<{ assetIncrement: number; quoteIncrement: number; minOrder?: number }> {
    const cached = this.pairs.get(symbol);
    if (cached) return cached;
    const rows = await this.paged<Record<string, unknown>>(`/api/${this.v}/crypto/trading/trading_pairs/?symbol=${encodeURIComponent(symbol)}`);
    const r = rows.find((x) => x["symbol"] === symbol);
    if (!r) throw new BrokerError(`${symbol} is not a tradable Robinhood crypto pair`);
    const info = { assetIncrement: num(r["asset_increment"]) ?? 1e-8, quoteIncrement: num(r["quote_increment"]) ?? 0.01, ...(num(r["min_order_size"] ?? r["min_order_amount"]) !== undefined ? { minOrder: num(r["min_order_size"] ?? r["min_order_amount"]) as number } : {}) };
    this.pairs.set(symbol, info);
    return info;
  }

  async placeOrder(_mode: BrokerMode, intent: OrderIntent): Promise<BrokerOrder> {
    const symbol = RobinhoodCryptoBroker.toPair(intent.symbol);
    const info = await this.pair(symbol);
    const roundQty = (q: number): string => {
      const dp = Math.max(0, Math.round(-Math.log10(info.assetIncrement)));
      const stepped = Math.floor(q / info.assetIncrement + 1e-9) * info.assetIncrement;
      return stepped.toFixed(dp);
    };
    let qty = intent.qty;
    if (qty === undefined && intent.notionalUsd !== undefined) {
      const px = intent.limitPrice ?? (await this.getQuote(symbol))[intent.side === "buy" ? "ask" : "bid"];
      qty = intent.notionalUsd / px;
    }
    if (qty === undefined || !(qty > 0)) throw new BrokerError("order needs a positive quantity");
    const assetQuantity = roundQty(qty);
    const body: Record<string, unknown> = { client_order_id: intent.clientOrderId ?? uuid(), side: intent.side, type: intent.type === "limit" ? "limit" : "market", symbol };
    if (intent.type === "limit") {
      if (intent.limitPrice === undefined) throw new BrokerError("limit order needs limit_price");
      body["limit_order_config"] = { asset_quantity: assetQuantity, limit_price: String(intent.limitPrice), time_in_force: "gtc" };
    } else {
      body["market_order_config"] = { asset_quantity: assetQuantity };
    }
    const path = this.v === "v2" ? `/api/v2/crypto/trading/orders/?account_number=${encodeURIComponent(await this.acctNumber())}` : "/api/v1/crypto/trading/orders/";
    return toOrder((await this.call("POST", path, body)) as Record<string, unknown>);
  }

  async cancelOrder(_mode: BrokerMode, orderId: string): Promise<void> {
    await this.call("POST", `/api/${this.v}/crypto/trading/orders/${encodeURIComponent(orderId)}/cancel/`);
  }

  async cancelAll(_mode: BrokerMode): Promise<number> {
    const open = (await this.ordersRaw()).filter((o) => o["state"] === "open" || o["state"] === "partially_filled");
    let n = 0;
    for (const o of open) {
      try {
        await this.cancelOrder("live", String(o["id"]));
        n++;
      } catch {
        /* keep cancelling the rest */
      }
    }
    return n;
  }

  async householdView(mode: BrokerMode): Promise<HouseholdAccount[]> {
    const [acct, positions, orders] = await Promise.all([this.getAccount(mode), this.getPositions(mode), this.ordersRaw()]);
    const fills: Fill[] = [];
    for (const o of orders) {
      const execs = Array.isArray(o["executions"]) ? (o["executions"] as Array<Record<string, unknown>>) : [];
      for (const e of execs) {
        const qty = num(e["quantity"]);
        const px = num(e["effective_price"]);
        const ts = typeof e["timestamp"] === "string" ? e["timestamp"] : undefined;
        if (qty && px && ts) fills.push({ symbol: String(o["symbol"]), side: o["side"] === "sell" ? "sell" : "buy", qty, price: px, ts, assetClass: "crypto" });
      }
    }
    return [{ id: acct.id, label: "robinhood crypto", isAgentAccount: true, equity: acct.equity, positions, fills }];
  }
}

function toOrder(o: Record<string, unknown>): BrokerOrder {
  const cfg = (o["market_order_config"] ?? o["limit_order_config"] ?? o["stop_loss_order_config"] ?? o["stop_limit_order_config"] ?? {}) as Record<string, unknown>;
  const qty = num(cfg["asset_quantity"]);
  const avg = num(o["average_price"]);
  return {
    id: String(o["id"] ?? ""),
    symbol: String(o["symbol"] ?? ""),
    side: o["side"] === "sell" ? "sell" : "buy",
    type: String(o["type"] ?? "market"),
    status: String(o["state"] ?? "unknown"),
    ...(qty !== undefined ? { qty } : {}),
    ...(num(cfg["quote_amount"]) !== undefined ? { notionalUsd: num(cfg["quote_amount"]) as number } : {}),
    filledQty: num(o["filled_asset_quantity"]) ?? 0,
    ...(avg !== undefined && avg > 0 ? { filledAvgPrice: avg } : {}),
    ...(typeof o["created_at"] === "string" ? { submittedAt: o["created_at"] } : {}),
  };
}

/** Reduce a pagination `next` link to path+query so signing and the request always target our configured base URL. */
function nextPath(next: string): string {
  if (next.startsWith("/")) return next;
  const u = new URL(next);
  return `${u.pathname}${u.search}`;
}
