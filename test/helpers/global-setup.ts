import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Build dist/ once so the stdio and CLI tests can spawn the real compiled entry point. */
export default function setup(): void {
  const root = resolve(__dirname, "../..");
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
}
