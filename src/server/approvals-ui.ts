import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import type { LeashCore } from "../core.js";
import type { Proposal } from "../state.js";
import { errorMessage, safeEqual } from "../util.js";

export interface ApprovalsUiOptions {
  host: string;
  port: number;
  /** Same bearer token as the HTTP gateway. Exchanged once at /login for an HttpOnly session cookie. */
  token: string;
}

export interface RunningApprovalsUi {
  url: string;
  loginUrl: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY = 16 * 1024;

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function headers(res: ServerResponse, type: string): void {
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function card(p: Proposal, csrf: string): string {
  const i = p.intent;
  const size = i["qty"] !== undefined ? `${esc(i["qty"])} units` : i["notionalUsd"] !== undefined ? `$${esc(i["notionalUsd"])}` : "";
  const checks = p.checks.map((c) => `<li class="${esc(c.level)}">${esc(c.level.toUpperCase())}: ${esc(c.message)}</li>`).join("");
  const pending = p.status === "pending";
  return `<section class="card ${esc(p.status)}">
  <h2>${esc(String(i["side"]).toUpperCase())} ${esc(i["symbol"])} <small>(${esc(i["assetClass"])})</small></h2>
  <table>
    <tr><th>proposal</th><td><code>${esc(p.id)}</code></td></tr>
    <tr><th>status</th><td>${esc(p.status)}</td></tr>
    <tr><th>type</th><td>${esc(i["type"])}${i["limitPrice"] !== undefined ? ` @ ${esc(i["limitPrice"])}` : ""}</td></tr>
    <tr><th>size</th><td>${size}</td></tr>
    <tr><th>est. value</th><td>$${esc(p.notionalUsd.toFixed(2))}</td></tr>
    <tr><th>tool</th><td><code>${esc(p.tool)}</code></td></tr>
    <tr><th>expires</th><td>${esc(p.expiresAt)}</td></tr>
  </table>
  ${checks ? `<ul>${checks}</ul>` : ""}
  ${p.rationale ? `<p class="rationale"><b>Agent's rationale (untrusted text, not part of the order):</b><br>${esc(p.rationale)}</p>` : ""}
  ${p.error ? `<p class="error">${esc(p.error)}</p>` : ""}
  ${
    pending
      ? `<form method="post" action="/proposals/${esc(p.id)}/approve">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <label>Type <code>${esc(p.id)}</code> to send this order LIVE: <input name="confirm" autocomplete="off" required></label>
    <button type="submit">Approve and send</button>
  </form>
  <form method="post" action="/proposals/${esc(p.id)}/decline">
    <input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Decline</button>
  </form>`
      : ""
  }
</section>`;
}

function page(core: LeashCore, csrf: string, flash?: string): string {
  const st = core.status();
  const ps = core.listProposals().slice().reverse();
  const pending = ps.filter((p) => p.status === "pending");
  const done = ps.filter((p) => p.status !== "pending").slice(0, 20);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Leash approvals</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}
.card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}.card.pending{border-color:#c80}
th{text-align:left;padding-right:1rem;color:#555;font-weight:normal}li.block{color:#b00}li.warn{color:#a60}
.rationale{background:#f6f6f6;padding:.5rem;border-left:3px solid #999}.error{color:#b00}.flash{background:#eef;padding:.5rem}
form{display:inline-block;margin:.5rem 1rem .5rem 0}button{padding:.4rem .8rem}
</style></head><body>
<h1>Leash approvals</h1>
<p>Rung <b>${esc(st.rung)}</b> · ${esc(st.capsToday.remainingDailyUsd)} USD left today · live trading ${core.config.live.enabled ? "<b>enabled</b>" : "disabled"} · ${pending.length} pending</p>
${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
<h2>Pending</h2>${pending.length ? pending.map((p) => card(p, csrf)).join("") : "<p>Nothing waiting.</p>"}
<h2>Recent</h2>${done.length ? done.map((p) => card(p, csrf)).join("") : "<p>None.</p>"}
<p><small>Approval cards are built from the canonical order fields. Everything is re-checked when you approve. Reload to refresh.</small></p>
</body></html>`;
}

/**
 * Local web UI for deciding proposals, in addition to `leash approve`. Loopback only. Auth: the gateway's bearer
 * token, either as an Authorization header or exchanged once at /login for an HttpOnly, SameSite=Strict cookie.
 * State-changing requests are POST-only and need a CSRF token bound to the session, a same-origin Origin header,
 * and the proposal id typed back. The agent never gets this token.
 */
export async function startApprovalsUi(core: LeashCore, opts: ApprovalsUiOptions): Promise<RunningApprovalsUi> {
  if (!LOOPBACK.has(opts.host)) throw new Error("The approvals UI only binds to loopback.");
  if (!opts.token || opts.token.length < 16) throw new Error("Token must be at least 16 characters.");
  const sessionSecret = randomBytes(32);
  const sessions = new Set<string>();
  const csrfFor = (sid: string): string => createHmac("sha256", sessionSecret).update(sid).digest("base64url");
  let origin = "";

  const authed = (req: IncomingMessage): string | undefined => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
    if (m && safeEqual(m[1] as string, opts.token)) return "bearer";
    const sid = cookies(req)["leash_sid"];
    return sid && sessions.has(sid) ? sid : undefined;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (!LOOPBACK.has(host)) {
        res.writeHead(403).end("bad host");
        return;
      }
      if (url.pathname === "/login" && req.method === "GET") {
        const t = url.searchParams.get("token") ?? "";
        if (!safeEqual(t, opts.token)) {
          res.writeHead(401).end("bad token");
          return;
        }
        const sid = randomBytes(24).toString("base64url");
        sessions.add(sid);
        res.writeHead(303, { location: "/", "set-cookie": `leash_sid=${sid}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
        return;
      }
      const sid = authed(req);
      if (!sid) {
        headers(res, "text/plain; charset=utf-8");
        res.writeHead(401).end("Unauthorized. Open the login URL printed by `leash approvals-ui`.");
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        headers(res, "text/html; charset=utf-8");
        res.writeHead(200).end(page(core, csrfFor(sid), url.searchParams.get("m") ?? undefined));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/proposals") {
        headers(res, "application/json");
        res.writeHead(200).end(JSON.stringify(core.listProposals()));
        return;
      }
      const m = /^\/proposals\/([A-Za-z0-9-]{1,64})\/(approve|decline)$/.exec(url.pathname);
      if (req.method === "POST" && m) {
        const o = req.headers.origin;
        if (o && o !== origin) {
          res.writeHead(403).end("cross-origin request refused");
          return;
        }
        const form = await readForm(req);
        if (sid !== "bearer" && !safeEqual(form.get("csrf") ?? "", csrfFor(sid))) {
          res.writeHead(403).end("bad csrf token");
          return;
        }
        const id = m[1] as string;
        let msg: string;
        try {
          if (m[2] === "decline") {
            await core.declineProposal(id, "human:web");
            msg = `Declined ${id}.`;
          } else {
            if ((form.get("confirm") ?? "").trim() !== id) msg = "Not approved: the typed id did not match.";
            else {
              const out = await core.approveProposal(id, "human:web");
              msg = out.status === "executed" ? `Executed ${id}.` : `Not executed: ${out.error ?? out.status}`;
            }
          }
        } catch (e) {
          msg = errorMessage(e);
        }
        res.writeHead(303, { location: `/?m=${encodeURIComponent(msg)}`, "cache-control": "no-store" }).end();
        return;
      }
      res.writeHead(404).end("not found");
    })().catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(errorMessage(e));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const hostForUrl = opts.host === "::1" ? "[::1]" : opts.host;
  origin = `http://${hostForUrl}:${port}`;
  return {
    url: `${origin}/`,
    loginUrl: `${origin}/login?token=${encodeURIComponent(opts.token)}`,
    async close() {
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}
