import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSecretStore, KeychainSecretStore, openSecretStore } from "../src/secrets.js";
import { sha256 } from "../src/util.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "haelo-sec-"));

/** In-memory stand-in for @napi-rs/keyring's Entry, to test the keychain code path deterministically. */
function fakeKeyring(opts: { broken?: boolean } = {}): { Entry: new (s: string, a: string) => { getPassword(): string | null; setPassword(v: string): void; deletePassword(): boolean }; data: Map<string, string> } {
  const data = new Map<string, string>();
  class Entry {
    constructor(
      private readonly s: string,
      private readonly a: string,
    ) {}
    getPassword(): string | null {
      if (opts.broken) throw new Error("no keychain daemon");
      return data.get(`${this.s}/${this.a}`) ?? null;
    }
    setPassword(v: string): void {
      if (opts.broken) throw new Error("no keychain daemon");
      data.set(`${this.s}/${this.a}`, v);
    }
    deletePassword(): boolean {
      if (opts.broken) throw new Error("no keychain daemon");
      return data.delete(`${this.s}/${this.a}`);
    }
  }
  return { Entry, data };
}

describe("secret stores", () => {
  it("file store writes 0600 files in a 0700 directory and never stores the key name in the file name", () => {
    const d = dir();
    const s = new FileSecretStore(d);
    s.set("oauth:https://agent.example/mcp", "tok");
    expect(s.get("oauth:https://agent.example/mcp")).toBe("tok");
    const f = join(d, "secrets", `${sha256("oauth:https://agent.example/mcp").slice(0, 24)}.json`);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, "secrets")).mode & 0o777).toBe(0o700);
    s.delete("oauth:https://agent.example/mcp");
    expect(s.get("oauth:https://agent.example/mcp")).toBeUndefined();
    expect(existsSync(f)).toBe(false);
  });

  it("auto prefers a working keychain, and namespaces keys per state dir", () => {
    const k = fakeKeyring();
    const a = openSecretStore("auto", dir(), { entry: k.Entry });
    const b = openSecretStore("auto", dir(), { entry: k.Entry });
    expect(a.kind).toBe("keychain");
    a.set("x", "1");
    b.set("x", "2");
    expect(a.get("x")).toBe("1");
    expect(b.get("x")).toBe("2");
    a.delete("x");
    expect(a.get("x")).toBeUndefined();
    expect([...k.data.keys()].every((key) => key.startsWith("haelo-solana/"))).toBe(true);
  });

  it("auto falls back to files when the keychain library is missing or the OS keychain does not work", () => {
    expect(openSecretStore("auto", dir(), { entry: null }).kind).toBe("file");
    expect(openSecretStore("auto", dir(), { entry: fakeKeyring({ broken: true }).Entry }).kind).toBe("file");
    expect(openSecretStore("file", dir(), { entry: fakeKeyring().Entry }).kind).toBe("file");
  });

  it("`keychain` mode refuses to silently fall back", () => {
    expect(() => openSecretStore("keychain", dir(), { entry: null })).toThrow(/no usable OS keychain/);
  });

  it("keychain store tolerates reading or deleting a missing entry", () => {
    const s = new KeychainSecretStore(fakeKeyring({ broken: true }).Entry, "ns");
    expect(s.get("nope")).toBeUndefined();
    expect(() => s.delete("nope")).not.toThrow();
  });

  it("uses the real @napi-rs/keyring when this machine has a keychain (skipped otherwise)", () => {
    const s = openSecretStore("auto", dir());
    if (s.kind !== "keychain") return;
    s.set("haelo-test-real", "value");
    expect(s.get("haelo-test-real")).toBe("value");
    s.delete("haelo-test-real");
    expect(s.get("haelo-test-real")).toBeUndefined();
  });
});
