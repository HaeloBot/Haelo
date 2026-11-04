import { existsSync, readFileSync, statSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { redactSecrets } from "./uniswap.js";

/**
 * A signer Haelo does not hold the key for. The host signs and broadcasts.
 * `send` must not log the transaction's secret material.
 */
export interface ExternalSigner {
  readonly address: Address;
  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
}

export interface LocalSigner {
  kind: "env" | "keystore";
  account: PrivateKeyAccount;
}

function normalizeKey(raw: string): Hex {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Private key must be a 32-byte hex string.");
  return hex as Hex;
}

/**
 * Load HAELO_PRIVATE_KEY or a 0600 keystore file. Never returns the key in an Error message.
 * Exactly one of the two may be set. Neither is required for quotes.
 */
export function loadLocalSigner(env: NodeJS.ProcessEnv, names: { privateKeyEnv?: string; keystoreEnv?: string } = {}): LocalSigner | undefined {
  const keyName = names.privateKeyEnv ?? "HAELO_PRIVATE_KEY";
  const fileName = names.keystoreEnv ?? "HAELO_KEYSTORE";
  const raw = env[keyName];
  const file = env[fileName];
  if (raw && file) throw new Error(`Set only one of ${keyName} or ${fileName}.`);
  try {
    if (raw) return { kind: "env", account: privateKeyToAccount(normalizeKey(raw)) };
    if (!file) return undefined;
    if (!existsSync(file)) throw new Error(`${fileName} does not point at a file.`);
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) throw new Error(`${fileName} is readable by group or others. chmod 600 the file.`);
    const text = readFileSync(file, "utf8").trim();
    let secret = text;
    if (text.startsWith("{")) {
      const parsed = JSON.parse(text) as { privateKey?: unknown };
      if (typeof parsed.privateKey !== "string") throw new Error("Keystore JSON needs a privateKey string.");
      secret = parsed.privateKey;
    }
    return { kind: "keystore", account: privateKeyToAccount(normalizeKey(secret)) };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load the signer.";
    throw new Error(redactSecrets(message), { cause: e });
  }
}

export function signerAddress(signer: LocalSigner | ExternalSigner | undefined, env: NodeJS.ProcessEnv, addressEnv = "HAELO_ADDRESS"): Address | undefined {
  if (signer && "account" in signer) return signer.account.address;
  if (signer && "address" in signer) return signer.address;
  const raw = env[addressEnv];
  if (!raw) return undefined;
  return getAddress(raw);
}
