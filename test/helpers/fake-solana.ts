import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { verify as edVerify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { associatedTokenAddress } from "../../src/solana/guard.js";
import { DEFAULT_TOKENS, PROGRAMS, USDC_MINT, WSOL_MINT } from "../../src/solana/constants.js";

/** The fake answers with mainnet's genesis so production code paths run unmodified. */
export const FAKE_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TzNYuXEsWcLDf8tBPZvamb");

export interface FakeSwap {
  requestId: string;
  taker?: string;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  executed: boolean;
  signature?: string;
}

export interface FakeSolanaState {
  /** USDC per whole token. */
  prices: Record<string, number>;
  lamports: Map<string, bigint>;
  /** Token balances keyed by associated token account address. */
  tokenAccounts: Map<string, { owner: string; mint: string; amount: bigint }>;
  swaps: Map<string, FakeSwap>;
  /** When set, built transactions drain this many extra lamports in simulation and on execute. */
  drainLamports: bigint;
  /** When set, /order refuses with this message. */
  failOrders?: string;
  /** When set, /execute returns Failed with this message. */
  failExecute?: string;
  /** Lamports a swap costs in fees. */
  feeLamports: bigint;
  decimals: Record<string, number>;
  /** Genesis hash the RPC reports. */
  genesis: string;
}

export function newFakeState(): FakeSolanaState {
  const decimals: Record<string, number> = {};
  for (const t of DEFAULT_TOKENS) decimals[t.mint] = t.decimals;
  return {
    prices: { [WSOL_MINT]: 150, [USDC_MINT]: 1, JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 0.5, DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 0.00002 },
    lamports: new Map(),
    tokenAccounts: new Map(),
    swaps: new Map(),
    drainLamports: 0n,
    feeLamports: 5_000n,
    decimals,
    genesis: FAKE_GENESIS,
  };
}

export function fund(state: FakeSolanaState, owner: string, sol: number, usdc: number): void {
  state.lamports.set(owner, BigInt(Math.round(sol * 1e9)));
  setToken(state, owner, USDC_MINT, BigInt(Math.round(usdc * 1e6)));
}

export function setToken(state: FakeSolanaState, owner: string, mint: string, amount: bigint): void {
  state.tokenAccounts.set(associatedTokenAddress(owner, mint, PROGRAMS.token), { owner, mint, amount });
}

export function tokenBalance(state: FakeSolanaState, owner: string, mint: string): bigint {
  return state.tokenAccounts.get(associatedTokenAddress(owner, mint, PROGRAMS.token))?.amount ?? 0n;
}

function quoteOut(state: FakeSolanaState, inputMint: string, outputMint: string, amount: bigint): bigint {
  const pin = state.prices[inputMint];
  const pout = state.prices[outputMint];
  const din = state.decimals[inputMint];
  const dout = state.decimals[outputMint];
  if (pin === undefined || pout === undefined || din === undefined || dout === undefined) return 0n;
  const usd = (Number(amount) / 10 ** din) * pin;
  return BigInt(Math.floor((usd / pout) * 0.997 * 10 ** dout)); // 0.3% route fee
}

/** Balance changes a swap makes, as owner lamports delta and token deltas by ATA. */
function effects(state: FakeSolanaState, s: FakeSwap): { lamports: bigint; tokens: Map<string, bigint> } {
  const owner = s.taker as string;
  let lamports = -(state.feeLamports + state.drainLamports);
  const tokens = new Map<string, bigint>();
  if (s.inputMint === WSOL_MINT) lamports -= s.inAmount;
  else tokens.set(associatedTokenAddress(owner, s.inputMint, PROGRAMS.token), -s.inAmount);
  if (s.outputMint === WSOL_MINT) lamports += s.outAmount;
  else tokens.set(associatedTokenAddress(owner, s.outputMint, PROGRAMS.token), (tokens.get(associatedTokenAddress(owner, s.outputMint, PROGRAMS.token)) ?? 0n) + s.outAmount);
  return { lamports, tokens };
}

function buildTx(taker: string, requestId: string): string {
  const message = new TransactionMessage({
    payerKey: new PublicKey(taker),
    recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
    instructions: [new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: new PublicKey(taker), isSigner: true, isWritable: true }], data: Buffer.from(requestId) })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function requestIdOf(tx: VersionedTransaction): string | undefined {
  const ix = tx.message.compiledInstructions[0];
  return ix ? Buffer.from(ix.data).toString() : undefined;
}

function ed25519Valid(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub)]);
  return edVerify(null, Buffer.from(msg), { key: spki, format: "der", type: "spki" }, Buffer.from(sig));
}

function tokenAccountJson(addr: string, a: { owner: string; mint: string; amount: bigint }): Record<string, unknown> {
  return {
    lamports: 2_039_280,
    owner: PROGRAMS.token,
    data: { parsed: { type: "account", info: { mint: a.mint, owner: a.owner, tokenAmount: { amount: a.amount.toString() } } }, program: "spl-token" },
    pubkey: addr,
  };
}

export interface RunningFakeSolana {
  url: string;
  rpcUrl: string;
  jupiterUrl: string;
  state: FakeSolanaState;
  close(): Promise<void>;
}

export async function startFakeSolana(state = newFakeState()): Promise<RunningFakeSolana> {
  let n = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
      };
      const url = new URL(req.url ?? "/", "http://x");
      try {
        if (req.method === "GET" && url.pathname === "/swap/v2/order") {
          if (state.failOrders) return send(200, { errorCode: 1, errorMessage: state.failOrders });
          const inputMint = url.searchParams.get("inputMint") ?? "";
          const outputMint = url.searchParams.get("outputMint") ?? "";
          const amount = BigInt(url.searchParams.get("amount") ?? "0");
          const taker = url.searchParams.get("taker") ?? undefined;
          const outAmount = quoteOut(state, inputMint, outputMint, amount);
          const requestId = `req-${++n}`;
          state.swaps.set(requestId, { requestId, ...(taker ? { taker } : {}), inputMint, outputMint, inAmount: amount, outAmount, executed: false });
          return send(200, {
            requestId,
            inAmount: amount.toString(),
            outAmount: outAmount.toString(),
            router: "metis",
            transaction: taker ? buildTx(taker, requestId) : null,
            lastValidBlockHeight: 1000,
          });
        }
        if (req.method === "POST" && url.pathname === "/swap/v2/execute") {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { signedTransaction: string; requestId: string };
          const swap = state.swaps.get(body.requestId);
          if (!swap?.taker) return send(400, { error: "unknown requestId" });
          const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
          const sig = tx.signatures[0];
          if (!sig || !ed25519Valid(new PublicKey(swap.taker).toBytes(), tx.message.serialize(), sig)) return send(200, { status: "Failed", code: -1, error: "bad signature" });
          if (state.failExecute) return send(200, { status: "Failed", code: -2, error: state.failExecute, signature: bs58.encode(sig) });
          const fx = effects(state, swap);
          state.lamports.set(swap.taker, (state.lamports.get(swap.taker) ?? 0n) + fx.lamports);
          for (const [ata, d] of fx.tokens) {
            const mint = ata === associatedTokenAddress(swap.taker, swap.inputMint, PROGRAMS.token) ? swap.inputMint : swap.outputMint;
            const cur = state.tokenAccounts.get(ata) ?? { owner: swap.taker, mint, amount: 0n };
            state.tokenAccounts.set(ata, { ...cur, amount: cur.amount + d });
          }
          swap.executed = true;
          swap.signature = bs58.encode(sig);
          return send(200, { status: "Success", code: 0, signature: swap.signature, inputAmountResult: swap.inAmount.toString(), outputAmountResult: swap.outAmount.toString() });
        }
        if (req.method === "POST" && url.pathname === "/") {
          const rpc = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string; params: unknown[] };
          const ok = (result: unknown): void => send(200, { jsonrpc: "2.0", id: rpc.id, result });
          const p = rpc.params;
          switch (rpc.method) {
            case "getGenesisHash":
              return ok(state.genesis);
            case "getBalance":
              return ok({ context: { slot: 1 }, value: Number(state.lamports.get(p[0] as string) ?? 0n) });
            case "getAccountInfo": {
              const d = state.decimals[p[0] as string];
              return ok({ context: { slot: 1 }, value: d === undefined ? null : { lamports: 1, owner: PROGRAMS.token, data: { parsed: { type: "mint", info: { decimals: d } }, program: "spl-token" } } });
            }
            case "getTokenAccountsByOwner": {
              const owner = p[0] as string;
              const prog = (p[1] as { programId: string }).programId;
              const value = prog !== PROGRAMS.token ? [] : [...state.tokenAccounts.entries()].filter(([, a]) => a.owner === owner).map(([addr, a]) => ({ pubkey: addr, account: tokenAccountJson(addr, a) }));
              return ok({ context: { slot: 1 }, value });
            }
            case "getMultipleAccounts": {
              const addrs = p[0] as string[];
              return ok({ context: { slot: 1 }, value: addrs.map((a) => (state.tokenAccounts.has(a) ? tokenAccountJson(a, state.tokenAccounts.get(a)!) : null)) });
            }
            case "simulateTransaction": {
              const tx = VersionedTransaction.deserialize(Buffer.from(p[0] as string, "base64"));
              const swap = state.swaps.get(requestIdOf(tx) ?? "");
              const addrs = ((p[1] as { accounts?: { addresses: string[] } }).accounts?.addresses ?? []) as string[];
              if (!swap?.taker) return ok({ context: { slot: 1 }, value: { err: { InstructionError: [0, "Custom"] }, logs: ["unknown swap"], accounts: null } });
              const fx = effects(state, swap);
              const owner = swap.taker;
              const lam = (state.lamports.get(owner) ?? 0n) + fx.lamports;
              if (lam < 0n) return ok({ context: { slot: 1 }, value: { err: { InsufficientFundsForFee: null }, logs: ["insufficient lamports"], accounts: null } });
              const accounts = addrs.map((a) => {
                if (a === owner) return { lamports: Number(lam), owner: PROGRAMS.system, data: ["", "base64"] };
                const cur = state.tokenAccounts.get(a);
                const d = fx.tokens.get(a) ?? 0n;
                const amount = (cur?.amount ?? 0n) + d;
                if (amount < 0n) return null;
                if (!cur && d === 0n) return null;
                const mint = cur?.mint ?? (a === associatedTokenAddress(owner, swap.inputMint, PROGRAMS.token) ? swap.inputMint : swap.outputMint);
                return tokenAccountJson(a, { owner, mint, amount });
              });
              const negative = [...fx.tokens.entries()].some(([a, d]) => (state.tokenAccounts.get(a)?.amount ?? 0n) + d < 0n);
              if (negative) return ok({ context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"], accounts: null } });
              return ok({ context: { slot: 1 }, value: { err: null, logs: ["Program log: swap ok"], accounts, unitsConsumed: 120_000 } });
            }
            default:
              return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `method ${rpc.method} not faked` } });
          }
        }
        send(404, { error: "not found" });
      } catch (e) {
        send(500, { error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    rpcUrl: `${url}/`,
    jupiterUrl: `${url}/swap/v2`,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function newWallet(): Keypair {
  return Keypair.generate();
}
