import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlpacaBroker } from "../../src/adapters/alpaca.js";
import { RestAdapter } from "../../src/adapters/rest-base.js";
import { AuditLog } from "../../src/audit.js";
import { HaeloCore } from "../../src/core.js";
import { parseConfig } from "../../src/policy/load.js";
import type { HaeloConfig } from "../../src/policy/schema.js";
import { StateStore } from "../../src/state.js";
import { MOCK_ALPACA_CREDS, newMockAlpacaState, startMockAlpaca, type RunningMockAlpaca } from "./mock-alpaca.js";
import type { BrokerAdapter } from "../../src/adapters/types.js";

export class Clock {
  constructor(public t = Date.parse("2026-11-04T10:00:00Z")) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
  days(n: number): void {
    this.t += n * 86_400_000;
  }
}

export interface Harness {
  core: HaeloCore;
  dir: string;
  clock: Clock;
  config: HaeloConfig;
  paper?: RunningMockAlpaca;
  live?: RunningMockAlpaca;
  cleanup(): Promise<void>;
}

export function baseYaml(extra = ""): string {
  return `version: 1
broker:
  type: alpaca
${extra}`;
}

/** A HaeloCore wired to local mock Alpaca servers (paper and live) with a controllable clock. */
export async function alpacaHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "haelo-test-"));
  const clock = new Clock();
  const paper = await startMockAlpaca(newMockAlpacaState());
  const live = await startMockAlpaca(newMockAlpacaState());
  const yaml = JSON.stringify(deepMerge({
    version: 1,
    stateDir: dir,
    live: { enabled: true },
    broker: { type: "alpaca" },
    // Short criteria so the ladder can be climbed in a test.
    ladder: {
      criteria: {
        shadow: { minDays: 1, minDecisions: 2 },
        paper: { minDays: 1, minDecisions: 2 },
        propose: { minDays: 1, minDecisions: 1 },
        micro: { minDays: 1, minDecisions: 2 },
      },
    },
    household: { enabled: true, concentration: { maxPct: 60, block: true } },
  }, overrides));
  const config = parseConfig(yaml);
  const adapter: BrokerAdapter = new RestAdapter(
    new AlpacaBroker({
      paper: MOCK_ALPACA_CREDS,
      live: MOCK_ALPACA_CREDS,
      paperBaseUrl: paper.url,
      liveBaseUrl: live.url,
      dataBaseUrl: live.url,
      now: clock.now,
    }),
  );
  const store = new StateStore(dir, HaeloCore.initialStateFactory(config, clock.now));
  const audit = new AuditLog(join(dir, "audit.jsonl"), clock.now);
  const core = new HaeloCore({ config, adapter, store, audit, now: clock.now });
  await core.init();
  return {
    core,
    dir,
    clock,
    config,
    paper,
    live,
    async cleanup() {
      await core.close();
      await paper.close();
      await live.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && av && typeof av === "object" && !Array.isArray(av) ? deepMerge(av as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}
