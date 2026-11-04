import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJsonIfExists, sleep } from "./util.js";
import type { Rung, ToolDef } from "./types.js";

export interface RungStats {
  startedAt: string;
  decisions: number;
  accepted: number;
  invalid: number;
  breaches: number;
  injectionFollows: number;
  startEquity?: number;
  hwmEquity?: number;
  drawdownPct: number;
}

export interface LadderEvent {
  ts: string;
  from: Rung;
  to: Rung;
  reason: string;
  by: "auto" | "human";
}

export interface ShadowPosition {
  qty: number;
  avgPrice: number;
}

export interface ShadowOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  limitPrice?: number;
  status: "filled" | "open" | "canceled" | "rejected";
  filledQty: number;
  filledAvgPrice?: number;
  fee: number;
  submittedAt: string;
  filledAt?: string;
  lastMark?: number;
}

export interface ShadowState {
  cash: number;
  positions: Record<string, ShadowPosition>;
  orders: ShadowOrder[];
  startingCash: number;
  hwmEquity: number;
  realizedPnl: number;
}

export interface Proposal {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "declined" | "expired" | "executed" | "failed";
  tool: string;
  args: Record<string, unknown>;
  intent: Record<string, unknown>;
  notionalUsd: number;
  rungAtCreation: Rung;
  checks: Array<{ code: string; level: string; message: string }>;
  rationale?: string;
  decidedAt?: string;
  decidedBy?: string;
  result?: unknown;
  error?: string;
}

export interface UsageState {
  day: string;
  ordersToday: number;
  notionalToday: number;
  recentOrderTimes: number[];
  lastOrderBySymbol: Record<string, number>;
}

export interface PersistedState {
  version: 1;
  ladder: {
    rung: Rung;
    since: string;
    stats: RungStats;
    frozenUntil?: string;
    frozenReason?: string;
    history: LadderEvent[];
  };
  shadow: ShadowState;
  usage: UsageState;
  pin?: { hash: string; pinnedAt: string; defs: ToolDef[] };
  /** Set when upstream tools changed from the pin. Orders are refused until `haelo pin approve`. */
  drift?: { detectedAt: string; hash: string; added: string[]; removed: string[]; changed: string[]; reason?: string };
  proposals: Proposal[];
}

/** Persistence for the ladder state. `update` must be atomic across processes. */
export interface StateBackend {
  readonly location: string;
  load(): PersistedState;
  update<T>(fn: (s: PersistedState) => T): Promise<T>;
}

const LOCK_STALE_MS = 15_000;

/**
 * JSON state on disk with a lock directory, so the gateway and CLI (separate processes) can both
 * read-modify-write without losing updates. State is re-read on every access.
 */
export class StateStore implements StateBackend {
  readonly file: string;
  readonly location: string;
  private readonly lockDir: string;

  constructor(
    readonly dir: string,
    private readonly init: () => PersistedState,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "state.json");
    this.location = this.file;
    this.lockDir = join(dir, "state.lock");
  }

  load(): PersistedState {
    return readJsonIfExists<PersistedState>(this.file) ?? this.init();
  }

  async update<T>(fn: (s: PersistedState) => T): Promise<T> {
    await this.acquire();
    try {
      const s = this.load();
      const out = fn(s);
      atomicWriteJson(this.file, s);
      return out;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(this.lockDir);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (existsSync(this.lockDir) && Date.now() - statSync(this.lockDir).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          /* raced with another process; retry */
        }
        if (Date.now() > deadline) throw new Error("Timed out waiting for the Haelo state lock.", { cause: e });
        await sleep(15);
      }
    }
  }

  private release(): void {
    rmSync(this.lockDir, { recursive: true, force: true });
  }
}
