/**
 * Delivery-recipient enforcement. This is the backend control that makes it
 * impossible for the app to email a prospect:
 *
 *  - The EmailProvider API has no recipient parameter; the only recipient is DEMO_INBOX_EMAIL.
 *  - Before every send, the authenticated Gmail identity must equal DEMO_INBOX_EMAIL
 *    (and GMAIL_SENDER_EMAIL, if set).
 *  - The final MIME message must have exactly one To address, no Cc/Bcc, and must not
 *    contain any prospect address anywhere in its headers or body.
 *
 * There is intentionally no setting that relaxes any of these checks.
 */
export class RecipientViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipientViolation";
  }
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

export const normEmail = (e: string) => e.trim().toLowerCase();

export function assertDemoInboxConfigured(demoInbox: string): string {
  const v = normEmail(demoInbox);
  if (!v) throw new RecipientViolation("DEMO_INBOX_EMAIL is not set. Sending is blocked until it is configured.");
  if (!EMAIL_RE.test(v)) throw new RecipientViolation(`DEMO_INBOX_EMAIL "${demoInbox}" is not a valid email address.`);
  return v;
}

export function assertIdentityMatchesInbox(params: {
  authenticatedEmail: string | null;
  demoInbox: string;
  configuredSender?: string;
}): void {
  const inbox = assertDemoInboxConfigured(params.demoInbox);
  if (!params.authenticatedEmail) throw new RecipientViolation("Could not verify which Gmail account is authenticated. Sending blocked.");
  const auth = normEmail(params.authenticatedEmail);
  if (auth !== inbox) {
    throw new RecipientViolation(
      `Authenticated Gmail account (${auth}) does not match DEMO_INBOX_EMAIL (${inbox}). Emails may only be sent from and to your own inbox.`,
    );
  }
  if (params.configuredSender && normEmail(params.configuredSender) !== auth) {
    throw new RecipientViolation(`GMAIL_SENDER_EMAIL (${params.configuredSender}) does not match the authenticated account (${auth}).`);
  }
}

/** Parse the header block of a raw RFC 5322 message (unfolding continuation lines). */
function parseHeaders(raw: string): Map<string, string[]> {
  const head = raw.split(/\r?\n\r?\n/)[0];
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const map = new Map<string, string[]>();
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    map.set(k, [...(map.get(k) ?? []), line.slice(i + 1).trim()]);
  }
  return map;
}

function addresses(value: string): string[] {
  return (value.match(/[^\s@<>()",;:]+@[^\s@<>()",;:]+/g) ?? []).map(normEmail);
}

/** Final check on the exact bytes that will be handed to Gmail. */
export function assertMessageSafe(rawMime: string, params: { demoInbox: string; prospectEmails: (string | null | undefined)[] }): void {
  const inbox = assertDemoInboxConfigured(params.demoInbox);
  const headers = parseHeaders(rawMime);
  const to = headers.get("to") ?? [];
  if (to.length !== 1) throw new RecipientViolation(`Message must have exactly one To header (found ${to.length}).`);
  const toAddrs = addresses(to[0]);
  if (toAddrs.length !== 1 || toAddrs[0] !== inbox) {
    throw new RecipientViolation(`To must be exactly ${inbox}; got "${to[0]}".`);
  }
  for (const h of ["cc", "bcc", "resent-to", "resent-cc", "resent-bcc", "delivered-to"]) {
    if (headers.has(h)) throw new RecipientViolation(`Header "${h}" is not allowed on demo deliveries.`);
  }
  // Prospect addresses must not appear anywhere in the message (headers or body, decoded or not).
  const decodedBody = decodeBase64Body(rawMime);
  const decodedHeaders = decodeEncodedWords(rawMime.split(/\r?\n\r?\n/)[0]);
  const haystack = (rawMime + "\n" + decodedHeaders + "\n" + decodedBody).toLowerCase();
  for (const p of params.prospectEmails) {
    if (!p) continue;
    const pe = normEmail(p);
    if (pe === inbox) throw new RecipientViolation("The prospect's address equals the demo inbox; refusing to send.");
    if (haystack.includes(pe)) throw new RecipientViolation("A prospect email address appears in the outgoing message; refusing to send.");
  }
}

/** Decode RFC 2047 encoded-words (=?UTF-8?B?…?= / =?UTF-8?Q?…?=) so encoded headers can be inspected. */
export function decodeEncodedWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf8");
      return Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
    } catch {
      return "";
    }
  });
}

function decodeBase64Body(raw: string): string {
  const parts = raw.split(/\r?\n\r?\n/);
  if (parts.length < 2) return "";
  if (!/content-transfer-encoding:\s*base64/i.test(parts[0])) return parts.slice(1).join("\n\n");
  try {
    return Buffer.from(parts.slice(1).join("").replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}
