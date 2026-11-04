import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { RobinhoodChainBroker } from "../src/adapters/robinhood-chain.js";
import { RestAdapter } from "../src/adapters/rest-base.js";
import { AuditLog } from "../src/audit.js";
import { bestQuote, encodeApprove, viemReader, type ChainReader, type ChainSender } from "../src/chain/executor.js";
import { loadLocalSigner } from "../src/chain/signer.js";
import { ROBINHOOD_MAINNET, ROBINHOOD_TESTNET, amountOutMinimum, erc20Abi } from "../src/chain/uniswap.js";
import { HaeloCore } from "../src/core.js";
import { parseConfig } from "../src/policy/load.js";
import { evaluateOrder } from "../src/policy/evaluate.js";
import { StateStore } from "../src/state.js";

const MAX = 2n ** 256n - 1n;
const OWNER = getAddress("0x00000000000000000000000000000000000000a1");
const HASH = `0x${"ab".repeat(32)}` as Hex;

class FakeChain implements ChainReader, ChainSender {
  readonly address = OWNER;
  sent: Array<{ to: Address; data: Hex }> = [];
  currentAllowance = 0n;
  revertSwap = false;
  chainId = ROBINHOOD_MAINNET.chainId;
  async getChainId(): Promise<number> {
    return this.chainId;
  }
  async getBytecode(): Promise<Hex> {
    return "0x6001";
  }
  async quoteExactInputSingle(_tokenIn: Address, _tokenOut: Address, amountIn: bigint, fee: number): Promise<bigint> {
    return amountIn * BigInt(fee === 500 ? 3 : 2);
  }
  async allowance(): Promise<bigint> {
    return this.currentAllowance;
  }
  async balanceOf(): Promise<bigint> {
    return 1_000_000_000n;
  }
  async decimals(token: Address): Promise<number> {
    return token === ROBINHOOD_MAINNET.usdg ? 6 : 18;
  }
  async symbol(): Promise<string> {
    return "WETH";
  }
  async ethBalance(): Promise<bigint> {
    return 10n ** 18n;
  }
  async simulate(): Promise<void> {
    return undefined;
  }
  async send(tx: { to: Address; data: Hex }): Promise<Hex> {
    this.sent.push(tx);
    if (tx.to !== ROBINHOOD_MAINNET.swapRouter02) this.currentAllowance = MAX;
    return HASH;
  }
  async wait(): Promise<{ status: "success" | "reverted"; transactionHash: Hex; blockNumber: bigint }> {
    return { status: this.revertSwap && this.sent.at(-1)?.to === ROBINHOOD_MAINNET.swapRouter02 ? "reverted" : "success", transactionHash: HASH, blockNumber: 1n };
  }
}

function broker(chain: FakeChain, withSender = true): RobinhoodChainBroker {
  return new RobinhoodChainBroker(chain, withSender ? chain : undefined, { maxSlippageBps: 100, address: OWNER });
}

describe("Uniswap v3 math and calldata", () => {
  it("caps output and refuses an unlimited approval", () => {
    expect(amountOutMinimum(1_000_000n, 100)).toBe(990_000n);
    expect(() => amountOutMinimum(1n, 10_000)).toThrow(/basis points/);
    const data = encodeApprove(ROBINHOOD_MAINNET.swapRouter02, 12_345n);
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args[1]).toBe(12_345n);
    expect(data.includes("f".repeat(64))).toBe(false);
    expect(() => encodeApprove(ROBINHOOD_MAINNET.swapRouter02, MAX)).toThrow(/unlimited/);
  });

  it("picks the fee tier with the best quote", async () => {
    const chain = new FakeChain();
    const quote = await bestQuote(chain, ROBINHOOD_MAINNET.weth, ROBINHOOD_MAINNET.usdg, 100n);
    expect(quote.fee).toBe(500);
    expect(quote.amountOut).toBe(300n);
  });

  it("keeps the documented mainnet addresses and does not invent a testnet router", () => {
    expect(ROBINHOOD_MAINNET.chainId).toBe(4663);
    expect(ROBINHOOD_MAINNET.swapRouter02).toBe(getAddress("0xcaf681a66d020601342297493863e78c959e5cb2"));
    expect(ROBINHOOD_MAINNET.quoterV2).toBe(getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"));
    expect(ROBINHOOD_TESTNET.chainId).toBe(46630);
    expect("swapRouter02" in ROBINHOOD_TESTNET).toBe(false);
  });
});

describe("Robinhood Chain broker", () => {
  it("prices paper orders from the quoter and does not sign", async () => {
    const chain = new FakeChain();
    const order = await broker(chain, false).placeOrder("paper", {
      symbol: "WETH/USDG",
      side: "buy",
      type: "market",
      notionalUsd: 10,
      assetClass: "crypto",
    });
    expect(order.id.startsWith("paper-")).toBe(true);
    expect(chain.sent).toHaveLength(0);
    expect(order.filledQty).toBeGreaterThan(0);
  });

  it("reads balances, refuses cancels, and sells a quantity on paper", async () => {
    const chain = new FakeChain();
    const live = broker(chain);
    const account = await live.getAccount("paper");
    expect(account.id).toBe(OWNER);
    expect(account.cash).toBeGreaterThan(0);
    const positions = await live.getPositions("paper");
    expect(positions.length).toBeGreaterThan(0);
    expect((await live.householdView("paper"))[0]?.isAgentAccount).toBe(true);
    expect(await live.listOrders("paper")).toEqual([]);
    expect(await live.cancelAll("paper")).toBe(0);
    await expect(live.cancelOrder()).rejects.toThrow(/cannot be cancelled/);
    const sold = await live.placeOrder("paper", { symbol: "WETH/USDG", side: "sell", type: "market", qty: 0.01, assetClass: "crypto" });
    expect(sold.filledQty).toBeCloseTo(0.01);
    await expect(live.placeOrder("paper", { symbol: "WETH/USDG", side: "buy", type: "limit", notionalUsd: 1, assetClass: "crypto" })).rejects.toThrow(/market/);
    await expect(new RobinhoodChainBroker(chain, undefined).getAccount("paper")).rejects.toThrow(/HAELO_ADDRESS/);
  });

  it("refuses a live swap without confirm and without broadcasting", async () => {
    const chain = new FakeChain();
    await expect(
      broker(chain).placeOrder("live", { symbol: "WETH/USDG", side: "buy", type: "market", notionalUsd: 10, assetClass: "crypto" }),
    ).rejects.toThrow(/confirm: true/);
    expect(chain.sent).toHaveLength(0);
  });

  it("approves the exact amount in, simulates, then sends", async () => {
    const chain = new FakeChain();
    const order = await broker(chain).placeOrder("live", {
      symbol: "WETH/USDG",
      side: "buy",
      type: "market",
      notionalUsd: 10,
      assetClass: "crypto",
      confirm: true,
      slippageBps: 50,
    });
    expect(order.id).toBe(HASH);
    expect(chain.sent).toHaveLength(2);
    const approval = decodeFunctionData({ abi: erc20Abi, data: chain.sent[0]?.data as Hex });
    expect(approval.args[0]).toBe(ROBINHOOD_MAINNET.swapRouter02);
    expect(approval.args[1]).toBe(10_000_000n);
    expect(chain.sent[1]?.to).toBe(ROBINHOOD_MAINNET.swapRouter02);
  });

  it("drops to shadow after consecutive live send failures", async () => {
    const chain = new FakeChain();
    chain.revertSwap = true;
    const dir = mkdtempSync(join(tmpdir(), "haelo-chain-"));
    const config = parseConfig(`version: 1
stateDir: ${dir}
live: { enabled: true }
broker: { type: robinhood-chain, maxConsecutiveErrors: 2 }
ladder: { start: micro }
household: { enabled: false }
rails: { maxOrderUsd: 100, allowAssetClasses: [crypto] }
`);
    const core = new HaeloCore({
      config,
      adapter: new RestAdapter(broker(chain)),
      store: new StateStore(dir, HaeloCore.initialStateFactory(config, () => new Date())),
      audit: new AuditLog(join(dir, "audit.jsonl")),
      now: () => new Date(),
    });
    await core.init();
    const args = { symbol: "WETH/USDG", side: "buy", type: "market", notional_usd: 10, confirm: true };
    const first = await core.callTool("place_order", args);
    const second = await core.callTool("place_order", args);
    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    expect(core.status().rung).toBe("shadow");
    const third = await core.callTool("place_order", args);
    expect(third.isError).toBeFalsy();
    expect(JSON.stringify(third.content)).toContain("simulated");
    const stopped = await core.callTool("haelo_kill_switch", {});
    expect(JSON.stringify(stopped.content)).toContain("shadow");
    expect(core.audit.verify().ok).toBe(true);
  });
});

describe("viem reader against a scripted RPC", () => {
  it("quotes, reads a token, and simulates a call", async () => {
    const quote = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }],
      [5_000_000n, 0n, 0, 21_000n],
    );
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string; params?: [{ data?: string }] };
        const data = body.params?.[0]?.data ?? "";
        let result: string = "0x";
        if (body.method === "eth_chainId") result = "0x1237";
        else if (body.method === "eth_getCode") result = "0x6001";
        else if (body.method === "eth_getBalance") result = "0xde0b6b3a7640000";
        else if (body.method === "eth_blockNumber") result = "0x10";
        else if (data.startsWith("0x313ce567")) result = encodeAbiParameters([{ type: "uint8" }], [18]);
        else if (data.startsWith("0x95d89b41")) result = encodeAbiParameters([{ type: "string" }], ["WETH"]);
        else if (data.startsWith("0x70a08231") || data.startsWith("0xdd62ed3e")) result = encodeAbiParameters([{ type: "uint256" }], [1000n]);
        else if (body.method === "eth_call") result = quote;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const reader = viemReader(`http://127.0.0.1:${address.port}`);
      expect(await reader.getChainId()).toBe(4663);
      expect(await reader.getBytecode(ROBINHOOD_MAINNET.swapRouter02)).toBe("0x6001");
      expect(await reader.ethBalance(OWNER)).toBeGreaterThan(0n);
      expect(await reader.decimals(ROBINHOOD_MAINNET.weth)).toBe(18);
      expect(await reader.symbol(ROBINHOOD_MAINNET.weth)).toBe("WETH");
      expect(await reader.balanceOf(ROBINHOOD_MAINNET.weth, OWNER)).toBe(1000n);
      expect(await reader.allowance(ROBINHOOD_MAINNET.weth, OWNER, ROBINHOOD_MAINNET.swapRouter02)).toBe(1000n);
      const out = await reader.quoteExactInputSingle(ROBINHOOD_MAINNET.weth, ROBINHOOD_MAINNET.usdg, 10n ** 15n, 100);
      expect(out).toBe(5_000_000n);
      await reader.simulate(ROBINHOOD_MAINNET.swapRouter02, "0x12345678", OWNER);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("signer and policy", () => {
  it("refuses a world-readable keystore and does not echo the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "haelo-key-"));
    const file = join(dir, "key");
    const secret = `0x${"11".repeat(32)}`;
    writeFileSync(file, JSON.stringify({ privateKey: secret }));
    chmodSync(file, 0o644);
    expect(() => loadLocalSigner({ HAELO_KEYSTORE: file })).toThrow(/chmod 600/);
    expect(() => loadLocalSigner({ HAELO_PRIVATE_KEY: secret, HAELO_KEYSTORE: file })).toThrow(/only one/);
    try {
      loadLocalSigner({ HAELO_PRIVATE_KEY: "nope" });
    } catch (e) {
      expect(e instanceof Error ? e.message : "").not.toContain(secret);
    }
    chmodSync(file, 0o600);
    const loaded = loadLocalSigner({ HAELO_KEYSTORE: file });
    expect(loaded?.kind).toBe("keystore");
    expect(loaded?.account.address.startsWith("0x")).toBe(true);
  });

  it("blocks slippage above the rail", () => {
    const config = parseConfig("version: 1\nbroker: { type: robinhood-chain }\nrails: { maxSlippageBps: 50 }\n");
    const result = evaluateOrder({
      config,
      rung: "shadow",
      intent: { symbol: "WETH/USDG", side: "buy", type: "market", notionalUsd: 10, assetClass: "crypto", slippageBps: 80 },
      notionalUsd: 10,
      usage: { ordersToday: 0, notionalToday: 0, recentOrderTimes: [], lastOrderBySymbol: {} },
      nowMs: Date.now(),
    });
    expect(result.verdict).toBe("block");
    expect(result.violations.some((v) => v.code === "max_slippage")).toBe(true);
  });
});

describe("testnet swap", () => {
  it.skipIf(process.env["HAELO_RUN_TESTNET"] !== "1")("is gated and refuses to invent a router", async () => {
    const { createPublicClient, http } = await import("viem");
    const client = createPublicClient({ transport: http(ROBINHOOD_TESTNET.rpc) });
    const code = await client.getBytecode({ address: ROBINHOOD_MAINNET.swapRouter02 });
    if (!code || code === "0x") {
      throw new Error("Uniswap v3 SwapRouter02 has no code on Robinhood Chain testnet (46630). Official docs publish no testnet router. Nothing was signed.");
    }
    if (!process.env["HAELO_PRIVATE_KEY"]) throw new Error("HAELO_PRIVATE_KEY is required before a funded testnet swap can be sent.");
  });
});
