import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

export interface MockOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  time_in_force: string;
  status: string;
  qty: string | null;
  notional: string | null;
  limit_price: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  submitted_at: string;
  filled_at: string | null;
  asset_class: string;
}

export interface MockAlpacaState {
  cash: number;
  positions: Record<string, { qty: number; avg: number; crypto: boolean }>;
  orders: MockOrder[];
  quotes: Record<string, { bid: number; ask: number }>;
  requests: Array<{ method: string; url: string; body: unknown; headers: IncomingMessage["headers"] }>;
  /** Make the next N requests fail with this status (for retry tests). */
  failNext: { status: number; count: number } | undefined;
  /** Equity override so tests can simulate drawdown without trading. */
  equityOverride: number | undefined;
}

export function newMockAlpacaState(): MockAlpacaState {
  return {
    cash: 10_000,
    positions: {},
    orders: [],
    quotes: { AAPL: { bid: 189.9, ask: 190.1 }, MSFT: { bid: 419.8, ask: 420.2 }, "BTC/USD": { bid: 64_900, ask: 65_100 } },
    requests: [],
    failNext: undefined,
    equityOverride: undefined,
  };
}

export interface RunningMockAlpaca {
  url: string;
  state: MockAlpacaState;
  close(): Promise<void>;
}

const KEY = "PKTEST";
const SECRET = "secret-test";

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : undefined;
}

/** A local server that implements the Alpaca endpoints Haelo uses, with the documented response shapes. */
export async function startMockAlpaca(state: MockAlpacaState = newMockAlpacaState(), creds = { key: KEY, secret: SECRET }): Promise<RunningMockAlpaca> {
  const equity = (): number => state.equityOverride ?? state.cash + Object.entries(state.positions).reduce((s, [sym, p]) => s + p.qty * (state.quotes[sym]?.bid ?? p.avg), 0);

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = req.method === "POST" ? await readBody(req) : undefined;
    state.requests.push({ method: req.method ?? "", url: req.url ?? "", body, headers: req.headers });
    if (state.failNext && state.failNext.count > 0) {
      state.failNext.count--;
      return send(res, state.failNext.status, { message: "injected failure" });
    }
    if (req.headers["apca-api-key-id"] !== creds.key || req.headers["apca-api-secret-key"] !== creds.secret) {
      return send(res, 401, { message: "forbidden" });
    }
    const p = url.pathname;
    const m = req.method;
    if (m === "GET" && p === "/v2/account") {
      return send(res, 200, { id: "acct-id", account_number: "PA-TEST-1", status: "ACTIVE", currency: "USD", cash: state.cash.toFixed(2), equity: equity().toFixed(2), buying_power: state.cash.toFixed(2) });
    }
    if (m === "GET" && p === "/v2/positions") {
      return send(
        res,
        200,
        Object.entries(state.positions).map(([sym, pos]) => ({
          symbol: pos.crypto ? sym.replace("/", "") : sym,
          asset_class: pos.crypto ? "crypto" : "us_equity",
          qty: String(pos.qty),
          avg_entry_price: String(pos.avg),
          market_value: (pos.qty * (state.quotes[sym]?.bid ?? pos.avg)).toFixed(2),
        })),
      );
    }
    if (m === "GET" && p === "/v2/orders") {
      const status = url.searchParams.get("status");
      let rows = state.orders;
      if (status === "closed") rows = rows.filter((o) => ["filled", "canceled"].includes(o.status));
      return send(res, 200, [...rows].reverse());
    }
    if (m === "POST" && p === "/v2/orders") {
      const b = body as Record<string, string>;
      if ((b["qty"] && b["notional"]) || (!b["qty"] && !b["notional"])) return send(res, 422, { message: "qty or notional required, not both" });
      const q = state.quotes[b["symbol"] as string];
      if (!q) return send(res, 404, { message: "asset not found" });
      const crypto = (b["symbol"] as string).includes("/");
      const marketable = b["type"] === "market" || (b["limit_price"] && (b["side"] === "buy" ? Number(b["limit_price"]) >= q.ask : Number(b["limit_price"]) <= q.bid));
      const px = b["side"] === "buy" ? q.ask : q.bid;
      const qty = b["qty"] ? Number(b["qty"]) : Number(b["notional"]) / px;
      const order: MockOrder = {
        id: randomUUID(),
        client_order_id: b["client_order_id"] ?? "",
        symbol: b["symbol"] as string,
        side: b["side"] as "buy" | "sell",
        type: b["type"] as string,
        time_in_force: b["time_in_force"] as string,
        status: marketable ? "filled" : "new",
        qty: b["qty"] ?? null,
        notional: b["notional"] ?? null,
        limit_price: b["limit_price"] ?? null,
        filled_qty: marketable ? String(qty) : "0",
        filled_avg_price: marketable ? String(px) : null,
        submitted_at: new Date().toISOString(),
        filled_at: marketable ? new Date().toISOString() : null,
        asset_class: crypto ? "crypto" : "us_equity",
      };
      if (marketable) {
        const pos = state.positions[order.symbol] ?? { qty: 0, avg: 0, crypto };
        if (order.side === "buy") {
          state.cash -= qty * px;
          pos.avg = (pos.avg * pos.qty + qty * px) / (pos.qty + qty);
          pos.qty += qty;
        } else {
          if (pos.qty < qty) return send(res, 403, { message: "insufficient qty available" });
          state.cash += qty * px;
          pos.qty -= qty;
        }
        if (pos.qty <= 1e-12) delete state.positions[order.symbol];
        else state.positions[order.symbol] = pos;
      }
      state.orders.push(order);
      return send(res, 200, order);
    }
    if (m === "DELETE" && p === "/v2/orders") {
      const open = state.orders.filter((o) => o.status === "new");
      open.forEach((o) => (o.status = "canceled"));
      return send(res, 207, open.map((o) => ({ id: o.id, status: 200 })));
    }
    const del = /^\/v2\/orders\/([^/]+)$/.exec(p);
    if (m === "DELETE" && del) {
      const o = state.orders.find((x) => x.id === del[1]);
      if (!o || o.status !== "new") return send(res, 422, { message: "order not cancelable" });
      o.status = "canceled";
      return send(res, 204);
    }
    const sq = /^\/v2\/stocks\/([^/]+)\/quotes\/latest$/.exec(p);
    if (m === "GET" && sq) {
      const q = state.quotes[decodeURIComponent(sq[1] as string)];
      if (!q) return send(res, 404, { message: "no data" });
      return send(res, 200, { symbol: sq[1], quote: { t: new Date().toISOString(), ap: q.ask, as: 1, bp: q.bid, bs: 1 } });
    }
    const st = /^\/v2\/stocks\/([^/]+)\/trades\/latest$/.exec(p);
    if (m === "GET" && st) {
      const q = state.quotes[decodeURIComponent(st[1] as string)];
      if (!q) return send(res, 404, { message: "no data" });
      return send(res, 200, { symbol: st[1], trade: { t: new Date().toISOString(), p: (q.ask + q.bid) / 2 } });
    }
    if (m === "GET" && p === "/v1beta3/crypto/us/latest/quotes") {
      const sym = url.searchParams.get("symbols") ?? "";
      const q = state.quotes[sym];
      return send(res, 200, { quotes: q ? { [sym]: { t: new Date().toISOString(), ap: q.ask, bp: q.bid, as: 1, bs: 1 } } : {} });
    }
    return send(res, 404, { message: `not found: ${m} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export const MOCK_ALPACA_CREDS = { keyId: KEY, secret: SECRET };
