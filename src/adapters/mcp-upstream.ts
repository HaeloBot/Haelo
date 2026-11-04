import { VERSION } from "../version.js";
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Args, AssetClass, BrokerAccount, BrokerMode, BrokerOrder, BrokerPosition, Fill, HouseholdAccount, OrderIntent, Quote, TaxLot, ToolDef, ToolResult } from "../types.js";
import { classifyTool, extractIntent, type Classification, type EffectOverride } from "../classify.js";
import { BrokerError, type BrokerAdapter } from "./types.js";
import { collectResultText } from "../injection.js";
import type { SecretOAuthProvider } from "../oauth.js";
import { errorMessage, num, round } from "../util.js";

export interface McpUpstreamOptions {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  bearerToken?: string;
  oauth?: SecretOAuthProvider;
  quoteTools?: { equity?: string; crypto?: string };
  accountTool?: string;
  positionsTool?: string;
  ordersTool?: string;
  taxLotsTool?: string;
  cancelAllTool?: string;
  toolOverrides?: Record<string, EffectOverride>;
  accountId?: string;
  fallbackSpreadBps?: number;
  name?: string;
}

const tok = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Proxy to an upstream MCP server (Robinhood's official agentic-trading MCP at agent.robinhood.com/mcp/trading,
 * or any other). The agent never talks to the upstream directly: every tool is classified and order and
 * transfer tools go through the ladder.
 *
 * Robinhood does not publish tool argument or response schemas, so extraction is schema-driven and tolerant
 * and everything that cannot be sized or understood is REFUSED. Name the tools explicitly in config
 * (quoteTools, accountTool, ...) once you have seen your upstream's `tools/list`.
 */
export class McpUpstreamAdapter implements BrokerAdapter {
  readonly supportsPaper = false;
  readonly dynamicTools = true;
  readonly shadowReadTools: { account?: string; positions?: string; orders?: string } = {};
  private client: Client | undefined;
  private tools: ToolDef[] = [];

  constructor(private readonly o: McpUpstreamOptions) {}

  get id(): string {
    return this.o.name ?? "mcp-upstream";
  }

  private makeTransport(): Transport {
    if (this.o.command) {
      return new StdioClientTransport({ command: this.o.command, args: this.o.args ?? [], env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(this.o.env ?? {}) }, stderr: "inherit" });
    }
    if (!this.o.url) throw new BrokerError("mcp-upstream needs url or command");
    return new StreamableHTTPClientTransport(new URL(this.o.url), {
      ...(this.o.bearerToken ? { requestInit: { headers: { Authorization: `Bearer ${this.o.bearerToken}` } } } : {}),
      ...(!this.o.bearerToken && this.o.oauth ? { authProvider: this.o.oauth } : {}),
    });
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const client = new Client({ name: "leash-gateway", version: VERSION }, { versionNegotiation: { mode: "auto" } });
    try {
      await client.connect(this.makeTransport());
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        throw new BrokerError("Upstream requires sign-in. Run `leash auth` first.", 401);
      }
      throw new BrokerError(`Could not connect to upstream MCP server: ${errorMessage(e)}`);
    }
    this.client = client;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    await c?.close().catch(() => undefined);
  }

  private async withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    await this.connect();
    try {
      return await fn(this.client as Client);
    } catch (e) {
      // One reconnect attempt for dropped connections; protocol errors propagate.
      if (/closed|ECONNRESET|socket|fetch failed/i.test(errorMessage(e))) {
        await this.close();
        await this.connect();
        return fn(this.client as Client);
      }
      throw e;
    }
  }

  async listTools(): Promise<ToolDef[]> {
    const res = await this.withClient((c) => c.listTools());
    this.tools = res.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}),
    }));
    return this.tools;
  }

  classify(tool: ToolDef): Classification {
    return classifyTool(tool, this.o.toolOverrides ?? {});
  }

  async callRead(name: string, args: Args, _mode: BrokerMode): Promise<ToolResult> {
    return this.forward(name, args);
  }

  private async forward(name: string, args: Args): Promise<ToolResult> {
    const res = await this.withClient((c) => c.callTool({ name, arguments: args }));
    const out: ToolResult = { content: (res.content ?? []) as ToolResult["content"] };
    if (res.structuredContent) out.structuredContent = res.structuredContent as Record<string, unknown>;
    if (res.isError) out.isError = true;
    return out;
  }

  parseOrder(name: string, args: Args): OrderIntent | undefined {
    // The account wall compares intent.account only when the call names one.
    return extractIntent(name, args);
  }

  executeOrder(name: string, args: Args, _intent: OrderIntent, _mode: BrokerMode): Promise<ToolResult> {
    return this.forward(name, args);
  }

  executeCancel(name: string, args: Args, _mode: BrokerMode): Promise<ToolResult> {
    return this.forward(name, args);
  }

  // ---- helper: pick a read tool by config or by name tokens ----
  private pickTool(configured: string | undefined, want: string[], avoid: string[] = []): ToolDef | undefined {
    if (configured) return this.tools.find((t) => t.name === configured);
    return this.tools.find((t) => {
      const k = tok(t.name);
      return this.classify(t).effect === "read" && want.every((w) => k.includes(w) || k.includes(`${w}s`)) && !avoid.some((a) => k.includes(a));
    });
  }

  /** Build arguments for a tool from its JSON Schema: fill the symbol-like property, leave the rest unset. */
  static symbolArgs(tool: ToolDef, symbol: string): Args | undefined {
    const props = ((tool.inputSchema as { properties?: Record<string, { type?: string }> }).properties ?? {}) as Record<string, { type?: string }>;
    const key = Object.keys(props).find((k) => /^(symbols?|tickers?|pairs?|currency_pairs?|assets?|instruments?)$/i.test(k));
    if (!key) return undefined;
    return { [key]: props[key]?.type === "array" ? [symbol] : symbol };
  }

  async quote(symbol: string): Promise<Quote> {
    if (this.tools.length === 0) await this.listTools();
    const crypto = symbol.includes("/") || /-USD[CT]?$/i.test(symbol);
    const configured = crypto ? this.o.quoteTools?.crypto : this.o.quoteTools?.equity;
    const tool = this.pickTool(configured, ["quote"], crypto ? ["option"] : ["crypto", "option"]) ?? (crypto ? this.pickTool(undefined, ["crypto", "quote"]) : undefined);
    if (!tool) throw new BrokerError(`No quote tool found upstream for ${symbol}. Set broker.quoteTools in leash.yaml.`);
    const args = McpUpstreamAdapter.symbolArgs(tool, symbol);
    if (!args) throw new BrokerError(`Cannot build arguments for upstream quote tool ${tool.name}; its schema has no symbol-like property.`);
    const res = await this.forward(tool.name, args);
    if (res.isError) throw new BrokerError(`Upstream quote tool ${tool.name} returned an error`);
    const q = parseQuote(symbol, res, (this.o.fallbackSpreadBps ?? 10) / 10_000);
    if (!q) throw new BrokerError(`Could not read a price from upstream tool ${tool.name}; set broker.quoteTools or refine the mapping.`);
    return q;
  }

  async getAccount(_mode: BrokerMode): Promise<BrokerAccount | undefined> {
    try {
      if (this.tools.length === 0) await this.listTools();
      const tool = this.pickTool(this.o.accountTool, ["portfolio"]) ?? this.pickTool(this.o.accountTool, ["account"], ["history", "positions"]);
      if (!tool) return undefined;
      const res = await this.forward(tool.name, {});
      const data = resultJson(res);
      const equity = findNumber(data, ["equity", "total_equity", "portfolio_value", "total_value", "net_liquidation_value", "market_value"]);
      if (equity === undefined) return undefined;
      return {
        id: String(findString(data, ["account_number", "account_id", "id"]) ?? this.o.accountId ?? "upstream"),
        equity,
        cash: findNumber(data, ["cash", "buying_power", "withdrawable_amount"]) ?? 0,
        buyingPower: findNumber(data, ["buying_power", "cash"]) ?? 0,
        currency: "USD",
      };
    } catch {
      return undefined;
    }
  }

  async getPositions(_mode: BrokerMode): Promise<BrokerPosition[]> {
    return this.readPositions().catch(() => []);
  }
  async listOrders(_mode: BrokerMode): Promise<BrokerOrder[]> {
    return [];
  }

  private async readPositions(): Promise<BrokerPosition[]> {
    if (this.tools.length === 0) await this.listTools();
    const tool = this.pickTool(this.o.positionsTool, ["positions"], ["option", "crypto"]) ?? this.pickTool(this.o.positionsTool, ["holdings"]);
    if (!tool) return [];
    const objs = objectsWith(resultJson(await this.forward(tool.name, {})), "symbol");
    return objs.flatMap((o) => {
      const qty = num(o["quantity"] ?? o["qty"] ?? o["shares"]);
      if (!qty || qty <= 0) return [];
      const avg = num(o["average_buy_price"] ?? o["avg_entry_price"] ?? o["average_cost"] ?? o["cost_basis_per_share"]) ?? 0;
      const mv = num(o["market_value"] ?? o["equity"] ?? o["value"]) ?? qty * avg;
      const sym = String(o["symbol"]);
      const crypto = sym.includes("/") || /-USD$/.test(sym);
      return [{ symbol: sym, qty, avgEntryPrice: avg, marketValue: mv, assetClass: (crypto ? "crypto" : "equity") as AssetClass }];
    });
  }

  /**
   * Household view from upstream read tools. UNVERIFIED against live Robinhood: response shapes are
   * undocumented, so parsing is tolerant and any failure yields an empty view (the gateway then reports
   * household data as unavailable instead of pretending the checks passed).
   */
  async householdView(_mode: BrokerMode): Promise<HouseholdAccount[]> {
    if (this.tools.length === 0) await this.listTools();
    const acct = await this.getAccount("live");
    const positions = await this.readPositions().catch(() => []);
    const fills: Fill[] = [];
    const ordersTool = this.pickTool(this.o.ordersTool, ["orders"], ["option", "crypto", "open", "cancel"]);
    if (ordersTool) {
      try {
        for (const o of objectsWith(resultJson(await this.forward(ordersTool.name, {})), "symbol")) {
          const state = String(o["state"] ?? o["status"] ?? "").toLowerCase();
          if (state && !/fill/.test(state)) continue;
          const side = String(o["side"] ?? "").toLowerCase();
          const qty = num(o["filled_quantity"] ?? o["cumulative_quantity"] ?? o["quantity"]);
          const px = num(o["average_price"] ?? o["filled_avg_price"] ?? o["executed_price"] ?? o["price"]);
          const ts = String(o["last_transaction_at"] ?? o["filled_at"] ?? o["updated_at"] ?? o["created_at"] ?? "");
          if ((side === "buy" || side === "sell") && qty && px && Date.parse(ts)) fills.push({ symbol: String(o["symbol"]), side, qty, price: px, ts, assetClass: "equity" });
        }
      } catch {
        /* household data is best effort */
      }
    }
    let lots: TaxLot[] | undefined;
    const lotTool = this.pickTool(this.o.taxLotsTool, ["tax", "lots"]);
    if (lotTool) {
      try {
        lots = objectsWith(resultJson(await this.forward(lotTool.name, {})), "symbol").flatMap((o) => {
          const qty = num(o["quantity"] ?? o["shares"]);
          const total = num(o["cost_basis"] ?? o["total_cost"]);
          const per = num(o["cost_basis_per_share"] ?? o["price"]) ?? (qty && total ? total / qty : undefined);
          const when = String(o["acquired_at"] ?? o["purchase_date"] ?? o["opened_at"] ?? o["created_at"] ?? "");
          return qty && per !== undefined && Date.parse(when) ? [{ symbol: String(o["symbol"]), qty, costBasisPerShare: per, acquiredAt: when }] : [];
        });
      } catch {
        lots = undefined;
      }
    }
    if (!acct && positions.length === 0 && fills.length === 0) return [];
    return [{ id: acct?.id ?? this.o.accountId ?? "upstream", label: "upstream", isAgentAccount: true, equity: acct?.equity ?? positions.reduce((s, p) => s + p.marketValue, 0), positions, fills, ...(lots ? { lots } : {}) }];
  }

  async cancelAllOpen(_mode: BrokerMode): Promise<number> {
    if (this.tools.length === 0) await this.listTools();
    if (this.o.cancelAllTool) {
      await this.forward(this.o.cancelAllTool, {});
      return -1; // count unknown
    }
    const all = this.tools.find((t) => {
      const k = tok(t.name);
      return k.includes("cancel") && k.includes("all");
    });
    if (all) {
      await this.forward(all.name, {});
      return -1;
    }
    return 0;
  }
}

// ---- tolerant result parsing ----

function resultJson(res: ToolResult): unknown {
  if (res.structuredContent) return res.structuredContent;
  for (const c of res.content) {
    if (c.type === "text" && typeof (c as { text?: unknown }).text === "string") {
      try {
        return JSON.parse((c as { text: string }).text);
      } catch {
        /* not json */
      }
    }
  }
  return collectResultText(res);
}

function walk(v: unknown, fn: (o: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(v)) v.forEach((x) => walk(x, fn, depth + 1));
  else if (v && typeof v === "object") {
    fn(v as Record<string, unknown>);
    Object.values(v as Record<string, unknown>).forEach((x) => walk(x, fn, depth + 1));
  }
}

function objectsWith(data: unknown, key: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  walk(data, (o) => {
    if (key in o) out.push(o);
  });
  return out;
}

function findNumber(data: unknown, keys: string[]): number | undefined {
  let found: number | undefined;
  walk(data, (o) => {
    if (found !== undefined) return;
    for (const k of keys) {
      const n = num(o[k]);
      if (n !== undefined) {
        found = n;
        return;
      }
    }
  });
  return found;
}

function findString(data: unknown, keys: string[]): string | undefined {
  let found: string | undefined;
  walk(data, (o) => {
    if (found !== undefined) return;
    for (const k of keys) if (typeof o[k] === "string" && o[k]) found = o[k] as string;
  });
  return found;
}

/** Read a quote from an arbitrary upstream result: prefer explicit bid/ask, else a last/mark price with a synthetic spread. */
export function parseQuote(symbol: string, res: ToolResult, spread: number): Quote | undefined {
  const data = resultJson(res);
  let bid: number | undefined;
  let ask: number | undefined;
  let last: number | undefined;
  const want = symbol.toUpperCase().replace("/", "-");
  walk(data, (o) => {
    const s = typeof o["symbol"] === "string" ? o["symbol"].toUpperCase().replace("/", "-") : undefined;
    if (s !== undefined && s !== want) return;
    bid ??= num(o["bid_price"] ?? o["bid"] ?? o["bid_inclusive_of_sell_spread"]);
    ask ??= num(o["ask_price"] ?? o["ask"] ?? o["ask_inclusive_of_buy_spread"]);
    last ??= num(o["last_trade_price"] ?? o["last_price"] ?? o["price"] ?? o["mark_price"] ?? o["last"] ?? o["mid"]);
  });
  const ts = new Date().toISOString();
  if (bid && ask && bid > 0 && ask > 0) return { symbol: want, bid, ask, mid: round((bid + ask) / 2, 8), ts };
  const px = last ?? bid ?? ask;
  if (!px || px <= 0) return undefined;
  return { symbol: want, bid: round(px * (1 - spread / 2), 8), ask: round(px * (1 + spread / 2), 8), mid: px, ts };
}
