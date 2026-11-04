import { BrokerError, type FetchFn } from "../adapters/types.js";
import { requestJson } from "../adapters/http.js";
import { JUPITER } from "./constants.js";

export interface OrderRequest {
  inputMint: string;
  outputMint: string;
  /** Raw input amount in the input token's base units. */
  amount: bigint;
  /** Wallet that will sign. Without it Jupiter returns a quote and no transaction. */
  taker?: string;
  slippageBps?: number;
}

export interface OrderResponse {
  requestId: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Base64 unsigned transaction. Absent for quote-only requests. */
  transaction?: string;
  router?: string;
  slippageBps?: number;
  priceImpactPct?: number;
  lastValidBlockHeight?: number;
  feeBps?: number;
}

export interface ExecuteResponse {
  status: "Success" | "Failed";
  signature?: string;
  code: number;
  error?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

/** The two calls Haelo makes to Jupiter. Tests replace this with a local fake server. */
export interface SwapVenue {
  order(req: OrderRequest): Promise<OrderResponse>;
  execute(signedTransaction: string, requestId: string, lastValidBlockHeight?: number): Promise<ExecuteResponse>;
}

/** Jupiter Swap API V2: GET /order builds the route and transaction, POST /execute lands the signed transaction. */
export class JupiterClient implements SwapVenue {
  private readonly base: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: FetchFn | undefined;

  constructor(opts: { baseUrl?: string; apiKey?: string; fetch?: FetchFn } = {}) {
    this.base = (opts.baseUrl ?? JUPITER.baseUrl).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch;
  }

  private headers(json = false): Record<string, string> {
    return {
      accept: "application/json",
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
  }

  async order(req: OrderRequest): Promise<OrderResponse> {
    const q = new URLSearchParams({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amount.toString() });
    if (req.taker) q.set("taker", req.taker);
    if (req.slippageBps !== undefined) q.set("slippageBps", String(req.slippageBps));
    const body = (await requestJson(`${this.base}/order?${q.toString()}`, { method: "GET", headers: this.headers() }, this.fetchFn ? { fetch: this.fetchFn } : {})) as Record<string, unknown>;
    return parseOrder(body, req);
  }

  async execute(signedTransaction: string, requestId: string, lastValidBlockHeight?: number): Promise<ExecuteResponse> {
    const body = (await requestJson(
      `${this.base}/execute`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ signedTransaction, requestId, ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}) }),
      },
      { ...(this.fetchFn ? { fetch: this.fetchFn } : {}), timeoutMs: 60_000 },
    )) as Record<string, unknown>;
    const status = body["status"] === "Success" ? "Success" : "Failed";
    return {
      status,
      code: typeof body["code"] === "number" ? body["code"] : status === "Success" ? 0 : -1,
      ...(typeof body["signature"] === "string" ? { signature: body["signature"] } : {}),
      ...(typeof body["error"] === "string" ? { error: body["error"] } : {}),
      ...(typeof body["inputAmountResult"] === "string" ? { inputAmountResult: body["inputAmountResult"] } : {}),
      ...(typeof body["outputAmountResult"] === "string" ? { outputAmountResult: body["outputAmountResult"] } : {}),
    };
  }
}

function bigintField(body: Record<string, unknown>, key: string): bigint | undefined {
  const v = body[key];
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}

export function parseOrder(body: Record<string, unknown>, req: OrderRequest): OrderResponse {
  const errorMessage = typeof body["errorMessage"] === "string" ? body["errorMessage"] : typeof body["error"] === "string" ? body["error"] : undefined;
  const outAmount = bigintField(body, "outAmount");
  if (outAmount === undefined || outAmount === 0n) throw new BrokerError(`Jupiter found no route${errorMessage ? `: ${errorMessage}` : "."}`, undefined, body);
  const tx = body["transaction"];
  if (req.taker && (typeof tx !== "string" || tx.length === 0)) {
    throw new BrokerError(`Jupiter quoted but could not build a transaction${errorMessage ? `: ${errorMessage}` : "."}`, undefined, body);
  }
  const requestId = typeof body["requestId"] === "string" ? body["requestId"] : "";
  if (req.taker && !requestId) throw new BrokerError("Jupiter returned a transaction without a requestId.", undefined, body);
  const impact = Number(body["priceImpactPct"] ?? body["priceImpact"]);
  return {
    requestId,
    inAmount: bigintField(body, "inAmount") ?? req.amount,
    outAmount,
    ...(typeof tx === "string" && tx.length > 0 ? { transaction: tx } : {}),
    ...(typeof body["router"] === "string" ? { router: body["router"] } : {}),
    ...(typeof body["slippageBps"] === "number" ? { slippageBps: body["slippageBps"] } : {}),
    ...(Number.isFinite(impact) ? { priceImpactPct: impact } : {}),
    ...(typeof body["lastValidBlockHeight"] === "number" ? { lastValidBlockHeight: body["lastValidBlockHeight"] } : {}),
    ...(typeof body["feeBps"] === "number" ? { feeBps: body["feeBps"] } : {}),
  };
}
