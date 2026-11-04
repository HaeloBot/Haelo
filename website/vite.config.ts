import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

/** SPA fallback. Segment count follows the Vite base, which is `import.meta.env.BASE_URL`. */
function spa404(base: string): string {
  const pathSegmentsToKeep = base.split("/").filter(Boolean).length;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Haelo</title>
    <script>
      var pathSegmentsToKeep = ${pathSegmentsToKeep};
      var l = window.location;
      l.replace(
        l.protocol +
          "//" +
          l.hostname +
          (l.port ? ":" + l.port : "") +
          l.pathname.split("/").slice(0, 1 + pathSegmentsToKeep).join("/") +
          "/?/" +
          l.pathname.slice(1).split("/").slice(pathSegmentsToKeep).join("/").replace(/&/g, "~and~") +
          (l.search ? "&" + l.search.slice(1).replace(/&/g, "~and~") : "") +
          l.hash,
      );
    </script>
  </head>
  <body style="background:#050605"></body>
</html>
`;
}

function spa404Plugin(base: string): Plugin {
  return {
    name: "haelo-spa-404",
    apply: "build",
    closeBundle() {
      writeFileSync(path.join(root, "dist/404.html"), spa404(base));
    },
  };
}

const base = "/";

export default defineConfig({
  base,
  plugins: [react(), spa404Plugin(base)],
  resolve: {
    alias: {
      "node:crypto": path.join(root, "src/shims/node-crypto.ts"),
      "node:fs": path.join(root, "src/shims/node-fs.ts"),
      "node:path": path.join(root, "src/shims/node-path.ts"),
      "node:os": path.join(root, "src/shims/node-os.ts"),
      // Parent engine files import these. Point them at this package so a
      // website-only install can bundle ../src without the repo root node_modules.
      "zod/v4": path.join(root, "node_modules/zod/v4/index.js"),
      yaml: path.join(root, "node_modules/yaml/browser/index.js"),
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
