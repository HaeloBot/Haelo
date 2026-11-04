import { chmodSync, mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type CliIo } from "../src/cli-main.js";
import { parseConfig } from "../src/policy/load.js";
import { configTemplate } from "../src/templates.js";
import { createHaelo } from "../src/factory.js";
import { loadConfig } from "../src/policy/load.js";
import bs58 from "bs58";
import { fund, newWallet, startFakeSolana, type RunningFakeSolana } from "./helpers/fake-solana.js";

let up: RunningFakeSolana | undefined;
afterEach(async () => {
  await up?.close();
  up = undefined;
});

const executed = (): number => [...(up?.state.swaps.values() ?? [])].filter((s) => s.executed).length;

function io(cwd: string, env: NodeJS.ProcessEnv = {}): CliIo & { stdout: string; stderr: string } {
  const o = {
    stdout: "",
    stderr: "",
    cwd,
    env,
    out(s: string) {
      o.stdout += s;
    },
    err(s: string) {
      o.stderr += s;
    },
  };
  return o;
}

async function project(): Promise<{ dir: string; cfg: string; state: string; env: NodeJS.ProcessEnv; address: string }> {
  up = await startFakeSolana();
  const wallet = newWallet();
  const address = wallet.publicKey.toBase58();
  fund(up.state, address, 5, 1000);
  const dir = mkdtempSync(join(tmpdir(), "haelo-cli-"));
  const state = join(dir, "state");
  const cfg = join(dir, "haelo.yaml");
  writeFileSync(cfg, `version: 1\nstateDir: ${state}\nsecrets: { store: file }\nbroker:\n  type: solana\n  rpcUrl: ${up.rpcUrl}\n  jupiterBaseUrl: ${up.jupiterUrl}\nagent: { accountId: ${address} }\nhousehold: { enabled: false }\n`);
  return { dir, cfg, state, env: { HAELO_PRIVATE_KEY: bs58.encode(wallet.secretKey) }, address };
}

describe("haelo CLI", () => {
  it("prints help and version", async () => {
    const i = io(tmpdir());
    expect(await run(["--help"], i)).toBe(0);
    expect(i.stdout).toContain("autonomy ladder");
    const v = io(tmpdir());
    expect(await run(["--version"], v)).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the config template is valid and Solana-only", () => {
    const c = parseConfig(configTemplate());
    expect(c.broker.type).toBe("solana");
    expect(c.live.enabled).toBe(false);
  });

  it("init writes a valid config, creates a 0600 http token, and refuses to overwrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "haelo-init-"));
    const i = io(dir);
    expect(await run(["init", "--state-dir", join(dir, "st")], i)).toBe(0);
    expect(i.stdout).toContain("haelo quote SOL/USDC");
    expect(existsSync(join(dir, "haelo.yaml"))).toBe(true);
    expect(statSync(join(dir, "st", "http-token")).mode & 0o777).toBe(0o600);
    const again = io(dir);
    expect(await run(["init"], again)).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  it("policy lock records the hash and policy check detects an edit", async () => {
    const p = await project();
    expect(await run(["policy", "lock", "--config", p.cfg], io(p.dir))).toBe(0);
    expect(await run(["policy", "check", "--config", p.cfg], io(p.dir))).toBe(0);
    writeFileSync(p.cfg, readFileSync(p.cfg, "utf8") + "\n# edited\n");
    const c = io(p.dir);
    expect(await run(["policy", "check", "--config", p.cfg], c)).not.toBe(0);
  });

  it("serve refuses to start after the locked policy changed", async () => {
    const p = await project();
    await run(["policy", "lock", "--config", p.cfg], io(p.dir));
    writeFileSync(p.cfg, readFileSync(p.cfg, "utf8").replace("household: { enabled: false }", "household: { enabled: true }"));
    const s = io(p.dir);
    expect(await run(["serve", "--stdio", "--config", p.cfg], { ...s, env: p.env })).toBe(2);
    expect(s.stderr).toContain("policy file changed");
  });

  it("status works offline and reports the starting rung", async () => {
    const p = await project();
    await up?.close();
    up = undefined;
    const s = io(p.dir);
    expect(await run(["status", "--json", "--config", p.cfg], s)).toBe(0);
    expect(JSON.parse(s.stdout).rung).toBe("shadow");
  });

  it("promote refuses until the criteria are met", async () => {
    const p = await project();
    const s = io(p.dir, p.env);
    expect(await run(["promote", "--config", p.cfg], s)).not.toBe(0);
    expect(s.stdout + s.stderr).toMatch(/minimum|criteria|not eligible|decisions/i);
  });

  it("a proposal can be created by the agent path and approved by the human CLI", async () => {
    const p = await project();
    const cfg = readFileSync(p.cfg, "utf8") + "live: { enabled: true }\nladder:\n  start: propose\n";
    writeFileSync(p.cfg, cfg);
    const core = await createHaelo(loadConfig(p.cfg), { env: p.env });
    await core.init();
    const r = await core.callTool("place_order", { symbol: "SOL", side: "buy", notional_usd: 60, confirm: true });
    await core.close();
    expect(JSON.stringify(r)).toMatch(/proposal|pending/i);
    const list = io(p.dir);
    expect(await run(["proposals", "--config", p.cfg], list)).toBe(0);
    const id = /^([0-9a-f]{8})\s/m.exec(list.stdout)?.[1];
    expect(id).toBeTruthy();
    expect(executed()).toBe(0);
    const a = io(p.dir, p.env);
    expect(await run(["approve", id as string, "--yes", "--config", p.cfg], a)).toBe(0);
    expect(a.stdout).toContain("ORDER APPROVAL CARD");
    expect(a.stdout).toContain("solscan.io/tx/");
    expect(executed()).toBe(1);
  });

  it("refuses to execute an approved proposal while live trading is disabled (the default)", async () => {
    const p = await project();
    writeFileSync(p.cfg, readFileSync(p.cfg, "utf8") + "ladder:\n  start: propose\n");
    const core = await createHaelo(loadConfig(p.cfg), { env: p.env });
    await core.init();
    await core.callTool("place_order", { symbol: "SOL", side: "buy", notional_usd: 60, confirm: true });
    const id = core.listProposals()[0]?.id as string;
    await core.close();
    const a = io(p.dir, p.env);
    expect(await run(["approve", id, "--yes", "--config", p.cfg], a)).toBe(1);
    expect(a.stdout).toContain("live.enabled: false");
    expect(executed()).toBe(0);
  });

  it("audit verify detects tampering in the SQLite store, even with the append-only triggers dropped", async () => {
    const p = await project();
    await run(["policy", "lock", "--config", p.cfg], io(p.dir));
    const core = await createHaelo(loadConfig(p.cfg), { env: p.env });
    await core.init();
    await core.callTool("get_quote", { symbol: "SOL" });
    await core.close();
    expect(await run(["audit", "verify", "--config", p.cfg], io(p.dir))).toBe(0);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(p.state, "haelo.db"));
    expect(() => db.exec("UPDATE audit SET type = 'edit' WHERE type = 'read'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit")).toThrow(/append-only/);
    db.exec("DROP TRIGGER audit_no_update");
    db.exec("UPDATE audit SET type = 'edit' WHERE type = 'read'");
    db.close();
    const v = io(p.dir);
    expect(await run(["audit", "verify", "--config", p.cfg], v)).toBe(1);
    expect(v.stderr).toContain("BROKEN");
  });

  it("audit export writes JSONL that verifies on its own, and tail prints entries", async () => {
    const p = await project();
    await run(["policy", "lock", "--config", p.cfg], io(p.dir));
    const out = join(p.dir, "export.jsonl");
    const e = io(p.dir);
    expect(await run(["audit", "export", "--out", out, "--config", p.cfg], e)).toBe(0);
    expect(e.stdout).toContain("Exported 1 entries");
    expect(await run(["audit", "verify", "--file", out], io(p.dir))).toBe(0);
    const t = io(p.dir);
    expect(await run(["audit", "tail", "-n", "5", "--config", p.cfg], t)).toBe(0);
    expect(t.stdout).toContain("policy_locked");
    writeFileSync(out, readFileSync(out, "utf8").replace("policy_locked", "policy_lockeD"));
    expect(await run(["audit", "verify", "--file", out], io(p.dir))).toBe(1);
  });

  it("audit verify passes on a fresh JSONL log and fails after tampering", async () => {
    const p = await project();
    writeFileSync(p.cfg, readFileSync(p.cfg, "utf8") + "storage: { backend: jsonl }\n");
    await run(["policy", "lock", "--config", p.cfg], io(p.dir));
    const core = await createHaelo(loadConfig(p.cfg), { env: p.env });
    await core.init();
    await core.callTool("get_quote", { symbol: "SOL" });
    await core.close();
    expect(await run(["audit", "verify", "--config", p.cfg], io(p.dir))).toBe(0);
    const f = join(p.state, "audit.jsonl");
    writeFileSync(f, readFileSync(f, "utf8").replace(/"type":"read"/, '"type":"edit"'));
    expect(await run(["audit", "verify", "--config", p.cfg], io(p.dir))).not.toBe(0);
  });

  it("quote prints a live Jupiter price", async () => {
    const p = await project();
    const q = io(p.dir);
    expect(await run(["quote", "SOL/USDC", "--config", p.cfg], q)).toBe(0);
    expect(q.stdout).toMatch(/SOL\/USDC\s+bid 14\d/);
    const bad = io(p.dir);
    expect(await run(["quote", "NOPE", "--config", p.cfg], bad)).toBe(1);
    expect(bad.stderr).toContain("Unknown token");
  });

  it("key import stores a keypair in the secret store, show prints only the address, forget removes it", async () => {
    const p = await project();
    const kp = newWallet();
    const file = join(p.dir, "id.json");
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    chmodSync(file, 0o644);
    expect(await run(["key", "import", "--file", file, "--config", p.cfg], io(p.dir))).toBe(1);
    chmodSync(file, 0o600);
    const imp = io(p.dir);
    expect(await run(["key", "import", "--file", file, "--config", p.cfg], imp)).toBe(0);
    expect(imp.stdout).toContain(kp.publicKey.toBase58());
    expect(imp.stdout).not.toContain(bs58.encode(kp.secretKey));
    const show = io(p.dir);
    expect(await run(["key", "show", "--config", p.cfg], show)).toBe(0);
    expect(show.stdout).toContain(kp.publicKey.toBase58());
    expect(show.stdout).not.toContain(bs58.encode(kp.secretKey));
    expect(await run(["key", "forget", "--config", p.cfg], io(p.dir))).toBe(0);
    expect(await run(["key", "show", "--config", p.cfg], io(p.dir))).toBe(1);
  });

  it("an unknown command is an error, not a silent success", async () => {
    const i = io(tmpdir());
    expect(await run(["frobnicate"], i)).not.toBe(0);
  });
});
