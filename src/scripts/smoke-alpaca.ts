/**
 * LIVE smoke test against Alpaca's PAPER environment. Needs a free paper account's keys:
 *   ALPACA_PAPER_KEY_ID=... ALPACA_PAPER_SECRET_KEY=... npm run smoke:alpaca
 * It reads the account and a quote, places one tiny limit order far below market (so it cannot fill),
 * lists it, and cancels it. It never touches the live endpoint. Not run in CI (no credentials there).
 */
import { AlpacaBroker } from "../adapters/alpaca.js";

const keyId = process.env["ALPACA_PAPER_KEY_ID"];
const secret = process.env["ALPACA_PAPER_SECRET_KEY"];
if (!keyId || !secret) {
  console.error("Set ALPACA_PAPER_KEY_ID and ALPACA_PAPER_SECRET_KEY (paper keys only).");
  process.exit(2);
}

const broker = new AlpacaBroker({ paper: { keyId, secret } });
const acct = await broker.getAccount("paper");
console.log("account:", { equity: acct.equity, cash: acct.cash });
const q = await broker.getQuote("AAPL");
console.log("quote:", q);
const px = Math.max(1, Math.floor(q.bid * 0.5));
const order = await broker.placeOrder("paper", { symbol: "AAPL", side: "buy", type: "limit", qty: 1, limitPrice: px, assetClass: "equity" });
console.log("placed:", { id: order.id, status: order.status });
const open = (await broker.listOrders("paper")).filter((o) => o.id === order.id);
console.log("listed:", open.length === 1 ? "ok" : "MISSING");
await broker.cancelOrder("paper", order.id);
console.log("cancelled:", order.id);
console.log("OK: Alpaca paper adapter works against the real API.");
