import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** Tiny programmable HTTP server for the Robinhood Crypto API tests. */
export async function startJsonServer(handler: (s: SeenRequest) => { status?: number; body: unknown }): Promise<{ url: string; seen: SeenRequest[]; close(): Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s: SeenRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    seen.push(s);
    const out = handler(s);
    res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

/** Responds like the Robinhood Crypto Trading API for the GET endpoints doctor and the client use. */
export function robinhoodReadHandler(s: SeenRequest): { status?: number; body: unknown } {
  if (!s.headers["x-signature"]) return { status: 401, body: { detail: "unsigned" } };
  if (s.url.startsWith("/api/v1/crypto/trading/accounts/")) return { body: { account_number: "RH-1234", status: "active", buying_power: "250.00", buying_power_currency: "USD" } };
  if (s.url.startsWith("/api/v1/crypto/trading/holdings/")) return { body: { next: null, results: [{ asset_code: "BTC", total_quantity: "0.001" }] } };
  if (s.url.startsWith("/api/v1/crypto/marketdata/best_bid_ask/")) return { body: { results: [{ symbol: "BTC-USD", price: 65000, bid_inclusive_of_sell_spread: 64900, ask_inclusive_of_buy_spread: 65100 }] } };
  if (s.url.startsWith("/api/v1/crypto/trading/orders/")) return { body: { next: null, results: [] } };
  return { status: 404, body: { detail: "not found" } };
}
