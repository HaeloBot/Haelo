import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listenForOAuthCallback, SecretOAuthProvider } from "../src/oauth.js";
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
    expect([...k.data.keys()].every((key) => key.startsWith("haelo-mcp/"))).toBe(true);
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

describe("SecretOAuthProvider", () => {
  it("persists PKCE state, client registration and tokens through the secret store", () => {
    const d = dir();
    const store = new FileSecretStore(d);
    const seen: URL[] = [];
    const p = new SecretOAuthProvider(store, d, "https://agent.example/mcp", 8765, (u) => seen.push(u));
    expect(p.redirectUrl).toBe("http://127.0.0.1:8765/callback");
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
    expect(p.hasTokens()).toBe(false);
    expect(() => p.codeVerifier()).toThrow(/PKCE/);
    p.saveCodeVerifier("verifier");
    const st = p.state();
    p.saveClientInformation({ client_id: "cid" }, { issuer: "https://auth.example" } as never);
    p.saveClientInformation({ client_id: "ignored" });
    p.saveDiscoveryState({ authorizationServerUrl: "https://auth.example" } as never);
    p.saveTokens({ access_token: "at", token_type: "Bearer" });
    p.redirectToAuthorization(new URL("https://auth.example/authorize"));
    expect(seen).toHaveLength(1);
    expect(p.storeKind).toBe("file");

    const again = new SecretOAuthProvider(store, d, "https://agent.example/mcp", 8765, () => undefined);
    expect(again.hasTokens()).toBe(true);
    expect(again.tokens()?.access_token).toBe("at");
    expect(again.codeVerifier()).toBe("verifier");
    expect(again.expectedState()).toBe(st);
    expect(again.clientInformation({ issuer: "https://auth.example" } as never)?.client_id).toBe("cid");
    expect(again.clientInformation()).toBeUndefined();
    expect(again.discoveryState()).toBeTruthy();
    again.clear();
    expect(new SecretOAuthProvider(store, d, "https://agent.example/mcp", 8765, () => undefined).hasTokens()).toBe(false);
  });

  it("migrates a legacy plain token file into the store and deletes it", () => {
    const d = dir();
    const url = "https://agent.example/mcp";
    mkdirSync(join(d, "oauth"), { recursive: true });
    const legacy = join(d, "oauth", `${sha256(url).slice(0, 16)}.json`);
    writeFileSync(legacy, JSON.stringify({ clients: {}, tokens: { access_token: "old", token_type: "Bearer" } }));
    const k = fakeKeyring();
    const store = openSecretStore("auto", d, { entry: k.Entry });
    const p = new SecretOAuthProvider(store, d, url, 8765, () => undefined);
    expect(p.tokens()?.access_token).toBe("old");
    expect(existsSync(legacy)).toBe(false);
    expect(k.data.size).toBe(1);
  });
});

describe("OAuth loopback callback listener", () => {
  it("resolves with the query parameters on /callback and 404s other paths", async () => {
    const port = 18000 + Math.floor(Math.random() * 2000);
    const l = listenForOAuthCallback(port, 5000);
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`);
    expect(await res.text()).toContain("authorization received");
    const params = await l.promise;
    expect(params.get("code")).toBe("abc");
    l.close();
  });

  it("times out", async () => {
    const port = 20000 + Math.floor(Math.random() * 2000);
    const l = listenForOAuthCallback(port, 50);
    await expect(l.promise).rejects.toThrow(/Timed out/);
    l.close();
  });
});
