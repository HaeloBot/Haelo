/**
 * LIVE, READ-ONLY smoke test of the Robinhood Crypto Trading API client (US customers).
 *   RH_CRYPTO_API_KEY=... RH_CRYPTO_PRIVATE_KEY=<base64 seed> npm run smoke:robinhood-crypto
 * It signs and sends GET requests only (account, quote, holdings). It places no orders.
 * Run this before trusting the client: request signing is verified offline against the documentation vector,
 * but only a real call proves the server accepts our requests.
 */
import { RobinhoodCryptoBroker } from "../adapters/robinhood-crypto.js";

const apiKey = process.env["RH_CRYPTO_API_KEY"];
const privateKeyBase64 = process.env["RH_CRYPTO_PRIVATE_KEY"];
if (!apiKey || !privateKeyBase64) {
  console.error("Set RH_CRYPTO_API_KEY and RH_CRYPTO_PRIVATE_KEY.");
  process.exit(2);
}

const broker = new RobinhoodCryptoBroker({ apiKey, privateKeyBase64 });
console.log("account:", await broker.getAccount("live"));
console.log("quote BTC-USD:", await broker.getQuote("BTC-USD"));
console.log("positions:", await broker.getPositions("live"));
console.log("OK: signed GET requests were accepted by Robinhood.");
