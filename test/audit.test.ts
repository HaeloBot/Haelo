import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, GENESIS_HASH, verifyFile } from "../src/audit.js";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "leash-audit-")), "audit.jsonl");
}

describe("hash-chained audit log", () => {
  it("chains entries from a genesis hash and verifies", () => {
    const p = tmp();
    const log = new AuditLog(p);
    const a = log.append("a", { x: 1 });
    const b = log.append("b", { y: 2 });
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    const v = verifyFile(p);
    expect(v).toMatchObject({ ok: true, entries: 2, headHash: b.hash });
  });

  it("detects an edited entry", () => {
    const p = tmp();
    const log = new AuditLog(p);
    log.append("order", { usd: 10 });
    log.append("order", { usd: 20 });
    writeFileSync(p, readFileSync(p, "utf8").replace('"usd":10', '"usd":1'));
    const v = verifyFile(p);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it("detects a deleted entry", () => {
    const p = tmp();
    const log = new AuditLog(p);
    for (let i = 0; i < 4; i++) log.append("e", { i });
    const lines = readFileSync(p, "utf8").trim().split("\n");
    writeFileSync(p, [lines[0], lines[2], lines[3]].join("\n") + "\n");
    const v = verifyFile(p);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/gap/);
  });

  it("detects reordered entries and garbage lines", () => {
    const p = tmp();
    const log = new AuditLog(p);
    for (let i = 0; i < 3; i++) log.append("e", { i });
    const lines = readFileSync(p, "utf8").trim().split("\n");
    writeFileSync(p, [lines[1], lines[0], lines[2]].join("\n") + "\n");
    expect(verifyFile(p).ok).toBe(false);
    writeFileSync(p, lines.join("\n") + "\nnot json\n");
    expect(verifyFile(p).ok).toBe(false);
  });

  it("resumes the chain across instances (gateway and CLI share one log)", () => {
    const p = tmp();
    const one = new AuditLog(p);
    one.append("a");
    const two = new AuditLog(p);
    two.append("b");
    one.append("c");
    const v = verifyFile(p);
    expect(v).toMatchObject({ ok: true, entries: 3 });
  });

  it("redacts secret-looking fields", () => {
    const p = tmp();
    const log = new AuditLog(p);
    log.append("call", { apiKey: "sk-live-123", nested: { Authorization: "Bearer abc", ok: "fine" }, secret_token: "x" });
    const text = readFileSync(p, "utf8");
    expect(text).not.toContain("sk-live-123");
    expect(text).not.toContain("Bearer abc");
    expect(text).toContain("fine");
  });

  it("an empty log verifies", () => {
    expect(verifyFile(tmp()).ok).toBe(true);
  });
});
