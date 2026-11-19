import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/companies/[id]/actions/route";
import { getDb } from "@/lib/db";
import { processCompany } from "@/lib/pipeline/orchestrator";
import * as repo from "@/lib/repo";
import { freshDb, useProviders } from "./helpers";

const act = (id: number, body: unknown) =>
  POST(new Request("http://127.0.0.1/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) });

async function reviewCompany() {
  const id = repo.upsertCompany("ledgerly.example", "mock");
  const { runIds } = repo.createBatch("test", "demo", [id]);
  expect(await processCompany(runIds[0])).toBe("needs_review");
  return id;
}

describe("human review: approve / reject", () => {
  beforeEach(() => freshDb());

  it("reject marks the company not qualified with the reviewer's reason, and nothing is sent", async () => {
    useProviders();
    const id = await reviewCompany();
    const res = await act(id, { action: "reject", note: "Agency, not a product company" });
    expect(res.status).toBe(200);
    const q = repo.latestQualification(id)!;
    expect(q.decision).toBe("not_qualified");
    expect(q.override_note).toBe("Rejected: Agency, not a product company");
    expect(q.explanation).toContain("Rejected by reviewer");
    expect(getDb().prepare("SELECT COUNT(*) n FROM emails").get()).toEqual({ n: 0 });
    // Already decided: a second reject (or an approve) is refused.
    expect((await act(id, { action: "reject" })).status).toBe(400);
    expect((await act(id, { action: "approve", note: "changed my mind" })).status).toBe(400);
  });

  it("approve needs a reason", async () => {
    useProviders();
    const id = await reviewCompany();
    expect((await act(id, { action: "approve", note: "ok" })).status).toBe(400);
  });
});
