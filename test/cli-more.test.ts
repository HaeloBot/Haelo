import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type CliIo } from "../src/cli-main.js";
import { createHaelo } from "../src/factory.js";
import { loadConfig } from "../src/policy/load.js";
import { startMockUpstream, type RunningMockUpstream } from "../src/testkit/mock-upstream.js";

let up: RunningMockUpstream | undefined;
afterEach(async () => {
  await up?.close();
  up = undefined;
});

function io(cwd: string, env: NodeJS.ProcessEnv = {}): CliIo & { stdout: string; stderr: string } {
  const o = { stdout: "", stderr: "", cwd, env, out: (s: string) => void (o.stdout += s), err: (s: string) => void (o.stderr += s) };
  return o;
}

async function project(extra = ""): Promise<{ dir: string; cfg: string }> {
  up = await startMockUpstream();
  const dir = mkdtempSync(join(tmpdir(), "haelo-cli2-"));
  const cfg = join(dir, "haelo.yaml");
  writeFileSync(cfg, `version: 1\nstateDir: ${join(dir, "state")}\nbroker:\n  type: mcp-upstream\n  url: ${up.url}\n  quoteTools: { equity: get_equity_quotes }\nagent: { accountId: MOCK-AGENT-1 }\nhousehold: { enabled: false }\nladder:\n  criteria:\n    shadow: { minDays: 0, minDecisions: 0 }\n${extra}`);
  return { dir, cfg };
}

/** Run a long-lived command, wait until it logs `ready`, then send it SIGINT the way a terminal would. */
async function runUntil(argv: string[], o: ReturnType<typeof io>, ready: RegExp, during?: () => Promise<void>): Promise<number> {
  const p = run(argv, o);
  for (let i = 0; i < 200 && !ready.test(o.stderr); i++) await new Promise((r) => setTimeout(r, 10));
  expect(o.stderr).toMatch(ready);
  await during?.();
  process.emit("SIGINT");
  return p;
}

describe("haelo CLI: operating commands", () => {
  it("status (text), report, promote, demote, panic", async () => {
    const p = await project();
    const s = io(p.dir);
    expect(await run(["status", "--config", p.cfg], s)).toBe(0);
    expect(s.stdout).toContain("rung         shadow");
    const r = io(p.dir);
    expect(await run(["report", "--config", p.cfg], r)).toBe(0);
    expect(JSON.parse(r.stdout).promotion.eligible).toBe(true);
    const pr = io(p.dir);
    expect(await run(["promote", "--config", p.cfg], pr)).toBe(0);
    expect(pr.stdout).toMatch(/propose/);
    const d = io(p.dir);
    expect(await run(["demote", "--config", p.cfg], d)).toBe(0);
    expect(d.stdout).toContain("Demoted propose -> shadow");
    const d2 = io(p.dir);
    await run(["demote", "--config", p.cfg], d2);
    expect(d2.stdout).toContain("lowest rung");
    const pa = io(p.dir);
    expect(await run(["panic", "--config", p.cfg], pa)).toBe(0);
  });

  it("proposals (empty and JSON), decline, and usage errors", async () => {
    const p = await project();
    const e = io(p.dir);
    expect(await run(["proposals", "--config", p.cfg], e)).toBe(0);
    expect(e.stdout).toContain("No proposals");
    writeFileSync(p.cfg, readFileSync(p.cfg, "utf8") + "  start: propose\n");
    const core = createHaelo(loadConfig(p.cfg), { env: {} });
    await core.init();
    await core.callTool("place_equity_order", { account_number: "MOCK-AGENT-1", symbol: "AAPL", side: "buy", type: "market", notional: 30 });
    const id = core.listProposals()[0]?.id as string;
    await core.close();
    const j = io(p.dir);
    expect(await run(["proposals", "--json", "--config", p.cfg], j)).toBe(0);
    expect(JSON.parse(j.stdout)[0].id).toBe(id);
    const dc = io(p.dir);
    expect(await run(["decline", id, "--config", p.cfg], dc)).toBe(0);
    expect(dc.stdout).toContain("Declined");
    expect(await run(["approve", "--config", p.cfg], io(p.dir))).toBe(1);
    expect(await run(["approve", "nope", "--yes", "--config", p.cfg], io(p.dir))).toBe(1);
    expect(await run(["pin", "bogus", "--config", p.cfg], io(p.dir))).toBe(1);
    expect(await run(["policy", "bogus", "--config", p.cfg], io(p.dir))).toBe(1);
    expect(await run(["audit", "bogus", "--config", p.cfg], io(p.dir))).toBe(1);
  });

  it("pin status / approve, policy show and check without a lock", async () => {
    const p = await project();
    const ps = io(p.dir);
    expect(await run(["pin", "status", "--config", p.cfg], ps)).toBe(0);
    const pa = io(p.dir);
    expect(await run(["pin", "approve", "--config", p.cfg], pa)).toBe(0);
    expect(pa.stdout).toMatch(/Pinned \d+ upstream tools/);
    const ps2 = io(p.dir);
    await run(["pin", "status", "--config", p.cfg], ps2);
    expect(ps2.stdout).toContain("no drift");
    up!.state.descriptionSuffix = " changed";
    const core = createHaelo(loadConfig(p.cfg), { env: {} });
    await core.init();
    await core.close();
    const ps3 = io(p.dir);
    expect(await run(["pin", "status", "--config", p.cfg], ps3)).toBe(1);
    expect(ps3.stdout).toContain("DRIFT");
    const st = io(p.dir);
    await run(["status", "--config", p.cfg], st);
    expect(st.stdout).toContain("TOOL DRIFT");
    const show = io(p.dir);
    expect(await run(["policy", "show", "--config", p.cfg], show)).toBe(0);
    expect(JSON.parse(show.stdout).live.enabled).toBe(false);
    expect(await run(["policy", "check", "--config", p.cfg], io(p.dir))).toBe(1);
  });

  it("config errors are readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "haelo-cli3-"));
    const m = io(dir);
    expect(await run(["status"], m)).toBe(1);
    expect(m.stderr).toContain("Config not found");
    expect(await run(["init", "--broker", "nope"], io(dir))).toBe(1);
    const a = io(dir);
    expect(await run(["init", "--broker", "alpaca", "--state-dir", join(dir, "s")], a)).toBe(0);
    const au = io(dir);
    expect(await run(["auth"], au)).toBe(1);
    expect(au.stderr).toContain("mcp-upstream");
    expect(await run(["serve"], io(dir))).toBe(1);
    expect(await run(["version"], io(dir))).toBe(0);
  });

  it("serve --http starts, serves /healthz, and stops on SIGINT", async () => {
    const p = await project();
    await run(["policy", "lock", "--config", p.cfg], io(p.dir));
    const o = io(p.dir, { HAELO_HTTP_TOKEN: "cli-token-0123456789abcdef" });
    const code = await runUntil(["serve", "--http", "--port", "0", "--config", p.cfg], o, /serving http:\/\/127\.0\.0\.1:(\d+)\/mcp/, async () => {
      const port = /127\.0\.0\.1:(\d+)/.exec(o.stderr)?.[1];
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    });
    expect(code).toBe(0);
    expect(o.stderr).toContain("HAELO_HTTP_TOKEN");
  });

  it("serve warns when the policy is not locked and accepts --allow-policy-change", async () => {
    const p = await project();
    const o = io(p.dir);
    expect(await runUntil(["serve", "--http", "--port", "0", "--config", p.cfg], o, /serving/)).toBe(0);
    expect(o.stderr).toContain("policy is not locked");
    expect(o.stderr).toContain("http-token");
    await run(["policy", "lock", "--config", p.cfg], io(p.dir));
    writeFileSync(p.cfg, readFileSync(p.cfg, "utf8") + "\n# edit\n");
    const o2 = io(p.dir);
    expect(await runUntil(["serve", "--http", "--port", "0", "--allow-policy-change", "--config", p.cfg], o2, /serving/)).toBe(0);
  });

  it("approvals-ui starts with a login URL and stops on SIGINT", async () => {
    const p = await project("approvals:\n  web: { port: 0 }\n");
    const o = io(p.dir, { HAELO_HTTP_TOKEN: "cli-token-0123456789abcdef" });
    const code = await runUntil(["approvals-ui", "--config", p.cfg], o, /login\?token=/, async () => {
      const url = /(http:\/\/127\.0\.0\.1:\d+\/login\?token=\S+)/.exec(o.stderr)?.[1] as string;
      const r = await fetch(url, { redirect: "manual" });
      expect(r.status).toBe(303);
    });
    expect(code).toBe(0);
  });

  it("mock-upstream serves over HTTP until SIGINT", async () => {
    const o = io(tmpdir());
    expect(await runUntil(["mock-upstream", "--port", "0"], o, /listening at/)).toBe(0);
  });
});
