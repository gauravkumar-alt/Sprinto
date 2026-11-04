/**
 * Request guard (the app is a single-user tool, no sign-in):
 *  - Host must be loopback or listed in ALLOWED_HOSTS (blocks DNS-rebinding attacks).
 *    Entries may use a leading wildcard, e.g. "*.trycloudflare.com" for a tunnel you run.
 *  - Through any non-loopback host (e.g. a shared tunnel link) the app is READ-ONLY:
 *    viewers can browse results, but running the agent, editing contacts, sending email
 *    and Gmail authorisation only work from the machine itself (localhost).
 *  - State-changing requests must come from this same origin and be JSON (blocks CSRF).
 */
import { NextResponse, type NextRequest } from "next/server";
import { isShowroom } from "@/lib/showroom-flag";
import { isLoopbackHost as isLoopback } from "@/lib/viewer";

const hostname = (hostHeader: string) => hostHeader.toLowerCase().replace(/:\d+$/, "");

export function hostAllowed(hostHeader: string | null, extra: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostname(hostHeader);
  if (isLoopback(host)) return true;
  return extra.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern));
}

const deny = (status: number, error: string) => NextResponse.json({ error }, { status });

export function middleware(req: NextRequest) {
  // Showroom (e.g. Vercel): a frozen, already-masked snapshot with no database or keys behind it.
  // Any host may read it; nothing can be changed and Gmail authorisation is off.
  if (isShowroom()) {
    if (req.method !== "GET" && req.method !== "HEAD") return deny(403, "Read-only snapshot. Run the agent on the computer it's installed on.");
    if (req.nextUrl.pathname.startsWith("/api/auth/")) return deny(403, "Not available in the snapshot.");
    return NextResponse.next();
  }
  const extra = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = req.headers.get("host");
  const path = req.nextUrl.pathname;
  const readOnly = !isLoopback(host);

  if (!hostAllowed(host, extra)) return deny(403, "Forbidden host");

  if (readOnly) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return deny(403, "This shared link is view-only. Run the agent from the computer it runs on (localhost).");
    }
    if (path.startsWith("/api/auth/")) return deny(403, "Gmail authorisation is only available on localhost.");
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    let originHost = "";
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : "";
    } catch {
      originHost = ""; // "null" or malformed origins are rejected below
    }
    if (!originHost || originHost !== host!.toLowerCase()) return deny(403, "Cross-origin request blocked");
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return deny(415, "Content-Type must be application/json");
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
