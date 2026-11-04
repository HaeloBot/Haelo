import { getAddress, type Address } from "viem";
import type { BrokerAccount, BrokerMode, BrokerOrder, BrokerPosition, HouseholdAccount, OrderIntent, Quote } from "../types.js";
import { uuid } from "../util.js";
import { bestQuote, executeSwap, type ChainReader, type ChainSender } from "../chain/executor.js";
import { ROBINHOOD_MAINNET, decimalToUnits, unitsToNumber } from "../chain/uniswap.js";
import { BrokerError } from "./types.js";
import type { RestBroker } from "./rest-base.js";

export interface KnownToken {
  symbol: string;
  address: Address;
  decimals: number;
}

interface Pair {
  label: string;
  base: KnownToken;
  quote: KnownToken;
}

/**
 * On-chain swaps through Uniswap v3 SwapRouter02 on Robinhood Chain.
 * Paper mode quotes on-chain and does not sign. Live mode signs only after
 * `confirm: true` and `live.enabled`.
 */
export class RobinhoodChainBroker implements RestBroker {
  readonly id = "robinhood-chain";
  /** Paper is a no-sign simulation against the same quoter live uses. */
  readonly supportsPaper = true;
  private readonly tokens = new Map<string, KnownToken>();
  private readonly router: Address;
  private readonly readAddress: Address | undefined;
  private readonly deadlineSeconds: number;
  private readonly maxSlippageBps: number;
  private readonly now: () => Date;
  private ready = false;

  constructor(
    private readonly reader: ChainReader,
    private readonly sender: ChainSender | undefined,
    opts: {
      router?: Address;
      deadlineSeconds?: number;
      maxSlippageBps?: number;
      now?: () => Date;
      tokens?: Array<{ symbol: string; address: Address; decimals?: number }>;
      address?: Address;
    } = {},
  ) {
    this.router = opts.router ?? ROBINHOOD_MAINNET.swapRouter02;
    this.readAddress = opts.address;
    this.deadlineSeconds = opts.deadlineSeconds ?? 120;
    this.maxSlippageBps = opts.maxSlippageBps ?? 100;
    this.now = opts.now ?? (() => new Date());
    const defaults: Array<{ symbol: string; address: Address }> = [
      { symbol: "WETH", address: ROBINHOOD_MAINNET.weth },
      { symbol: "USDG", address: ROBINHOOD_MAINNET.usdg },
    ];
    for (const t of defaults) this.tokens.set(t.symbol, { symbol: t.symbol, address: t.address, decimals: t.symbol === "USDG" ? 6 : 18 });
    for (const t of opts.tokens ?? []) {
      this.tokens.set(t.symbol.toUpperCase(), { symbol: t.symbol.toUpperCase(), address: getAddress(t.address), decimals: t.decimals ?? 18 });
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await this.connect();
    this.ready = true;
  }

  async connect(): Promise<void> {
    const id = await this.reader.getChainId();
    if (id !== ROBINHOOD_MAINNET.chainId) {
      throw new BrokerError(`Robinhood Chain RPC returned chain id ${id}, expected ${ROBINHOOD_MAINNET.chainId}.`);
    }
    const code = await this.reader.getBytecode(this.router);
    if (!code || code === "0x") throw new BrokerError(`No contract code at Uniswap SwapRouter02 ${this.router}.`);
    const quoter = await this.reader.getBytecode(ROBINHOOD_MAINNET.quoterV2);
    if (!quoter || quoter === "0x") throw new BrokerError(`No contract code at Uniswap QuoterV2 ${ROBINHOOD_MAINNET.quoterV2}.`);
  }

  async getQuote(symbol: string): Promise<Quote> {
    await this.ensureReady();
    const pair = this.pair(symbol);
    const one = 10n ** BigInt(pair.base.decimals);
    const sold = await bestQuote(this.reader, pair.base.address, pair.quote.address, one);
    const bid = unitsToNumber(sold.amountOut, pair.quote.decimals);
    const spend = decimalToUnits(bid, pair.quote.decimals);
    const bought = await bestQuote(this.reader, pair.quote.address, pair.base.address, spend > 0n ? spend : one);
    const baseOut = unitsToNumber(bought.amountOut, pair.base.decimals);
    const ask = baseOut > 0 ? bid / baseOut : bid;
    return {
      symbol: pair.label,
      bid,
      ask: ask > 0 ? ask : bid,
      mid: (bid + (ask > 0 ? ask : bid)) / 2,
      ts: this.now().toISOString(),
    };
  }

  async getAccount(mode: BrokerMode): Promise<BrokerAccount> {
    const owner = this.owner(mode);
    const usdg = this.tokens.get("USDG");
    if (!usdg) throw new BrokerError("USDG is not in the token book.");
    const cash = unitsToNumber(await this.reader.balanceOf(usdg.address, owner), usdg.decimals);
    const positions = await this.getPositions(mode);
    const equity = cash + positions.reduce((s, p) => s + p.marketValue, 0);
    return { id: owner, equity, cash, buyingPower: cash, currency: "USDG" };
  }

  async getPositions(mode: BrokerMode): Promise<BrokerPosition[]> {
    const owner = this.owner(mode);
    const out: BrokerPosition[] = [];
    for (const token of this.tokens.values()) {
      if (token.symbol === "USDG") continue;
      const raw = await this.reader.balanceOf(token.address, owner);
      if (raw === 0n) continue;
      const qty = unitsToNumber(raw, token.decimals);
      let marketValue: number;
      try {
        const q = await this.getQuote(`${token.symbol}/USDG`);
        marketValue = qty * q.mid;
      } catch {
        throw new BrokerError(`Could not price ${token.symbol}. Refusing to invent a market value.`);
      }
      out.push({ symbol: token.symbol, qty, avgEntryPrice: 0, marketValue, assetClass: "crypto" });
    }
    return out;
  }

  async listOrders(): Promise<BrokerOrder[]> {
    return [];
  }

  async placeOrder(mode: BrokerMode, intent: OrderIntent): Promise<BrokerOrder> {
    await this.ensureReady();
    const pair = this.pair(intent.symbol);
    const slippage = intent.slippageBps ?? this.maxSlippageBps;
    if (slippage > this.maxSlippageBps) throw new BrokerError(`Slippage ${slippage} bps exceeds the policy cap of ${this.maxSlippageBps} bps.`);
    const side = intent.side;
    const { tokenIn, tokenOut, amountIn, baseDecimals, quoteDecimals } = this.amountIn(pair, intent);
    if (mode === "paper") {
      const quote = await bestQuote(this.reader, tokenIn, tokenOut, amountIn);
      const outDecimals = side === "buy" ? baseDecimals : quoteDecimals;
      const inDecimals = side === "buy" ? quoteDecimals : baseDecimals;
      const price = unitsToNumber(quote.amountOut, outDecimals) / unitsToNumber(amountIn, inDecimals);
      const qty = side === "buy" ? unitsToNumber(quote.amountOut, baseDecimals) : unitsToNumber(amountIn, baseDecimals);
      const order: BrokerOrder = {
        id: `paper-${uuid()}`,
        symbol: pair.label,
        side,
        type: intent.type,
        status: "filled",
        qty,
        filledQty: qty,
        filledAvgPrice: price,
        submittedAt: this.now().toISOString(),
        filledAt: this.now().toISOString(),
      };
      return Object.assign(order, { simulated: true, fee: quote.fee, quotedOut: quote.amountOut.toString(), signed: false });
    }
    if (intent.confirm !== true) {
      throw new BrokerError("Live Robinhood Chain swaps require confirm: true. Nothing was signed.");
    }
    if (!this.sender) throw new BrokerError("No signer configured. Set HAELO_PRIVATE_KEY or HAELO_KEYSTORE, or pass an external signer. Nothing was signed.");
    const deadline = BigInt(Math.floor(this.now().getTime() / 1000) + this.deadlineSeconds);
    const done = await executeSwap({
      reader: this.reader,
      sender: this.sender,
      router: this.router,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps: slippage,
      deadline,
    });
    const outDecimals = side === "buy" ? baseDecimals : quoteDecimals;
    const inDecimals = side === "buy" ? quoteDecimals : baseDecimals;
    const qty = side === "buy" ? unitsToNumber(done.quotedOut, baseDecimals) : unitsToNumber(amountIn, baseDecimals);
    const price = unitsToNumber(done.quotedOut, outDecimals) / unitsToNumber(amountIn, inDecimals);
    const order: BrokerOrder = {
      id: done.swapTxHash,
      symbol: pair.label,
      side,
      type: intent.type,
      status: "filled",
      qty,
      filledQty: qty,
      filledAvgPrice: price,
      submittedAt: this.now().toISOString(),
      filledAt: this.now().toISOString(),
    };
    return Object.assign(order, {
      simulated: false,
      txHash: done.swapTxHash,
      ...(done.approveTxHash ? { approveTxHash: done.approveTxHash } : {}),
      fee: done.fee,
      amountOutMinimum: done.amountOutMinimum.toString(),
    });
  }

  async cancelOrder(): Promise<void> {
    throw new BrokerError("A Uniswap swap settles in one transaction and cannot be cancelled. Call haelo_kill_switch to stop new orders.");
  }

  async cancelAll(): Promise<number> {
    return 0;
  }

  async householdView(mode: BrokerMode): Promise<HouseholdAccount[]> {
    const account = await this.getAccount(mode);
    const positions = await this.getPositions(mode);
    return [{ id: account.id, isAgentAccount: true, equity: account.equity, positions, fills: [] }];
  }

  private owner(_mode: BrokerMode): Address {
    const address = this.sender?.address ?? this.readAddress;
    if (!address) throw new BrokerError("Set HAELO_ADDRESS or a signer to read balances. Quotes do not need one.");
    return address;
  }

  private pair(symbol: string): Pair {
    const raw = symbol.trim().toUpperCase();
    const [baseSym, quoteSym] = raw.includes("/") ? raw.split("/") : [raw, "USDG"];
    if (!baseSym || !quoteSym) throw new BrokerError(`Cannot read pair "${symbol}". Use BASE/QUOTE, for example WETH/USDG.`);
    const base = this.tokens.get(baseSym);
    const quote = this.tokens.get(quoteSym);
    if (!base || !quote) throw new BrokerError(`Unknown token in ${symbol}. Known tokens: ${[...this.tokens.keys()].join(", ")}.`);
    return { label: `${base.symbol}/${quote.symbol}`, base, quote };
  }

  private amountIn(pair: Pair, intent: OrderIntent): { tokenIn: Address; tokenOut: Address; amountIn: bigint; baseDecimals: number; quoteDecimals: number } {
    if (intent.type !== "market") throw new BrokerError("Robinhood Chain swaps are market exact-input swaps. Limit orders are refused.");
    if (intent.side === "buy") {
      if (intent.notionalUsd === undefined) throw new BrokerError("A buy needs notional_usd, the USDG amount to spend.");
      return {
        tokenIn: pair.quote.address,
        tokenOut: pair.base.address,
        amountIn: decimalToUnits(intent.notionalUsd, pair.quote.decimals),
        baseDecimals: pair.base.decimals,
        quoteDecimals: pair.quote.decimals,
      };
    }
    if (intent.qty === undefined) throw new BrokerError("A sell needs qty of the base token.");
    return {
      tokenIn: pair.base.address,
      tokenOut: pair.quote.address,
      amountIn: decimalToUnits(intent.qty, pair.base.decimals),
      baseDecimals: pair.base.decimals,
      quoteDecimals: pair.quote.decimals,
    };
  }
}
