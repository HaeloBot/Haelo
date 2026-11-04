import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMockUpstreamServer, newMockUpstreamState } from "../../src/testkit/mock-upstream.js";

/**
 * An OAuth 2.1-protected MCP server for tests: protected-resource metadata (RFC 9728), authorization-server
 * metadata (RFC 8414), dynamic client registration (RFC 7591), authorization code + PKCE S256, refresh tokens.
 * It approves every authorization request (there is no user), so it tests Leash's client side, not a real IdP.
 */
export async function startOAuthUpstream(): Promise<{ base: string; mcpUrl: string; tokensIssued: () => number; close(): Promise<void> }> {
  const codes = new Map<string, { challenge: string; redirect: string; clientId: string }>();
  const access = new Set<string>();
  const clients = new Set<string>();
  let issued = 0;
  const handler = createMcpHandler(() => createMockUpstreamServer(newMockUpstreamState()));
  const node = toNodeHandler(handler);
  let base = "";
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const meta = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const id = `client-${randomBytes(4).toString("hex")}`;
        clients.add(id);
        return json(res, 201, { ...meta, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (url.pathname === "/authorize") {
        const p = url.searchParams;
        if (p.get("code_challenge_method") !== "S256" || !clients.has(p.get("client_id") ?? "")) return json(res, 400, { error: "invalid_request" });
        const code = randomBytes(8).toString("hex");
        codes.set(code, { challenge: p.get("code_challenge") ?? "", redirect: p.get("redirect_uri") ?? "", clientId: p.get("client_id") ?? "" });
        const to = new URL(p.get("redirect_uri") ?? "");
        to.searchParams.set("code", code);
        to.searchParams.set("state", p.get("state") ?? "");
        res.writeHead(302, { location: to.toString() }).end();
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const p = new URLSearchParams(await readBody(req));
        if (p.get("grant_type") === "authorization_code") {
          const c = codes.get(p.get("code") ?? "");
          const verifier = p.get("code_verifier") ?? "";
          const ok = c && createHash("sha256").update(verifier).digest("base64url") === c.challenge && c.redirect === p.get("redirect_uri");
          if (!ok) return json(res, 400, { error: "invalid_grant" });
          codes.delete(p.get("code") ?? "");
        } else if (p.get("grant_type") !== "refresh_token") return json(res, 400, { error: "unsupported_grant_type" });
        const at = `at-${randomBytes(6).toString("hex")}`;
        access.add(at);
        issued++;
        return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${randomBytes(6).toString("hex")}` });
      }
      if (url.pathname === "/mcp") {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
        if (!m || !access.has(m[1] as string)) {
          res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        await node(req, res);
        return;
      }
      json(res, 404, { error: "not found" });
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    mcpUrl: `${base}/mcp`,
    tokensIssued: () => issued,
    async close() {
      await handler.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}
