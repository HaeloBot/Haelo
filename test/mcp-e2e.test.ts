import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startHttp, type RunningHttp } from "../src/server/http.js";
import { upstreamHarness, type UpstreamHarness } from "./helpers/upstream-harness.js";
import { startMockUpstream, type RunningMockUpstream } from "../src/testkit/mock-upstream.js";

const TOKEN = "test-token-0123456789abcdef";
let h: UpstreamHarness | undefined;
let http: RunningHttp | undefined;
let up: RunningMockUpstream | undefined;
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
  it("serves tools/list with upstream tools and Haelo tools, never transfers", async () => {
    h = await upstreamHarness();
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const c = await connectHttp(http.url);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("place_equity_order");
    expect(names).toContain("haelo_status");
    expect(names).not.toContain("transfer_funds");
  });

  it("round-trips a shadow order and the status tool", async () => {
    h = await upstreamHarness();
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const c = await connectHttp(http.url);
    const r = await c.callTool({ name: "place_equity_order", arguments: { account_number: "MOCK-AGENT-1", symbol: "AAPL", side: "buy", type: "market", notional: 100 } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("simulated");
    const s = await c.callTool({ name: "haelo_status", arguments: {} });
    expect(text(s)).toContain("shadow");
    expect(h.state.orders).toHaveLength(0);
  });

  it("rejects a missing or wrong bearer token with 401", async () => {
    h = await upstreamHarness();
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
    h = await upstreamHarness();
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
    h = await upstreamHarness();
    await expect(startHttp(h.core, { host: "127.0.0.1", port: 0, token: "short" })).rejects.toThrow(/16/);
    await expect(startHttp(h.core, { host: "0.0.0.0", port: 0, token: TOKEN })).rejects.toThrow(/loopback/);
  });

  it("a blocked tool call comes back as an MCP error result the agent can read", async () => {
    h = await upstreamHarness({ rails: { maxOrderUsd: 50 } });
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const c = await connectHttp(http.url);
    const r = await c.callTool({ name: "place_equity_order", arguments: { account_number: "MOCK-AGENT-1", symbol: "AAPL", side: "buy", type: "market", notional: 500 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("per-order cap");
  });

  it("serves /healthz without auth and 404s other paths", async () => {
    h = await upstreamHarness();
    http = await startHttp(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
    const base = http.url.replace("/mcp", "");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});

describe("Haelo as an MCP server over stdio (spawned compiled CLI)", () => {
  it("serves the same gateway over stdio", async () => {
    up = await startMockUpstream();
    const dir = mkdtempSync(join(tmpdir(), "haelo-stdio-"));
    const cfg = join(dir, "haelo.yaml");
    writeFileSync(cfg, `version: 1\nstateDir: ${dir}/state\nbroker:\n  type: mcp-upstream\n  url: ${up.url}\n  accountTool: get_portfolio\nagent: { accountId: MOCK-AGENT-1 }\nhousehold: { enabled: false }\n`);
    const cli = resolve(__dirname, "../dist/cli.js");
    const client = new Client({ name: "stdio-agent", version: "1" }, { versionNegotiation: { mode: "auto" } });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "serve", "--stdio", "--config", cfg], stderr: "pipe" }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("haelo_status");
    expect(names).toContain("get_portfolio");
    expect(names).not.toContain("transfer_funds");
    const r = await client.callTool({ name: "place_equity_order", arguments: { account_number: "MOCK-AGENT-1", symbol: "AAPL", side: "buy", type: "market", notional: 40 } });
    expect(text(r)).toContain("simulated");
    expect(up.state.orders).toHaveLength(0);
  }, 30_000);
});
