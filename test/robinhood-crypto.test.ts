import { createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RobinhoodCryptoBroker, buildSigningMessage, privateKeyFromSeed, pythonStyleJson, signMessage } from "../src/adapters/robinhood-crypto.js";

// Values from https://docs.robinhood.com/crypto/trading/ ("Example Signature").
const DOC = {
  privateKey: "xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=",
  publicKey: "jPItx4TLjcnSUnmnXQQyAKL4eJj3+oWNNMmmm2vATqk=",
  apiKey: "rh-api-6148effc-c0b1-486c-8940-a1d099456be6",
  timestamp: "1698708981",
  path: "/api/v1/crypto/trading/orders/",
  signature: "q/nEtxp/P2Or3hph3KejBqnw5o9qeuQ+hYRnB56FaHbjDsNUY9KhB1asMxohDnzdVFSD7StaTqjSd9U9HvaRAw==",
  // The docs' Python sample interpolates a dict into an f-string, so the signed body is Python's repr, not JSON.
  signedBody: "{'client_order_id': '131de903-5a9c-4260-abc1-28d562a5dcf0', 'side': 'buy', 'symbol': 'BTC-USD', 'type': 'market', 'market_order_config': {'asset_quantity': '0.1'}}",
};

describe("Robinhood Crypto signing", () => {
  it("reproduces the official documentation signature byte for byte", () => {
    const key = privateKeyFromSeed(DOC.privateKey);
    const msg = buildSigningMessage(DOC.apiKey, DOC.timestamp, DOC.path, "POST", DOC.signedBody);
    expect(signMessage(key, msg)).toBe(DOC.signature);
  });

  it("derives the documented public key from the seed", () => {
    const key = privateKeyFromSeed(DOC.privateKey);
    const pub = createPublicKey(key).export({ format: "der", type: "spki" });
    expect(pub.subarray(pub.length - 32).toString("base64")).toBe(DOC.publicKey);
  });

  it("rejects a malformed private key", () => {
    expect(() => privateKeyFromSeed(Buffer.from("short").toString("base64"))).toThrow(/32-byte/);
  });

  it("serialises bodies like Python's json.dumps so the signed bytes equal the sent bytes", () => {
    expect(pythonStyleJson({ a: 1, b: "x", c: { d: [1, 2] }, e: undefined })).toBe('{"a": 1, "b": "x", "c": {"d": [1, 2]}}');
  });
});

describe("Robinhood Crypto client against a local mock server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  interface Seen {
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    body: string;
  }

  async function mock(handler: (s: Seen) => { status?: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(s);
      const out = handler(s);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  const verifySig = (s: Seen, pubB64: string): boolean => {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubB64, "base64")]);
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    const msg = buildSigningMessage(String(s.headers["x-api-key"]), String(s.headers["x-timestamp"]), s.url, s.method, s.body);
    return verify(null, Buffer.from(msg), pub, Buffer.from(String(s.headers["x-signature"]), "base64"));
  };

  const broker = (url: string, extra = {}) => new RobinhoodCryptoBroker({ apiKey: DOC.apiKey, privateKeyBase64: DOC.privateKey, baseUrl: url, now: () => new Date(1_698_708_981_000), ...extra });

  it("signs every request, including the query string and body, with a signature the public key verifies", async () => {
    const m = await mock((s) => {
      if (s.url.startsWith("/api/v1/crypto/marketdata/best_bid_ask/")) return { body: { results: [{ symbol: "BTC-USD", price: 65000, bid_inclusive_of_sell_spread: 64900, ask_inclusive_of_buy_spread: 65100, timestamp: "t" }] } };
      if (s.url.startsWith("/api/v1/crypto/trading/trading_pairs/")) return { body: { results: [{ symbol: "BTC-USD", asset_increment: "0.00000001", quote_increment: "0.01", min_order_size: "0.00001", max_order_size: "10" }] } };
      return { body: { id: "o1", symbol: "BTC-USD", side: "buy", type: "market", state: "open", market_order_config: { asset_quantity: "0.0001" } } };
    });
    const b = broker(m.url);
    const q = await b.getQuote("BTC/USD");
    expect(q).toMatchObject({ symbol: "BTC-USD", bid: 64900, ask: 65100 });
    await b.placeOrder("live", { symbol: "BTC-USD", side: "buy", type: "market", notionalUsd: 6.5, assetClass: "crypto" });
    expect(m.seen.length).toBeGreaterThanOrEqual(3);
    for (const s of m.seen) {
      expect(s.headers["x-timestamp"]).toBe("1698708981");
      expect(verifySig(s, DOC.publicKey)).toBe(true);
    }
    const post = m.seen.find((s) => s.method === "POST");
    expect(post?.url).toBe("/api/v1/crypto/trading/orders/");
    const body = JSON.parse(post?.body ?? "{}");
    expect(body.symbol).toBe("BTC-USD");
    expect(body.market_order_config.asset_quantity).toBe("0.00009984"); // 6.5 / 65100 floored to the pair's increment
    expect(body.client_order_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body).toContain('", "'); // python-style separators, same bytes that were signed
  });

  it("v2 resolves the account number and sends it with orders", async () => {
    const m = await mock((s) => {
      if (s.url.startsWith("/api/v2/crypto/trading/accounts/")) return { body: { results: [{ account_number: "ACC-9", status: "active", buying_power: "100", buying_power_currency: "USD", is_api_tradable: true }] } };
      if (s.url.startsWith("/api/v2/crypto/trading/trading_pairs/")) return { body: { results: [{ symbol: "ETH-USD", asset_increment: "0.0001", quote_increment: "0.01" }] } };
      return { body: { id: "o2", symbol: "ETH-USD", side: "sell", type: "limit", state: "open", limit_order_config: { asset_quantity: "0.5", limit_price: "4000" } } };
    });
    const o = await broker(m.url, { apiVersion: "v2" }).placeOrder("live", { symbol: "ETH-USD", side: "sell", type: "limit", qty: 0.5, limitPrice: 4000, assetClass: "crypto" });
    expect(o.symbol).toBe("ETH-USD");
    const post = m.seen.find((s) => s.method === "POST");
    expect(post?.url).toBe("/api/v2/crypto/trading/orders/?account_number=ACC-9");
    expect(JSON.parse(post?.body ?? "{}").limit_order_config).toMatchObject({ asset_quantity: "0.5000", limit_price: "4000", time_in_force: "gtc" });
  });

  it("follows pagination and builds holdings positions", async () => {
    let calls = 0;
    const m = await mock((s) => {
      if (s.url.startsWith("/api/v1/crypto/trading/holdings/")) {
        calls++;
        return calls === 1
          ? { body: { next: "http://x/api/v1/crypto/trading/holdings/?cursor=2", results: [{ asset_code: "BTC", total_quantity: "0.5" }] } }
          : { body: { next: null, results: [{ asset_code: "ETH", total_quantity: "0" }, { asset_code: "SOL", total_quantity: "10" }] } };
      }
      return { body: { results: [{ symbol: "BTC-USD", price: 1, bid_inclusive_of_sell_spread: 100, ask_inclusive_of_buy_spread: 102 }] } };
    });
    const pos = await broker(m.url).getPositions("live");
    expect(pos.map((p) => p.symbol).sort()).toEqual(["BTC-USD", "SOL-USD"]); // zero holdings dropped
    expect(calls).toBe(2);
  });

  it("cancels an order with a signed POST", async () => {
    const m = await mock(() => ({ body: "Cancel request was submitted" }));
    await broker(m.url).cancelOrder("live", "abc-123");
    expect(m.seen[0]?.method).toBe("POST");
    expect(m.seen[0]?.url).toBe("/api/v1/crypto/trading/orders/abc-123/cancel/");
    expect(verifySig(m.seen[0] as Seen, DOC.publicKey)).toBe(true);
  });

  it("surfaces API errors with the status code", async () => {
    const m = await mock(() => ({ status: 400, body: { type: "validation_error", errors: [{ detail: "Must be a valid UUID.", attr: "client_order_id" }] } }));
    await expect(broker(m.url).listOrders("live")).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to build an order it cannot size", async () => {
    const m = await mock((s) => (s.url.includes("trading_pairs") ? { body: { results: [{ symbol: "BTC-USD", asset_increment: "0.00000001", quote_increment: "0.01" }] } } : { body: {} }));
    await expect(broker(m.url).placeOrder("live", { symbol: "BTC-USD", side: "buy", type: "market", assetClass: "crypto" })).rejects.toThrow(/positive quantity/);
  });
});
