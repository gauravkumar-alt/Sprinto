/**
 * Who is looking: the machine itself (localhost) or a viewer through a shared link.
 * Shared-link viewers get a read-only view with email addresses partly masked.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostHeader: string | null): boolean {
  return Boolean(hostHeader && LOOPBACK.has(hostHeader.toLowerCase().replace(/:\d+$/, "")));
}

export const isRemoteViewer = (req: Request) => !isLoopbackHost(req.headers.get("host"));

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** "gaurav_kumar@pg27.mesaschool.co" → "g•••@pg27.mesaschool.co" */
export const maskEmails = (s: string) => s.replace(EMAIL, "$1•••@$2");

/** Mask every email address anywhere in a JSON-serialisable payload. */
export function maskPayload<T>(payload: T): T {
  return JSON.parse(maskEmails(JSON.stringify(payload))) as T;
}
