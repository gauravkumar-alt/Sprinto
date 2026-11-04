import { describe, expect, it, vi } from "vitest";

describe("strict ICP setting", () => {
  it("ALREADY_CERTIFIED_QUALIFIES=false restores the case's strict rule", async () => {
    vi.resetModules();
    process.env.ALREADY_CERTIFIED_QUALIFIES = "false";
    const { QUALIFYING_TRIGGERS } = await import("@/lib/config");
    expect(QUALIFYING_TRIGGERS.audit).not.toContain("already_certified");
    delete process.env.ALREADY_CERTIFIED_QUALIFIES;
    vi.resetModules();
    const fresh = await import("@/lib/config");
    expect(fresh.QUALIFYING_TRIGGERS.audit).toContain("already_certified");
  });
});
