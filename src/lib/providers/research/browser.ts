/**
 * Headless-browser fallback (Playwright) for pages whose content only appears after JavaScript runs.
 * Used only when plain HTML yields too little text, and only for URLs robots.txt already allowed.
 *
 * Safety: Chromium never touches the network itself. Every request is intercepted and fetched by the
 * agent's own SSRF-safe client (DNS resolved once and pinned, private/loopback/link-local addresses refused,
 * redirects re-checked), then handed back to the page. Only GET requests for documents, scripts, styles and
 * data on ports 80/443; WebSockets are closed; images/media/fonts skipped; top-level navigation must stay on
 * the company's domain. No logins, no form submission, no CAPTCHA handling.
 */
import type { Browser } from "playwright-core";
import { safeFetch } from "@/lib/security/ssrf";
import { sameSite } from "./prioritize";

const g = globalThis as unknown as { __outreachBrowser?: Promise<Browser | null> };

async function getBrowser(): Promise<Browser | null> {
  g.__outreachBrowser ??= (async () => {
    try {
      const { chromium } = await import("playwright-core");
      const b = await chromium.launch({ headless: true });
      process.once("exit", () => void b.close().catch(() => {}));
      return b;
    } catch {
      return null; // Playwright or its browser isn't installed: the fallback is simply unavailable.
    }
  })();
  return g.__outreachBrowser;
}

const ALLOWED_TYPES = new Set(["document", "script", "stylesheet", "xhr", "fetch"]);

export interface RenderedPage {
  html: string;
  finalUrl: string;
}

export async function renderWithBrowser(url: string, domain: string, opts: { timeoutMs: number; userAgent: string }): Promise<RenderedPage | null> {
  const browser = await getBrowser();
  if (!browser) return null;
  const context = await browser.newContext({ userAgent: opts.userAgent, acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true });
  try {
    const page = await context.newPage();
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await page.route("**/*", async (route) => {
      const req = route.request();
      let u: URL;
      try {
        u = new URL(req.url());
      } catch {
        return route.abort();
      }
      if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
      if (u.protocol !== "http:" && u.protocol !== "https:") return route.abort();
      if (u.port && u.port !== "80" && u.port !== "443") return route.abort();
      if (req.method() !== "GET" || !ALLOWED_TYPES.has(req.resourceType())) return route.abort();
      const topLevel = req.isNavigationRequest() && req.frame() === page.mainFrame();
      if (topLevel && !sameSite(u, domain)) return route.abort();
      try {
        const r = await safeFetch(u.toString(), { timeoutMs: opts.timeoutMs, maxRedirects: 3, maxBytes: 3_000_000, userAgent: opts.userAgent, accept: req.headers()["accept"] ?? "*/*" });
        if (topLevel && !sameSite(new URL(r.finalUrl), domain)) return route.abort();
        return route.fulfill({ status: r.status, contentType: r.contentType || undefined, body: r.body });
      } catch {
        return route.abort();
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(6000, opts.timeoutMs) }).catch(() => {});
    const finalUrl = page.url();
    if (!sameSite(new URL(finalUrl), domain)) return null;
    return { html: await page.content(), finalUrl };
  } catch {
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}
