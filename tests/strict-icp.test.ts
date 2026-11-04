import { describe, expect, it, vi } from "vitest";

describe("already-certified setting", () => {
  it("defaults to disqualifying (Sprinto Evidence Map); ALREADY_CERTIFIED_QUALIFIES=true opts out", async () => {
    vi.resetModules();
    delete process.env.ALREADY_CERTIFIED_QUALIFIES;
    expect((await import("@/lib/config")).ALREADY_CERTIFIED_QUALIFIES).toBe(false);
    vi.resetModules();
    process.env.ALREADY_CERTIFIED_QUALIFIES = "true";
    expect((await import("@/lib/config")).ALREADY_CERTIFIED_QUALIFIES).toBe(true);
    delete process.env.ALREADY_CERTIFIED_QUALIFIES;
    vi.resetModules();
  });
});
