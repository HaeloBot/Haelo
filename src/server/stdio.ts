import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { HaeloCore } from "../core.js";
import { createServerFactory } from "./gateway.js";

/** Serve the gateway over stdio. Never write to stdout from anywhere else: it is the protocol channel. */
export function startStdio(core: HaeloCore): ReturnType<typeof serveStdio> {
  return serveStdio(createServerFactory(core, "stdio"), {
    onerror: (e) => process.stderr.write(`[haelo] ${e.message}\n`),
  });
}
