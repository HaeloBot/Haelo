import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { atomicWriteJson, sha256 } from "./util.js";

/** Where Haelo keeps long-lived secrets it creates itself (OAuth tokens for an upstream MCP server). */
export interface SecretStore {
  readonly kind: "keychain" | "file";
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const SERVICE = "haelo-mcp";

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(v: string): void;
  deletePassword(): boolean | void;
}
type EntryCtor = new (service: string, account: string) => KeyringEntry;

/**
 * OS keychain via `@napi-rs/keyring` (macOS Keychain, Windows Credential Manager, Linux Secret Service /
 * kernel keyutils). It is an optional dependency: when it is missing or the OS has no usable keychain,
 * `openSecretStore("auto")` falls back to a 0600 file.
 */
export class KeychainSecretStore implements SecretStore {
  readonly kind = "keychain" as const;
  constructor(
    private readonly Entry: EntryCtor,
    private readonly namespace: string,
  ) {}
  private entry(key: string): KeyringEntry {
    return new this.Entry(SERVICE, `${this.namespace}:${key}`);
  }
  get(key: string): string | undefined {
    try {
      return this.entry(key).getPassword() ?? undefined;
    } catch {
      return undefined;
    }
  }
  set(key: string, value: string): void {
    this.entry(key).setPassword(value);
  }
  delete(key: string): void {
    try {
      this.entry(key).deletePassword();
    } catch {
      /* already gone */
    }
  }
}

/** One 0600 JSON file per key in `<stateDir>/secrets/` (directory 0700). Readable by anything running as your OS user. */
export class FileSecretStore implements SecretStore {
  readonly kind = "file" as const;
  private readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "secrets");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      /* best effort */
    }
  }
  private file(key: string): string {
    return join(this.dir, `${sha256(key).slice(0, 24)}.json`);
  }
  get(key: string): string | undefined {
    const f = this.file(key);
    if (!existsSync(f)) return undefined;
    return (JSON.parse(readFileSync(f, "utf8")) as { value: string }).value;
  }
  set(key: string, value: string): void {
    atomicWriteJson(this.file(key), { key, value });
  }
  delete(key: string): void {
    rmSync(this.file(key), { force: true });
  }
}

function loadKeyring(): EntryCtor | undefined {
  try {
    const require = createRequire(import.meta.url);
    return (require("@napi-rs/keyring") as { Entry: EntryCtor }).Entry;
  } catch {
    return undefined;
  }
}

/** Probe that the keychain really works (a library can load on a machine with no keychain daemon). */
function keychainWorks(store: KeychainSecretStore): boolean {
  const probe = `probe-${process.pid}-${Date.now()}`;
  try {
    store.set(probe, "ok");
    const ok = store.get(probe) === "ok";
    store.delete(probe);
    return ok;
  } catch {
    return false;
  }
}

export interface OpenSecretOptions {
  /** Test hook: replace the keyring Entry class (or `null` to simulate it missing). */
  entry?: EntryCtor | null;
}

export function openSecretStore(mode: "auto" | "keychain" | "file", stateDir: string, opts: OpenSecretOptions = {}): SecretStore {
  if (mode === "file") return new FileSecretStore(stateDir);
  const Entry = opts.entry === null ? undefined : (opts.entry ?? loadKeyring());
  const ns = sha256(stateDir).slice(0, 12);
  if (Entry) {
    const k = new KeychainSecretStore(Entry, ns);
    if (keychainWorks(k)) return k;
  }
  if (mode === "keychain") throw new Error("secrets.store is `keychain` but no usable OS keychain was found (install @napi-rs/keyring and a keychain service, or use `auto`/`file`).");
  return new FileSecretStore(stateDir);
}
