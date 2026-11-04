import { existsSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, readEntries, type AuditSink } from "../audit.js";
import { StateStore, type PersistedState, type StateBackend } from "../state.js";
import { SqliteAuditLog, SqliteStateStore, openDatabase } from "./sqlite.js";

export type StorageBackend = "sqlite" | "jsonl";

export interface Storage {
  backend: StorageBackend;
  store: StateBackend;
  audit: AuditSink;
  close(): void;
}

/**
 * Open the configured storage. `sqlite` (default) keeps state and the audit chain in `<stateDir>/leash.db`;
 * `jsonl` keeps `state.json` + `audit.jsonl`. When switching to SQLite with an existing JSONL log, the old
 * chain is imported once so history is not lost (and stays verifiable: hashes are identical).
 */
export function openStorage(backend: StorageBackend, stateDir: string, init: () => PersistedState, now: () => Date = () => new Date()): Storage {
  if (backend === "jsonl") {
    return { backend, store: new StateStore(stateDir, init), audit: new AuditLog(join(stateDir, "audit.jsonl"), now), close: () => undefined };
  }
  const file = join(stateDir, "leash.db");
  const db = openDatabase(file);
  const audit = new SqliteAuditLog(db, file, now);
  const store = new SqliteStateStore(db, file, init);
  migrateFromJsonl(db, stateDir);
  return {
    backend,
    store,
    audit,
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}

function migrateFromJsonl(db: ReturnType<typeof openDatabase>, stateDir: string): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n;
  const jsonl = join(stateDir, "audit.jsonl");
  if (Number(count) === 0 && existsSync(jsonl)) {
    const ins = db.prepare("INSERT INTO audit (seq, ts, type, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN IMMEDIATE");
    for (const e of readEntries(jsonl)) if (e.type !== "__corrupt__") ins.run(e.seq, e.ts, e.type, JSON.stringify(e.data), e.prevHash, e.hash);
    db.exec("COMMIT");
  }
  const hasState = db.prepare("SELECT 1 FROM kv WHERE k = 'state'").get();
  const sj = join(stateDir, "state.json");
  if (!hasState && existsSync(sj)) {
    const legacy = new StateStore(stateDir, () => {
      throw new Error("unreachable");
    });
    db.prepare("INSERT INTO kv (k, v) VALUES ('state', ?)").run(JSON.stringify(legacy.load()));
  }
}
