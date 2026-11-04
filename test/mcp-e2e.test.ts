import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startHttp, type RunningHttp } from "../src/server/http.js";
import { solanaHarness, type Harness } from "./helpers/harness.js";
import { fund, newWallet, startFakeSolana, type RunningFakeSolana } from "./helpers/fake-solana.js";

const TOKEN = "test-token-0123456789abcdef";
let h: Harness | undefined;
let http: RunningHttp | undefined;
let up: RunningFakeSolana | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await http?.close();
  await h?.cleanup();
  await up?.close();
  http = h = up = undefined;
});

async function connectHttp(url: string, token = TOKEN): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const text = (r: { content?: unknown }): string => JSON.stringify(r.content);

describe("Haelo as an MCP server over Streamable HTTP (real SDK client)", () => {
  it("serves tools/list with the swap tools and Haelo tools, never transfers", async () => {
    h = await solanaHarness();
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const c = await connectHttp(http.url);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("place_order");
    expect(names).toContain("get_quote");
    expect(names).toContain("haelo_status");
    expect(names.some((n) => /transfer|withdraw/.test(n))).toBe(false);
  });

  it("round-trips a shadow order and the status tool", async () => {
    h = await solanaHarness();
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const c = await connectHttp(http.url);
    const r = await c.callTool({ name: "place_order", arguments: { symbol: "SOL/USDC", side: "buy", notional_usd: 100 } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("simulated");
    const s = await c.callTool({ name: "haelo_status", arguments: {} });
    expect(text(s)).toContain("shadow");
    expect(h.executed()).toBe(0);
  });

  it("rejects a missing or wrong bearer token with 401", async () => {
    h = await solanaHarness();
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const bad = new Client({ name: "x", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await expect(bad.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { authorization: "Bearer nope" } } }))).rejects.toThrow();
    const status = await new Promise<number>((res, rej) => {
      const u = new URL(http?.url ?? "");
      const r = request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json" } }, (resp) => res(resp.statusCode ?? 0));
      r.on("error", rej);
      r.end("{}");
    });
    expect(status).toBe(401);
  });

  it("rejects a DNS-rebinding style Host header and a foreign Origin", async () => {
    h = await solanaHarness();
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const u = new URL(http.url);
    const send = (headers: Record<string, string>): Promise<number> =>
      new Promise((res, rej) => {
        const r = request({ host: "127.0.0.1", port: u.port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers } }, (resp) => res(resp.statusCode ?? 0));
        r.on("error", rej);
        r.end("{}");
      });
    expect(await send({ host: "evil.example.com" })).toBeGreaterThanOrEqual(400);
    expect(await send({ origin: "https://evil.example.com" })).toBeGreaterThanOrEqual(400);
  });

  it("refuses to start with a short token or on a non-loopback address without --allow-remote", async () => {
    h = await solanaHarness();
    await expect(startHttp(h.core, { host: "127.0.0.1", port: 0, token: "short" })).rejects.toThrow(/16/);
    await expect(startHttp(h.core, { host: "0.0.0.0", port: 0, token: TOKEN })).rejects.toThrow(/loopback/);
  });

  it("a blocked tool call comes back as an MCP error result the agent can read", async () => {
    h = await solanaHarness({ rails: { maxOrderUsd: 50 } });
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const c = await connectHttp(http.url);
    const r = await c.callTool({ name: "place_order", arguments: { symbol: "SOL", side: "buy", notional_usd: 500 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("per-order cap");
  });

  it("serves /healthz without auth and 404s other paths", async () => {
    h = await solanaHarness();
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const base = http.url.replace("/mcp", "");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});

describe("Haelo as an MCP server over stdio (spawned compiled CLI)", () => {
  it("serves the same gateway over stdio", async () => {
    up = await startFakeSolana();
    fund(up.state, newWallet().publicKey.toBase58(), 1, 100);
    const dir = mkdtempSync(join(tmpdir(), "haelo-stdio-"));
    const cfg = join(dir, "haelo.yaml");
    writeFileSync(cfg, `version: 1\nstateDir: ${dir}/state\nsecrets: { store: file }\nbroker:\n  type: solana\n  rpcUrl: ${up.rpcUrl}\n  jupiterBaseUrl: ${up.jupiterUrl}\nhousehold: { enabled: false }\n`);
    const cli = resolve(__dirname, "../dist/cli.js");
    const client = new Client({ name: "stdio-agent", version: "1" }, { versionNegotiation: { mode: "auto" } });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "serve", "--stdio", "--config", cfg], stderr: "pipe" }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("haelo_status");
    expect(names).toContain("get_quote");
    const q = await client.callTool({ name: "get_quote", arguments: { symbol: "SOL" } });
    expect(text(q)).toContain("SOL/USDC");
    const r = await client.callTool({ name: "place_order", arguments: { symbol: "SOL", side: "buy", notional_usd: 40 } });
    expect(text(r)).toContain("simulated");
    expect([...up.state.swaps.values()].some((s) => s.executed)).toBe(false);
  }, 30_000);
});
