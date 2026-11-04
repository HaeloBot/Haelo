import { mkdirSync } from "node:fs";
import { SolanaBroker } from "./adapters/solana.js";
import { RestAdapter } from "./adapters/rest-base.js";
import type { BrokerAdapter, FetchFn } from "./adapters/types.js";
import { HaeloCore } from "./core.js";
import { openSecretStore } from "./secrets.js";
import { JupiterClient } from "./solana/jupiter.js";
import { SolanaRpc } from "./solana/rpc.js";
import { loadSigner, walletAddress, type SolanaSigner } from "./solana/signer.js";
import type { LoadedConfig } from "./policy/load.js";
import type { HaeloConfig } from "./policy/schema.js";
import { openStorage } from "./storage/index.js";

export interface BuildOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchFn;
  now?: () => Date;
  /** Use this signer instead of loading one from the environment or keychain. */
  signer?: SolanaSigner;
  /** Expected genesis hash. Tests point this at a local fake cluster. */
  genesisHash?: string;
}

export function rpcUrl(config: HaeloConfig, env: NodeJS.ProcessEnv): string {
  return env[config.broker.rpcUrlEnv]?.trim() || config.broker.rpcUrl;
}

/** Create the Solana venue. Secrets come only from the environment or the OS keychain. */
export async function buildAdapter(config: HaeloConfig, stateDir: string, opts: BuildOptions = {}): Promise<BrokerAdapter> {
  const env = opts.env ?? process.env;
  const b = config.broker;
  const signer =
    opts.signer ?? (await loadSigner(env, { privateKeyEnv: b.privateKeyEnv, keypairFileEnv: b.keypairFileEnv }, openSecretStore(config.secrets.store, stateDir)));
  const address = walletAddress(signer, env, b.addressEnv);
  const reader = new SolanaRpc(rpcUrl(config, env), opts.fetch);
  const apiKey = env[b.jupiterApiKeyEnv]?.trim();
  const venue = new JupiterClient({ baseUrl: b.jupiterBaseUrl, ...(apiKey ? { apiKey } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return new RestAdapter(
    new SolanaBroker(reader, venue, signer, {
      maxSlippageBps: config.rails.maxSlippageBps,
      reserveLamports: BigInt(Math.round(b.reserveSol * 1e9)),
      maxFeeLamports: BigInt(Math.round(b.maxFeeSol * 1e9)),
      paperSimulate: b.paperSimulate,
      tokens: Object.entries(b.tokens).map(([symbol, mint]) => ({ symbol, mint })),
      ...(address ? { address } : {}),
      ...(opts.genesisHash ? { genesisHash: opts.genesisHash } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    }),
  );
}

/** A venue that cannot reach the network. Used by commands that only read local state (status, proposals). */
export function offlineAdapter(config: HaeloConfig): BrokerAdapter {
  const fail = (): never => {
    throw new Error("This command does not connect to Solana.");
  };
  return {
    id: config.broker.type,
    supportsPaper: true,
    dynamicTools: false,
    shadowReadTools: {},
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => [],
    classify: () => ({ effect: "unknown", untrustedText: false, reason: "offline" }),
    callRead: async () => fail(),
    parseOrder: () => undefined,
    executeOrder: async () => fail(),
    executeCancel: async () => fail(),
    quote: async () => fail(),
    getAccount: async () => undefined,
    getPositions: async () => [],
    listOrders: async () => [],
    householdView: async () => [],
    cancelAllOpen: async () => 0,
  };
}

/** Wire config, venue, state and audit log into a HaeloCore. Call `core.init()` before serving. */
export async function createHaelo(loaded: LoadedConfig, opts: BuildOptions & { adapter?: BrokerAdapter; offline?: boolean } = {}): Promise<HaeloCore> {
  mkdirSync(loaded.stateDir, { recursive: true, mode: 0o700 });
  const now = opts.now ?? (() => new Date());
  const adapter = opts.adapter ?? (opts.offline ? offlineAdapter(loaded.config) : await buildAdapter(loaded.config, loaded.stateDir, opts));
  const storage = openStorage(loaded.config.storage.backend, loaded.stateDir, HaeloCore.initialStateFactory(loaded.config, now), now);
  return new HaeloCore({ config: loaded.config, adapter, store: storage.store, audit: storage.audit, now, onClose: storage.close });
}
