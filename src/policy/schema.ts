import * as z from "zod/v4";
import { RUNGS } from "../types.js";

const rungEnum = z.enum(RUNGS);
const symbolList = z.array(z.string().min(1)).default([]);

/** Hard caps. Used for the standard rung; lower rungs may only tighten them. */
export const railsSchema = z.object({
  maxOrderUsd: z.number().positive().default(500),
  maxDailyUsd: z.number().positive().default(2000),
  maxOrdersPerDay: z.number().int().positive().default(20),
  maxOrdersPerMinute: z.number().int().positive().default(5),
  symbolCooldownSeconds: z.number().int().nonnegative().default(0),
  /** Empty means any symbol that is not blocked. */
  allowSymbols: symbolList,
  blockSymbols: symbolList,
  allowOrderTypes: z.array(z.enum(["market", "limit", "stop", "stop_limit"])).default(["market", "limit"]),
  allowAssetClasses: z.array(z.enum(["equity", "crypto", "option"])).default(["equity", "crypto"]),
  allowShort: z.boolean().default(false),
  /** Largest single-symbol share of total equity after the order, in percent. */
  maxPositionPct: z.number().positive().max(100).default(100),
});

export const rungOverrideSchema = z
  .object({
    maxOrderUsd: z.number().positive(),
    maxDailyUsd: z.number().positive(),
    maxOrdersPerDay: z.number().int().positive(),
    maxOrdersPerMinute: z.number().int().positive(),
    allowSymbols: z.array(z.string().min(1)),
    maxPositionPct: z.number().positive().max(100),
  })
  .partial();

export const criteriaSchema = z.object({
  minDays: z.number().nonnegative().default(7),
  minDecisions: z.number().int().nonnegative().default(20),
  /** Share of order attempts that were invalid (rejected or malformed). */
  maxInvalidRate: z.number().min(0).max(1).default(0.1),
  maxBreaches: z.number().int().nonnegative().default(0),
  maxInjectionFollows: z.number().int().nonnegative().default(0),
  maxDrawdownPct: z.number().nonnegative().default(10),
});

const defaultCriteria = criteriaSchema.parse({});

export const ladderSchema = z.object({
  start: rungEnum.default("shadow"),
  autoPromote: z
    .object({
      enabled: z.boolean().default(false),
      /** Automatic promotion never goes above this rung. */
      maxRung: rungEnum.default("propose"),
    })
    .default({ enabled: false, maxRung: "propose" }),
  /** Criteria to LEAVE each rung. The top rung has none. */
  criteria: z
    .object({
      shadow: criteriaSchema.default(defaultCriteria),
      paper: criteriaSchema.default(defaultCriteria),
      propose: criteriaSchema.default(defaultCriteria),
      micro: criteriaSchema.default(defaultCriteria),
    })
    .default({
      shadow: defaultCriteria,
      paper: defaultCriteria,
      propose: defaultCriteria,
      micro: defaultCriteria,
    }),
  demotion: z
    .object({
      /** Where a hard breach sends the agent. */
      onBreach: rungEnum.default("shadow"),
      /** `one_rung` steps down once; otherwise a fixed rung. */
      onDrawdown: z.union([z.literal("one_rung"), rungEnum]).default("one_rung"),
      onToolDrift: rungEnum.default("shadow"),
      onInjectionFollow: z.union([z.literal("one_rung"), rungEnum]).default("one_rung"),
      cancelOpenOrders: z.boolean().default(true),
      /** After any demotion, promotion is frozen for this long. */
      cooldownHours: z.number().nonnegative().default(24),
    })
    .default({
      onBreach: "shadow",
      onDrawdown: "one_rung",
      onToolDrift: "shadow",
      onInjectionFollow: "one_rung",
      cancelOpenOrders: true,
      cooldownHours: 24,
    }),
  drawdown: z.object({ maxPct: z.number().positive().default(10) }).default({ maxPct: 10 }),
});

export const householdSchema = z.object({
  enabled: z.boolean().default(true),
  washSale: z
    .object({
      enabled: z.boolean().default(true),
      windowDays: z.number().int().positive().default(30),
      block: z.boolean().default(false),
      /** Whether wash-sale rules apply to crypto is unverified, so it is off by default. */
      includeCrypto: z.boolean().default(false),
    })
    .default({ enabled: true, windowDays: 30, block: false, includeCrypto: false }),
  concentration: z
    .object({
      maxPct: z.number().positive().max(100).default(30),
      block: z.boolean().default(true),
    })
    .default({ maxPct: 30, block: true }),
  lots: z.object({ warnDaysToLongTerm: z.number().int().nonnegative().default(45) }).default({ warnDaysToLongTerm: 45 }),
  /** When true, an order is refused if household data cannot be loaded. */
  requireData: z.boolean().default(false),
});

export const brokerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("alpaca"),
    /** Env var names holding credentials. Secrets never live in this file. */
    paperKeyIdEnv: z.string().default("ALPACA_PAPER_KEY_ID"),
    paperSecretEnv: z.string().default("ALPACA_PAPER_SECRET_KEY"),
    liveKeyIdEnv: z.string().default("ALPACA_LIVE_KEY_ID"),
    liveSecretEnv: z.string().default("ALPACA_LIVE_SECRET_KEY"),
    feed: z.enum(["iex", "sip", "delayed_sip"]).default("iex"),
    paperBaseUrl: z.string().url().default("https://paper-api.alpaca.markets"),
    liveBaseUrl: z.string().url().default("https://api.alpaca.markets"),
    dataBaseUrl: z.string().url().default("https://data.alpaca.markets"),
  }),
  z.object({
    type: z.literal("robinhood-crypto"),
    apiKeyEnv: z.string().default("RH_CRYPTO_API_KEY"),
    /** Base64 Ed25519 private key seed (32 bytes). */
    privateKeyEnv: z.string().default("RH_CRYPTO_PRIVATE_KEY"),
    apiVersion: z.enum(["v1", "v2"]).default("v1"),
    baseUrl: z.string().url().default("https://trading.robinhood.com"),
  }),
  z.object({
    type: z.literal("mcp-upstream"),
    /** Upstream MCP server. Exactly one of url or command. */
    url: z.string().url().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    /** Env var holding a static bearer token (for dev or mock servers). If unset, OAuth is used for URLs. */
    bearerTokenEnv: z.string().optional(),
    /** Env var names passed to a stdio upstream. */
    passEnv: z.array(z.string()).default([]),
    /** Optional explicit tool names, since upstream argument shapes are not always documented. */
    quoteTools: z.object({ equity: z.string().optional(), crypto: z.string().optional() }).default({}),
    accountTool: z.string().optional(),
    positionsTool: z.string().optional(),
    ordersTool: z.string().optional(),
    taxLotsTool: z.string().optional(),
    cancelAllTool: z.string().optional(),
    /** OAuth loopback port for `leash auth`. */
    oauthPort: z.number().int().min(1024).max(65535).default(8765),
    /** Per-tool effect overrides, e.g. { "place_equity_order": "order_place" }. */
    toolOverrides: z.record(z.string(), z.enum(["read", "order_place", "order_cancel", "transfer", "blocked"])).default({}),
  }),
]);

export const configSchema = z.object({
  version: z.literal(1),
  stateDir: z.string().default("~/.leash"),
  /**
   * Live trading is OFF unless you opt in here. While off, nothing is ever sent to a live account:
   * promotion to micro/standard is refused and approved proposals are not executed.
   */
  live: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  /** Where state and the audit chain live. `sqlite` = <stateDir>/leash.db (WAL, append-only triggers); `jsonl` = state.json + audit.jsonl. */
  storage: z.object({ backend: z.enum(["sqlite", "jsonl"]).default("sqlite") }).default({ backend: "sqlite" }),
  /** Where OAuth tokens are kept. `auto` = OS keychain when available, else a 0600 file. */
  secrets: z.object({ store: z.enum(["auto", "keychain", "file"]).default("auto") }).default({ store: "auto" }),
  broker: brokerSchema,
  agent: z
    .object({
      /** The only account number the agent may trade in. Orders naming another account are blocked. */
      accountId: z.string().optional(),
    })
    .default({}),
  rails: railsSchema.default(railsSchema.parse({})),
  rungs: z
    .object({
      micro: rungOverrideSchema.default({ maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 5 }),
      propose: rungOverrideSchema.default({}),
      paper: rungOverrideSchema.default({}),
      shadow: rungOverrideSchema.default({}),
    })
    .default({ micro: { maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 5 }, propose: {}, paper: {}, shadow: {} }),
  ladder: ladderSchema.default(ladderSchema.parse({})),
  shadow: z
    .object({
      startingCash: z.number().positive().default(10_000),
      slippageBps: z.number().nonnegative().default(5),
      feeBps: z.number().nonnegative().default(0),
      /** Spread assumed when the broker quote has no usable bid/ask. */
      fallbackSpreadBps: z.number().nonnegative().default(10),
    })
    .default({ startingCash: 10_000, slippageBps: 5, feeBps: 0, fallbackSpreadBps: 10 }),
  approvals: z
    .object({
      ttlSeconds: z.number().int().positive().default(900),
      /** Local web approval UI (`leash approvals-ui`). Loopback only, bearer-token + CSRF protected. */
      web: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().min(0).max(65535).default(8790) }).default({ host: "127.0.0.1", port: 8790 }),
    })
    .default({ ttlSeconds: 900, web: { host: "127.0.0.1", port: 8790 } }),
  injection: z
    .object({
      enabled: z.boolean().default(true),
      /** An order within this many calls or seconds of a flagged tool result counts as follow-through. */
      windowCalls: z.number().int().positive().default(5),
      windowSeconds: z.number().int().positive().default(900),
      /** `block` refuses the order; `block_and_demote` also demotes per ladder.demotion.onInjectionFollow. */
      action: z.enum(["block", "block_and_demote"]).default("block_and_demote"),
    })
    .default({ enabled: true, windowCalls: 5, windowSeconds: 900, action: "block_and_demote" }),
  tools: z
    .object({
      /** Pin the upstream tool list on first start. When false, `leash pin approve` is required before orders. `recheckSeconds: 0` re-checks before every order. */
      trustOnFirstUse: z.boolean().default(true),
      recheckSeconds: z.number().int().nonnegative().default(0),
    })
    .default({ trustOnFirstUse: true, recheckSeconds: 0 }),
  household: householdSchema.default(householdSchema.parse({})),
  http: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(8787),
    })
    .default({ host: "127.0.0.1", port: 8787 }),
});

export type LeashConfig = z.infer<typeof configSchema>;
export type Rails = z.infer<typeof railsSchema>;
export type Criteria = z.infer<typeof criteriaSchema>;
export type BrokerConfig = z.infer<typeof brokerSchema>;
