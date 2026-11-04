import * as z from "zod/v4";

export const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

const siteConfigSchema = z.object({
  token: z.object({
    symbol: z.string().min(1).default("HAELO"),
    ca: z.string().default(""),
    buyUrlTemplate: z.string().min(1).default("https://pump.fun/coin/{CA}"),
  }),
  social: z.object({
    x: z.string().url().default("https://x.com/HaeloBot"),
  }),
  /** RPC the browser uses to read token mints and simulate swaps. A keyed RPC with CORS enabled works best. */
  solana: z
    .object({
      rpcUrl: z.string().url().default(DEFAULT_SOLANA_RPC),
    })
    .default({ rpcUrl: DEFAULT_SOLANA_RPC }),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

export const FALLBACK_CONFIG: SiteConfig = {
  token: {
    symbol: "HAELO",
    ca: "",
    buyUrlTemplate: "https://pump.fun/coin/{CA}",
  },
  social: { x: "https://x.com/HaeloBot" },
  solana: { rpcUrl: DEFAULT_SOLANA_RPC },
};

const PLACEHOLDER = /^(coming soon|ca coming soon|tbd|placeholder|todo|none|null)$/i;

/** Empty and obvious stand-in strings are not a contract address. */
export function isCaSet(ca: string): boolean {
  const trimmed = ca.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER.test(trimmed)) return false;
  if (/^0x0+$/i.test(trimmed)) return false;
  // A Solana mint is a base58 public key. Anything else is not a contract address on this chain.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
}

export function truncateCa(ca: string): string {
  const trimmed = ca.trim();
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export function buyUrl(template: string, ca: string): string {
  return template.replaceAll("{CA}", encodeURIComponent(ca.trim()));
}

export function parseSiteConfig(data: unknown): SiteConfig {
  const parsed = siteConfigSchema.safeParse(data);
  return parsed.success ? parsed.data : FALLBACK_CONFIG;
}

export async function loadSiteConfig(): Promise<SiteConfig> {
  const base = import.meta.env.BASE_URL;
  const url = `${base}config.json?t=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return FALLBACK_CONFIG;
    return parseSiteConfig(await res.json());
  } catch {
    return FALLBACK_CONFIG;
  }
}
