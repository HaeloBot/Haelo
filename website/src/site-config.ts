import * as z from "zod/v4";

export const DEFAULT_REOWN_PROJECT_ID = "d55fd8ddbd81e9b400102b491e41a339";

const siteConfigSchema = z.object({
  token: z.object({
    symbol: z.string().min(1).default("HAELO"),
    ca: z.string().default(""),
    buyUrlTemplate: z.string().min(1).default("https://ponsfamily.com/launchpad/{CA}"),
  }),
  social: z.object({
    x: z.string().url().default("https://x.com/HaeloBot"),
  }),
  reown: z
    .object({
      projectId: z.string().min(1).default(DEFAULT_REOWN_PROJECT_ID),
    })
    .default({ projectId: DEFAULT_REOWN_PROJECT_ID }),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

export const FALLBACK_CONFIG: SiteConfig = {
  token: {
    symbol: "HAELO",
    ca: "",
    buyUrlTemplate: "https://ponsfamily.com/launchpad/{CA}",
  },
  social: { x: "https://x.com/HaeloBot" },
  reown: { projectId: DEFAULT_REOWN_PROJECT_ID },
};

const PLACEHOLDER = /^(coming soon|ca coming soon|tbd|placeholder|todo|none|null)$/i;

/** Empty and obvious stand-in strings are not a contract address. */
export function isCaSet(ca: string): boolean {
  const trimmed = ca.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER.test(trimmed)) return false;
  if (/^0x0+$/i.test(trimmed)) return false;
  return true;
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
