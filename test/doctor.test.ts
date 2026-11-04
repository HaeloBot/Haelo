import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctor, runDoctor, type DoctorCheck } from "../src/doctor.js";
import { loadConfig } from "../src/policy/load.js";
import { run } from "../src/cli-main.js";
import { fund, newWallet, startFakeSolana, type RunningFakeSolana } from "./helpers/fake-solana.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function cfgFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "haelo-doc-"));
  const f = join(dir, "haelo.yaml");
  writeFileSync(f, `version: 1\nstateDir: ${join(dir, "state")}\nsecrets: { store: file }\n${body}`);
  return f;
}
const find = (cs: DoctorCheck[], area: string, name: string): DoctorCheck | undefined => cs.find((c) => c.area === area && c.name === name);

async function fake(): Promise<RunningFakeSolana> {
  const f = await startFakeSolana();
  closers.push(f.close);
  return f;
}
const solanaBroker = (f: RunningFakeSolana, extra = ""): string => `broker:\n  type: solana\n  rpcUrl: ${f.rpcUrl}\n  jupiterBaseUrl: ${f.jupiterUrl}\n${extra}`;

describe("haelo doctor", () => {
  it("checks the cluster, every mint, a Jupiter quote and the wallet, without building a swap", async () => {
    const f = await fake();
    const kp = newWallet();
    fund(f.state, kp.publicKey.toBase58(), 1, 250);
    const file = cfgFile(`${solanaBroker(f)}live: { enabled: true }\nagent: { accountId: ${kp.publicKey.toBase58()} }\n`);
    const checks = await runDoctor(loadConfig(file), { env: { HAELO_PRIVATE_KEY: bs58.encode(kp.secretKey) }, live: true });
    expect(find(checks, "solana", "rpc")?.level).toBe("pass");
    expect(find(checks, "solana", "rpc tier")?.level).toBe("warn");
    expect(find(checks, "solana", "mint USDC")?.detail).toBe("6 decimals");
    expect(find(checks, "jupiter", "quote")?.level).toBe("pass");
    expect(find(checks, "wallet", "signing key")?.detail).toContain(kp.publicKey.toBase58());
    expect(find(checks, "wallet", "SOL for fees")?.level).toBe("pass");
    expect(find(checks, "wallet", "USDC")?.detail).toBe("250 USDC");
    expect(find(checks, "live", "live.enabled")?.level).toBe("pass");
    expect(find(checks, "local", "policy lock")?.level).toBe("fail"); // not locked yet
    expect(JSON.stringify(checks)).not.toContain(bs58.encode(kp.secretKey));
    // Doctor only quoted: no swap was built for a taker and nothing executed.
    expect([...f.state.swaps.values()].every((sw) => !sw.taker && !sw.executed)).toBe(true);
    expect(formatDoctor(checks)).toMatch(/passed, \d+ warnings, \d+ failed/);
  });

  it("fails clearly on the wrong cluster, no key for --live, low SOL and a mismatched account wall", async () => {
    const f = await fake();
    const watch = newWallet().publicKey.toBase58();
    fund(f.state, watch, 0.001, 0);
    const file = cfgFile(`${solanaBroker(f)}agent: { accountId: ${newWallet().publicKey.toBase58()} }\n`);
    const checks = await runDoctor(loadConfig(file), { env: { HAELO_ADDRESS: watch }, live: true });
    expect(find(checks, "wallet", "signing key")?.level).toBe("fail");
    expect(find(checks, "wallet", "watch address")?.level).toBe("pass");
    expect(find(checks, "wallet", "SOL for fees")?.level).toBe("fail");
    expect(find(checks, "wallet", "account wall")?.level).toBe("fail");
    expect(find(checks, "live", "live.enabled")?.level).toBe("fail");
    f.state.genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    const wrong = await runDoctor(loadConfig(file), { env: {} });
    expect(find(wrong, "solana", "rpc")?.level).toBe("fail");
    expect(find(wrong, "solana", "rpc")?.detail).toContain("not mainnet-beta");
  });

  it("reports an unreachable RPC and Jupiter without crashing, and a missing key as skip", async () => {
    const file = cfgFile("broker:\n  type: solana\n  rpcUrl: http://127.0.0.1:9/\n  jupiterBaseUrl: http://127.0.0.1:9/swap/v2\n");
    const checks = await runDoctor(loadConfig(file), { env: {} });
    expect(find(checks, "solana", "rpc")?.level).toBe("fail");
    expect(find(checks, "jupiter", "quote")?.level).toBe("fail");
    expect(find(checks, "wallet", "signing key")?.level).toBe("skip");
    expect(find(checks, "local", "secret store")?.level).toBe("warn");
  });

  it("hides a private RPC URL that may carry an API key", async () => {
    const f = await fake();
    const file = cfgFile(solanaBroker(f));
    const checks = await runDoctor(loadConfig(file), { env: { HAELO_RPC_URL: `${f.rpcUrl}?api-key=SECRET123` } });
    expect(find(checks, "solana", "rpc")?.level).toBe("pass");
    expect(JSON.stringify(checks)).not.toContain("SECRET123");
    expect(find(checks, "solana", "rpc tier")).toBeUndefined();
  });

  it("flags a broken audit chain, loose permissions and a weak HTTP token", async () => {
    const f = cfgFile("broker: { type: solana }\nstorage: { backend: jsonl }\n");
    const l = loadConfig(f);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(l.stateDir, { recursive: true });
    chmodSync(l.stateDir, 0o755);
    writeFileSync(join(l.stateDir, "audit.jsonl"), "garbage\n");
    writeFileSync(join(l.stateDir, "http-token"), "tok\n", { mode: 0o644 });
    chmodSync(join(l.stateDir, "http-token"), 0o644);
    const checks = await runDoctor(l, { env: {} });
    expect(find(checks, "local", "audit chain")?.level).toBe("fail");
    expect(find(checks, "local", "state dir permissions")?.level).toBe("warn");
    expect(find(checks, "local", "http token")?.level).toBe("warn");
    const short = await runDoctor(l, { env: { HAELO_HTTP_TOKEN: "short" } });
    expect(find(short, "local", "http token")?.level).toBe("fail");
  });

  it("is wired into the CLI with a non-zero exit code on failure and JSON output", async () => {
    const f = cfgFile("broker:\n  type: solana\n  rpcUrl: http://127.0.0.1:9/\n  jupiterBaseUrl: http://127.0.0.1:9/swap/v2\n");
    const out = { s: "", e: "" };
    const code = await run(["doctor", "--json", "--config", f], { cwd: tmpdir(), env: {}, out: (s) => (out.s += s), err: (s) => (out.e += s) });
    expect(code).toBe(1);
    expect(JSON.parse(out.s).some((c: DoctorCheck) => c.level === "fail")).toBe(true);
    const text = { s: "" };
    await run(["doctor", "--config", f], { cwd: tmpdir(), env: {}, out: (s) => (text.s += s), err: () => undefined });
    expect(text.s).toContain("FAIL");
  });
});
