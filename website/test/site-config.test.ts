import { describe, expect, it } from "vitest";
import { buyUrl, isCaSet, parseSiteConfig, truncateCa } from "../src/site-config.js";

describe("site config", () => {
  it("accepts the shipped file shape and keeps an empty contract address unset", () => {
    const cfg = parseSiteConfig({
      token: { symbol: "HAELO", ca: "", buyUrlTemplate: "https://ponsfamily.com/launchpad/{CA}" },
      social: { x: "https://x.com/HaeloBot" },
    });
    expect(cfg.token.symbol).toBe("HAELO");
    expect(isCaSet(cfg.token.ca)).toBe(false);
    expect(cfg.social.x).toBe("https://x.com/HaeloBot");
    expect(cfg.solana.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
  });

  it("fills defaults for a partial document", () => {
    const cfg = parseSiteConfig({ token: {}, social: {} });
    expect(cfg.token.buyUrlTemplate).toContain("{CA}");
    expect(cfg.social.x).toBe("https://x.com/HaeloBot");
    expect(cfg.solana.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
  });

  it("falls back when the document is not the config", () => {
    const cfg = parseSiteConfig({ token: { ca: 12 } });
    expect(cfg.token.ca).toBe("");
    expect(isCaSet(cfg.token.ca)).toBe(false);
  });

  it("treats placeholder strings as unset and builds the buy link from the template", () => {
    expect(isCaSet("  ")).toBe(false);
    expect(isCaSet("TBD")).toBe(false);
    expect(isCaSet("0x000")).toBe(false);
    const ca = "So11111111111111111111111111111111111111112";
    expect(isCaSet(ca)).toBe(true);
    expect(truncateCa(ca)).toBe("So1111…1112");
    expect(buyUrl("https://ponsfamily.com/launchpad/{CA}", ca)).toBe(`https://ponsfamily.com/launchpad/${encodeURIComponent(ca)}`);
  });
});
