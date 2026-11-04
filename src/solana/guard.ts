import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { BrokerError } from "../adapters/types.js";
import { PROGRAMS, WSOL_MINT } from "./constants.js";
import type { MintInfo, SolanaReader } from "./rpc.js";

export interface SwapExpectation {
  owner: string;
  inputMint: string;
  outputMint: string;
  inputProgram: string;
  outputProgram: string;
  amountIn: bigint;
  /** Smallest output the wallet must end up with: quoted output less the slippage allowance. */
  minOut: bigint;
  /** Most lamports the swap may cost beyond any SOL being sold: fees, priority fees and new account rent. */
  maxFeeLamports: bigint;
}

export interface GuardReport {
  ok: true;
  solDelta: bigint;
  inputSpent: bigint;
  outputReceived: bigint;
  unitsConsumed?: number;
}

export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(PROGRAMS.associatedToken),
  );
  return ata.toBase58();
}

export function decodeTransaction(base64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch (e) {
    throw new BrokerError(`Jupiter returned a transaction Haelo cannot decode: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Static check: this wallet must be a required signer. The fee payer may be Jupiter on gasless routes;
 * what the wallet actually loses is checked by simulation, not by trusting the payer field.
 */
export function checkSigners(tx: VersionedTransaction, owner: string): void {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const signers = keys.slice(0, tx.message.header.numRequiredSignatures);
  if (!signers.includes(owner)) throw new BrokerError("The swap transaction does not need this wallet's signature. Refusing to sign.");
}

/**
 * Simulate the unsigned transaction against the cluster and compare balances before and after.
 * Refuses when the wallet would lose more than the order allows or receive less than the minimum.
 */
export async function guardSwap(reader: SolanaReader, tx: VersionedTransaction, exp: SwapExpectation): Promise<GuardReport> {
  checkSigners(tx, exp.owner);
  const inSol = exp.inputMint === WSOL_MINT;
  const outSol = exp.outputMint === WSOL_MINT;
  const inAta = inSol ? undefined : associatedTokenAddress(exp.owner, exp.inputMint, exp.inputProgram);
  const outAta = outSol ? undefined : associatedTokenAddress(exp.owner, exp.outputMint, exp.outputProgram);
  const tokenAccounts = [inAta, outAta].filter((a): a is string => a !== undefined);

  const [preLamports, preTokens] = await Promise.all([reader.getBalance(exp.owner), reader.getTokenAccounts(tokenAccounts)]);
  const preOf = (addr: string | undefined): bigint => {
    if (!addr) return 0n;
    return preTokens[tokenAccounts.indexOf(addr)]?.tokenAmount ?? 0n;
  };

  const encoded = Buffer.from(tx.serialize()).toString("base64");
  const sim = await reader.simulate(encoded, [exp.owner, ...tokenAccounts]);
  if (sim.err) {
    const tail = sim.logs.slice(-4).join(" | ");
    throw new BrokerError(`Simulation failed, nothing was signed: ${JSON.stringify(sim.err)}${tail ? ` (${tail})` : ""}`);
  }
  const [ownerPost, ...tokenPost] = sim.accounts;
  if (!ownerPost) throw new BrokerError("Simulation did not return the wallet's balance. Refusing to sign.");
  const postOf = (addr: string | undefined): bigint => {
    if (!addr) return 0n;
    return tokenPost[tokenAccounts.indexOf(addr)]?.tokenAmount ?? 0n;
  };

  const solDelta = BigInt(ownerPost.lamports) - preLamports;
  const lamportLoss = -solDelta;
  const inputSpent = inSol ? lamportLoss : preOf(inAta) - postOf(inAta);
  const outputReceived = outSol ? solDelta : postOf(outAta) - preOf(outAta);

  const solBudget = (inSol ? exp.amountIn : 0n) + exp.maxFeeLamports;
  if (lamportLoss > solBudget) {
    throw new BrokerError(`Simulation shows the wallet losing ${lamportLoss} lamports, over the allowed ${solBudget}. Refusing to sign.`);
  }
  if (!inSol && inputSpent > exp.amountIn) {
    throw new BrokerError(`Simulation spends ${inputSpent} base units of the input token, more than the ${exp.amountIn} ordered. Refusing to sign.`);
  }
  // SOL output is net of fees, so allow the fee budget when the output is SOL.
  const outFloor = outSol ? exp.minOut - exp.maxFeeLamports : exp.minOut;
  if (outputReceived < outFloor) {
    throw new BrokerError(`Simulation delivers ${outputReceived} base units, under the minimum ${outFloor}. Refusing to sign.`);
  }
  return { ok: true, solDelta, inputSpent, outputReceived, ...(sim.unitsConsumed !== undefined ? { unitsConsumed: sim.unitsConsumed } : {}) };
}

export function minOutAfterSlippage(outAmount: bigint, slippageBps: number): bigint {
  return (outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}

export type { MintInfo };
