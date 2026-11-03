import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { afterEach } from "vitest";
import { hostAllowed, middleware } from "@/middleware";
import { SESSION_COOKIE, createSessionToken, verifySessionToken } from "@/lib/session";
import * as cheerio from "cheerio";
import { embeddedSentences, extractHtml } from "@/lib/providers/research/html";
import { scoreUrl } from "@/lib/providers/research/prioritize";

const req = (method: string, headers: Record<string, string>, url = "http://localhost:3123/api/batches") =>
  new NextRequest(url, { method, headers, body: method === "POST" ? "{}" : undefined });

describe("API request guard", () => {
  it("allows loopback hosts only (DNS-rebinding defence)", () => {
    expect(hostAllowed("localhost:3123", [])).toBe(true);
    expect(hostAllowed("127.0.0.1:3000", [])).toBe(true);
    expect(hostAllowed("attacker.example:3123", [])).toBe(false);
    expect(hostAllowed(null, [])).toBe(false);
    expect(hostAllowed("demo.mytunnel.dev", ["demo.mytunnel.dev"])).toBe(true);
    expect(hostAllowed("abc-def.trycloudflare.com", ["*.trycloudflare.com"])).toBe(true);
    expect(hostAllowed("trycloudflare.com", ["*.trycloudflare.com"])).toBe(false);
    expect(hostAllowed("evil-trycloudflare.com", ["*.trycloudflare.com"])).toBe(false);
  });

  it("blocks cross-site and non-JSON state-changing requests (CSRF)", async () => {
    const ok = { host: "localhost:3123", origin: "http://localhost:3123", "content-type": "application/json" };
    expect((await middleware(req("POST", ok))).status).toBe(200);
    expect((await middleware(req("POST", { ...ok, origin: "https://evil.example" }))).status).toBe(403);
    expect((await middleware(req("POST", { host: ok.host, "content-type": ok["content-type"] }))).status).toBe(403);
    expect((await middleware(req("POST", { ...ok, "content-type": "text/plain" }))).status).toBe(415);
    expect((await middleware(req("GET", { host: "evil.example" }))).status).toBe(403);
    expect((await middleware(req("GET", { host: "localhost:3123" }))).status).toBe(200);
    expect((await middleware(req("POST", { ...ok, origin: "null" }))).status).toBe(403); // sandboxed iframes / file:// pages
  });
});

describe("password sign-in for remote access", () => {
  afterEach(() => {
    delete process.env.APP_PASSWORD;
    delete process.env.ALLOWED_HOSTS;
  });
  const tunnel = "https://abc.trycloudflare.com";

  it("refuses non-local hosts entirely when no password is set", async () => {
    process.env.ALLOWED_HOSTS = "*.trycloudflare.com";
    expect((await middleware(req("GET", { host: "abc.trycloudflare.com" }, `${tunnel}/`))).status).toBe(403);
  });

  it("requires a valid session for pages and APIs, but not for /login", async () => {
    process.env.ALLOWED_HOSTS = "*.trycloudflare.com";
    process.env.APP_PASSWORD = "correct horse battery staple";
    const page = await middleware(req("GET", { host: "abc.trycloudflare.com" }, `${tunnel}/companies/3`));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/login?next=%2Fcompanies%2F3");
    const viaTunnel = await middleware(req("GET", { host: "abc.trycloudflare.com", "x-forwarded-proto": "https" }, "http://127.0.0.1:3123/"));
    expect(viaTunnel.headers.get("location")).toBe("https://abc.trycloudflare.com/login");
    expect((await middleware(req("GET", { host: "abc.trycloudflare.com" }, `${tunnel}/api/status`))).status).toBe(401);
    expect((await middleware(req("GET", { host: "abc.trycloudflare.com" }, `${tunnel}/login`))).status).toBe(200);

    const token = await createSessionToken(process.env.APP_PASSWORD);
    const authed = { host: "abc.trycloudflare.com", cookie: `${SESSION_COOKIE}=${token}` };
    expect((await middleware(req("GET", authed, `${tunnel}/api/status`))).status).toBe(200);
    expect((await middleware(req("GET", { ...authed, cookie: `${SESSION_COOKIE}=${token}x` }, `${tunnel}/api/status`))).status).toBe(401);
  });

  it("session tokens expire and are bound to the password", async () => {
    const t = await createSessionToken("pw1", 0);
    expect(await verifySessionToken(t, "pw1", 1000)).toBe(true);
    expect(await verifySessionToken(t, "pw2", 1000)).toBe(false);
    expect(await verifySessionToken(t, "pw1", 13 * 3600 * 1000)).toBe(false);
  });
});

describe("crawler improvements", () => {
  it("recovers prose from embedded JSON on JS-rendered pages, but not code", () => {
    const html = `<html><body><div id="root"></div>
      <script>self.__next_f.push([1,"We are currently preparing for our SOC 2 Type II audit this year."])</script>
      <script>var x = "function(){ return a < b && c; } and more code tokens here"</script>
      <script type="application/ld+json">{"description":"Acme helps finance teams close their books faster every month."}</script>
      </body></html>`;
    const ex = extractHtml(html, "https://acme.com/", 10_000);
    expect(ex.text).toContain("preparing for our SOC 2 Type II audit");
    expect(ex.text).toContain("close their books faster");
    expect(ex.text).not.toContain("function(");
    expect(embeddedSentences(cheerio.load(`<script>"short"</script>`))).toEqual([]);
  });

  it("treats trust-centre subdomains as security pages", () => {
    expect(scoreUrl("https://trust.acme.com/", "acme.com")).toMatchObject({ tag: "security/compliance" });
    expect(scoreUrl("https://acme.com/", "acme.com")).toMatchObject({ tag: "homepage" });
    expect(scoreUrl("https://evil.com/", "acme.com")).toBeNull();
  });
});

describe("embedded page data", () => {
  it("reports where visible text ends so hidden-data quotes can be downgraded", () => {
    const ex = extractHtml(
      `<html><body><main><p>Acme builds billing software for SaaS companies.</p></main><script>x("We are currently preparing for our SOC 2 Type II audit this year.")</script></body></html>`,
      "https://acme.com/",
      10_000,
    );
    expect(ex.text.slice(0, ex.visibleChars)).toContain("billing software");
    expect(ex.text.slice(0, ex.visibleChars)).not.toContain("SOC 2");
    expect(ex.text.slice(ex.visibleChars)).toContain("preparing for our SOC 2");
  });
});
