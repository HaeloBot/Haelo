import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startApprovalsUi, type RunningApprovalsUi } from "../src/server/approvals-ui.js";
import { solanaHarness, type Harness } from "./helpers/harness.js";

const TOKEN = "ui-token-0123456789abcdef";
let h: Harness | undefined;
let ui: RunningApprovalsUi | undefined;
afterEach(async () => {
  await ui?.close();
  await h?.cleanup();
  ui = h = undefined;
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const u = new URL(ui?.url ?? "");
  return new Promise((resolve, reject) => {
    const r = request({ host: u.hostname, port: u.port, path, method, headers: opts.headers ?? {} }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end(opts.body);
  });
}

async function withProposal(): Promise<string> {
  h = await solanaHarness({ ladder: { start: "propose" } });
  await h.core.callTool("place_order", { symbol: "SOL", side: "buy", notional_usd: 60, confirm: true, rationale: "<script>alert(1)</script> buy the dip" });
  ui = await startApprovalsUi(h.core, { host: "127.0.0.1", port: 0, token: TOKEN });
  return h.core.listProposals()[0]?.id as string;
}

async function login(): Promise<{ cookie: string; csrf: string; page: string }> {
  const r = await call("GET", `/login?token=${TOKEN}`);
  expect(r.status).toBe(303);
  const cookie = String((r.headers["set-cookie"] as string[])[0]).split(";")[0] as string;
  expect(String((r.headers["set-cookie"] as string[])[0])).toMatch(/HttpOnly; SameSite=Strict/);
  const page = await call("GET", "/", { headers: { cookie } });
  expect(page.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] as string;
  return { cookie, csrf, page: page.body };
}

const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();
const formHeaders = (cookie: string, origin?: string): Record<string, string> => ({ cookie, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) });

describe("web approvals UI", () => {
  it("requires auth and refuses a bad login token", async () => {
    await withProposal();
    expect((await call("GET", "/")).status).toBe(401);
    expect((await call("GET", "/login?token=wrong")).status).toBe(401);
    expect((await call("GET", "/api/proposals", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("refuses a non-loopback Host header (DNS rebinding)", async () => {
    await withProposal();
    expect((await call("GET", "/", { headers: { host: "evil.example.com", authorization: `Bearer ${TOKEN}` } })).status).toBe(403);
  });

  it("shows the canonical card, escapes agent text, and sets strict security headers", async () => {
    const id = await withProposal();
    const { page } = await login();
    expect(page).toContain(id);
    expect(page).toContain("BUY SOL/USDC");
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
    const r = await call("GET", "/", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });

  it("rejects approval without a CSRF token, from a foreign origin, or with a mistyped id", async () => {
    const id = await withProposal();
    const { cookie, csrf } = await login();
    expect((await call("POST", `/proposals/${id}/approve`, { headers: formHeaders(cookie), body: form({ confirm: id }) })).status).toBe(403);
    expect((await call("POST", `/proposals/${id}/approve`, { headers: formHeaders(cookie, "https://evil.example.com"), body: form({ csrf, confirm: id }) })).status).toBe(403);
    const typo = await call("POST", `/proposals/${id}/approve`, { headers: formHeaders(cookie), body: form({ csrf, confirm: "nope" }) });
    expect(typo.status).toBe(303);
    expect(decodeURIComponent(String(typo.headers.location))).toContain("did not match");
    expect(h?.executed()).toBe(0);
  });

  it("approves with CSRF + typed id and sends exactly that order", async () => {
    const id = await withProposal();
    const { cookie, csrf } = await login();
    const origin = ui?.url.replace(/\/$/, "") as string;
    const r = await call("POST", `/proposals/${id}/approve`, { headers: formHeaders(cookie, origin), body: form({ csrf, confirm: id }) });
    expect(r.status).toBe(303);
    expect(decodeURIComponent(String(r.headers.location))).toContain(`Executed ${id}`);
    expect(h?.executed()).toBe(1);
    expect(h?.core.getProposal(id)?.decidedBy).toBe("human:web");
    const again = await call("POST", `/proposals/${id}/approve`, { headers: formHeaders(cookie), body: form({ csrf, confirm: id }) });
    expect(decodeURIComponent(String(again.headers.location))).toMatch(/not pending/);
  });

  it("declines", async () => {
    const id = await withProposal();
    const { cookie, csrf } = await login();
    const r = await call("POST", `/proposals/${id}/decline`, { headers: formHeaders(cookie), body: form({ csrf }) });
    expect(decodeURIComponent(String(r.headers.location))).toContain("Declined");
    expect(h?.core.getProposal(id)?.status).toBe("declined");
    const page = await call("GET", "/?m=hello", { headers: { cookie } });
    expect(page.body).toContain("Nothing waiting");
    expect(page.body).toContain("hello");
  });

  it("refuses non-loopback binds, short tokens, oversized bodies and unknown routes", async () => {
    const id = await withProposal();
    await expect(startApprovalsUi(h?.core as Harness["core"], { host: "0.0.0.0", port: 0, token: TOKEN })).rejects.toThrow(/loopback/);
    await expect(startApprovalsUi(h?.core as Harness["core"], { host: "127.0.0.1", port: 0, token: "short" })).rejects.toThrow(/16/);
    expect((await call("GET", "/nope", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    const big = await call("POST", `/proposals/${id}/decline`, { headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: "x=" + "a".repeat(20_000) }).catch(() => ({ status: 500 }) as Res);
    expect(big.status).toBe(500);
    expect(h?.core.getProposal(id)?.status).toBe("pending");
  });
});
