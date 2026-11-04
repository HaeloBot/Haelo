import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialState } from "../src/ladder.js";
import { parseConfig } from "../src/policy/load.js";
import { StateStore } from "../src/state.js";

describe("StateStore", () => {
  const config = parseConfig(JSON.stringify({ version: 1, broker: { type: "alpaca" } }));
  const mk = () => new StateStore(mkdtempSync(join(tmpdir(), "haelo-state-")), () => initialState(config, new Date("2026-11-04T00:00:00Z")));

  it("persists updates and re-reads them from disk", async () => {
    const a = mk();
    await a.update((s) => {
      s.ladder.stats.decisions = 7;
    });
    const b = new StateStore(a.dir, () => initialState(config, new Date()));
    expect(b.load().ladder.stats.decisions).toBe(7);
  });

  it("does not lose concurrent read-modify-write updates, even across instances", async () => {
    const a = mk();
    const b = new StateStore(a.dir, () => initialState(config, new Date()));
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).update((s) => {
        s.usage.ordersToday++;
      })),
    );
    expect(a.load().usage.ordersToday).toBe(40);
  });
});
