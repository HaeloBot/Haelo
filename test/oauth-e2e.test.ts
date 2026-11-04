import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli-main.js";
import { createLeash } from "../src/factory.js";
import { loadConfig } from "../src/policy/load.js";
import { startOAuthUpstream } from "./helpers/mock-oauth-upstream.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe("`leash auth` against an OAuth 2.1 + PKCE protected MCP server (local mock IdP)", () => {
  it("discovers metadata, registers, does PKCE, stores tokens, and the gateway then connects with them", async () => {
    const up = await startOAuthUpstream();
    closers.push(up.close);
    const dir = mkdtempSync(join(tmpdir(), "leash-oauth-"));
    const cfg = join(dir, "leash.yaml");
    const oauthPort = 21000 + Math.floor(Math.random() * 2000);
    writeFileSync(cfg, `version: 1\nstateDir: ${join(dir, "state")}\nsecrets: { store: file }\nbroker:\n  type: mcp-upstream\n  url: ${up.mcpUrl}\n  oauthPort: ${oauthPort}\n`);
    const o = { out: "", err: "" };
    const p = run(["auth", "--config", cfg], { cwd: dir, env: {}, out: (s) => (o.out += s), err: (s) => (o.err += s) });
    for (let i = 0; i < 300 && !/Open this URL/.test(o.err); i++) await new Promise((r) => setTimeout(r, 10));
    const authUrl = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(o.err)?.[1];
    expect(authUrl).toBeTruthy();
    // Play the browser: the IdP redirects to Leash's loopback callback.
    const r = await fetch(authUrl as string, { redirect: "manual" });
    expect(r.status).toBe(302);
    const cb = r.headers.get("location") as string;
    expect(cb).toContain(`127.0.0.1:${oauthPort}/callback`);
    await fetch(cb);
    expect(await p).toBe(0);
    expect(o.out).toContain("Signed in");
    expect(o.out).toMatch(/Upstream exposes \d+ tools/);
    expect(up.tokensIssued()).toBe(1);

    // The gateway reuses the stored token without another sign-in.
    const core = createLeash(loadConfig(cfg), { env: {} });
    await core.init();
    expect(core.toolDefs().map((t) => t.name)).toContain("get_portfolio");
    await core.close();
    // A second `leash auth` sees it is already authorized.
    const o2 = { out: "" };
    expect(await run(["auth", "--config", cfg], { cwd: dir, env: {}, out: (s) => (o2.out += s), err: () => undefined })).toBe(0);
    expect(o2.out).toContain("Already authorized");
  });

  it("without tokens the gateway refuses to start and says to run `leash auth`", async () => {
    const up = await startOAuthUpstream();
    closers.push(up.close);
    const dir = mkdtempSync(join(tmpdir(), "leash-oauth-"));
    const cfg = join(dir, "leash.yaml");
    writeFileSync(cfg, `version: 1\nstateDir: ${join(dir, "state")}\nsecrets: { store: file }\nbroker:\n  type: mcp-upstream\n  url: ${up.mcpUrl}\n`);
    const core = createLeash(loadConfig(cfg), { env: {} });
    await expect(core.init()).rejects.toThrow(/leash auth/);
  });
});
