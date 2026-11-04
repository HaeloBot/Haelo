import type { AssetClass, BrokerAccount, BrokerMode, BrokerOrder, BrokerPosition, Fill, HouseholdAccount, OrderIntent, Quote } from "../types.js";
import { BrokerError, type FetchFn } from "./types.js";
import { requestJson } from "./http.js";
import type { RestBroker } from "./rest-base.js";
import { num, round, uuid } from "../util.js";

export interface AlpacaCredentials {
  keyId: string;
  secret: string;
}

export interface AlpacaOptions {
  paper?: AlpacaCredentials;
  live?: AlpacaCredentials;
  paperBaseUrl?: string;
  liveBaseUrl?: string;
  dataBaseUrl?: string;
  feed?: "iex" | "sip" | "delayed_sip";
  fallbackSpreadBps?: number;
  fetch?: FetchFn;
  now?: () => Date;
}

interface AlpacaOrderJson {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type?: string;
  order_type?: string;
  status: string;
  qty?: string | null;
  notional?: string | null;
  filled_qty?: string | null;
  filled_avg_price?: string | null;
  submitted_at?: string | null;
  filled_at?: string | null;
  asset_class?: string;
}

/**
 * Alpaca Trading API v2 + Market Data API v2 client. Real HTTP against the documented endpoints:
 *   POST/GET/DELETE /v2/orders, GET /v2/account, GET /v2/positions,
 *   GET data.alpaca.markets/v2/stocks/{symbol}/quotes/latest and /v1beta3/crypto/us/latest/quotes.
 * Paper and live use separate base URLs and credentials. See README for what is verified against real Alpaca.
 */
export class AlpacaBroker implements RestBroker {
  readonly id = "alpaca";
  readonly supportsPaper = true;
  private readonly o: Required<Pick<AlpacaOptions, "paperBaseUrl" | "liveBaseUrl" | "dataBaseUrl" | "feed" | "fallbackSpreadBps">> & AlpacaOptions;

  constructor(opts: AlpacaOptions) {
    this.o = {
      paperBaseUrl: "https://paper-api.alpaca.markets",
      liveBaseUrl: "https://api.alpaca.markets",
      dataBaseUrl: "https://data.alpaca.markets",
      feed: "iex",
      fallbackSpreadBps: 10,
      ...opts,
    };
  }

  private creds(mode: BrokerMode): AlpacaCredentials {
    const c = mode === "paper" ? this.o.paper : this.o.live;
    if (!c) throw new BrokerError(`No Alpaca ${mode} credentials configured (see .env.example).`);
    return c;
  }

  private headers(c: AlpacaCredentials): Record<string, string> {
    return { "APCA-API-KEY-ID": c.keyId, "APCA-API-SECRET-KEY": c.secret, accept: "application/json" };
  }

  private trading(mode: BrokerMode, method: string, path: string, body?: unknown): Promise<unknown> {
    const c = this.creds(mode);
    const base = mode === "paper" ? this.o.paperBaseUrl : this.o.liveBaseUrl;
    return requestJson(
      base + path,
      {
        method,
        headers: { ...this.headers(c), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      this.o.fetch ? { fetch: this.o.fetch } : {},
    );
  }

  /** Market data needs credentials too; paper keys work for data. */
  private data(path: string, query: Record<string, string>): Promise<unknown> {
    const c = this.o.paper ?? this.o.live;
    if (!c) throw new BrokerError("No Alpaca credentials configured for market data.");
    const qs = new URLSearchParams(query).toString();
    return requestJson(`${this.o.dataBaseUrl}${path}${qs ? `?${qs}` : ""}`, { method: "GET", headers: this.headers(c) }, this.o.fetch ? { fetch: this.o.fetch } : {});
  }

  static normaliseSymbol(symbol: string): string {
    const s = symbol.trim().toUpperCase();
    if (/^[A-Z0-9]+-USD[CT]?$/.test(s)) return s.replace("-", "/");
    return s;
  }

  async getQuote(symbolIn: string): Promise<Quote> {
    const symbol = AlpacaBroker.normaliseSymbol(symbolIn);
    const spread = this.o.fallbackSpreadBps / 10_000;
    if (symbol.includes("/")) {
      const res = (await this.data("/v1beta3/crypto/us/latest/quotes", { symbols: symbol })) as { quotes?: Record<string, { ap?: number; bp?: number; t?: string }> };
      const q = res.quotes?.[symbol];
      if (!q) throw new BrokerError(`No crypto quote returned for ${symbol}`);
      return toQuote(symbol, q.bp, q.ap, q.t, spread);
    }
    const res = (await this.data(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`, { feed: this.o.feed })) as { quote?: { ap?: number; bp?: number; t?: string } };
    const q = res.quote;
    if (q && (q.ap ?? 0) > 0 && (q.bp ?? 0) > 0) return toQuote(symbol, q.bp, q.ap, q.t, spread);
    // Quotes can be zero outside market hours on the free feed; fall back to the last trade.
    const tr = (await this.data(`/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`, { feed: this.o.feed })) as { trade?: { p?: number; t?: string } };
    const p = tr.trade?.p;
    if (!p || p <= 0) throw new BrokerError(`No usable quote or trade for ${symbol}`);
    return { symbol, bid: round(p * (1 - spread / 2), 6), ask: round(p * (1 + spread / 2), 6), mid: p, ts: tr.trade?.t ?? (this.o.now?.() ?? new Date()).toISOString() };
  }

  /** Raw account flags for `leash doctor`: is the account active and allowed to trade? */
  async accountStatus(mode: BrokerMode): Promise<{ status: string; tradingBlocked: boolean; accountBlocked: boolean; patternDayTrader: boolean; accountNumber: string }> {
    const a = (await this.trading(mode, "GET", "/v2/account")) as Record<string, unknown>;
    return {
      status: String(a["status"] ?? "UNKNOWN"),
      tradingBlocked: a["trading_blocked"] === true,
      accountBlocked: a["account_blocked"] === true,
      patternDayTrader: a["pattern_day_trader"] === true,
      accountNumber: String(a["account_number"] ?? ""),
    };
  }

  async getAccount(mode: BrokerMode): Promise<BrokerAccount> {
    const a = (await this.trading(mode, "GET", "/v2/account")) as Record<string, unknown>;
    return {
      id: String(a["account_number"] ?? a["id"] ?? "alpaca"),
      equity: num(a["equity"]) ?? 0,
      cash: num(a["cash"]) ?? 0,
      buyingPower: num(a["buying_power"]) ?? 0,
      currency: String(a["currency"] ?? "USD"),
    };
  }

  async getPositions(mode: BrokerMode): Promise<BrokerPosition[]> {
    const rows = (await this.trading(mode, "GET", "/v2/positions")) as Array<Record<string, unknown>>;
    return rows.map((p) => {
      const crypto = String(p["asset_class"] ?? "") === "crypto";
      let symbol = String(p["symbol"] ?? "");
      if (crypto && !symbol.includes("/") && symbol.endsWith("USD")) symbol = `${symbol.slice(0, -3)}/USD`;
      return {
        symbol,
        qty: num(p["qty"]) ?? 0,
        avgEntryPrice: num(p["avg_entry_price"]) ?? 0,
        marketValue: num(p["market_value"]) ?? 0,
        assetClass: (crypto ? "crypto" : "equity") as AssetClass,
      };
    });
  }

  async listOrders(mode: BrokerMode): Promise<BrokerOrder[]> {
    const rows = (await this.trading(mode, "GET", "/v2/orders?status=all&limit=50&direction=desc")) as AlpacaOrderJson[];
    return rows.map(toOrder);
  }

  async placeOrder(mode: BrokerMode, intent: OrderIntent): Promise<BrokerOrder> {
    const symbol = AlpacaBroker.normaliseSymbol(intent.symbol);
    const crypto = symbol.includes("/");
    const body: Record<string, unknown> = {
      symbol,
      side: intent.side,
      type: intent.type,
      time_in_force: crypto ? "gtc" : (intent.timeInForce ?? "day"),
      client_order_id: intent.clientOrderId ?? uuid(),
    };
    if (intent.type === "limit") {
      if (intent.limitPrice === undefined) throw new BrokerError("limit order needs limit_price");
      body["limit_price"] = String(intent.limitPrice);
    }
    if (intent.qty !== undefined) body["qty"] = String(round(intent.qty, 9));
    else if (intent.notionalUsd !== undefined) {
      if (intent.type === "market") {
        body["notional"] = String(round(intent.notionalUsd, 2));
        if (!crypto) body["time_in_force"] = "day"; // Alpaca: notional orders must be day for equities
      } else {
        // Alpaca accepts notional only for market orders: convert to a quantity at the limit price.
        const px = intent.limitPrice;
        if (!px) throw new BrokerError("cannot convert notional without a limit price");
        body["qty"] = String(round(intent.notionalUsd / px, 9));
      }
    } else throw new BrokerError("order needs qty or notional");
    const res = (await this.trading(mode, "POST", "/v2/orders", body)) as AlpacaOrderJson;
    return toOrder(res);
  }

  async cancelOrder(mode: BrokerMode, orderId: string): Promise<void> {
    await this.trading(mode, "DELETE", `/v2/orders/${encodeURIComponent(orderId)}`);
  }

  async cancelAll(mode: BrokerMode): Promise<number> {
    const res = (await this.trading(mode, "DELETE", "/v2/orders")) as Array<{ status?: number }> | undefined;
    return Array.isArray(res) ? res.filter((r) => (r.status ?? 200) < 300).length : 0;
  }

  async householdView(mode: BrokerMode): Promise<HouseholdAccount[]> {
    const [acct, positions, rows] = await Promise.all([
      this.getAccount(mode),
      this.getPositions(mode),
      this.trading(mode, "GET", `/v2/orders?status=closed&limit=500&direction=desc&after=${encodeURIComponent(new Date(((this.o.now?.() ?? new Date()).getTime()) - 70 * 86_400_000).toISOString())}`) as Promise<AlpacaOrderJson[]>,
    ]);
    const fills: Fill[] = [];
    for (const o of rows) {
      const qty = num(o.filled_qty) ?? 0;
      const px = num(o.filled_avg_price);
      if (qty > 0 && px && o.filled_at) {
        fills.push({
          symbol: o.symbol,
          side: o.side,
          qty,
          price: px,
          ts: o.filled_at,
          assetClass: o.asset_class === "crypto" ? "crypto" : "equity",
        });
      }
    }
    return [{ id: acct.id, label: `alpaca ${mode}`, isAgentAccount: true, equity: acct.equity, positions, fills }];
  }
}

function toQuote(symbol: string, bp: number | undefined, ap: number | undefined, t: string | undefined, spread: number): Quote {
  const ts = t ?? new Date().toISOString();
  if (bp && ap && bp > 0 && ap > 0) return { symbol, bid: bp, ask: ap, mid: round((bp + ap) / 2, 8), ts };
  const px = ap && ap > 0 ? ap : bp && bp > 0 ? bp : undefined;
  if (!px) throw new BrokerError(`Quote for ${symbol} has no usable bid or ask`);
  return { symbol, bid: round(px * (1 - spread / 2), 8), ask: round(px * (1 + spread / 2), 8), mid: px, ts };
}

function toOrder(o: AlpacaOrderJson): BrokerOrder {
  const qty = num(o.qty);
  const notional = num(o.notional);
  const avg = num(o.filled_avg_price);
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    type: o.type ?? o.order_type ?? "market",
    status: o.status,
    ...(qty !== undefined ? { qty } : {}),
    ...(notional !== undefined ? { notionalUsd: notional } : {}),
    filledQty: num(o.filled_qty) ?? 0,
    ...(avg !== undefined && avg > 0 ? { filledAvgPrice: avg } : {}),
    ...(o.submitted_at ? { submittedAt: o.submitted_at } : {}),
    ...(o.filled_at ? { filledAt: o.filled_at } : {}),
  };
}
