import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as z from "zod/v4";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, toNodeHandler } from "@modelcontextprotocol/node";

/**
 * A local MCP server shaped like a broker's agent-trading MCP. It exists so Leash can be run and tested end to end
 * with no broker account. IMPORTANT: tool names follow Robinhood's public documentation in spirit, but the argument
 * and response shapes here are ASSUMPTIONS, because Robinhood does not publish them. This is a test double, not a
 * model of Robinhood. Replace it with golden fixtures captured from a real account when you have them.
 */
export interface MockUpstreamState {
  cash: number;
  positions: Record<string, { qty: number; avg: number }>;
  orders: Array<{ id: string; symbol: string; side: string; quantity: number; price: number; state: string; created_at: string }>;
  quotes: Record<string, number>;
  /** Text returned by get_stock_news. Tests set this to a poisoned string. */
  news: string;
  /** Suffix appended to the place_equity_order description, to simulate an upstream tool change. */
  descriptionSuffix: string;
  /** Names of every tool call received, in order. */
  calls: string[];
  orderCounter: number;
}

export function newMockUpstreamState(): MockUpstreamState {
  return {
    cash: 10_000,
    positions: {},
    orders: [],
    quotes: { AAPL: 190, MSFT: 420, TSLA: 250, "BTC-USD": 65_000 },
    news: "AAPL reports steady quarterly results; analysts remain neutral.",
    descriptionSuffix: "",
    calls: [],
    orderCounter: 0,
  };
}

const spreadOf = (px: number): { bid: number; ask: number } => ({ bid: +(px * 0.9995).toFixed(4), ask: +(px * 1.0005).toFixed(4) });
const json = (data: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> } => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}),
});

export function createMockUpstreamServer(state: MockUpstreamState): McpServer {
  const server = new McpServer({ name: "mock-broker-mcp", version: "0.0.1" });
  const track = (n: string): void => {
    state.calls.push(n);
  };
  const equity = (): number => state.cash + Object.entries(state.positions).reduce((s, [sym, p]) => s + p.qty * (state.quotes[sym] ?? p.avg), 0);

  server.registerTool("get_accounts", { description: "List brokerage accounts." }, async () => {
    track("get_accounts");
    return json({ accounts: [{ account_number: "MOCK-AGENT-1", type: "agentic" }] });
  });
  server.registerTool("get_portfolio", { description: "Portfolio summary for the account." }, async () => {
    track("get_portfolio");
    return json({ account_number: "MOCK-AGENT-1", equity: +equity().toFixed(2), cash: +state.cash.toFixed(2), buying_power: +state.cash.toFixed(2) });
  });
  server.registerTool(
    "get_equity_quotes",
    { description: "Latest quotes for equity symbols.", inputSchema: z.object({ symbols: z.array(z.string()) }) },
    async ({ symbols }) => {
      track("get_equity_quotes");
      return json({ quotes: symbols.filter((s) => state.quotes[s.toUpperCase()] !== undefined).map((s) => ({ symbol: s.toUpperCase(), ...spreadOf(state.quotes[s.toUpperCase()] as number) })) });
    },
  );
  server.registerTool("get_equity_positions", { description: "Open equity positions." }, async () => {
    track("get_equity_positions");
    return json({
      positions: Object.entries(state.positions).map(([symbol, p]) => ({ symbol, quantity: p.qty, average_buy_price: p.avg, market_value: +(p.qty * (state.quotes[symbol] ?? p.avg)).toFixed(2) })),
    });
  });
  server.registerTool("get_equity_orders", { description: "Recent equity orders." }, async () => {
    track("get_equity_orders");
    return json({ orders: state.orders });
  });
  server.registerTool(
    "get_stock_news",
    { description: "Recent news headlines for a stock. Third-party text.", inputSchema: z.object({ symbol: z.string() }) },
    async ({ symbol }) => {
      track("get_stock_news");
      return json({ symbol, headlines: [state.news] });
    },
  );
  server.registerTool(
    "place_equity_order",
    {
      description: `Place an equity order.${state.descriptionSuffix}`,
      inputSchema: z.object({
        account_number: z.string(),
        symbol: z.string(),
        side: z.enum(["buy", "sell"]),
        type: z.enum(["market", "limit"]).default("market"),
        quantity: z.number().positive().optional(),
        notional: z.number().positive().optional(),
        limit_price: z.number().positive().optional(),
      }),
    },
    async (a) => {
      track("place_equity_order");
      const px = state.quotes[a.symbol.toUpperCase()];
      if (px === undefined) return { ...json({ error: `unknown symbol ${a.symbol}` }), isError: true };
      const fill = a.side === "buy" ? spreadOf(px).ask : spreadOf(px).bid;
      const qty = a.quantity ?? (a.notional ?? 0) / fill;
      const sym = a.symbol.toUpperCase();
      if (a.side === "buy") {
        state.cash -= qty * fill;
        const p = state.positions[sym] ?? { qty: 0, avg: 0 };
        p.avg = (p.avg * p.qty + qty * fill) / (p.qty + qty);
        p.qty += qty;
        state.positions[sym] = p;
      } else {
        const p = state.positions[sym];
        if (!p || p.qty < qty) return { ...json({ error: "insufficient shares" }), isError: true };
        p.qty -= qty;
        state.cash += qty * fill;
        if (p.qty <= 1e-12) delete state.positions[sym];
      }
      const order = { id: `ord-${++state.orderCounter}`, symbol: sym, side: a.side, quantity: qty, price: fill, state: "filled", created_at: new Date().toISOString() };
      state.orders.push(order);
      return json(order);
    },
  );
  server.registerTool("cancel_equity_order", { description: "Cancel an open equity order.", inputSchema: z.object({ order_id: z.string() }) }, async ({ order_id }) => {
    track("cancel_equity_order");
    return json({ order_id, state: "cancelled" });
  });
  server.registerTool(
    "transfer_funds",
    { description: "Transfer funds out of the account.", inputSchema: z.object({ amount: z.number(), destination: z.string() }) },
    async () => {
      track("transfer_funds");
      return json({ transferred: true });
    },
  );
  server.registerTool("create_price_alert", { description: "Create a price alert.", inputSchema: z.object({ symbol: z.string(), price: z.number() }) }, async () => {
    track("create_price_alert");
    return json({ created: true });
  });
  return server;
}

export interface RunningMockUpstream {
  url: string;
  port: number;
  state: MockUpstreamState;
  close(): Promise<void>;
}

/** Serve the mock over Streamable HTTP on loopback. Optional bearer token. */
export async function startMockUpstream(opts: { port?: number; token?: string; state?: MockUpstreamState } = {}): Promise<RunningMockUpstream> {
  const state = opts.state ?? newMockUpstreamState();
  const handler = createMcpHandler(() => createMockUpstreamServer(state));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const server: Server = createServer((req, res) => {
    if (!validateHost(req, res)) return;
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401).end();
      return;
    }
    void nodeHandler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    state,
    async close() {
      await handler.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}
