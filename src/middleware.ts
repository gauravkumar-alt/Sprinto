/**
 * Request guard (the app is a single-user tool):
 *  - Host must be loopback or listed in ALLOWED_HOSTS (blocks DNS-rebinding attacks).
 *    Entries may use a leading wildcard, e.g. "*.trycloudflare.com" for a tunnel you run.
 *  - If APP_PASSWORD is set, every page and API call requires a signed session cookie
 *    (sign in at /login). Non-loopback hosts are refused outright when no password is set,
 *    so the app can never be exposed by accident.
 *  - State-changing requests must come from this same origin and be JSON (blocks CSRF).
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Reachable without a session: the sign-in page and the sign-in endpoint. */
const PUBLIC_PATHS = new Set(["/login", "/api/session"]);

const hostname = (hostHeader: string) => hostHeader.toLowerCase().replace(/:\d+$/, "");

export function isLoopback(hostHeader: string | null): boolean {
  return Boolean(hostHeader && LOOPBACK.has(hostname(hostHeader)));
}

export function hostAllowed(hostHeader: string | null, extra: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostname(hostHeader);
  if (LOOPBACK.has(host)) return true;
  return extra.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern));
}

function deny(req: NextRequest, status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function middleware(req: NextRequest) {
  const extra = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const password = process.env.APP_PASSWORD ?? "";
  const host = req.headers.get("host");
  const path = req.nextUrl.pathname;
  const isApi = path.startsWith("/api/");

  if (!hostAllowed(host, extra)) return deny(req, 403, "Forbidden host");
  if (!password && !isLoopback(host)) return deny(req, 403, "Remote access is disabled until APP_PASSWORD is set");

  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    let originHost = "";
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : "";
    } catch {
      originHost = ""; // "null" or malformed origins are rejected below
    }
    if (!originHost || originHost !== host!.toLowerCase()) return deny(req, 403, "Cross-origin request blocked");
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return deny(req, 415, "Content-Type must be application/json");
    }
  }

  if (password && !PUBLIC_PATHS.has(path)) {
    const ok = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value, password);
    if (!ok) {
      if (isApi) return deny(req, 401, "Sign in required");
      // Built from the (already allow-listed) Host header, so it is correct behind a tunnel/proxy
      // where the server's own URL (127.0.0.1) is not the public one.
      const proto = (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "")).split(",")[0].trim() === "https" ? "https" : "http";
      const target = new URL(path !== "/" ? `/login?next=${encodeURIComponent(path)}` : "/login", `${proto}://${host}`);
      return NextResponse.redirect(target);
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
