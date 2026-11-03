/**
 * Request guard for the API (the app is a local, single-user tool):
 *  - Host must be a loopback name (blocks DNS-rebinding attacks from other websites).
 *  - State-changing requests must come from this same origin and be JSON
 *    (blocks cross-site "simple" POSTs, i.e. CSRF).
 * Extra hostnames (e.g. a tunnel you control) can be allowed via ALLOWED_HOSTS=host1,host2.
 */
import { NextResponse, type NextRequest } from "next/server";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function hostAllowed(hostHeader: string | null, extra: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK.has(host) || extra.includes(host);
}

export function middleware(req: NextRequest) {
  const extra = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = req.headers.get("host");
  if (!hostAllowed(host, extra)) {
    return NextResponse.json({ error: "Forbidden host" }, { status: 403 });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    let originHost = "";
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : "";
    } catch {
      originHost = ""; // "null" or malformed origins are rejected below
    }
    if (!originHost || originHost !== host!.toLowerCase()) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
