/**
 * Who is looking: the machine itself (localhost) or a viewer through a shared link.
 * Shared-link viewers get a read-only view with email addresses partly masked.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostHeader: string | null): boolean {
  return Boolean(hostHeader && LOOPBACK.has(hostHeader.toLowerCase().replace(/:\d+$/, "")));
}

const LOOPBACK_IP = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost|unknown)$/i;

/**
 * A request counts as local only if the Host is loopback AND no proxy header names a non-local client.
 * Tunnels (cloudflared, ngrok) can rewrite Host to "localhost", but they still add the visitor's IP here.
 */
export function isRemoteRequest(headers: Headers): boolean {
  if (!isLoopbackHost(headers.get("host"))) return true;
  if (headers.get("cf-connecting-ip") || headers.get("cf-ray") || headers.get("ngrok-trace-id")) return true;
  const ips = [
    ...(headers.get("x-forwarded-for") ?? "").split(","),
    headers.get("x-real-ip") ?? "",
    ...[...(headers.get("forwarded") ?? "").matchAll(/for="?\[?([^\]";,]+)/gi)].map((m) => m[1]),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  if (ips.some((ip) => !LOOPBACK_IP.test(ip))) return true;
  const fwdHost = headers.get("x-forwarded-host");
  return Boolean(fwdHost && !isLoopbackHost(fwdHost.split(",")[0].trim()));
}

export const isRemoteViewer = (req: Request) => isRemoteRequest(req.headers);

const EMAIL = /([A-Za-z0-9._%+'-])[A-Za-z0-9._%+'-]*(?:@|%40)([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;

/**
 * "gaurav_kumar@pg27.mesaschool.co" → "g•••@pg27.mesaschool.co" (also catches URL-encoded "%40").
 * Addresses in `keep` (the decision-makers' work emails, shown by the owner's choice) stay in full.
 */
export const maskEmails = (s: string, keep: Iterable<string> = []) => {
  const k = new Set([...keep].map((e) => e.toLowerCase()));
  return s.replace(EMAIL, (m, first: string, domain: string) => (k.has(m.toLowerCase()) ? m : `${first}•••@${domain}`));
};

/** Any unmasked address left that isn't in `keep` (used to refuse publishing). */
export const hasFullEmail = (s: string, keep: Iterable<string> = []) => {
  const k = new Set([...keep].map((e) => e.toLowerCase()));
  return [...s.matchAll(/[A-Za-z0-9._%+'-]{2,}(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi)].some((m) => !k.has(m[0].toLowerCase()));
};

type Row = Record<string, unknown>;
/**
 * What a shared-link or public viewer may see of one company: an allowlist. Only the selected decision-maker
 * (name, title and work email), no other people Hunter returned, no contact-source evidence, no Gmail ids.
 */
export function publicCompanyDetail<T extends Row | null>(detail: T): T {
  if (!detail) return detail;
  const d = { ...detail } as Row;
  const contacts = (d.contacts as Row[] | undefined) ?? [];
  d.contacts = contacts
    .filter((c) => c.selected)
    .map((c) => ({ id: c.id, name: c.name, first_name: c.first_name, title: c.title, department: c.department, role_category: c.role_category, rank: c.rank, selected: c.selected, eligible: c.eligible, reason: c.reason, provider: c.provider, data_source: c.data_source, confidence: c.confidence, verification_status: c.verification_status, evidence_ids_json: "[]", business_email: c.business_email }));
  d.evidence = ((d.evidence as Row[] | undefined) ?? []).filter((e) => !/contact|hunter/i.test(`${e.category ?? ""} ${e.source_type ?? ""}`));
  d.sends = ((d.sends as Row[] | undefined) ?? []).map((s) => ({ id: s.id, status: s.status, provider: s.provider, delivery_recipient: s.delivery_recipient, attempted_at: s.attempted_at, completed_at: s.completed_at, error: s.error ? "Delivery error (details on the agent's computer)" : null }));
  return maskPayload(d, contactEmailsOf(d)) as T;
}

/** The selected decision-makers' work emails in a payload — the only addresses shown in full to viewers. */
export function contactEmailsOf(payload: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Row;
      if (typeof o.contactEmail === "string") out.add(o.contactEmail);
      if (o.selected && typeof o.business_email === "string") out.add(o.business_email);
      Object.values(o).forEach(walk);
    }
  };
  walk(payload);
  return [...out];
}

/** Mask every email address anywhere in a JSON-serialisable payload. */
export function maskPayload<T>(payload: T, keep: Iterable<string> = []): T {
  return JSON.parse(maskEmails(JSON.stringify(payload), keep)) as T;
}
