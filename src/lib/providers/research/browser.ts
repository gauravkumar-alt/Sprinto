/**
 * Headless-browser fallback (Playwright) for pages whose content only appears after JavaScript runs.
 * Used only when plain HTML yields too little text, and only for URLs robots.txt already allowed.
 *
 * Safety: the browser makes its own network requests, so every request is checked here —
 * http(s) only, no private/loopback/link-local destinations (DNS resolved and checked per host),
 * top-level navigation must stay on the company's domain, and images/media/fonts are skipped.
 * No logins, no form submission, no CAPTCHA handling.
 */
import dns from "node:dns/promises";
import net from "node:net";
import type { Browser } from "playwright-core";
import { isPrivateAddress } from "@/lib/security/ssrf";
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

const hostVerdict = new Map<string, Promise<boolean>>();
function hostIsPublic(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, "");
  if (net.isIP(h)) return Promise.resolve(!isPrivateAddress(h));
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(h)) return Promise.resolve(false);
  let v = hostVerdict.get(h);
  if (!v) {
    v = dns
      .lookup(h, { all: true })
      .then((addrs) => addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address)))
      .catch(() => false);
    hostVerdict.set(h, v);
  }
  return v;
}

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
      if (["image", "media", "font"].includes(req.resourceType())) return route.abort();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !sameSite(u, domain)) return route.abort();
      if (!(await hostIsPublic(u.hostname))) return route.abort();
      return route.continue();
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
