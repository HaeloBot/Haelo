import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/Haelo/",
  plugins: [react()],
  resolve: {
    alias: {
      "node:crypto": path.join(root, "src/shims/node-crypto.ts"),
      "node:fs": path.join(root, "src/shims/node-fs.ts"),
      "node:path": path.join(root, "src/shims/node-path.ts"),
      "node:os": path.join(root, "src/shims/node-os.ts"),
    },
  },
  server: {
    fs: { allow: [path.resolve(root, "..")] },
  },
  build: {
    sourcemap: false,
    target: "es2022",
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
