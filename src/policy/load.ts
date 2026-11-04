import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse } from "yaml";
import { configSchema, type HaeloConfig } from "./schema.js";
import { sha256 } from "../util.js";

export interface LoadedConfig {
  config: HaeloConfig;
  /** SHA-256 of the raw policy file, used by `haelo policy lock`. */
  hash: string;
  path: string;
  stateDir: string;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export function parseConfig(text: string): HaeloConfig {
  const raw: unknown = parse(text);
  const res = configSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid haelo config:\n${issues}`);
  }
  const cfg = res.data;
  if (cfg.broker.type === "mcp-upstream" && !cfg.broker.url && !cfg.broker.command) {
    throw new Error("Invalid haelo config:\n  - broker: mcp-upstream needs either `url` or `command`");
  }
  if (cfg.broker.type === "mcp-upstream" && cfg.broker.url && cfg.broker.command) {
    throw new Error("Invalid haelo config:\n  - broker: set only one of `url` or `command`");
  }
  if ((cfg.ladder.start === "micro" || cfg.ladder.start === "standard") && !cfg.live.enabled) {
    throw new Error(`Invalid haelo config:\n  - ladder.start: ${cfg.ladder.start} is a live rung; set live.enabled: true to opt in to live trading`);
  }
  if (cfg.ladder.autoPromote.enabled && (cfg.ladder.autoPromote.maxRung === "micro" || cfg.ladder.autoPromote.maxRung === "standard") && !cfg.live.enabled) {
    throw new Error("Invalid haelo config:\n  - ladder.autoPromote.maxRung: a live rung needs live.enabled: true");
  }
  return cfg;
}

export function loadConfig(path: string): LoadedConfig {
  const abs = resolve(path);
  const text = readFileSync(abs, "utf8");
  const config = parseConfig(text);
  return { config, hash: sha256(text), path: abs, stateDir: expandHome(config.stateDir) };
}
