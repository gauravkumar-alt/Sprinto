import { afterEach, describe, expect, it, vi } from "vitest";
import { getSnapshot, resetShowroomCache } from "@/lib/showroom";
import { publishSnapshot, supabaseWriteConfig } from "@/lib/showroom-publish";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  resetShowroomCache();
});

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("showroom (Supabase read side)", () => {
  it("serves the empty placeholder when Supabase isn't configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    const f = vi.fn();
    const snap = await getSnapshot(f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
    expect(snap.companies).toEqual({});
  });

  it("reads the single row with the anon key and caches it", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co/";
    process.env.SUPABASE_ANON_KEY = "anon";
    const payload = { generatedAt: "2026-11-04T00:00:00Z", status: { companies: [] }, companies: { c1: { id: "c1" } }, qualification: {} };
    const f = vi.fn(async () => okJson([{ payload }]));
    expect((await getSnapshot(f as unknown as typeof fetch)).companies).toHaveProperty("c1");
    await getSnapshot(f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://abc.supabase.co/rest/v1/showroom_snapshot?id=eq.1&select=payload");
    expect((init.headers as Record<string, string>).apikey).toBe("anon");
  });

  it("keeps the last good copy when Supabase fails", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    const payload = { generatedAt: "x", status: null, companies: { c1: {} }, qualification: {} };
    await getSnapshot((async () => okJson([{ payload }])) as unknown as typeof fetch);
    (globalThis as unknown as { __showroomCache: { at: number } }).__showroomCache.at = 0; // expire
    const snap = await getSnapshot((async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
    expect(snap.companies).toHaveProperty("c1");
  });
});

describe("showroom (publish side)", () => {
  it("does nothing without the service_role key", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(supabaseWriteConfig()).toBeNull();
    const f = vi.fn();
    expect(await publishSnapshot(f as unknown as typeof fetch)).toMatch(/not configured/);
    expect(f).not.toHaveBeenCalled();
  });
});
