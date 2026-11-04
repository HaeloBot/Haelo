import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it } from "vitest";
import { SolanaBroker } from "../src/adapters/solana.js";
import { parseConfig } from "../src/policy/load.js";
import { JupiterClient, parseOrder } from "../src/solana/jupiter.js";
import { SolanaRpc } from "../src/solana/rpc.js";
import { loadSigner, parseSecretKey, walletAddress } from "../src/solana/signer.js";
import { fromUnits, redactSecrets, toUnits, USDC_MINT, WSOL_MINT } from "../src/solana/constants.js";
import { minOutAfterSlippage } from "../src/solana/guard.js";
import type { OrderIntent } from "../src/types.js";
import { fund, startFakeSolana, tokenBalance, type RunningFakeSolana } from "./helpers/fake-solana.js";
import { buildBroker, keypairSigner } from "./helpers/harness.js";

let fake: RunningFakeSolana | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const config = parseConfig("version: 1\nbroker: { type: solana }\n");

function buy(symbol: string, usd: number, extra: Partial<OrderIntent> = {}): OrderIntent {
  return { symbol, side: "buy", type: "market", notionalUsd: usd, assetClass: "crypto", confirm: true, ...extra };
}
function sell(symbol: string, qty: number, extra: Partial<OrderIntent> = {}): OrderIntent {
  return { symbol, side: "sell", type: "market", qty, assetClass: "crypto", confirm: true, ...extra };
}

async function setup(sol = 10, usdc = 1000): Promise<{ broker: SolanaBroker; kp: Keypair; owner: string }> {
  fake = await startFakeSolana();
  const kp = Keypair.generate();
  const owner = kp.publicKey.toBase58();
  fund(fake.state, owner, sol, usdc);
  return { broker: buildBroker(fake, keypairSigner(kp), config), kp, owner };
}

describe("units", () => {
  it("converts decimals exactly", () => {
    expect(toUnits(1.5, 9)).toBe(1_500_000_000n);
    expect(toUnits(0.000001, 6)).toBe(1n);
    expect(fromUnits(123_456_789n, 6)).toBeCloseTo(123.456789, 9);
    expect(() => toUnits(0, 6)).toThrow();
    expect(minOutAfterSlippage(10_000n, 50)).toBe(9_950n);
  });
});

describe("SolanaBroker", () => {
  it("refuses an RPC that is not mainnet-beta", async () => {
    fake = await startFakeSolana();
    fake.state.genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; // devnet
    const b = new SolanaBroker(new SolanaRpc(fake.rpcUrl), new JupiterClient({ baseUrl: fake.jupiterUrl }), undefined);
    await expect(b.connect()).rejects.toThrow(/not Solana mainnet-beta/);
  });

  it("quotes a pair from Jupiter in both directions", async () => {
    const { broker } = await setup();
    const q = await broker.getQuote("sol");
    expect(q.symbol).toBe("SOL/USDC");
    expect(q.bid).toBeGreaterThan(149);
    expect(q.ask).toBeGreaterThanOrEqual(q.bid);
    expect(broker.normalizeSymbol("jup-usdc")).toBe("JUP/USDC");
  });

  it("reads wallet balances and values positions through Jupiter", async () => {
    const { broker } = await setup(2, 500);
    const a = await broker.getAccount("live");
    expect(a.cash).toBe(500);
    const pos = await broker.getPositions("live");
    expect(pos[0]?.symbol).toBe("SOL/USDC");
    expect(pos[0]?.qty).toBe(2);
    expect(a.equity).toBeGreaterThan(790);
  });

  it("paper: prices from a real route and simulates the transaction, never executes", async () => {
    const { broker } = await setup();
    const o = (await broker.placeOrder("paper", buy("SOL/USDC", 150))) as unknown as Record<string, unknown>;
    expect(o["simulated"]).toBe(true);
    expect(o["signed"]).toBe(false);
    expect((o["onchainSimulation"] as { ok: boolean }).ok).toBe(true);
    expect(o["filledQty"]).toBeGreaterThan(0.99);
    expect([...fake!.state.swaps.values()].some((s) => s.executed)).toBe(false);
  });

  it("live: signs locally, executes through Jupiter, and the wallet balances move", async () => {
    const { broker, owner } = await setup();
    const o = (await broker.placeOrder("live", buy("SOL/USDC", 300))) as unknown as Record<string, unknown>;
    expect(o["simulated"]).toBe(false);
    expect(String(o["explorer"])).toContain("solscan.io/tx/");
    expect(tokenBalance(fake!.state, owner, USDC_MINT)).toBe(700_000_000n);
    expect(fake!.state.lamports.get(owner)).toBeGreaterThan(11_900_000_000n);
    const s = (await broker.placeOrder("live", sell("SOL", 1))) as unknown as Record<string, unknown>;
    expect(s["status"]).toBe("filled");
    expect(tokenBalance(fake!.state, owner, USDC_MINT)).toBeGreaterThan(840_000_000n);
  });

  it("refuses to sign when simulation shows the wallet being drained", async () => {
    const { broker } = await setup();
    fake!.state.drainLamports = 2_000_000_000n;
    await expect(broker.placeOrder("live", buy("SOL/USDC", 50))).rejects.toThrow(/Refusing to sign/);
    expect([...fake!.state.swaps.values()].some((s) => s.executed)).toBe(false);
  });

  it("refuses to sign when the simulated payout is under the slippage floor", async () => {
    const { broker } = await setup();
    const real = new JupiterClient({ baseUrl: fake!.jupiterUrl });
    // Jupiter quotes one amount, but the transaction it builds delivers half of it.
    const lying = {
      order: async (r: Parameters<JupiterClient["order"]>[0]) => {
        const o = await real.order(r);
        const stored = fake!.state.swaps.get(o.requestId);
        if (stored) stored.outAmount = stored.outAmount / 2n;
        return o;
      },
      execute: real.execute.bind(real),
    };
    (broker as unknown as { venue: unknown }).venue = lying;
    await expect(broker.placeOrder("live", buy("JUP/USDC", 100))).rejects.toThrow(/under the minimum/);
    expect([...fake!.state.swaps.values()].some((s) => s.executed)).toBe(false);
  });

  it("needs confirm: true and a signer to go live", async () => {
    const { broker } = await setup();
    await expect(broker.placeOrder("live", buy("SOL", 10, { confirm: false }))).rejects.toThrow(/confirm: true/);
    const watch = buildBroker(fake!, undefined, config, undefined, Keypair.generate().publicKey.toBase58());
    await expect(watch.placeOrder("live", buy("SOL", 10))).rejects.toThrow(/No signer/);
  });

  it("keeps a SOL reserve for fees", async () => {
    const { broker } = await setup(1, 0);
    await expect(broker.placeOrder("live", sell("SOL", 0.99))).rejects.toThrow(/for fees/);
  });

  it("refuses limit orders, unknown tokens and slippage over the cap", async () => {
    const { broker } = await setup();
    await expect(broker.placeOrder("live", { ...buy("SOL", 10), type: "limit", limitPrice: 100 })).rejects.toThrow(/market/);
    await expect(broker.placeOrder("live", buy("NOPE", 10))).rejects.toThrow(/Unknown token/);
    await expect(broker.placeOrder("live", buy("SOL", 10, { slippageBps: 500 }))).rejects.toThrow(/exceeds the policy cap/);
    await expect(broker.placeOrder("live", { ...sell("SOL", 1), qty: undefined })).rejects.toThrow(/needs qty/);
  });

  it("reports a failed execute without pretending it filled", async () => {
    const { broker } = await setup();
    fake!.state.failExecute = "slippage exceeded";
    await expect(broker.placeOrder("live", buy("SOL", 10))).rejects.toThrow(/execute failed.*slippage exceeded/);
  });

  it("reports when Jupiter has no route", async () => {
    const { broker } = await setup();
    fake!.state.failOrders = "No routes found";
    await expect(broker.getQuote("SOL")).rejects.toThrow(/no route: No routes found/);
  });

  it("swaps cannot be cancelled", async () => {
    const { broker } = await setup();
    await expect(broker.cancelOrder("live", "x")).rejects.toThrow(/cannot be cancelled/);
    expect(await broker.cancelAll("live")).toBe(0);
    expect(await broker.listOrders("live")).toEqual([]);
  });
});

describe("Jupiter response parsing", () => {
  it("rejects a taker order with no transaction", () => {
    expect(() => parseOrder({ outAmount: "10", requestId: "r", transaction: "" }, { inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 1n, taker: "x" })).toThrow(/could not build/);
    expect(parseOrder({ outAmount: "10", inAmount: "1" }, { inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 1n }).outAmount).toBe(10n);
  });
});

describe("signer loading", () => {
  const kp = Keypair.generate();
  it("parses base58 and Solana CLI JSON keys", () => {
    expect(parseSecretKey(bs58.encode(kp.secretKey)).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(() => parseSecretKey("not-a-key!")).toThrow(/base58/);
  });

  it("loads from env, a 0600 file, or the secret store, and never echoes the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "haelo-key-"));
    try {
      const file = join(dir, "id.json");
      writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
      chmodSync(file, 0o644);
      await expect(loadSigner({ HAELO_KEYPAIR: file })).rejects.toThrow(/chmod 600/);
      chmodSync(file, 0o600);
      expect((await loadSigner({ HAELO_KEYPAIR: file }))?.source).toBe("file");
      expect((await loadSigner({ HAELO_PRIVATE_KEY: bs58.encode(kp.secretKey) }))?.address).toBe(kp.publicKey.toBase58());
      await expect(loadSigner({ HAELO_PRIVATE_KEY: "x", HAELO_KEYPAIR: file })).rejects.toThrow(/only one/);
      const store = { kind: "file" as const, get: () => bs58.encode(kp.secretKey), set: () => undefined, delete: () => undefined };
      expect((await loadSigner({}, {}, store))?.source).toBe("keychain");
      expect(await loadSigner({})).toBeUndefined();
      expect(walletAddress(undefined, { HAELO_ADDRESS: kp.publicKey.toBase58() })).toBe(kp.publicKey.toBase58());
      expect(() => walletAddress(undefined, { HAELO_ADDRESS: "0xnot" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts key material from messages", () => {
    expect(redactSecrets(`bad ${bs58.encode(kp.secretKey)}`)).not.toContain(bs58.encode(kp.secretKey));
    expect(redactSecrets(JSON.stringify(Array.from(kp.secretKey)))).toBe("[redacted key bytes]");
  });

});
