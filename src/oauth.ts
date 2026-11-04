import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import { sha256 } from "./util.js";
import type { SecretStore } from "./secrets.js";

interface Persisted {
  clients: Record<string, OAuthClientInformationMixed>;
  tokens?: OAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  state?: string;
}

/**
 * OAuth 2.1 (PKCE) client provider for upstream MCP servers such as Robinhood's. Client registrations and
 * tokens are kept in a SecretStore (the OS keychain when available, else a 0600 file), keyed by server URL.
 * A pre-0.2 plain file (`<stateDir>/oauth/<hash>.json`) is migrated into the store and deleted.
 */
export class SecretOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly key: string;
  private data: Persisted;

  constructor(
    private readonly secrets: SecretStore,
    stateDir: string,
    serverUrl: string,
    port: number,
    private readonly onRedirect: (url: URL) => void,
  ) {
    this.key = `oauth:${serverUrl}`;
    this.redirectUrl = `http://127.0.0.1:${port}/callback`;
    this.clientMetadata = {
      client_name: "Leash (autonomy ladder gateway)",
      redirect_uris: [this.redirectUrl],
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    } as OAuthClientMetadata;
    const stored = secrets.get(this.key);
    const legacy = join(stateDir, "oauth", `${sha256(serverUrl).slice(0, 16)}.json`);
    if (stored) this.data = JSON.parse(stored) as Persisted;
    else if (existsSync(legacy)) {
      this.data = JSON.parse(readFileSync(legacy, "utf8")) as Persisted;
      this.save();
      rmSync(legacy, { force: true });
    } else this.data = { clients: {} };
  }

  get storeKind(): SecretStore["kind"] {
    return this.secrets.kind;
  }

  private save(): void {
    this.secrets.set(this.key, JSON.stringify(this.data));
  }

  /** Forget tokens and registrations for this server. */
  clear(): void {
    this.data = { clients: {} };
    this.secrets.delete(this.key);
  }

  hasTokens(): boolean {
    return Boolean(this.data.tokens?.access_token);
  }

  clientInformation(ctx?: OAuthClientInformationContext): OAuthClientInformationMixed | undefined {
    return ctx ? this.data.clients[ctx.issuer] : undefined;
  }
  saveClientInformation(info: OAuthClientInformationMixed, ctx?: OAuthClientInformationContext): void {
    if (ctx) {
      this.data.clients[ctx.issuer] = info;
      this.save();
    }
  }
  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens;
    this.save();
  }
  state(): string {
    this.data.state = randomUUID();
    this.save();
    return this.data.state;
  }
  expectedState(): string | undefined {
    return this.data.state;
  }
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.data.discovery = state;
    this.save();
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.data.discovery;
  }
  redirectToAuthorization(url: URL): void {
    this.onRedirect(url);
  }
  saveCodeVerifier(v: string): void {
    this.data.verifier = v;
    this.save();
  }
  codeVerifier(): string {
    if (!this.data.verifier) throw new Error("No PKCE code verifier saved; restart `leash auth`.");
    return this.data.verifier;
  }
}

export interface CallbackListener {
  promise: Promise<URLSearchParams>;
  close(): void;
}

/** Listen on loopback for the OAuth redirect. Start this BEFORE sending the user to the browser. */
export function listenForOAuthCallback(port: number, timeoutMs = 300_000): CallbackListener {
  let server: ReturnType<typeof createServer> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<URLSearchParams>((resolvePromise, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Leash: authorization received. You can close this tab and return to the terminal.");
      if (timer) clearTimeout(timer);
      server?.close();
      resolvePromise(url.searchParams);
    });
    timer = setTimeout(() => {
      server?.close();
      reject(new Error("Timed out waiting for the OAuth callback."));
    }, timeoutMs);
    server.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    server.listen(port, "127.0.0.1");
  });
  promise.catch(() => undefined);
  return {
    promise,
    close() {
      if (timer) clearTimeout(timer);
      server?.close();
    },
  };
}
