import { BrokerError, type FetchFn } from "../adapters/types.js";
import { sleep } from "../util.js";
import { PROGRAMS } from "./constants.js";

export interface MintInfo {
  decimals: number;
  /** Token program that owns the mint (classic Token or Token-2022). */
  program: string;
}

export interface SimulatedAccount {
  lamports: number;
  /** Raw token amount when the account is a token account. */
  tokenAmount?: bigint;
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
  /** Post-simulation state, in the order requested. Null when the account does not exist afterwards. */
  accounts: Array<SimulatedAccount | null>;
  unitsConsumed?: number;
}

interface RpcError {
  code: number;
  message: string;
}

/** What Haelo reads from a Solana RPC. Kept small so tests can stand up a fake. */
export interface SolanaReader {
  getGenesisHash(): Promise<string>;
  getBalance(owner: string): Promise<bigint>;
  getMint(mint: string): Promise<MintInfo>;
  /** Raw balances of every token account the owner holds, summed by mint. */
  getTokenBalances(owner: string): Promise<Map<string, bigint>>;
  /** Current state of token accounts by address; missing accounts read as null. */
  getTokenAccounts(addresses: string[]): Promise<Array<SimulatedAccount | null>>;
  simulate(txBase64: string, accounts: string[]): Promise<SimulationResult>;
}

const READ_RETRIES = 2;

/** Minimal JSON-RPC client over fetch. Reads retry on 429 and 5xx; nothing here sends a transaction. */
export class SolanaRpc implements SolanaReader {
  private id = 0;

  constructor(
    private readonly url: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: ctl.signal,
        });
        if ((res.status === 429 || res.status >= 500) && attempt < READ_RETRIES) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        const body = (await res.json().catch(() => undefined)) as { result?: T; error?: RpcError } | undefined;
        if (!res.ok) throw new BrokerError(`Solana RPC HTTP ${res.status} on ${method}`, res.status, body);
        if (!body) throw new BrokerError(`Solana RPC returned no JSON for ${method}`);
        if (body.error) throw new BrokerError(`Solana RPC ${method}: ${body.error.message}`, body.error.code, body.error);
        return body.result as T;
      } catch (e) {
        last = e;
        if (e instanceof BrokerError) throw e;
        if (attempt < READ_RETRIES) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw new BrokerError(`Solana RPC ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last instanceof Error ? last : new BrokerError(`Solana RPC ${method} failed`);
  }

  getGenesisHash(): Promise<string> {
    return this.call<string>("getGenesisHash", []);
  }

  async getBalance(owner: string): Promise<bigint> {
    const r = await this.call<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
    return BigInt(r.value);
  }

  async getMint(mint: string): Promise<MintInfo> {
    const r = await this.call<{ value: ParsedAccount | null }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const v = r.value;
    const info = parsedOf(v);
    const decimals = info?.info?.decimals;
    if (!v || info?.type !== "mint" || typeof decimals !== "number") throw new BrokerError(`${mint} is not a token mint on this cluster.`);
    return { decimals, program: v.owner };
  }

  async getTokenBalances(owner: string): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const programId of [PROGRAMS.token, PROGRAMS.token2022]) {
      const r = await this.call<{ value: Array<{ pubkey: string; account: ParsedAccount }> }>("getTokenAccountsByOwner", [
        owner,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      for (const { account } of r.value) {
        const parsed = parsedOf(account);
        const mint = parsed?.info?.mint;
        const amount = parsed?.info?.tokenAmount?.amount;
        if (typeof mint !== "string" || typeof amount !== "string") continue;
        out.set(mint, (out.get(mint) ?? 0n) + BigInt(amount));
      }
    }
    return out;
  }

  async getTokenAccounts(addresses: string[]): Promise<Array<SimulatedAccount | null>> {
    if (addresses.length === 0) return [];
    const r = await this.call<{ value: Array<ParsedAccount | null> }>("getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "confirmed" }]);
    return r.value.map(toSimulated);
  }

  async simulate(txBase64: string, accounts: string[]): Promise<SimulationResult> {
    const r = await this.call<{ value: { err: unknown; logs: string[] | null; accounts: Array<ParsedAccount | null> | null; unitsConsumed?: number } }>(
      "simulateTransaction",
      [
        txBase64,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
          accounts: { encoding: "jsonParsed", addresses: accounts },
        },
      ],
    );
    const v = r.value;
    return {
      err: v.err,
      logs: v.logs ?? [],
      accounts: (v.accounts ?? accounts.map(() => null)).map(toSimulated),
      ...(typeof v.unitsConsumed === "number" ? { unitsConsumed: v.unitsConsumed } : {}),
    };
  }
}

interface ParsedAccount {
  lamports: number;
  owner: string;
  /** jsonParsed data, or a [base64, encoding] pair for accounts the RPC cannot parse. */
  data: ParsedTokenData | unknown[] | string;
}

function parsedOf(a: ParsedAccount | null | undefined): ParsedTokenData["parsed"] | undefined {
  const d = a?.data;
  return d && typeof d === "object" && !Array.isArray(d) ? d.parsed : undefined;
}

interface ParsedTokenData {
  parsed?: { type?: string; info?: { mint?: string; decimals?: number; tokenAmount?: { amount?: string } } };
}

function toSimulated(a: ParsedAccount | null): SimulatedAccount | null {
  if (!a) return null;
  const amount = parsedOf(a)?.info?.tokenAmount?.amount;
  return { lamports: a.lamports, ...(typeof amount === "string" ? { tokenAmount: BigInt(amount) } : {}) };
}
