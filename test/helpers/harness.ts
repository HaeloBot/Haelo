import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Keypair, VersionedTransaction } from "@solana/web3.js";
import { SolanaBroker } from "../../src/adapters/solana.js";
import { RestAdapter } from "../../src/adapters/rest-base.js";
import { AuditLog } from "../../src/audit.js";
import { HaeloCore } from "../../src/core.js";
import { parseConfig } from "../../src/policy/load.js";
import type { HaeloConfig } from "../../src/policy/schema.js";
import { JupiterClient } from "../../src/solana/jupiter.js";
import { SolanaRpc } from "../../src/solana/rpc.js";
import type { SolanaSigner } from "../../src/solana/signer.js";
import { StateStore } from "../../src/state.js";
import type { BrokerAccount, BrokerMode, BrokerOrder, OrderIntent } from "../../src/types.js";
import { FAKE_GENESIS, fund, newWallet, startFakeSolana, type RunningFakeSolana } from "./fake-solana.js";

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

export function keypairSigner(kp: Keypair): SolanaSigner {
  return {
    address: kp.publicKey.toBase58(),
    source: "external",
    async sign(tx: VersionedTransaction) {
      tx.sign([kp]);
      return tx;
    },
  };
}

/** A SolanaBroker that records every order it is asked to place, and can fake a drawdown. */
export class RecordingBroker extends SolanaBroker {
  readonly placed: Array<{ mode: BrokerMode; order: BrokerOrder }> = [];
  equityOverride: number | undefined;
  override async placeOrder(mode: BrokerMode, intent: OrderIntent): Promise<BrokerOrder> {
    const order = await super.placeOrder(mode, intent);
    this.placed.push({ mode, order });
    return order;
  }
  override async getAccount(mode: BrokerMode): Promise<BrokerAccount> {
    const a = await super.getAccount(mode);
    return this.equityOverride === undefined ? a : { ...a, equity: this.equityOverride };
  }
  orders(mode: BrokerMode): BrokerOrder[] {
    return this.placed.filter((p) => p.mode === mode).map((p) => p.order);
  }
}

export interface Harness {
  core: HaeloCore;
  dir: string;
  clock: Clock;
  config: HaeloConfig;
  fake: RunningFakeSolana;
  wallet: Keypair;
  broker: RecordingBroker;
  /** Swaps that were signed and sent through /execute. */
  executed(): number;
  cleanup(): Promise<void>;
}

export function buildBroker(fake: RunningFakeSolana, signer: SolanaSigner | undefined, config: HaeloConfig, clock?: Clock, address?: string): RecordingBroker {
  return new RecordingBroker(new SolanaRpc(fake.rpcUrl), new JupiterClient({ baseUrl: fake.jupiterUrl }), signer, {
    genesisHash: FAKE_GENESIS,
    maxSlippageBps: config.rails.maxSlippageBps,
    reserveLamports: BigInt(Math.round(config.broker.reserveSol * 1e9)),
    maxFeeLamports: BigInt(Math.round(config.broker.maxFeeSol * 1e9)),
    paperSimulate: config.broker.paperSimulate,
    ...(address ? { address } : {}),
    ...(clock ? { now: clock.now } : {}),
  });
}

/** A HaeloCore wired to a local fake Solana cluster and Jupiter API, with a funded wallet and a controllable clock. */
export async function solanaHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "haelo-test-"));
  const clock = new Clock();
  const fake = await startFakeSolana();
  const wallet = newWallet();
  fund(fake.state, wallet.publicKey.toBase58(), 10, 10_000);
  const yaml = JSON.stringify(
    deepMerge(
      {
        version: 1,
        stateDir: dir,
        live: { enabled: true },
        broker: { type: "solana", rpcUrl: fake.rpcUrl, jupiterBaseUrl: fake.jupiterUrl },
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
      },
      overrides,
    ),
  );
  const config = parseConfig(yaml);
  const broker = buildBroker(fake, keypairSigner(wallet), config, clock);
  const adapter = new RestAdapter(broker);
  const store = new StateStore(dir, HaeloCore.initialStateFactory(config, clock.now));
  const audit = new AuditLog(join(dir, "audit.jsonl"), clock.now);
  const core = new HaeloCore({ config, adapter, store, audit, now: clock.now });
  await core.init();
  return {
    core,
    dir,
    clock,
    config,
    fake,
    wallet,
    broker,
    executed: () => [...fake.state.swaps.values()].filter((s) => s.executed).length,
    async cleanup() {
      await core.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && av && typeof av === "object" && !Array.isArray(av) ? deepMerge(av as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}
