import { appendFileSync, existsSync, mkdirSync, readFileSync, chmodSync, closeSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, redact, sha256 } from "./util.js";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** Sequence number of the first entry that failed, if any. */
  brokenAt?: number;
  reason?: string;
  headHash: string;
}

/** Anything that stores the hash-chained audit trail (JSONL file or SQLite). */
export interface AuditSink {
  /** Human-readable location, for messages. */
  readonly location: string;
  append(type: string, data?: Record<string, unknown>): AuditEntry;
  entries(): AuditEntry[];
  verify(): VerifyResult;
}

export function entryHash(e: Omit<AuditEntry, "hash">): string {
  return sha256(canonicalJson(e));
}

/**
 * Append-only, hash-chained JSON Lines log. Each entry commits to the previous one, so editing,
 * deleting or reordering any line is detected by `verify`. This is tamper-EVIDENT, not tamper-proof:
 * someone who can rewrite the whole file can also recompute the chain. Anchor the head hash elsewhere
 * (for example in the policy lock or an external log) if you need stronger guarantees.
 */
export class AuditLog implements AuditSink {
  private seq = 0;
  private prev = GENESIS_HASH;
  readonly location: string;

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.location = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      closeSync(openSync(path, "a", 0o600));
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
    this.resume();
  }

  private resume(): void {
    const last = readEntries(this.path).at(-1);
    if (last) {
      this.seq = last.seq;
      this.prev = last.hash;
    }
  }

  append(type: string, data: Record<string, unknown> = {}): AuditEntry {
    // Re-read the tail so several processes (gateway + CLI) share one chain.
    this.resume();
    const base: Omit<AuditEntry, "hash"> = {
      seq: this.seq + 1,
      ts: this.now().toISOString(),
      type,
      data: redact(data) as Record<string, unknown>,
      prevHash: this.prev,
    };
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    appendFileSync(this.path, JSON.stringify(entry) + "\n", { flag: "a", mode: 0o600 });
    this.seq = entry.seq;
    this.prev = entry.hash;
    return entry;
  }

  entries(): AuditEntry[] {
    return readEntries(this.path);
  }

  verify(): VerifyResult {
    return verifyFile(this.path);
  }
}

export function readEntries(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      out.push({ seq: -1, ts: "", type: "__corrupt__", data: { line }, prevHash: "", hash: "" });
    }
  }
  return out;
}

export function verifyFile(path: string): VerifyResult {
  return verifyEntries(readEntries(path));
}

/** Check sequence numbers, the prevHash links and every entry's own hash. */
export function verifyEntries(entries: AuditEntry[]): VerifyResult {
  let prev = GENESIS_HASH;
  let seq = 0;
  for (const e of entries) {
    if (e.type === "__corrupt__") return { ok: false, entries: entries.length, brokenAt: seq + 1, reason: "unparseable line", headHash: prev };
    if (e.seq !== seq + 1) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: `sequence gap (expected ${seq + 1})`, headHash: prev };
    if (e.prevHash !== prev) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: "prevHash does not match previous entry", headHash: prev };
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: "entry content does not match its hash", headHash: prev };
    prev = hash;
    seq = e.seq;
  }
  return { ok: true, entries: entries.length, headHash: prev };
}

/** Build the next entry in a chain. Shared by the JSONL and SQLite sinks so their hashes are identical. */
export function nextEntry(prev: { seq: number; hash: string } | undefined, ts: string, type: string, data: Record<string, unknown>): AuditEntry {
  const base: Omit<AuditEntry, "hash"> = { seq: (prev?.seq ?? 0) + 1, ts, type, data: redact(data) as Record<string, unknown>, prevHash: prev?.hash ?? GENESIS_HASH };
  return { ...base, hash: entryHash(base) };
}
