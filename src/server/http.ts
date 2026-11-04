import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import type { LeashCore } from "../core.js";
import { createServerFactory } from "./gateway.js";
import { safeEqual } from "../util.js";

export interface HttpOptions {
  host: string;
  port: number;
  /** Bearer token the agent must present. Required: the gateway holds broker access. */
  token: string;
  /** Allow binding a non-loopback address. The bearer token is still required. */
  allowRemote?: boolean;
}

export interface RunningHttp {
  url: string;
  port: number;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Streamable HTTP endpoint at /mcp. Defence in depth for a local server that can move money:
 * loopback bind by default, Host and Origin validation (stops DNS rebinding), and a mandatory bearer token.
 */
export async function startHttp(core: LeashCore, opts: HttpOptions): Promise<RunningHttp> {
  if (!opts.token || opts.token.length < 16) throw new Error("HTTP token must be at least 16 characters.");
  if (!LOOPBACK.has(opts.host) && !opts.allowRemote) {
    throw new Error(`Refusing to bind ${opts.host}: not a loopback address. Pass --allow-remote if you really mean it (a bearer token is still required).`);
  }
  const handler = createMcpHandler(createServerFactory(core, "http"));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const loopback = LOOPBACK.has(opts.host);

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (loopback && (!validateHost(req, res) || !validateOrigin(req, res))) return;
    const auth = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/i.exec(auth);
    if (!m || !safeEqual(m[1] as string, opts.token)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="leash"' }).end(JSON.stringify({ error: "missing or invalid bearer token" }));
      return;
    }
    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const hostForUrl = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${hostForUrl}:${addr.port}/mcp`,
    port: addr.port,
    async close() {
      await handler.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
