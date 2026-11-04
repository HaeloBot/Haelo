import { existsSync, readFileSync, statSync } from "node:fs";
import type { VersionedTransaction } from "@solana/web3.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { SecretStore } from "../secrets.js";
import { BASE58_KEY, redactSecrets } from "./constants.js";

/** Name of the keypair entry in the OS keychain or 0600 secret file (`haelo key import`). */
export const KEYCHAIN_ENTRY = "solana-keypair";

/** Signs a Jupiter transaction. Haelo never returns or logs the secret key. */
export interface SolanaSigner {
  readonly address: string;
  readonly source: "env" | "file" | "keychain" | "external";
  sign(tx: VersionedTransaction): Promise<VersionedTransaction>;
}

/** Parse a secret key from base58 (Phantom export) or a JSON byte array (Solana CLI id.json). */
export function parseSecretKey(raw: string): Keypair {
  const text = raw.trim();
  let bytes: Uint8Array;
  if (text.startsWith("[")) {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("Keypair JSON must be an array of bytes.");
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = bs58.decode(text);
    } catch {
      throw new Error("Secret key is neither base58 nor a JSON byte array.");
    }
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Secret key must be 64 bytes (or a 32-byte seed); got ${bytes.length}.`);
}

class KeypairSigner implements SolanaSigner {
  readonly address: string;
  constructor(
    private readonly keypair: Keypair,
    readonly source: "env" | "file" | "keychain",
  ) {
    this.address = keypair.publicKey.toBase58();
  }
  async sign(tx: VersionedTransaction): Promise<VersionedTransaction> {
    tx.sign([this.keypair]);
    return tx;
  }
}

export interface SignerEnvNames {
  privateKeyEnv?: string;
  keypairFileEnv?: string;
}

/**
 * Load the signing key from, in order: the private key env var, a keypair file (0600), or the secret store
 * written by `haelo key import`. At most one of the two env vars may be set. None is needed for quotes.
 */
export async function loadSigner(env: NodeJS.ProcessEnv, names: SignerEnvNames = {}, store?: SecretStore): Promise<SolanaSigner | undefined> {
  const keyName = names.privateKeyEnv ?? "HAELO_PRIVATE_KEY";
  const fileName = names.keypairFileEnv ?? "HAELO_KEYPAIR";
  const raw = env[keyName];
  const file = env[fileName];
  if (raw && file) throw new Error(`Set only one of ${keyName} or ${fileName}.`);
  try {
    if (raw) return new KeypairSigner(parseSecretKey(raw), "env");
    if (file) return new KeypairSigner(parseSecretKey(readKeypairFile(file, fileName)), "file");
    const stored = store ? await store.get(KEYCHAIN_ENTRY) : undefined;
    if (stored) return new KeypairSigner(parseSecretKey(stored), "keychain");
    return undefined;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load the signer.";
    throw new Error(redactSecrets(message), { cause: e });
  }
}

export function readKeypairFile(file: string, label = "keypair file"): string {
  if (!existsSync(file)) throw new Error(`${label} does not point at a file.`);
  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) throw new Error(`${label} is readable by group or others. Run: chmod 600 ${file}`);
  }
  return readFileSync(file, "utf8");
}

/** The wallet address for balance reads: the signer if any, else a watch-only address from the env. */
export function walletAddress(signer: SolanaSigner | undefined, env: NodeJS.ProcessEnv, addressEnv = "HAELO_ADDRESS"): string | undefined {
  if (signer) return signer.address;
  const raw = env[addressEnv]?.trim();
  if (!raw) return undefined;
  if (!BASE58_KEY.test(raw)) throw new Error(`${addressEnv} is not a Solana address.`);
  return new PublicKey(raw).toBase58();
}
