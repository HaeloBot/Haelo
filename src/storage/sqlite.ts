import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
type DatabaseSyncT = NodeSqlite.DatabaseSync;
import { nextEntry, verifyEntries, type AuditEntry, type AuditSink, type VerifyResult } from "../audit.js";
import type { PersistedState, StateBackend } from "../state.js";
import { sleep } from "../util.js";

const require = createRequire(import.meta.url);

/** Open (or create) the Haelo SQLite database with WAL and a busy timeout so the gateway and CLI can share it. */
export function openDatabase(file: string): DatabaseSyncT {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Loaded lazily so the JSONL backend works on runtimes without node:sqlite.
  const { DatabaseSync } = require("node:sqlite") as typeof NodeSqlite;
  const db = new DatabaseSync(file, { timeout: 10_000 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    -- Append-only at the SQL level too: updates and deletes of audit rows are refused.
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
  `);
  return db;
}

function rowToEntry(r: Record<string, unknown>): AuditEntry {
  return { seq: Number(r["seq"]), ts: String(r["ts"]), type: String(r["type"]), data: JSON.parse(String(r["data"])) as Record<string, unknown>, prevHash: String(r["prev_hash"]), hash: String(r["hash"]) };
}

/**
 * Hash-chained audit log in SQLite. Entries and hashes are byte-compatible with the JSONL log, so
 * `exportJsonl` produces a file that `verifyFile` accepts. Triggers refuse UPDATE/DELETE; someone with the
 * file can still drop the triggers, so this is tamper-evident (the chain), not tamper-proof.
 */
export class SqliteAuditLog implements AuditSink {
  readonly location: string;
  constructor(
    private readonly db: DatabaseSyncT,
    file: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.location = file;
  }

  append(type: string, data: Record<string, unknown> = {}): AuditEntry {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
      const e = nextEntry(last ? { seq: Number(last.seq), hash: String(last.hash) } : undefined, this.now().toISOString(), type, data);
      this.db.prepare("INSERT INTO audit (seq, ts, type, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)").run(e.seq, e.ts, e.type, JSON.stringify(e.data), e.prevHash, e.hash);
      this.db.exec("COMMIT");
      return e;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  entries(): AuditEntry[] {
    return (this.db.prepare("SELECT * FROM audit ORDER BY rowid").all() as Array<Record<string, unknown>>).map(rowToEntry);
  }

  verify(): VerifyResult {
    return verifyEntries(this.entries());
  }

  /** Write the whole chain as JSON Lines (mode 600). Returns the number of entries. */
  exportJsonl(path: string): number {
    const all = this.entries();
    writeFileSync(path, all.map((e) => JSON.stringify(e)).join("\n") + (all.length ? "\n" : ""), { mode: 0o600 });
    return all.length;
  }
}

/** Ladder state as one JSON document in SQLite; `update` runs inside BEGIN IMMEDIATE, so it is atomic across processes. */
export class SqliteStateStore implements StateBackend {
  readonly location: string;
  constructor(
    private readonly db: DatabaseSyncT,
    file: string,
    private readonly init: () => PersistedState,
  ) {
    this.location = file;
  }

  load(): PersistedState {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = 'state'").get() as { v: string } | undefined;
    return r ? (JSON.parse(r.v) as PersistedState) : this.init();
  }

  async update<T>(fn: (s: PersistedState) => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
      } catch (e) {
        if (attempt < 50 && /locked|busy/i.test(String(e))) {
          await sleep(20);
          continue;
        }
        throw e;
      }
      try {
        const s = this.load();
        const out = fn(s);
        this.db.prepare("INSERT INTO kv (k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(s));
        this.db.exec("COMMIT");
        return out;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }
}
