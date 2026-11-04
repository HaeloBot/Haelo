import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlpacaBroker } from "../src/adapters/alpaca.js";
import { requestJson } from "../src/adapters/http.js";
import { McpUpstreamAdapter, parseQuote } from "../src/adapters/mcp-upstream.js";
import { RestAdapter } from "../src/adapters/rest-base.js";
import { BrokerError } from "../src/adapters/types.js";
import { buildAdapter, offlineAdapter } from "../src/factory.js";
import { parseConfig } from "../src/policy/load.js";
import { startMockUpstream, type RunningMockUpstream } from "../src/testkit/mock-upstream.js";
import { MOCK_ALPACA_CREDS, newMockAlpacaState, startMockAlpaca, type RunningMockAlpaca } from "./helpers/mock-alpaca.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? "").join("");

describe("RestAdapter native tools (Alpaca mock)", () => {
  async function adapter(): Promise<{ a: RestAdapter; m: RunningMockAlpaca }> {
    const m = await startMockAlpaca(newMockAlpacaState());
    closers.push(m.close);
    return { a: new RestAdapter(new AlpacaBroker({ paper: MOCK_ALPACA_CREDS, paperBaseUrl: m.url, liveBaseUrl: m.url, dataBaseUrl: m.url, live: MOCK_ALPACA_CREDS })), m };
  }

  it("serves every read tool and reports errors as tool errors", async () => {
    const { a } = await adapter();
    expect((await a.listTools()).map((t) => t.name)).toContain("cancel_all_orders");
    expect(text(await a.callRead("get_account", {}, "paper"))).toContain("equity");
    expect(text(await a.callRead("get_positions", {}, "paper"))).toContain("positions");
    expect(text(await a.callRead("list_orders", {}, "paper"))).toContain("orders");
    expect(text(await a.callRead("get_quote", { symbol: "AAPL" }, "paper"))).toContain("AAPL");
    expect((await a.callRead("get_quote", {}, "paper")).isError).toBe(true);
    expect((await a.callRead("nope", {}, "paper")).isError).toBe(true);
    expect((await a.callRead("get_quote", { symbol: "ZZZZ" }, "paper")).isError).toBe(true);
    expect(a.classify({ name: "whatever", inputSchema: {} }).effect).toBe("unknown");
  });

  it("parses native orders exactly and refuses ambiguous ones", () => {
    const a = new RestAdapter(new AlpacaBroker({}));
    expect(a.parseOrder("place_order", { symbol: "AAPL", side: "buy", qty: 2, type: "limit", limit_price: 10 })).toMatchObject({ qty: 2, type: "limit", limitPrice: 10 });
    expect(a.parseOrder("place_order", { symbol: "AAPL", side: "buy", qty: 2, notional_usd: 5 })).toBeUndefined();
    expect(a.parseOrder("place_order", { symbol: "AAPL" })).toBeUndefined();
    expect(a.parseOrder("other_order", { symbol: "AAPL", side: "sell", quantity: 1 })?.qty).toBe(1);
  });

  it("executes and cancels orders, surfacing broker errors", async () => {
    const { a, m } = await adapter();
    const ok = await a.executeOrder("place_order", {}, { symbol: "AAPL", side: "buy", type: "limit", qty: 1, limitPrice: 1, assetClass: "equity" }, "paper");
    expect(ok.isError).toBeFalsy();
    const id = m.state.orders[0]?.id as string;
    expect(text(await a.executeCancel("cancel_order", { order_id: id }, "paper"))).toContain(id);
    expect((await a.executeCancel("cancel_order", {}, "paper")).isError).toBe(true);
    expect(text(await a.executeCancel("cancel_all_orders", {}, "paper"))).toContain("cancelled");
    expect((await a.executeOrder("place_order", {}, { symbol: "NOPE", side: "buy", type: "market", qty: 1, assetClass: "equity" }, "paper")).isError).toBe(true);
    expect(await a.cancelAllOpen("paper")).toBeGreaterThanOrEqual(0);
    expect((await a.householdView("paper")).length).toBeGreaterThan(0);
    expect(await a.listOrders("paper")).toBeInstanceOf(Array);
  });
});

describe("McpUpstreamAdapter (mock upstream)", () => {
  async function up(extra: Partial<ConstructorParameters<typeof McpUpstreamAdapter>[0]> = {}): Promise<{ a: McpUpstreamAdapter; m: RunningMockUpstream }> {
    const m = await startMockUpstream();
    const a = new McpUpstreamAdapter({ url: m.url, ...extra });
    closers.push(async () => {
      await a.close();
      await m.close();
    });
    await a.connect();
    return { a, m };
  }

  it("finds quote, account and position tools by name when not configured", async () => {
    const { a, m } = await up();
    expect((await a.quote("AAPL")).ask).toBeGreaterThan(0);
    expect((await a.getAccount("live"))?.equity).toBe(10_000);
    m.state.positions["AAPL"] = { qty: 3, avg: 180 };
    expect(await a.getPositions("live")).toEqual([expect.objectContaining({ symbol: "AAPL", qty: 3 })]);
    expect(await a.listOrders("live")).toEqual([]);
  });

  it("builds a household view from orders and tax lots, tolerating odd shapes", async () => {
    const { a, m } = await up({ ordersTool: "get_equity_orders" });
    m.state.positions["AAPL"] = { qty: 1, avg: 100 };
    m.state.orders.push({ id: "o1", symbol: "AAPL", side: "buy", quantity: 1, price: 100, state: "filled", created_at: "2026-10-01T00:00:00Z" });
    m.state.orders.push({ id: "o2", symbol: "AAPL", side: "buy", quantity: 1, price: 100, state: "cancelled", created_at: "2026-10-01T00:00:00Z" });
    const hv = await a.householdView("live");
    expect(hv[0]?.fills).toHaveLength(1);
    expect(hv[0]?.positions).toHaveLength(1);
  });

  it("cancel-all uses a configured tool, or reports 0 when there is none", async () => {
    const { a, m } = await up({ cancelAllTool: "get_accounts" });
    expect(await a.cancelAllOpen("live")).toBe(-1);
    expect(m.state.calls).toContain("get_accounts");
    const { a: b } = await up();
    expect(await b.cancelAllOpen("live")).toBe(0);
  });

  it("fails clearly when there is no usable quote tool", async () => {
    const { a } = await up({ quoteTools: { equity: "get_portfolio" } });
    await expect(a.quote("AAPL")).rejects.toThrow(/symbol-like/);
    const { a: b } = await up({ quoteTools: { equity: "missing_tool" } });
    await expect(b.quote("AAPL")).rejects.toThrow(/No quote tool/);
    const { a: c } = await up();
    await expect(c.quote("ZZZZ")).rejects.toThrow(/Could not read a price|error/);
  });

  it("speaks to a stdio upstream launched as a command", async () => {
    const a = new McpUpstreamAdapter({ command: process.execPath, args: [resolve(__dirname, "../dist/cli.js"), "mock-upstream", "--stdio"] });
    closers.push(() => a.close());
    const tools = await a.listTools();
    expect(tools.map((t) => t.name)).toContain("place_equity_order");
    expect((await a.getAccount("live"))?.equity).toBe(10_000);
  }, 20_000);

  it("reports an unreachable upstream and a missing target", async () => {
    await expect(new McpUpstreamAdapter({ url: "http://127.0.0.1:9/" }).connect()).rejects.toThrow(/Could not connect/);
    await expect(new McpUpstreamAdapter({}).connect()).rejects.toThrow(/url or command/);
    expect(await new McpUpstreamAdapter({ url: "http://127.0.0.1:9/" }).getAccount("live")).toBeUndefined();
  });

  it("symbolArgs fills the symbol-like property, as an array when the schema says so", () => {
    expect(McpUpstreamAdapter.symbolArgs({ name: "q", inputSchema: { properties: { symbols: { type: "array" } } } }, "AAPL")).toEqual({ symbols: ["AAPL"] });
    expect(McpUpstreamAdapter.symbolArgs({ name: "q", inputSchema: { properties: { ticker: { type: "string" } } } }, "AAPL")).toEqual({ ticker: "AAPL" });
    expect(McpUpstreamAdapter.symbolArgs({ name: "q", inputSchema: { properties: { id: {} } } }, "AAPL")).toBeUndefined();
  });

  it("parseQuote reads bid/ask, falls back to last price, and ignores other symbols", () => {
    const r = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
    expect(parseQuote("AAPL", r({ quotes: [{ symbol: "MSFT", bid: 1, ask: 2 }, { symbol: "AAPL", bid_price: "10", ask_price: "11" }] }), 0.001)).toMatchObject({ bid: 10, ask: 11 });
    expect(parseQuote("BTC/USD", r({ symbol: "BTC-USD", last_trade_price: 100 }), 0.01)).toMatchObject({ mid: 100, bid: 99.5 });
    expect(parseQuote("AAPL", r({ nothing: true }), 0.01)).toBeUndefined();
    expect(parseQuote("AAPL", { content: [{ type: "text", text: "not json" }] }, 0.01)).toBeUndefined();
  });
});

describe("requestJson", () => {
  it("retries GETs on network errors and gives up with a BrokerError", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(requestJson("http://example.invalid/x", { method: "GET" }, { fetch: failing, retries: 1 })).rejects.toBeInstanceOf(BrokerError);
    expect(calls).toBe(2);
    calls = 0;
    await expect(requestJson("http://example.invalid/x", { method: "POST" }, { fetch: failing, retries: 3 })).rejects.toThrow(/failed/);
    expect(calls).toBe(1);
  });

  it("honours Retry-After on 429 and returns text bodies that are not JSON", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }) : new Response("plain text", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await requestJson("http://x.test/", { method: "GET" }, { fetch: f })).toBe("plain text");
    const empty = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await requestJson("http://x.test/", { method: "GET" }, { fetch: empty })).toBeUndefined();
  });

  it("times out a hung request", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(requestJson("http://x.test/", { method: "POST" }, { fetch: hang, timeoutMs: 20 })).rejects.toThrow(/aborted/);
  });
});

describe("buildAdapter", () => {
  const cfg = (b: Record<string, unknown>) => parseConfig(JSON.stringify({ version: 1, broker: b }));
  it("builds each broker from env vars only, with clear errors when they are missing", () => {
    expect(() => buildAdapter(cfg({ type: "alpaca" }), "/tmp", { env: {} })).toThrow(/No Alpaca credentials/);
    expect(buildAdapter(cfg({ type: "alpaca" }), "/tmp", { env: { ALPACA_LIVE_KEY_ID: "AK", ALPACA_LIVE_SECRET_KEY: "s" } }).id).toBe("alpaca");
    expect(() => buildAdapter(cfg({ type: "robinhood-crypto" }), "/tmp", { env: {} })).toThrow(/RH_CRYPTO_API_KEY/);
    expect(buildAdapter(cfg({ type: "robinhood-crypto" }), "/tmp", { env: { RH_CRYPTO_API_KEY: "k", RH_CRYPTO_PRIVATE_KEY: "xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=" } }).id).toBe("robinhood-crypto");
    expect(() => buildAdapter(cfg({ type: "mcp-upstream", url: "http://x.test/", bearerTokenEnv: "T" }), "/tmp", { env: {} })).toThrow(/empty/);
    expect(buildAdapter(cfg({ type: "mcp-upstream", url: "http://x.test/", bearerTokenEnv: "T" }), "/tmp", { env: { T: "tok" } }).dynamicTools).toBe(true);
    expect(buildAdapter(parseConfig(JSON.stringify({ version: 1, broker: { type: "mcp-upstream", url: "http://x.test/" }, secrets: { store: "file" } })), "/tmp/leash-ba", { env: {} }).id).toBe("mcp-upstream");
    expect(buildAdapter(cfg({ type: "mcp-upstream", command: "node", passEnv: ["A", "B"] }), "/tmp", { env: { A: "1" } }).id).toBe("mcp-upstream");
  });

  it("the offline adapter refuses anything that would touch a broker", async () => {
    const o = offlineAdapter(cfg({ type: "alpaca" }));
    expect(o.supportsPaper).toBe(true);
    await expect(o.callRead("x", {}, "live")).rejects.toThrow(/does not load broker credentials/);
    await expect(o.executeOrder("x", {}, { symbol: "A", side: "buy", type: "market", assetClass: "equity" }, "live")).rejects.toThrow();
    await expect(o.executeCancel("x", {}, "live")).rejects.toThrow();
    await expect(o.quote("A")).rejects.toThrow();
    expect(o.parseOrder("x", {})).toBeUndefined();
    expect(o.classify({ name: "x", inputSchema: {} }).effect).toBe("unknown");
    expect(await o.getAccount("live")).toBeUndefined();
    expect(await o.cancelAllOpen("live")).toBe(0);
    expect(await o.listTools()).toEqual([]);
    expect(await o.getPositions("live")).toEqual([]);
    expect(await o.listOrders("live")).toEqual([]);
    expect(await o.householdView("live")).toEqual([]);
  });
});
