import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/policy/load.js";

const root = resolve(__dirname, "..");

describe("shipped examples stay valid", () => {
  it("haelo.example.yaml parses", () => {
    expect(parseConfig(readFileSync(resolve(root, "haelo.example.yaml"), "utf8")).version).toBe(1);
  });
  it.each(readdirSync(resolve(root, "examples")).filter((f) => f.endsWith(".yaml")))("examples/%s parses", (f) => {
    expect(() => parseConfig(readFileSync(resolve(root, "examples", f), "utf8"))).not.toThrow();
  });
  it.each(readdirSync(resolve(root, "examples")).filter((f) => f.endsWith(".json")))("examples/%s is valid JSON with an mcpServers entry", (f) => {
    const j = JSON.parse(readFileSync(resolve(root, "examples", f), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(j.mcpServers)).toContain("haelo");
  });
  it(".env.example holds no secret values", () => {
    const lines = readFileSync(resolve(root, ".env.example"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l));
    for (const l of lines) expect(l.split("=")[1]).toBe("");
  });
});
