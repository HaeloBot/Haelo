import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "./adapters/types.js";
import { rpcUrl } from "./factory.js";
import { initialState } from "./ladder.js";
import type { LoadedConfig } from "./policy/load.js";
import { openSecretStore, type SecretStore } from "./secrets.js";
import { DEFAULT_TOKENS, SOLANA_MAINNET, USDC_MINT, WSOL_MINT, fromUnits } from "./solana/constants.js";
import { JupiterClient } from "./solana/jupiter.js";
import { SolanaRpc } from "./solana/rpc.js";
import { loadSigner, walletAddress } from "./solana/signer.js";
import { openStorage } from "./storage/index.js";
import { errorMessage } from "./util.js";

export type DoctorLevel = "pass" | "warn" | "fail" | "skip";
export interface DoctorCheck {
  area: string;
  name: string;
  level: DoctorLevel;
  detail: string;
}

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  /** Also check what going live needs (live credentials, live.enabled, policy lock). */
  live?: boolean;
  fetch?: FetchFn;
  /** Expected genesis hash (tests run against a local fake cluster). */
  genesisHash?: string;
}

/**
 * Read-only preflight. Doctor reads the RPC and asks Jupiter for a quote. It never signs, sends or
 * simulates a swap, and never prints a secret.
 */
export async function runDoctor(l: LoadedConfig, opts: DoctorOptions): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (area: string, name: string, level: DoctorLevel, detail: string): void => {
    out.push({ area, name, level, detail });
  };
  const env = opts.env;
  const cfg = l.config;

  // ---- local
  const major = Number(process.versions.node.split(".")[0]);
  add("local", "node", major >= 22 ? "pass" : "fail", `Node ${process.versions.node}${major >= 22 ? "" : " (need >= 22.13 for node:sqlite)"}`);
  add("local", "config", "pass", `${l.path} is valid`);
  const lockF = join(l.stateDir, "policy.lock");
  if (existsSync(lockF)) {
    const locked = (JSON.parse(readFileSync(lockF, "utf8")) as { hash: string }).hash;
    add("local", "policy lock", locked === l.hash ? "pass" : "fail", locked === l.hash ? "policy matches the lock" : "policy changed since it was locked: review, then `haelo policy lock`");
  } else add("local", "policy lock", opts.live ? "fail" : "warn", "policy is not locked (`haelo policy lock`)");
  if (existsSync(l.stateDir)) {
    const mode = statSync(l.stateDir).mode & 0o777;
    add("local", "state dir permissions", mode & 0o077 ? "warn" : "pass", `${l.stateDir} is ${mode.toString(8)}${mode & 0o077 ? " (should be 700: chmod 700)" : ""}`);
  }
  try {
    const st = openStorage(cfg.storage.backend, l.stateDir, () => initialState(cfg, new Date()));
    try {
      const v = st.audit.verify();
      add("local", "audit chain", v.ok ? "pass" : "fail", v.ok ? `${v.entries} entries, chain intact (${cfg.storage.backend})` : `BROKEN at ${v.brokenAt}: ${v.reason}`);
      const s = st.store.load();
      add("local", "ladder", "pass", `rung ${s.ladder.rung}${s.drift ? ", TOOL DRIFT unresolved" : ""}`);
    } finally {
      st.close();
    }
  } catch (e) {
    add("local", "storage", "fail", errorMessage(e));
  }
  const tokFile = join(l.stateDir, "http-token");
  if (env["HAELO_HTTP_TOKEN"]) add("local", "http token", env["HAELO_HTTP_TOKEN"].length >= 16 ? "pass" : "fail", "from HAELO_HTTP_TOKEN");
  else if (existsSync(tokFile)) add("local", "http token", (statSync(tokFile).mode & 0o077) === 0 ? "pass" : "warn", `${tokFile} (mode ${(statSync(tokFile).mode & 0o777).toString(8)})`);
  else add("local", "http token", "warn", "none yet (created on first `serve --http`)");
  let store: SecretStore | undefined;
  try {
    store = openSecretStore(cfg.secrets.store, l.stateDir);
    add("local", "secret store", store.kind === "keychain" ? "pass" : "warn", store.kind === "keychain" ? "OS keychain available" : "using 0600 files (no OS keychain); see SECURITY.md");
  } catch (e) {
    add("local", "secret store", "fail", errorMessage(e));
  }

  // ---- solana
  const b = cfg.broker;
  const rpc = new SolanaRpc(rpcUrl(cfg, env), opts.fetch);
  const rpcLabel = env[b.rpcUrlEnv] ? `${b.rpcUrlEnv} (hidden)` : b.rpcUrl;
  let rpcOk = false;
  try {
    const genesis = await rpc.getGenesisHash();
    const want = opts.genesisHash ?? SOLANA_MAINNET.genesisHash;
    rpcOk = genesis === want;
    add("solana", "rpc", rpcOk ? "pass" : "fail", rpcOk ? `${rpcLabel} is mainnet-beta` : `${rpcLabel} is not mainnet-beta (genesis ${genesis})`);
    if (rpcOk && !env[b.rpcUrlEnv]) add("solana", "rpc tier", "warn", "public RPC is rate limited; set a private RPC URL in " + b.rpcUrlEnv + " before going live");
  } catch (e) {
    add("solana", "rpc", "fail", `${rpcLabel}: ${errorMessage(e)}`);
  }
  if (rpcOk) {
    for (const t of [...DEFAULT_TOKENS.map((x) => [x.symbol, x.mint] as const), ...Object.entries(b.tokens)]) {
      try {
        const m = await rpc.getMint(t[1]);
        add("solana", `mint ${t[0]}`, "pass", `${m.decimals} decimals`);
      } catch (e) {
        add("solana", `mint ${t[0]}`, "fail", errorMessage(e));
      }
    }
  }
  const apiKey = env[b.jupiterApiKeyEnv]?.trim();
  try {
    const jup = new JupiterClient({ baseUrl: b.jupiterBaseUrl, ...(apiKey ? { apiKey } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    const q = await jup.order({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 10_000_000n });
    add("jupiter", "quote", "pass", `0.01 SOL -> ${fromUnits(q.outAmount, 6)} USDC${q.router ? ` via ${q.router}` : ""}${apiKey ? "" : " (keyless tier)"}`);
  } catch (e) {
    add("jupiter", "quote", "fail", errorMessage(e));
  }

  let address: string | undefined;
  try {
    const signer = await loadSigner(env, { privateKeyEnv: b.privateKeyEnv, keypairFileEnv: b.keypairFileEnv }, store);
    address = walletAddress(signer, env, b.addressEnv);
    if (signer) add("wallet", "signing key", "pass", `${signer.address} (from ${signer.source})`);
    else add("wallet", "signing key", opts.live ? "fail" : "skip", "none loaded; quotes, shadow and paper work without one (`haelo key import`)");
    if (!signer && address) add("wallet", "watch address", "pass", address);
  } catch (e) {
    add("wallet", "signing key", "fail", errorMessage(e));
  }
  if (address && rpcOk) {
    try {
      const lamports = await rpc.getBalance(address);
      const sol = fromUnits(lamports, 9);
      const need = b.reserveSol + b.maxFeeSol;
      add("wallet", "SOL for fees", sol >= need ? "pass" : opts.live ? "fail" : "warn", `${sol} SOL${sol >= need ? "" : ` (keep at least ${need} SOL for fees)`}`);
      const balances = await rpc.getTokenBalances(address);
      add("wallet", "USDC", "pass", `${fromUnits(balances.get(USDC_MINT) ?? 0n, 6)} USDC`);
    } catch (e) {
      add("wallet", "balances", "fail", errorMessage(e));
    }
    if (cfg.agent.accountId && cfg.agent.accountId !== address) add("wallet", "account wall", "fail", `agent.accountId ${cfg.agent.accountId} is not this wallet`);
  }

  // ---- go-live readiness
  if (opts.live) {
    add("live", "live.enabled", cfg.live.enabled ? "pass" : "fail", cfg.live.enabled ? "live trading opted in" : "set live: { enabled: true } in haelo.yaml, then `haelo policy lock`");
    add("live", "agent.accountId", cfg.agent.accountId ? "pass" : "warn", cfg.agent.accountId ? `account wall: ${cfg.agent.accountId}` : "no account wall set; set agent.accountId to the dedicated agent wallet");
    add("live", "micro caps", cfg.rungs.micro.maxOrderUsd !== undefined && cfg.rungs.micro.maxOrderUsd <= 100 ? "pass" : "warn", `micro maxOrderUsd ${cfg.rungs.micro.maxOrderUsd ?? cfg.rails.maxOrderUsd}`);
    add("live", "auto-promotion", cfg.ladder.autoPromote.enabled && ["micro", "standard"].includes(cfg.ladder.autoPromote.maxRung) ? "warn" : "pass", cfg.ladder.autoPromote.enabled ? `auto-promote up to ${cfg.ladder.autoPromote.maxRung}` : "humans promote");
    add("live", "dedicated wallet", "warn", "use a fresh wallet that holds only what the agent may trade; never your main wallet");
  }
  return out;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const icon: Record<DoctorLevel, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };
  const lines = checks.map((c) => `${icon[c.level]}  ${c.area.padEnd(16)} ${c.name.padEnd(22)} ${c.detail}`);
  const n = (lv: DoctorLevel): number => checks.filter((c) => c.level === lv).length;
  lines.push("", `${n("pass")} passed, ${n("warn")} warnings, ${n("fail")} failed`);
  return lines.join("\n") + "\n";
}
