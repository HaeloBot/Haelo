import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("custom cursor", () => {
  it("keeps the native cursor and parks the decorative layer above the wallet modal", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    expect(css).not.toMatch(/cursor:\s*none/);
    expect(css).toContain("z-index: 2147483647");
    expect(css).toContain("pointer-events: none");
    expect(css).toContain("html.wallet-open");
    expect(css).toContain("cursor: auto");

    const wallet = readFileSync("src/components/WalletButton.tsx", "utf8");
    expect(wallet).toContain("useWalletModal");
    expect(wallet).toContain('classList.toggle("wallet-open"');
  });
});
