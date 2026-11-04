import { BrokerError, type FetchFn } from "./types.js";
import { sleep } from "../util.js";

export interface HttpOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
  retries?: number;
}

/** JSON over HTTP with a timeout and bounded retries on 429 and 5xx (honouring Retry-After). */
export async function requestJson(url: string, init: RequestInit, opts: HttpOptions = {}): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
    try {
      const res = await doFetch(url, { ...init, signal: ctl.signal });
      const text = await res.text();
      let body: unknown = text;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          /* leave as text */
        }
      } else body = undefined;
      if (res.ok) return body;
      if ((res.status === 429 || res.status >= 500) && attempt < retries && (init.method ?? "GET") === "GET") {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : 250 * 2 ** attempt);
        continue;
      }
      throw new BrokerError(`HTTP ${res.status} from ${new URL(url).host}${new URL(url).pathname}`, res.status, body);
    } catch (e) {
      lastErr = e;
      if (e instanceof BrokerError) throw e;
      if (attempt < retries && (init.method ?? "GET") === "GET") {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      throw new BrokerError(`Request to ${safeHost(url)} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new BrokerError("request failed");
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}
