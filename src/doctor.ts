import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bestQuote, viemReader } from "./chain/executor.js";
import { ROBINHOOD_MAINNET } from "./chain/uniswap.js";
import { loadLocalSigner } from "./chain/signer.js";
import { AlpacaBroker } from "./adapters/alpaca.js";
import { McpUpstreamAdapter } from "./adapters/mcp-upstream.js";
import { RobinhoodCryptoBroker } from "./adapters/robinhood-crypto.js";
import type { FetchFn } from "./adapters/types.js";
import { initialState } from "./ladder.js";
import { SecretOAuthProvider } from "./oauth.js";
import type { LoadedConfig } from "./policy/load.js";
import { openSecretStore } from "./secrets.js";
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
  /** Test hook: base URLs for the Alpaca/Robinhood clients. */
  urls?: { alpacaPaper?: string; alpacaLive?: string; alpacaData?: string; robinhood?: string };
}

/**
 * Read-only preflight. Every network call is a GET (or MCP initialize + tools/list). Doctor never places,
 * cancels or modifies anything, and never prints a secret.
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
  try {
    const ss = openSecretStore(cfg.secrets.store, l.stateDir);
    add("local", "secret store", ss.kind === "keychain" ? "pass" : "warn", ss.kind === "keychain" ? "OS keychain available" : "using 0600 files (no OS keychain); see SECURITY.md");
  } catch (e) {
    add("local", "secret store", "fail", errorMessage(e));
  }

  // ---- broker
  const b = cfg.broker;
  const f = opts.fetch ? { fetch: opts.fetch } : {};
  if (b.type === "alpaca") {
    for (const mode of ["paper", "live"] as const) {
      const id = env[mode === "paper" ? b.paperKeyIdEnv : b.liveKeyIdEnv];
      const secret = env[mode === "paper" ? b.paperSecretEnv : b.liveSecretEnv];
      const area = `alpaca ${mode}`;
      if (!id || !secret) {
        add(area, "credentials", mode === "live" && opts.live ? "fail" : mode === "paper" ? "warn" : "skip", `${mode === "paper" ? b.paperKeyIdEnv : b.liveKeyIdEnv} / ${mode === "paper" ? b.paperSecretEnv : b.liveSecretEnv} not set`);
        continue;
      }
      if (mode === "paper" && !id.startsWith("PK")) add(area, "key type", "warn", "paper key ids usually start with PK; is this a live key?");
      if (mode === "live" && id.startsWith("PK")) add(area, "key type", "fail", "live key id starts with PK, which is a paper key");
      const broker = new AlpacaBroker({
        [mode]: { keyId: id, secret },
        paperBaseUrl: opts.urls?.alpacaPaper ?? b.paperBaseUrl,
        liveBaseUrl: opts.urls?.alpacaLive ?? b.liveBaseUrl,
        dataBaseUrl: opts.urls?.alpacaData ?? b.dataBaseUrl,
        feed: b.feed,
        ...f,
      });
      try {
        const a = await broker.accountStatus(mode);
        const ok = a.status === "ACTIVE" && !a.tradingBlocked && !a.accountBlocked;
        add(area, "account", ok ? "pass" : "fail", `status ${a.status}${a.tradingBlocked ? ", TRADING BLOCKED" : ""}${a.accountBlocked ? ", ACCOUNT BLOCKED" : ""}${a.patternDayTrader ? ", pattern day trader" : ""}`);
        if (mode === "live" && cfg.agent.accountId && a.accountNumber && a.accountNumber !== cfg.agent.accountId) add(area, "account wall", "fail", `agent.accountId ${cfg.agent.accountId} does not match these keys' account`);
      } catch (e) {
        add(area, "account", "fail", errorMessage(e));
        continue;
      }
      try {
        const q = await broker.getQuote("AAPL");
        add(area, "market data", "pass", `AAPL bid ${q.bid} / ask ${q.ask} (${b.feed})`);
      } catch (e) {
        add(area, "market data", "fail", errorMessage(e));
      }
    }
  } else if (b.type === "robinhood-chain") {
    try {
      const local = loadLocalSigner(env, { privateKeyEnv: b.privateKeyEnv, keystoreEnv: b.keystoreEnv });
      add(
        "robinhood chain",
        "signer",
        local ? "pass" : opts.live ? "fail" : "warn",
        local ? `loaded from ${local.kind}, address ${local.account.address}` : `no ${b.privateKeyEnv} or ${b.keystoreEnv}; quotes work, live sends do not`,
      );
    } catch (e) {
      add("robinhood chain", "signer", "fail", errorMessage(e));
    }
    try {
      const reader = viemReader(b.rpcUrl);
      const id = await reader.getChainId();
      add("robinhood chain", "chain id", id === ROBINHOOD_MAINNET.chainId ? "pass" : "fail", `eth_chainId ${id}, expected ${ROBINHOOD_MAINNET.chainId}`);
      const code = await reader.getBytecode(ROBINHOOD_MAINNET.swapRouter02);
      add("robinhood chain", "SwapRouter02", code && code !== "0x" ? "pass" : "fail", ROBINHOOD_MAINNET.swapRouter02);
      const quote = await bestQuote(reader, ROBINHOOD_MAINNET.weth, ROBINHOOD_MAINNET.usdg, 10n ** 15n);
      add("robinhood chain", "on-chain quote", quote.amountOut > 0n ? "pass" : "fail", `0.001 WETH quotes ${quote.amountOut.toString()} USDG base units at fee ${quote.fee}`);
    } catch (e) {
      add("robinhood chain", "rpc", "fail", errorMessage(e));
    }
  } else if (b.type === "robinhood-crypto") {
    const key = env[b.apiKeyEnv];
    const pk = env[b.privateKeyEnv];
    if (!key || !pk) add("robinhood crypto", "credentials", "fail", `${b.apiKeyEnv} / ${b.privateKeyEnv} not set`);
    else {
      try {
        const broker = new RobinhoodCryptoBroker({ apiKey: key, privateKeyBase64: pk, apiVersion: b.apiVersion, baseUrl: opts.urls?.robinhood ?? b.baseUrl, ...f });
        add("robinhood crypto", "private key", "pass", "valid 32-byte Ed25519 seed");
        const a = await broker.getAccount("live");
        add("robinhood crypto", "signed request", "pass", `account ${a.id.slice(0, 4)}..., buying power ${a.buyingPower} ${a.currency ?? "USD"}`);
        const q = await broker.getQuote("BTC-USD");
        add("robinhood crypto", "market data", "pass", `BTC-USD bid ${q.bid} / ask ${q.ask}`);
      } catch (e) {
        add("robinhood crypto", "signed request", "fail", errorMessage(e));
      }
    }
  } else {
    const bearer = b.bearerTokenEnv ? env[b.bearerTokenEnv] : undefined;
    let oauth: SecretOAuthProvider | undefined;
    if (b.url && !bearer) {
      oauth = new SecretOAuthProvider(openSecretStore(cfg.secrets.store, l.stateDir), l.stateDir, b.url, b.oauthPort, () => undefined);
      add("upstream", "oauth tokens", oauth.hasTokens() ? "pass" : "fail", oauth.hasTokens() ? `stored (${oauth.storeKind})` : "not signed in: run `haelo auth`");
    }
    const ad = new McpUpstreamAdapter({
      ...(b.url ? { url: b.url } : {}),
      ...(b.command ? { command: b.command, args: b.args } : {}),
      ...(bearer ? { bearerToken: bearer } : {}),
      ...(oauth ? { oauth } : {}),
      toolOverrides: b.toolOverrides,
    });
    try {
      await ad.connect();
      const tools = await ad.listTools();
      const counts: Record<string, number> = {};
      for (const t of tools) {
        const e = ad.classify(t).effect;
        counts[e] = (counts[e] ?? 0) + 1;
      }
      add("upstream", "connect + tools/list", "pass", `${tools.length} tools: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
      if ((counts["order_place"] ?? 0) === 0) add("upstream", "order tools", "warn", "no tool was classified as an order; check names / toolOverrides");
      if (counts["unknown"]) add("upstream", "unknown tools", "warn", `${counts["unknown"]} tools are unclassified and will be hidden and blocked; add toolOverrides if any are needed`);
      const names = new Set(tools.map((t) => t.name));
      const configured: Array<[string, string | undefined]> = [
        ["quoteTools.equity", b.quoteTools.equity],
        ["quoteTools.crypto", b.quoteTools.crypto],
        ["accountTool", b.accountTool],
        ["positionsTool", b.positionsTool],
        ["ordersTool", b.ordersTool],
        ["taxLotsTool", b.taxLotsTool],
        ["cancelAllTool", b.cancelAllTool],
      ];
      for (const [k, v] of configured) if (v) add("upstream", k, names.has(v) ? "pass" : "fail", names.has(v) ? v : `${v} is not in the upstream tools/list`);
      if (!b.quoteTools.equity && !b.quoteTools.crypto) add("upstream", "quote tool", "warn", "no quoteTools configured; orders sized in shares cannot be priced reliably");
    } catch (e) {
      add("upstream", "connect + tools/list", "fail", errorMessage(e));
    } finally {
      await ad.close();
    }
  }

  // ---- go-live readiness
  if (opts.live) {
    add("live", "live.enabled", cfg.live.enabled ? "pass" : "fail", cfg.live.enabled ? "live trading opted in" : "set live: { enabled: true } in haelo.yaml, then `haelo policy lock`");
    add("live", "agent.accountId", cfg.agent.accountId ? "pass" : "warn", cfg.agent.accountId ? `account wall: ${cfg.agent.accountId}` : "no account wall set; set agent.accountId to the dedicated agent account");
    add("live", "micro caps", cfg.rungs.micro.maxOrderUsd !== undefined && cfg.rungs.micro.maxOrderUsd <= 100 ? "pass" : "warn", `micro maxOrderUsd ${cfg.rungs.micro.maxOrderUsd ?? cfg.rails.maxOrderUsd}`);
    add("live", "auto-promotion", cfg.ladder.autoPromote.enabled && ["micro", "standard"].includes(cfg.ladder.autoPromote.maxRung) ? "warn" : "pass", cfg.ladder.autoPromote.enabled ? `auto-promote up to ${cfg.ladder.autoPromote.maxRung}` : "humans promote");
    if (b.type === "mcp-upstream") add("live", "upstream verification", "warn", "the Robinhood MCP adapter has not been verified against the real service; stay at propose until you have read its audit log");
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
