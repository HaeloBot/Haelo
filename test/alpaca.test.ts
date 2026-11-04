import { afterEach, describe, expect, it } from "vitest";
import { AlpacaBroker } from "../src/adapters/alpaca.js";
import { BrokerError } from "../src/adapters/types.js";
import { MOCK_ALPACA_CREDS, newMockAlpacaState, startMockAlpaca, type RunningMockAlpaca } from "./helpers/mock-alpaca.js";

let paper: RunningMockAlpaca;
let live: RunningMockAlpaca;
afterEach(async () => {
  await paper?.close();
  await live?.close();
});

async function setup(): Promise<AlpacaBroker> {
  paper = await startMockAlpaca(newMockAlpacaState());
  live = await startMockAlpaca(newMockAlpacaState());
  return new AlpacaBroker({ paper: MOCK_ALPACA_CREDS, live: MOCK_ALPACA_CREDS, paperBaseUrl: paper.url, liveBaseUrl: live.url, dataBaseUrl: live.url });
}

describe("AlpacaBroker (against a local mock that follows the documented API shapes)", () => {
  it("keeps paper and live apart: orders go only to the base URL for the requested mode", async () => {
    const b = await setup();
    await b.placeOrder("paper", { symbol: "AAPL", side: "buy", type: "market", notionalUsd: 100, assetClass: "equity" });
    expect(paper.state.orders).toHaveLength(1);
    expect(live.state.orders).toHaveLength(0);
    await b.placeOrder("live", { symbol: "MSFT", side: "buy", type: "market", qty: 1, assetClass: "equity" });
    expect(live.state.orders).toHaveLength(1);
  });

  it("sends the documented auth headers and request body", async () => {
    const b = await setup();
    await b.placeOrder("paper", { symbol: "AAPL", side: "buy", type: "limit", qty: 2, limitPrice: 150, assetClass: "equity" });
    const req = paper.state.requests.find((r) => r.method === "POST");
    expect(req?.url).toBe("/v2/orders");
    expect(req?.headers["apca-api-key-id"]).toBe(MOCK_ALPACA_CREDS.keyId);
    expect(req?.headers["apca-api-secret-key"]).toBe(MOCK_ALPACA_CREDS.secret);
    expect(req?.body).toMatchObject({ symbol: "AAPL", side: "buy", type: "limit", qty: "2", limit_price: "150", time_in_force: "day" });
  });

  it("uses notional for dollar orders and never sends qty and notional together", async () => {
    const b = await setup();
    await b.placeOrder("paper", { symbol: "AAPL", side: "buy", type: "market", notionalUsd: 250, assetClass: "equity" });
    const body = paper.state.requests.find((r) => r.method === "POST")?.body as Record<string, unknown>;
    expect(body["notional"]).toBe("250");
    expect(body["qty"]).toBeUndefined();
  });

  it("normalises crypto symbols and uses gtc for crypto", async () => {
    expect(AlpacaBroker.normaliseSymbol("btc-usd")).toBe("BTC/USD");
    expect(AlpacaBroker.normaliseSymbol("AAPL")).toBe("AAPL");
    const b = await setup();
    const q = await b.getQuote("BTC-USD");
    expect(q.symbol).toBe("BTC/USD");
    expect(q.ask).toBeGreaterThan(q.bid);
    await b.placeOrder("paper", { symbol: "BTC-USD", side: "buy", type: "market", notionalUsd: 50, assetClass: "crypto" });
    expect((paper.state.requests.find((r) => r.method === "POST")?.body as Record<string, unknown>)["time_in_force"]).toBe("gtc");
  });

  it("reads account, positions and orders into the common shapes", async () => {
    const b = await setup();
    await b.placeOrder("paper", { symbol: "AAPL", side: "buy", type: "market", qty: 3, assetClass: "equity" });
    const acct = await b.getAccount("paper");
    expect(acct.equity).toBeGreaterThan(0);
    const pos = await b.getPositions("paper");
    expect(pos[0]).toMatchObject({ symbol: "AAPL", qty: 3 });
    const orders = await b.listOrders("paper");
    expect(orders[0]?.symbol).toBe("AAPL");
  });

  it("retries GETs on 429/5xx but never retries an order POST (no duplicate orders)", async () => {
    const b = await setup();
    live.state.failNext = { status: 503, count: 2 };
    await expect(b.getAccount("live")).resolves.toBeTruthy();
    paper.state.failNext = { status: 503, count: 1 };
    await expect(b.placeOrder("paper", { symbol: "AAPL", side: "buy", type: "market", qty: 1, assetClass: "equity" })).rejects.toBeInstanceOf(BrokerError);
    expect(paper.state.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("surfaces broker rejections as BrokerError with the status", async () => {
    const b = await setup();
    await expect(b.placeOrder("paper", { symbol: "NOPE", side: "buy", type: "market", qty: 1, assetClass: "equity" })).rejects.toMatchObject({ status: expect.any(Number) });
  });

  it("fails clearly when credentials for a mode are missing", async () => {
    const b = new AlpacaBroker({ paper: MOCK_ALPACA_CREDS });
    await expect(b.getAccount("live")).rejects.toThrow(/live credentials/);
  });

  it("cancels one and all orders", async () => {
    const b = await setup();
    await b.placeOrder("paper", { symbol: "AAPL", side: "buy", type: "limit", qty: 1, limitPrice: 10, assetClass: "equity" });
    await b.placeOrder("paper", { symbol: "MSFT", side: "buy", type: "limit", qty: 1, limitPrice: 10, assetClass: "equity" });
    const [first] = await b.listOrders("paper");
    await b.cancelOrder("paper", (first as { id: string }).id);
    expect(await b.cancelAll("paper")).toBeGreaterThanOrEqual(1);
    expect((await b.listOrders("paper")).filter((o) => o.status === "open" || o.status === "new")).toHaveLength(0);
  });
});
