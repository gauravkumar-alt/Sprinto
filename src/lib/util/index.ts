import crypto from "node:crypto";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export const clamp01 = (n: unknown): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  // models sometimes answer on a 0-100 scale
  const scaled = v > 1 ? v / 100 : v;
  return Math.max(0, Math.min(1, scaled));
};

/** Lowercase, collapse whitespace and normalise quotes/dashes for verbatim matching. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export class TransientError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "TransientError";
  }
}

/** Retry only errors marked transient, with exponential backoff and jitter. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseMs?: number; maxMs?: number } = { retries: 2 },
): Promise<T> {
  const base = opts.baseMs ?? 800;
  const max = opts.maxMs ?? 10_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof TransientError) || attempt === opts.retries) throw err;
      const wait = err.retryAfterMs ?? Math.min(max, base * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Minimal p-limit: run at most `n` tasks at once. */
export function createLimiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    queue.shift()!();
  };
  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

/** Spaces out calls that share a key (e.g. a hostname or an API) by at least `minIntervalMs`. */
export class KeyedRateLimiter {
  private nextSlot = new Map<string, number>();
  constructor(private minIntervalMs: number) {}
  async wait(key: string, intervalMs = this.minIntervalMs) {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(key) ?? 0);
    this.nextSlot.set(key, slot + intervalMs);
    if (slot > now) await sleep(slot - now);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
