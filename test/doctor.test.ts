import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctor, runDoctor, type DoctorCheck } from "../src/doctor.js";
import { loadConfig } from "../src/policy/load.js";
import { run } from "../src/cli-main.js";
import { startMockUpstream, type RunningMockUpstream } from "../src/testkit/mock-upstream.js";
import { newMockAlpacaState, startMockAlpaca, type RunningMockAlpaca } from "./helpers/mock-alpaca.js";
import { robinhoodReadHandler, startJsonServer } from "./helpers/mock-robinhood.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function cfgFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "haelo-doc-"));
  const f = join(dir, "haelo.yaml");
  writeFileSync(f, `version: 1\nstateDir: ${join(dir, "state")}\n${body}`);
  return f;
}
const find = (cs: DoctorCheck[], area: string, name: string): DoctorCheck | undefined => cs.find((c) => c.area === area && c.name === name);

describe("haelo doctor", () => {
  it("checks Alpaca paper and live accounts and market data with read-only requests", async () => {
    const paper: RunningMockAlpaca = await startMockAlpaca(newMockAlpacaState());
    const live: RunningMockAlpaca = await startMockAlpaca(newMockAlpacaState(), { key: "AKLIVE123", secret: "live-secret" });
    closers.push(paper.close, live.close);
    const f = cfgFile("broker: { type: alpaca }\nlive: { enabled: true }\nagent: { accountId: PA-TEST-1 }\n");
    const env = { ALPACA_PAPER_KEY_ID: "PKTEST", ALPACA_PAPER_SECRET_KEY: "secret-test", ALPACA_LIVE_KEY_ID: "AKLIVE123", ALPACA_LIVE_SECRET_KEY: "live-secret" };
    const checks = await runDoctor(loadConfig(f), { env, live: true, urls: { alpacaPaper: paper.url, alpacaLive: live.url, alpacaData: live.url } });
    expect(find(checks, "alpaca paper", "account")?.level).toBe("pass");
    expect(find(checks, "alpaca live", "account")?.level).toBe("pass");
    expect(find(checks, "alpaca live", "market data")?.level).toBe("pass");
    expect(find(checks, "live", "live.enabled")?.level).toBe("pass");
    // Every request doctor made was a GET.
    expect([...paper.state.requests, ...live.state.requests].every((r) => r.method === "GET")).toBe(true);
    expect(paper.state.orders).toHaveLength(0);
    expect(formatDoctor(checks)).toMatch(/passed, \d+ warnings, \d+ failed/);
    // Policy is not locked yet, which is a failure for --live.
    expect(find(checks, "local", "policy lock")?.level).toBe("fail");
  });

  it("fails clearly on wrong keys, a paper key used as live, and missing live opt-in", async () => {
    const paper = await startMockAlpaca(newMockAlpacaState());
    closers.push(paper.close);
    const f = cfgFile("broker: { type: alpaca }\n");
    const env = { ALPACA_PAPER_KEY_ID: "PKTEST", ALPACA_PAPER_SECRET_KEY: "wrong", ALPACA_LIVE_KEY_ID: "PKOOPS", ALPACA_LIVE_SECRET_KEY: "x" };
    const checks = await runDoctor(loadConfig(f), { env, live: true, urls: { alpacaPaper: paper.url, alpacaLive: paper.url, alpacaData: paper.url } });
    expect(find(checks, "alpaca paper", "account")?.level).toBe("fail");
    expect(find(checks, "alpaca live", "key type")?.level).toBe("fail");
    expect(find(checks, "live", "live.enabled")?.level).toBe("fail");
  });

  it("reports missing credentials without making requests", async () => {
    const f = cfgFile("broker: { type: alpaca }\n");
    const checks = await runDoctor(loadConfig(f), { env: {} });
    expect(find(checks, "alpaca paper", "credentials")?.level).toBe("warn");
    expect(find(checks, "alpaca live", "credentials")?.level).toBe("skip");
  });

  it("sends a signed request to the Robinhood Crypto API", async () => {
    const rh = await startJsonServer(robinhoodReadHandler);
    closers.push(rh.close);
    const f = cfgFile("broker: { type: robinhood-crypto }\n");
    const env = { RH_CRYPTO_API_KEY: "rh-api-test", RH_CRYPTO_PRIVATE_KEY: "xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=" };
    const checks = await runDoctor(loadConfig(f), { env, urls: { robinhood: rh.url } });
    expect(find(checks, "robinhood crypto", "signed request")?.level).toBe("pass");
    expect(find(checks, "robinhood crypto", "market data")?.level).toBe("pass");
    expect(rh.seen.every((s) => s.method === "GET" && s.headers["x-signature"])).toBe(true);
    const missing = await runDoctor(loadConfig(f), { env: {} });
    expect(find(missing, "robinhood crypto", "credentials")?.level).toBe("fail");
    const bad = await runDoctor(loadConfig(f), { env: { RH_CRYPTO_API_KEY: "k", RH_CRYPTO_PRIVATE_KEY: "c2hvcnQ=" }, urls: { robinhood: rh.url } });
    expect(find(bad, "robinhood crypto", "signed request")?.level).toBe("fail");
  });

  it("connects to an upstream MCP server, classifies its tools and checks configured names", async () => {
    const up: RunningMockUpstream = await startMockUpstream({ token: "upstream-token-123" });
    closers.push(up.close);
    const f = cfgFile(`broker:\n  type: mcp-upstream\n  url: ${up.url}\n  bearerTokenEnv: UP_TOKEN\n  accountTool: get_portfolio\n  ordersTool: no_such_tool\n  quoteTools: { equity: get_equity_quotes }\nlive: { enabled: true }\n`);
    const checks = await runDoctor(loadConfig(f), { env: { UP_TOKEN: "upstream-token-123" }, live: true });
    expect(find(checks, "upstream", "connect + tools/list")?.level).toBe("pass");
    expect(find(checks, "upstream", "connect + tools/list")?.detail).toMatch(/transfer/);
    expect(find(checks, "upstream", "accountTool")?.level).toBe("pass");
    expect(find(checks, "upstream", "ordersTool")?.level).toBe("fail");
    expect(find(checks, "upstream", "unknown tools")?.level).toBe("warn");
    expect(find(checks, "live", "upstream verification")?.level).toBe("warn");
    const denied = await runDoctor(loadConfig(f), { env: { UP_TOKEN: "wrong-token-xxxxx" } });
    expect(find(denied, "upstream", "connect + tools/list")?.level).toBe("fail");
  });

  it("reports OAuth sign-in state for an OAuth upstream", async () => {
    const f = cfgFile("broker:\n  type: mcp-upstream\n  url: http://127.0.0.1:9/\nsecrets: { store: file }\n");
    const checks = await runDoctor(loadConfig(f), { env: {} });
    expect(find(checks, "upstream", "oauth tokens")?.level).toBe("fail");
    expect(find(checks, "upstream", "connect + tools/list")?.level).toBe("fail");
    expect(find(checks, "local", "secret store")?.level).toBe("warn");
  });

  it("flags a broken audit chain, loose permissions and a weak HTTP token", async () => {
    const f = cfgFile("broker: { type: alpaca }\nstorage: { backend: jsonl }\n");
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
    const f = cfgFile("broker: { type: robinhood-crypto }\n");
    const out = { s: "", e: "" };
    const code = await run(["doctor", "--json", "--config", f], { cwd: tmpdir(), env: {}, out: (s) => (out.s += s), err: (s) => (out.e += s) });
    expect(code).toBe(1);
    expect(JSON.parse(out.s).some((c: DoctorCheck) => c.level === "fail")).toBe(true);
    const text = { s: "" };
    await run(["doctor", "--config", f], { cwd: tmpdir(), env: {}, out: (s) => (text.s += s), err: () => undefined });
    expect(text.s).toContain("FAIL");
  });
});
