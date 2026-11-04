import { PublicKey } from "@solana/web3.js";
import type { BrokerAccount, BrokerMode, BrokerOrder, BrokerPosition, HouseholdAccount, OrderIntent, Quote } from "../types.js";
import { uuid } from "../util.js";
import { BrokerError } from "./types.js";
import type { RestBroker } from "./rest-base.js";
import { BASE58_KEY, DEFAULT_TOKENS, SOLANA_MAINNET, USDC_MINT, WSOL_MINT, fromUnits, toUnits, type TokenInfo } from "../solana/constants.js";
import type { SolanaReader } from "../solana/rpc.js";
import type { OrderResponse, SwapVenue } from "../solana/jupiter.js";
import type { SolanaSigner } from "../solana/signer.js";
import { decodeTransaction, guardSwap, minOutAfterSlippage, type GuardReport } from "../solana/guard.js";

interface Token extends TokenInfo {
  program: string;
}

interface Pair {
  label: string;
  base: Token;
  quote: Token;
}

export interface SolanaBrokerOptions {
  /** Expected genesis hash; mainnet-beta unless a test cluster is configured. */
  genesisHash?: string;
  maxSlippageBps?: number;
  /** Lamports kept back for fees when selling SOL. */
  reserveLamports?: bigint;
  /** Most lamports a swap may cost on top of any SOL sold. */
  maxFeeLamports?: bigint;
  /** Paper orders also build and simulate the real transaction when a wallet address is known. */
  paperSimulate?: boolean;
  tokens?: Array<{ symbol: string; mint: string }>;
  /** Watch-only address used for balances when no signer is loaded. */
  address?: string;
  now?: () => Date;
}

/**
 * Spot swaps on Solana through Jupiter.
 * Paper: priced from a live Jupiter route and, when a wallet is known, the real transaction is simulated. Nothing is signed.
 * Live: the transaction is decoded, simulated and balance-checked, then signed locally and sent through Jupiter /execute.
 */
export class SolanaBroker implements RestBroker {
  readonly id = "solana";
  readonly supportsPaper = true;
  private readonly tokens = new Map<string, Token>();
  private readonly pending: Array<{ symbol: string; mint: string }>;
  private readonly genesisHash: string;
  private readonly maxSlippageBps: number;
  private readonly reserveLamports: bigint;
  private readonly maxFeeLamports: bigint;
  private readonly paperSimulate: boolean;
  private readonly readAddress: string | undefined;
  private readonly now: () => Date;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly reader: SolanaReader,
    private readonly venue: SwapVenue,
    private readonly signer: SolanaSigner | undefined,
    opts: SolanaBrokerOptions = {},
  ) {
    this.genesisHash = opts.genesisHash ?? SOLANA_MAINNET.genesisHash;
    this.maxSlippageBps = opts.maxSlippageBps ?? 100;
    this.reserveLamports = opts.reserveLamports ?? 20_000_000n;
    this.maxFeeLamports = opts.maxFeeLamports ?? 10_000_000n;
    this.paperSimulate = opts.paperSimulate ?? true;
    this.readAddress = opts.address;
    this.now = opts.now ?? (() => new Date());
    this.pending = [...DEFAULT_TOKENS.map((t) => ({ symbol: t.symbol, mint: t.mint })), ...(opts.tokens ?? [])];
    for (const t of this.pending) {
      if (!BASE58_KEY.test(t.mint)) throw new BrokerError(`${t.symbol}: "${t.mint}" is not a Solana mint address.`);
    }
  }

  /** Check the cluster and read every mint's decimals and token program from chain. */
  connect(): Promise<void> {
    this.ready ??= (async () => {
      const genesis = await this.reader.getGenesisHash();
      if (genesis !== this.genesisHash) throw new BrokerError(`The RPC is not Solana mainnet-beta (genesis ${genesis}).`);
      for (const t of this.pending) {
        const mint = await this.reader.getMint(t.mint);
        this.tokens.set(t.symbol.toUpperCase(), { symbol: t.symbol.toUpperCase(), mint: t.mint, decimals: mint.decimals, program: mint.program });
      }
    })().catch((e: unknown) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  normalizeSymbol(symbol: string): string {
    const raw = symbol.trim().toUpperCase().replace(/[-_]/g, "/");
    const [base, quote] = raw.includes("/") ? raw.split("/") : [raw, "USDC"];
    return `${base}/${quote}`;
  }

  async getQuote(symbol: string): Promise<Quote> {
    await this.connect();
    const pair = this.pair(symbol);
    const one = 10n ** BigInt(pair.base.decimals);
    const sold = await this.venue.order({ inputMint: pair.base.mint, outputMint: pair.quote.mint, amount: one });
    const bid = fromUnits(sold.outAmount, pair.quote.decimals);
    const spend = toUnits(Math.max(bid, 1 / 10 ** pair.quote.decimals), pair.quote.decimals);
    const bought = await this.venue.order({ inputMint: pair.quote.mint, outputMint: pair.base.mint, amount: spend });
    const baseOut = fromUnits(bought.outAmount, pair.base.decimals);
    const ask = baseOut > 0 ? fromUnits(spend, pair.quote.decimals) / baseOut : bid;
    return { symbol: pair.label, bid, ask: Math.max(ask, bid), mid: (bid + Math.max(ask, bid)) / 2, ts: this.now().toISOString() };
  }

  async getAccount(mode: BrokerMode): Promise<BrokerAccount> {
    await this.connect();
    const owner = this.owner(mode);
    const balances = await this.reader.getTokenBalances(owner);
    const usdc = this.tokens.get("USDC");
    const cash = usdc ? fromUnits(balances.get(USDC_MINT) ?? 0n, usdc.decimals) : 0;
    const positions = await this.positionsFrom(owner, balances);
    const equity = cash + positions.reduce((s, p) => s + p.marketValue, 0);
    return { id: owner, equity, cash, buyingPower: cash, currency: "USDC" };
  }

  async getPositions(mode: BrokerMode): Promise<BrokerPosition[]> {
    const owner = this.owner(mode);
    return this.positionsFrom(owner, await this.reader.getTokenBalances(owner));
  }

  private async positionsFrom(owner: string, balances: Map<string, bigint>): Promise<BrokerPosition[]> {
    await this.connect();
    const out: BrokerPosition[] = [];
    for (const token of this.tokens.values()) {
      if (token.mint === USDC_MINT) continue;
      let raw = balances.get(token.mint) ?? 0n;
      if (token.mint === WSOL_MINT) raw += await this.reader.getBalance(owner);
      if (raw === 0n) continue;
      const qty = fromUnits(raw, token.decimals);
      let marketValue: number;
      try {
        const sold = await this.venue.order({ inputMint: token.mint, outputMint: USDC_MINT, amount: raw });
        marketValue = fromUnits(sold.outAmount, 6);
      } catch {
        throw new BrokerError(`Could not price ${token.symbol} through Jupiter. Refusing to invent a market value.`);
      }
      out.push({ symbol: `${token.symbol}/USDC`, qty, avgEntryPrice: 0, marketValue, assetClass: "crypto" });
    }
    return out;
  }

  async listOrders(_mode: BrokerMode): Promise<BrokerOrder[]> {
    // A Jupiter swap settles in one transaction; there is no resting order book to list.
    return [];
  }

  async placeOrder(mode: BrokerMode, intent: OrderIntent): Promise<BrokerOrder> {
    await this.connect();
    if (intent.type !== "market") throw new BrokerError("Solana swaps are market exact-input swaps. Limit orders are refused.");
    const pair = this.pair(intent.symbol);
    const slippage = intent.slippageBps ?? this.maxSlippageBps;
    if (!Number.isInteger(slippage) || slippage < 0) throw new BrokerError("slippage_bps must be a whole number of basis points.");
    if (slippage > this.maxSlippageBps) throw new BrokerError(`Slippage ${slippage} bps exceeds the policy cap of ${this.maxSlippageBps} bps.`);
    const leg = this.leg(pair, intent);

    if (mode === "paper") {
      const address = this.signer?.address ?? this.readAddress;
      let order: OrderResponse;
      let check: { ok: boolean; reason?: string; report?: GuardReport } | undefined;
      if (address && this.paperSimulate) {
        order = await this.venue.order({ ...leg.req, taker: address, slippageBps: slippage });
        try {
          const report = await guardSwap(this.reader, decodeTransaction(order.transaction ?? ""), this.expectation(address, leg, order, slippage));
          check = { ok: true, report };
        } catch (e) {
          check = { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
      } else {
        order = await this.venue.order({ ...leg.req, slippageBps: slippage });
      }
      const fill = this.fillOf(pair, intent, leg, order.outAmount);
      return Object.assign(this.brokerOrder(`paper-${uuid()}`, pair, intent, fill), {
        simulated: true,
        signed: false,
        router: order.router,
        quotedOut: order.outAmount.toString(),
        ...(check ? { onchainSimulation: check.ok ? { ok: true, unitsConsumed: check.report?.unitsConsumed } : { ok: false, reason: check.reason } } : {}),
      });
    }

    if (intent.confirm !== true) throw new BrokerError("Live Solana swaps require confirm: true. Nothing was signed.");
    if (!this.signer) throw new BrokerError("No signer loaded. Set HAELO_PRIVATE_KEY or HAELO_KEYPAIR, or run `haelo key import`. Nothing was signed.");
    const owner = this.signer.address;
    if (leg.req.inputMint === WSOL_MINT) {
      const lamports = await this.reader.getBalance(owner);
      if (lamports - leg.req.amount < this.reserveLamports) {
        throw new BrokerError(`Selling that much SOL would leave less than ${fromUnits(this.reserveLamports, 9)} SOL for fees. Nothing was signed.`);
      }
    }
    const order = await this.venue.order({ ...leg.req, taker: owner, slippageBps: slippage });
    const tx = decodeTransaction(order.transaction ?? "");
    const report = await guardSwap(this.reader, tx, this.expectation(owner, leg, order, slippage));
    const signed = await this.signer.sign(tx);
    const result = await this.venue.execute(Buffer.from(signed.serialize()).toString("base64"), order.requestId, order.lastValidBlockHeight);
    if (result.status !== "Success" || !result.signature) {
      throw new BrokerError(`Jupiter execute failed (code ${result.code})${result.error ? `: ${result.error}` : ""}.${result.signature ? ` Signature ${result.signature}.` : ""}`, undefined, result);
    }
    const outActual = result.outputAmountResult && /^\d+$/.test(result.outputAmountResult) ? BigInt(result.outputAmountResult) : order.outAmount;
    const fill = this.fillOf(pair, intent, leg, outActual);
    return Object.assign(this.brokerOrder(result.signature, pair, intent, fill), {
      simulated: false,
      signature: result.signature,
      explorer: `${SOLANA_MAINNET.explorerTx}${result.signature}`,
      router: order.router,
      quotedOut: order.outAmount.toString(),
      minOut: minOutAfterSlippage(order.outAmount, slippage).toString(),
      simulation: { lamportsDelta: report.solDelta.toString(), unitsConsumed: report.unitsConsumed },
    });
  }

  async cancelOrder(_mode: BrokerMode, _orderId: string): Promise<void> {
    throw new BrokerError("A Jupiter swap settles in one transaction and cannot be cancelled. Call haelo_kill_switch to stop new orders.");
  }

  async cancelAll(_mode: BrokerMode): Promise<number> {
    return 0;
  }

  async householdView(mode: BrokerMode): Promise<HouseholdAccount[]> {
    const account = await this.getAccount(mode);
    const positions = await this.getPositions(mode);
    return [{ id: account.id, isAgentAccount: true, equity: account.equity, positions, fills: [] }];
  }

  // ---- helpers ----

  private owner(_mode: BrokerMode): string {
    const address = this.signer?.address ?? this.readAddress;
    if (!address) throw new BrokerError("Set HAELO_ADDRESS or load a signer to read balances. Quotes do not need one.");
    return new PublicKey(address).toBase58();
  }

  private pair(symbol: string): Pair {
    const [baseSym, quoteSym] = this.normalizeSymbol(symbol).split("/");
    const base = baseSym ? this.tokens.get(baseSym) : undefined;
    const quote = quoteSym ? this.tokens.get(quoteSym) : undefined;
    if (!base || !quote) throw new BrokerError(`Unknown token in ${symbol}. Known tokens: ${[...this.tokens.keys()].join(", ")}. Add others under broker.tokens.`);
    if (base.mint === quote.mint) throw new BrokerError("Base and quote are the same token.");
    return { label: `${base.symbol}/${quote.symbol}`, base, quote };
  }

  private leg(pair: Pair, intent: OrderIntent): { req: { inputMint: string; outputMint: string; amount: bigint }; inToken: Token; outToken: Token } {
    if (intent.side === "buy") {
      if (intent.notionalUsd === undefined) throw new BrokerError(`A buy needs notional_usd, the ${pair.quote.symbol} amount to spend.`);
      return { req: { inputMint: pair.quote.mint, outputMint: pair.base.mint, amount: toUnits(intent.notionalUsd, pair.quote.decimals) }, inToken: pair.quote, outToken: pair.base };
    }
    if (intent.qty === undefined) throw new BrokerError(`A sell needs qty, the amount of ${pair.base.symbol} to sell.`);
    return { req: { inputMint: pair.base.mint, outputMint: pair.quote.mint, amount: toUnits(intent.qty, pair.base.decimals) }, inToken: pair.base, outToken: pair.quote };
  }

  private expectation(owner: string, leg: ReturnType<SolanaBroker["leg"]>, order: OrderResponse, slippageBps: number) {
    return {
      owner,
      inputMint: leg.inToken.mint,
      outputMint: leg.outToken.mint,
      inputProgram: leg.inToken.program,
      outputProgram: leg.outToken.program,
      amountIn: leg.req.amount,
      minOut: minOutAfterSlippage(order.outAmount, slippageBps),
      maxFeeLamports: this.maxFeeLamports,
    };
  }

  private fillOf(pair: Pair, intent: OrderIntent, leg: ReturnType<SolanaBroker["leg"]>, out: bigint): { qty: number; price: number } {
    const inAmt = fromUnits(leg.req.amount, leg.inToken.decimals);
    const outAmt = fromUnits(out, leg.outToken.decimals);
    if (intent.side === "buy") return { qty: outAmt, price: outAmt > 0 ? inAmt / outAmt : 0 };
    return { qty: inAmt, price: inAmt > 0 ? outAmt / inAmt : 0 };
  }

  private brokerOrder(id: string, pair: Pair, intent: OrderIntent, fill: { qty: number; price: number }): BrokerOrder {
    const ts = this.now().toISOString();
    return { id, symbol: pair.label, side: intent.side, type: "market", status: "filled", qty: fill.qty, filledQty: fill.qty, filledAvgPrice: fill.price, submittedAt: ts, filledAt: ts };
  }
}

