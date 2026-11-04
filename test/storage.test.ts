import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, verifyFile } from "../src/audit.js";
import { initialState } from "../src/ladder.js";
import { parseConfig } from "../src/policy/load.js";
import { StateStore } from "../src/state.js";
import { openStorage } from "../src/storage/index.js";
import { SqliteAuditLog, openDatabase } from "../src/storage/sqlite.js";

const config = parseConfig(JSON.stringify({ version: 1, broker: { type: "alpaca" } }));
const init = () => initialState(config, new Date("2026-11-04T00:00:00Z"));
const dir = (): string => mkdtempSync(join(tmpdir(), "haelo-db-"));

describe("SQLite storage", () => {
  it("creates haelo.db with mode 600 and round-trips state", async () => {
    const d = dir();
    const s = openStorage("sqlite", d, init);
    await s.store.update((x) => {
      x.ladder.stats.decisions = 3;
    });
    s.close();
    expect(statMode(join(d, "haelo.db"))).toBe(0o600);
    const again = openStorage("sqlite", d, init);
    expect(again.store.load().ladder.stats.decisions).toBe(3);
    again.close();
  });

  it("serialises concurrent updates from two connections (gateway + CLI)", async () => {
    const d = dir();
    const a = openStorage("sqlite", d, init);
    const b = openStorage("sqlite", d, init);
    await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).store.update((x) => void x.usage.ordersToday++)));
    expect(a.store.load().usage.ordersToday).toBe(40);
    a.close();
    b.close();
  });

  it("rolls back a failed update", async () => {
    const s = openStorage("sqlite", dir(), init);
    await expect(
      s.store.update((x) => {
        x.ladder.stats.decisions = 99;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(s.store.load().ladder.stats.decisions).toBe(0);
    s.close();
  });

  it("audit chain in SQLite has the same hashes as JSONL, so an export verifies", () => {
    const d = dir();
    const s = openStorage("sqlite", d, init, () => new Date("2026-11-04T00:00:00Z"));
    s.audit.append("a", { x: 1, apiKey: "secret" });
    s.audit.append("b");
    const j = new AuditLog(join(dir(), "audit.jsonl"), () => new Date("2026-11-04T00:00:00Z"));
    const ja = j.append("a", { x: 1, apiKey: "secret" });
    j.append("b");
    expect(s.audit.entries()[0]?.hash).toBe(ja.hash);
    expect(JSON.stringify(s.audit.entries())).not.toContain("secret\"");
    const out = join(d, "export.jsonl");
    expect((s.audit as SqliteAuditLog).exportJsonl(out)).toBe(2);
    expect(verifyFile(out)).toMatchObject({ ok: true, entries: 2 });
    expect(s.audit.verify().ok).toBe(true);
    s.close();
  });

  it("an empty SQLite chain exports an empty file", () => {
    const d = dir();
    const db = openDatabase(join(d, "x.db"));
    const log = new SqliteAuditLog(db, join(d, "x.db"));
    expect(log.exportJsonl(join(d, "e.jsonl"))).toBe(0);
    expect(readFileSync(join(d, "e.jsonl"), "utf8")).toBe("");
    db.close();
  });

  it("imports an existing JSONL chain and state.json once when switching to SQLite", async () => {
    const d = dir();
    const legacy = new AuditLog(join(d, "audit.jsonl"));
    legacy.append("old1");
    legacy.append("old2");
    const st = new StateStore(d, init);
    await st.update((x) => void (x.ladder.stats.decisions = 7));
    const s = openStorage("sqlite", d, init);
    expect(s.audit.entries().map((e) => e.type)).toEqual(["old1", "old2"]);
    expect(s.store.load().ladder.stats.decisions).toBe(7);
    s.audit.append("new");
    expect(s.audit.verify()).toMatchObject({ ok: true, entries: 3 });
    s.close();
    const s2 = openStorage("sqlite", d, init);
    expect(s2.audit.entries()).toHaveLength(3); // not imported twice
    s2.close();
  });

  it("jsonl backend still works and writes the classic files", async () => {
    const d = dir();
    const s = openStorage("jsonl", d, init);
    s.audit.append("x");
    await s.store.update((x) => void (x.usage.ordersToday = 1));
    s.close();
    expect(existsSync(join(d, "audit.jsonl"))).toBe(true);
    expect(existsSync(join(d, "state.json"))).toBe(true);
  });
});

function statMode(f: string): number {
  return statSync(f).mode & 0o777;
}
