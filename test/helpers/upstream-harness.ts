import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLeash } from "../../src/factory.js";
import type { LeashCore } from "../../src/core.js";
import { parseConfig } from "../../src/policy/load.js";
import { newMockUpstreamState, startMockUpstream, type MockUpstreamState, type RunningMockUpstream } from "../../src/testkit/mock-upstream.js";
import { Clock } from "./harness.js";

export interface UpstreamHarness {
  core: LeashCore;
  upstream: RunningMockUpstream;
  state: MockUpstreamState;
  dir: string;
  clock: Clock;
  cleanup(): Promise<void>;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && av && typeof av === "object" && !Array.isArray(av) ? deepMerge(av as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

/** A LeashCore proxying the local mock upstream MCP server over real Streamable HTTP. */
export async function upstreamHarness(overrides: Record<string, unknown> = {}): Promise<UpstreamHarness> {
  const dir = mkdtempSync(join(tmpdir(), "leash-up-"));
  const clock = new Clock();
  const state = newMockUpstreamState();
  const upstream = await startMockUpstream({ state });
  const raw = JSON.stringify(
    deepMerge(
      {
        version: 1,
        stateDir: dir,
        live: { enabled: true },
        broker: { type: "mcp-upstream", url: upstream.url, quoteTools: { equity: "get_equity_quotes" }, accountTool: "get_portfolio", positionsTool: "get_equity_positions", ordersTool: "get_equity_orders" },
        agent: { accountId: "MOCK-AGENT-1" },
        ladder: { criteria: { shadow: { minDays: 1, minDecisions: 1 }, propose: { minDays: 1, minDecisions: 1 }, micro: { minDays: 1, minDecisions: 1 } } },
        household: { enabled: false },
      },
      overrides,
    ),
  );
  const config = parseConfig(raw);
  const core = createLeash({ config, hash: "test", path: join(dir, "leash.yaml"), stateDir: dir }, { now: clock.now, env: {} });
  await core.init();
  return {
    core,
    upstream,
    state,
    dir,
    clock,
    async cleanup() {
      await core.close();
      await upstream.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
