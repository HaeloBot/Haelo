import { mkdirSync } from "node:fs";
import { AlpacaBroker } from "./adapters/alpaca.js";
import { RobinhoodCryptoBroker } from "./adapters/robinhood-crypto.js";
import { McpUpstreamAdapter } from "./adapters/mcp-upstream.js";
import { RestAdapter } from "./adapters/rest-base.js";
import type { BrokerAdapter, FetchFn } from "./adapters/types.js";
import { HaeloCore } from "./core.js";
import { SecretOAuthProvider } from "./oauth.js";
import { openSecretStore } from "./secrets.js";
import type { LoadedConfig } from "./policy/load.js";
import type { HaeloConfig } from "./policy/schema.js";
import { openStorage } from "./storage/index.js";

export interface BuildOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchFn;
  now?: () => Date;
  /** Called with the authorization URL when `haelo auth` needs the user to sign in. */
  onOAuthRedirect?: (url: URL) => void;
}

function need(env: NodeJS.ProcessEnv, name: string, what: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing environment variable ${name} (${what}). See .env.example.`);
  return v;
}

/** Create the broker adapter named in the config. Secrets come only from the environment. */
export function buildAdapter(config: HaeloConfig, stateDir: string, opts: BuildOptions = {}): BrokerAdapter {
  const env = opts.env ?? process.env;
  const b = config.broker;
  switch (b.type) {
    case "alpaca": {
      const paperId = env[b.paperKeyIdEnv];
      const paperSecret = env[b.paperSecretEnv];
      const liveId = env[b.liveKeyIdEnv];
      const liveSecret = env[b.liveSecretEnv];
      if (!(paperId && paperSecret) && !(liveId && liveSecret)) {
        throw new Error(`No Alpaca credentials found. Set ${b.paperKeyIdEnv} and ${b.paperSecretEnv} (a free paper account works), see .env.example.`);
      }
      return new RestAdapter(
        new AlpacaBroker({
          ...(paperId && paperSecret ? { paper: { keyId: paperId, secret: paperSecret } } : {}),
          ...(liveId && liveSecret ? { live: { keyId: liveId, secret: liveSecret } } : {}),
          paperBaseUrl: b.paperBaseUrl,
          liveBaseUrl: b.liveBaseUrl,
          dataBaseUrl: b.dataBaseUrl,
          feed: b.feed,
          fallbackSpreadBps: config.shadow.fallbackSpreadBps,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        }),
      );
    }
    case "robinhood-crypto":
      return new RestAdapter(
        new RobinhoodCryptoBroker({
          apiKey: need(env, b.apiKeyEnv, "Robinhood Crypto API key"),
          privateKeyBase64: need(env, b.privateKeyEnv, "base64 Ed25519 private key seed"),
          apiVersion: b.apiVersion,
          baseUrl: b.baseUrl,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        }),
      );
    case "mcp-upstream": {
      const bearer = b.bearerTokenEnv ? env[b.bearerTokenEnv] : undefined;
      if (b.bearerTokenEnv && !bearer) throw new Error(`Environment variable ${b.bearerTokenEnv} is empty.`);
      const passEnv: Record<string, string> = {};
      for (const k of b.passEnv) {
        const v = env[k];
        if (v !== undefined) passEnv[k] = v;
      }
      const oauth = b.url && !bearer ? new SecretOAuthProvider(openSecretStore(config.secrets.store, stateDir), stateDir, b.url, b.oauthPort, opts.onOAuthRedirect ?? (() => undefined)) : undefined;
      return new McpUpstreamAdapter({
        ...(b.url ? { url: b.url } : {}),
        ...(b.command ? { command: b.command, args: b.args, env: passEnv } : {}),
        ...(bearer ? { bearerToken: bearer } : {}),
        ...(oauth ? { oauth } : {}),
        quoteTools: b.quoteTools,
        ...(b.accountTool ? { accountTool: b.accountTool } : {}),
        ...(b.positionsTool ? { positionsTool: b.positionsTool } : {}),
        ...(b.ordersTool ? { ordersTool: b.ordersTool } : {}),
        ...(b.taxLotsTool ? { taxLotsTool: b.taxLotsTool } : {}),
        ...(b.cancelAllTool ? { cancelAllTool: b.cancelAllTool } : {}),
        toolOverrides: b.toolOverrides,
        ...(config.agent.accountId ? { accountId: config.agent.accountId } : {}),
        fallbackSpreadBps: config.shadow.fallbackSpreadBps,
      });
    }
  }
}

/** An adapter that cannot reach any broker. Used by commands that only read local state (status, proposals). */
export function offlineAdapter(config: HaeloConfig): BrokerAdapter {
  const fail = (): never => {
    throw new Error("This command does not load broker credentials.");
  };
  return {
    id: config.broker.type,
    supportsPaper: config.broker.type === "alpaca",
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

/** Wire config, adapter, state and audit log into a HaeloCore. Call `core.init()` before serving. */
export function createHaelo(loaded: LoadedConfig, opts: BuildOptions & { adapter?: BrokerAdapter; offline?: boolean } = {}): HaeloCore {
  mkdirSync(loaded.stateDir, { recursive: true, mode: 0o700 });
  const now = opts.now ?? (() => new Date());
  const adapter = opts.adapter ?? (opts.offline ? offlineAdapter(loaded.config) : buildAdapter(loaded.config, loaded.stateDir, opts));
  const storage = openStorage(loaded.config.storage.backend, loaded.stateDir, HaeloCore.initialStateFactory(loaded.config, now), now);
  return new HaeloCore({ config: loaded.config, adapter, store: storage.store, audit: storage.audit, now, onClose: storage.close });
}
