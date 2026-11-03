/** Builds a plain-text RFC 5322 message. Header values are stripped of CR/LF to prevent header injection. */
const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function encodeHeader(s: string): string {
  const v = clean(s);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

export function buildMime(p: { fromName: string; fromEmail: string; to: string; subject: string; body: string }): string {
  const body64 = Buffer.from(p.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return [
    `From: ${encodeHeader(p.fromName)} <${clean(p.fromEmail)}>`,
    `To: <${clean(p.to)}>`,
    `Subject: ${encodeHeader(p.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "X-Outreach-Demo: self-delivery-only",
    "",
    body64,
  ].join("\r\n");
}

export const toBase64Url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
