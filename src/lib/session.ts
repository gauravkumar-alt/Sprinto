/**
 * Password sign-in for exposing the app beyond localhost (e.g. through a tunnel).
 * Stateless signed cookie: "<expiryMs>.<HMAC-SHA256(APP_PASSWORD, 'v1|' + expiry)>".
 * Changing APP_PASSWORD invalidates every session. Uses Web Crypto so it runs in middleware.
 */
export const SESSION_COOKIE = "outreach_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let s = "";
  for (const b of sig) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Constant-time string comparison (for equal-length hex digests and hashed passwords). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(password: string, now = Date.now()): Promise<string> {
  const exp = now + SESSION_TTL_MS;
  return `${exp}.${await hmac(password, `v1|${exp}`)}`;
}

export async function verifySessionToken(token: string | undefined, password: string, now = Date.now()): Promise<boolean> {
  if (!token || !password) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now || !sig) return false;
  return safeEqual(sig, await hmac(password, `v1|${exp}`));
}

/** Compare a submitted password with APP_PASSWORD without leaking timing or length. */
export async function passwordMatches(submitted: string, password: string): Promise<boolean> {
  if (!password) return false;
  const [a, b] = await Promise.all([hmac("pw-compare", submitted), hmac("pw-compare", password)]);
  return safeEqual(a, b);
}
