import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EM_DASH = "\u2014";

function textFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) textFiles(path, out);
    else if (/\.(tsx?|html|json|css|md)$/.test(name)) out.push(path);
  }
  return out;
}

describe("website copy", () => {
  it("does not use em dashes in source or public text", () => {
    const files = [...textFiles("src"), ...textFiles("public"), "index.html"];
    const hits = files.filter((file) => readFileSync(file, "utf8").includes(EM_DASH));
    expect(hits).toEqual([]);
  });
});
