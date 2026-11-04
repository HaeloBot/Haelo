import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadConfig, expandHome, type LoadedConfig } from "./policy/load.js";
import { createHaelo } from "./factory.js";
import { verifyFile } from "./audit.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import { initialState } from "./ladder.js";
import { startApprovalsUi } from "./server/approvals-ui.js";
import { openStorage } from "./storage/index.js";
import { openSecretStore } from "./secrets.js";
import { startHttp } from "./server/http.js";
import { startStdio } from "./server/stdio.js";
import { configTemplate } from "./templates.js";
import { KEYCHAIN_ENTRY, loadSigner, parseSecretKey, readKeypairFile } from "./solana/signer.js";
import bs58 from "bs58";
import { VERSION } from "./version.js";
import type { Proposal } from "./state.js";
import { errorMessage, sha256 } from "./util.js";

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const HELP = `haelo ${VERSION}: an autonomy ladder for AI trading agents on Solana

Usage: haelo <command> [options]

Setup
  init [--force]                                                       Write haelo.yaml and create the state directory
  policy lock | show | check                                           Lock the policy hash, print it, or compare it to the lock
  key import --file <id.json> | --stdin                                Store a Solana keypair in the OS keychain (or a 0600 file)
  key show | forget                                                    Print the wallet address and where the key lives, or remove it

Run
  serve --stdio                                                        Serve the gateway over stdio (for Claude Desktop, Cursor, ...)
  serve --http [--port 8787] [--host 127.0.0.1]                        Serve Streamable HTTP at /mcp (bearer token required)
  quote <pair>                                                         Live Jupiter quote, for example: haelo quote SOL/USDC

Operate (human-only actions)
  status [--json]                                                      Rung, caps, stats, pending approvals
  report                                                               Shadow scorecard and promotion checklist
  promote [--force]                                                    Move up one rung if the criteria are met
  demote                                                               Move down one rung now
  panic                                                                Drop to shadow and cancel open orders
  proposals                                                            List order proposals
  approve <id> [--yes] | decline <id>                                  Decide a proposal
  pin status | approve                                                 Review and re-approve the pinned tool list
  approvals-ui [--port 8790]                                           Local web page to approve/decline proposals (loopback, token)
  audit verify | tail [-n 20] | export [--out f]                       Check the hash chain, show recent entries, export JSONL
  doctor [--live] [--json]                                             Read-only preflight: config, storage, key, RPC, Jupiter, balances

Global: --config <path> (default: $HAELO_CONFIG or ./haelo.yaml), --help, --version
`;

function configPath(values: { config?: string | undefined }, io: CliIo): string {
  return resolve(io.cwd, values.config ?? io.env["HAELO_CONFIG"] ?? "haelo.yaml");
}

function loadOrThrow(values: { config?: string | undefined }, io: CliIo): LoadedConfig {
  const p = configPath(values, io);
  if (!existsSync(p)) throw new Error(`Config not found: ${p}. Run \`haelo init\` first.`);
  return loadConfig(p);
}

function lockFile(l: LoadedConfig): string {
  return join(l.stateDir, "policy.lock");
}

function readOrCreateToken(l: LoadedConfig, env: NodeJS.ProcessEnv): { token: string; source: string } {
  if (env["HAELO_HTTP_TOKEN"]) return { token: env["HAELO_HTTP_TOKEN"], source: "HAELO_HTTP_TOKEN" };
  const f = join(l.stateDir, "http-token");
  if (existsSync(f)) return { token: readFileSync(f, "utf8").trim(), source: f };
  mkdirSync(l.stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(f, token + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  return { token, source: f };
}

function card(p: Proposal): string {
  const i = p.intent as Record<string, unknown>;
  const lines = [
    "ORDER APPROVAL CARD (built from the canonical order fields, not from agent text)",
    `  proposal   ${p.id}`,
    `  action     ${String(i["side"]).toUpperCase()} ${String(i["symbol"])} (${String(i["assetClass"])})`,
    `  type       ${String(i["type"])}${i["limitPrice"] !== undefined ? ` @ ${String(i["limitPrice"])}` : ""}`,
    `  size       ${i["qty"] !== undefined ? `${String(i["qty"])} units` : ""}${i["notionalUsd"] !== undefined ? `$${String(i["notionalUsd"])}` : ""}`,
    `  est. value $${p.notionalUsd.toFixed(2)}`,
    `  expires    ${p.expiresAt}`,
  ];
  for (const c of p.checks) lines.push(`  ${c.level.toUpperCase().padEnd(5)} ${c.message}`);
  if (p.rationale) lines.push("", "  Agent's stated rationale (untrusted, shown separately on purpose):", `  > ${p.rationale.replace(/\n/g, "\n  > ")}`);
  return lines.join("\n");
}

/** Entry point, separated from process wiring so tests can call it. Returns the exit code. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.out(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    io.out(VERSION + "\n");
    return 0;
  }
  const common = {
    config: { type: "string" as const },
    json: { type: "boolean" as const },
    yes: { type: "boolean" as const },
    force: { type: "boolean" as const },
  };

  try {
    switch (cmd) {
      case "init": {
        const { values } = parseArgs({ args: rest, options: { ...common, dir: { type: "string" }, "state-dir": { type: "string" } }, allowPositionals: false });
        const dir = resolve(io.cwd, values.dir ?? ".");
        const target = join(dir, "haelo.yaml");
        if (existsSync(target) && !values.force) throw new Error(`${target} already exists. Use --force to overwrite.`);
        mkdirSync(dir, { recursive: true });
        const stateDirOpt = values["state-dir"];
        writeFileSync(target, configTemplate(stateDirOpt ? { stateDir: stateDirOpt } : {}));
        const loaded = loadConfig(target);
        mkdirSync(loaded.stateDir, { recursive: true, mode: 0o700 });
        const t = readOrCreateToken(loaded, io.env);
        io.out(`Wrote ${target}\nState directory: ${loaded.stateDir}\nHTTP token stored at ${t.source} (mode 600)\n\nNext:\n  1. Review haelo.yaml. Quotes and shadow need no key.\n  2. haelo quote SOL/USDC   (checks Jupiter and the RPC)\n  3. haelo policy lock\n  4. haelo serve --stdio   (or --http)\n  Live swaps later: haelo key import --file ~/.config/solana/id.json, then haelo doctor --live\n`);
        return 0;
      }
      case "policy": {
        const sub = rest[0];
        const { values } = parseArgs({ args: rest.slice(1), options: common, allowPositionals: false });
        const l = loadOrThrow(values, io);
        if (sub === "lock") {
          mkdirSync(l.stateDir, { recursive: true, mode: 0o700 });
          writeFileSync(lockFile(l), JSON.stringify({ hash: l.hash, lockedAt: new Date().toISOString(), file: l.path }, null, 2) + "\n", { mode: 0o600 });
          const st = openStorage(l.config.storage.backend, l.stateDir, () => initialState(l.config, new Date()));
          try {
            st.audit.append("policy_locked", { hash: l.hash });
          } finally {
            st.close();
          }
          io.out(`Policy locked: ${l.hash}\nThe gateway will refuse to start if ${l.path} changes. Re-run \`haelo policy lock\` after a deliberate edit.\n`);
          return 0;
        }
        if (sub === "show") {
          io.out(JSON.stringify(l.config, null, 2) + "\n");
          return 0;
        }
        if (sub === "check") {
          const f = lockFile(l);
          if (!existsSync(f)) {
            io.err("No policy lock found. Run `haelo policy lock`.\n");
            return 1;
          }
          const locked = (JSON.parse(readFileSync(f, "utf8")) as { hash: string }).hash;
          if (locked !== l.hash) {
            io.err(`Policy has CHANGED since it was locked.\n  locked:  ${locked}\n  current: ${l.hash}\n`);
            return 2;
          }
          io.out("Policy matches the lock.\n");
          return 0;
        }
        throw new Error("Usage: haelo policy lock|show|check");
      }
      case "serve": {
        const { values } = parseArgs({
          args: rest,
          options: { ...common, stdio: { type: "boolean" }, http: { type: "boolean" }, port: { type: "string" }, host: { type: "string" }, "allow-remote": { type: "boolean" }, "allow-policy-change": { type: "boolean" } },
          allowPositionals: false,
        });
        if (!values.stdio && !values.http) throw new Error("Choose a transport: haelo serve --stdio or --http");
        const l = loadOrThrow(values, io);
        const lf = lockFile(l);
        if (existsSync(lf)) {
          const locked = (JSON.parse(readFileSync(lf, "utf8")) as { hash: string }).hash;
          if (locked !== l.hash && !values["allow-policy-change"]) {
            io.err(`Refusing to start: the policy file changed since it was locked.\n  locked:  ${locked}\n  current: ${l.hash}\nReview the change, then run \`haelo policy lock\` (or pass --allow-policy-change once).\n`);
            return 2;
          }
        } else {
          io.err("warning: policy is not locked. Run `haelo policy lock` so edits to haelo.yaml cannot go unnoticed.\n");
        }
        const core = await createHaelo(l, { env: io.env });
        await core.init();
        core.audit.append("policy_loaded", { hash: l.hash, locked: existsSync(lf) });
        if (values.stdio) {
          io.err(`haelo ${VERSION}: serving stdio (rung: ${core.status().rung}, broker: ${core.adapter.id})\n`);
          const handle = startStdio(core);
          await new Promise<void>((res) => {
            const stop = (): void => {
              void Promise.resolve(handle.close?.()).finally(() => core.close().finally(res));
            };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            process.stdin.once("end", stop);
          });
          return 0;
        }
        const t = readOrCreateToken(l, io.env);
        const port = values.port !== undefined ? Number(values.port) : l.config.http.port;
        const running = await startHttp(core, { host: values.host ?? l.config.http.host, port, token: t.token, allowRemote: Boolean(values["allow-remote"]) });
        io.err(`haelo ${VERSION}: serving ${running.url} (rung: ${core.status().rung}, broker: ${core.adapter.id})\nBearer token: see ${t.source}\n`);
        await new Promise<void>((res) => {
          const stop = (): void => {
            void running.close().finally(() => core.close().finally(res));
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        return 0;
      }
      case "quote": {
        const { values, positionals } = parseArgs({ args: rest, options: common, allowPositionals: true });
        const pair = positionals[0];
        if (!pair) throw new Error("Usage: haelo quote <pair>, for example haelo quote SOL/USDC");
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env });
        try {
          await core.adapter.connect();
          const q = await core.adapter.quote(pair);
          if (values.json) io.out(JSON.stringify(q, null, 2) + "\n");
          else io.out(`${q.symbol}  bid ${q.bid}  ask ${q.ask}  mid ${q.mid}  (Jupiter, ${q.ts})\n`);
        } finally {
          await core.close();
        }
        return 0;
      }
      case "status": {
        const { values } = parseArgs({ args: rest, options: common, allowPositionals: false });
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env, offline: true });
        const s = core.status();
        if (values.json) io.out(JSON.stringify(s, null, 2) + "\n");
        else {
          io.out(
            [
              `rung         ${s.rung} (since ${s.since})`,
              `next rung    ${s.nextRung ?? "none (top)"}`,
              `ladder       ${s.availableRungs.join(" > ")}`,
              `at this rung ${s.stats.decisions} decisions, ${s.stats.accepted} accepted, ${s.stats.invalid} invalid, ${s.stats.breaches} breaches, ${s.stats.injectionFollows} injection follow-throughs, max drawdown ${s.stats.drawdownPct}%`,
              `today        $${s.capsToday.remainingDailyUsd} of $${s.capsToday.maxDailyUsd} left, ${s.capsToday.ordersRemaining} orders left, max $${s.capsToday.maxOrderUsd}/order`,
              `proposals    ${s.pendingProposals} pending`,
              s.frozenUntil ? `promotion    frozen until ${s.frozenUntil} (${s.frozenReason ?? ""})` : "promotion    not frozen",
              s.toolDrift ? `TOOL DRIFT   orders frozen: +${s.toolDrift.added.length} -${s.toolDrift.removed.length} ~${s.toolDrift.changed.length}. Review, then \`haelo pin approve\`.` : `tools        ${s.toolsPinned ? "pinned" : "not pinned (static adapter or first run)"}`,
              `audit head   ${s.auditHead}`,
            ].join("\n") + "\n",
          );
        }
        return 0;
      }
      case "report": {
        const { values } = parseArgs({ args: rest, options: common, allowPositionals: false });
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env });
        const promo = await core.promotionReport();
        const shadow = await core.shadowReport().catch((e) => ({ error: errorMessage(e) }));
        io.out(JSON.stringify({ shadow, promotion: promo }, null, 2) + "\n");
        return 0;
      }
      case "promote": {
        const { values } = parseArgs({ args: rest, options: common, allowPositionals: false });
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env });
        const r = await core.promote({ force: Boolean(values.force) });
        for (const c of r.checks) io.out(`  [${c.ok ? "ok" : "NO"}] ${c.name}: ${c.detail}\n`);
        if (r.promoted) io.out(`Promoted ${r.from} -> ${r.to}.\n`);
        else {
          io.err(r.to ? `Not eligible to leave ${r.from}. Fix the failing checks or use --force (recorded in the audit log).\n` : "Already at the top rung.\n");
          return 1;
        }
        return 0;
      }
      case "demote": {
        const { values } = parseArgs({ args: rest, options: common, allowPositionals: false });
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env });
        const m = await core.demote("manual", "demoted by human", "human");
        io.out(m ? `Demoted ${m.from} -> ${m.to}.\n` : "Already at the lowest rung.\n");
        return 0;
      }
      case "panic": {
        const { values } = parseArgs({ args: rest, options: common, allowPositionals: false });
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env });
        const m = await core.panic();
        io.out(m ? `PANIC: ${m.from} -> ${m.to}. Swaps settle at once, so there are no open orders to cancel.\n` : "Already at shadow.\n");
        return 0;
      }
      case "proposals": {
        const { values } = parseArgs({ args: rest, options: common, allowPositionals: false });
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env, offline: true });
        const ps = core.listProposals();
        if (values.json) io.out(JSON.stringify(ps, null, 2) + "\n");
        else if (ps.length === 0) io.out("No proposals.\n");
        else for (const p of ps) io.out(`${p.id}  ${p.status.padEnd(9)} ${String((p.intent as Record<string, unknown>)["side"])} ${String((p.intent as Record<string, unknown>)["symbol"])} ~$${p.notionalUsd.toFixed(2)}  expires ${p.expiresAt}\n`);
        return 0;
      }
      case "approve":
      case "decline": {
        const { values, positionals } = parseArgs({ args: rest, options: common, allowPositionals: true });
        const id = positionals[0];
        if (!id) throw new Error(`Usage: haelo ${cmd} <proposal-id>`);
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env, offline: cmd === "decline" });
        const p = core.getProposal(id);
        if (!p) throw new Error(`No proposal ${id}.`);
        if (cmd === "decline") {
          await core.declineProposal(id);
          io.out(`Declined ${id}.\n`);
          return 0;
        }
        io.out(card(p) + "\n");
        if (!values.yes) {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          const ans = await rl.question(`Type the proposal id (${id}) to approve and send this order LIVE: `);
          rl.close();
          if (ans.trim() !== id) {
            io.err("Not approved.\n");
            return 1;
          }
        }
        const out = await core.approveProposal(id);
        io.out(out.status === "executed" ? `Executed. Result: ${JSON.stringify(out.result)}\n` : `Not executed: ${out.error ?? out.status}\n`);
        return out.status === "executed" ? 0 : 1;
      }
      case "pin": {
        const sub = rest[0];
        const { values } = parseArgs({ args: rest.slice(1), options: common, allowPositionals: false });
        const core = await createHaelo(loadOrThrow(values, io), { env: io.env, offline: sub === "status" });
        if (sub === "approve") {
          await core.adapter.connect();
          const r = await core.approvePin();
          io.out(`Pinned ${r.tools} tools (${r.hash.slice(0, 12)}...). Orders are unfrozen. The rung is unchanged: promote again when you are ready.\n`);
          return 0;
        }
        if (sub === "status") {
          const s = core.status();
          io.out(s.toolDrift ? `DRIFT detected ${s.toolDrift.detectedAt}\n  added:   ${s.toolDrift.added.join(", ") || "-"}\n  removed: ${s.toolDrift.removed.join(", ") || "-"}\n  changed: ${s.toolDrift.changed.join(", ") || "-"}\n` : s.toolsPinned ? "Tools pinned, no drift.\n" : "Tools not pinned.\n");
          return s.toolDrift ? 1 : 0;
        }
        throw new Error("Usage: haelo pin status|approve");
      }
      case "audit": {
        const sub = rest[0];
        const { values } = parseArgs({ args: rest.slice(1), options: { ...common, n: { type: "string", short: "n" }, out: { type: "string" }, file: { type: "string" } }, allowPositionals: false });
        if (sub === "verify" && values.file) {
          // Verify an exported JSONL chain without a config.
          const r = verifyFile(resolve(io.cwd, values.file));
          if (r.ok) io.out(`Audit chain OK: ${r.entries} entries, head ${r.headHash}\n`);
          else io.err(`Audit chain BROKEN at entry ${r.brokenAt}: ${r.reason}\n`);
          return r.ok ? 0 : 1;
        }
        const l = loadOrThrow(values, io);
        const st = openStorage(l.config.storage.backend, l.stateDir, () => initialState(l.config, new Date()));
        try {
          if (sub === "verify") {
            const r = st.audit.verify();
            if (r.ok) io.out(`Audit chain OK: ${r.entries} entries, head ${r.headHash}\n`);
            else io.err(`Audit chain BROKEN at entry ${r.brokenAt}: ${r.reason}\n`);
            return r.ok ? 0 : 1;
          }
          if (sub === "tail") {
            const n = Number(values.n ?? 20);
            for (const e of st.audit.entries().slice(-n)) io.out(`#${e.seq} ${e.ts} ${e.type} ${JSON.stringify(e.data).slice(0, 200)}\n`);
            return 0;
          }
          if (sub === "export") {
            const target = resolve(io.cwd, values.out ?? "audit-export.jsonl");
            const all = st.audit.entries();
            writeFileSync(target, all.map((e) => JSON.stringify(e)).join("\n") + (all.length ? "\n" : ""), { mode: 0o600 });
            io.out(`Exported ${all.length} entries to ${target}. Check it anywhere with: haelo audit verify --file ${target}\n`);
            return 0;
          }
        } finally {
          st.close();
        }
        throw new Error("Usage: haelo audit verify [--file f.jsonl] | tail [-n 20] | export [--out f.jsonl]");
      }
      case "doctor": {
        const { values } = parseArgs({ args: rest, options: { ...common, live: { type: "boolean" } }, allowPositionals: false });
        const l = loadOrThrow(values, io);
        const checks = await runDoctor(l, { env: io.env, live: Boolean(values.live) });
        if (values.json) io.out(JSON.stringify(checks, null, 2) + "\n");
        else io.out(formatDoctor(checks));
        return checks.some((c) => c.level === "fail") ? 1 : 0;
      }
      case "approvals-ui": {
        const { values } = parseArgs({ args: rest, options: { ...common, port: { type: "string" } }, allowPositionals: false });
        const l = loadOrThrow(values, io);
        const core = await createHaelo(l, { env: io.env });
        await core.init();
        const t = readOrCreateToken(l, io.env);
        const ui = await startApprovalsUi(core, { host: l.config.approvals.web.host, port: values.port !== undefined ? Number(values.port) : l.config.approvals.web.port, token: t.token });
        io.err(`haelo approvals UI at ${ui.url}\nOpen this once to sign in (keep it private, it contains the token):\n  ${ui.loginUrl}\n`);
        await new Promise<void>((res) => {
          const stop = (): void => {
            void ui.close().finally(() => core.close().finally(res));
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        return 0;
      }
      case "key": {
        const sub = rest[0];
        const { values } = parseArgs({ args: rest.slice(1), options: { ...common, file: { type: "string" }, stdin: { type: "boolean" } }, allowPositionals: false });
        const l = loadOrThrow(values, io);
        mkdirSync(l.stateDir, { recursive: true, mode: 0o700 });
        const store = openSecretStore(l.config.secrets.store, l.stateDir);
        if (sub === "import") {
          let raw: string;
          if (values.file) raw = readKeypairFile(resolve(io.cwd, values.file), values.file);
          else if (values.stdin) raw = await readStdin();
          else throw new Error("Usage: haelo key import --file <id.json> | --stdin");
          const kp = parseSecretKey(raw);
          store.set(KEYCHAIN_ENTRY, bs58.encode(kp.secretKey));
          io.out(`Stored the key for ${kp.publicKey.toBase58()} in the ${store.kind === "keychain" ? "OS keychain" : "Haelo state directory (0600 file; no OS keychain available)"}.\nFund this wallet with a little SOL for fees and some USDC, then run: haelo doctor --live\n`);
          return 0;
        }
        if (sub === "show") {
          const b = l.config.broker;
          const signer = await loadSigner(io.env, { privateKeyEnv: b.privateKeyEnv, keypairFileEnv: b.keypairFileEnv }, store);
          if (!signer) {
            io.out("No signing key loaded. Quotes, shadow and paper work without one.\n");
            return 1;
          }
          io.out(`${signer.address}  (from ${signer.source === "keychain" ? `the ${store.kind}` : signer.source === "env" ? b.privateKeyEnv : b.keypairFileEnv})\n`);
          return 0;
        }
        if (sub === "forget") {
          store.delete(KEYCHAIN_ENTRY);
          io.out(`Removed the stored key from the ${store.kind}. Keys set through the environment are not touched.\n`);
          return 0;
        }
        throw new Error("Usage: haelo key import --file <id.json> | --stdin | show | forget");
      }
      default:
        io.err(`Unknown command "${cmd}".\n\n${HELP}`);
        return 64;
    }
  } catch (e) {
    io.err(`error: ${errorMessage(e)}\n`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export { expandHome, sha256 };
