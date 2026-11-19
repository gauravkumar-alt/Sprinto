import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { KilledError, killSwitchOn, setKillSwitch } from "@/lib/kill-switch";
import { processCompany } from "@/lib/pipeline/orchestrator";
import { qualificationPrompt } from "@/lib/prompts";
import type { ContactProvider } from "@/lib/providers/contact/types";
import { MockContactProvider } from "@/lib/providers/contact/mock";
import { runPrompt } from "@/lib/providers/llm";
import * as repo from "@/lib/repo";
import { freshDb, useProviders } from "./helpers";

function queue(domain: string) {
  const id = repo.upsertCompany(domain, "mock");
  const { runIds, batchId } = repo.createBatch("test", "demo", [id]);
  return { companyId: id, runId: runIds[0], batchId };
}
const runRow = (id: number) => getDb().prepare("SELECT status, outcome, error_log FROM agent_runs WHERE id=?").get(id) as { status: string; outcome: string; error_log: string };

describe("kill switch", () => {
  beforeEach(() => freshDb());
  afterEach(() => {
    delete process.env.AGENT_KILL_SWITCH;
  });

  it("cancels queued runs at once and keeps them from starting", async () => {
    useProviders();
    const a = queue("vaultlane.example");
    expect(setKillSwitch(true)).toEqual({ on: true, cancelled: 1 });
    expect(runRow(a.runId)).toMatchObject({ status: "failed", outcome: "failed" });
    expect(runRow(a.runId).error_log).toContain("kill switch");
    expect(await processCompany(a.runId)).toBe("failed");
    expect(getDb().prepare("SELECT COUNT(*) n FROM stage_events WHERE agent_run_id=?").get(a.runId)).toEqual({ n: 0 });
    expect((getDb().prepare("SELECT status FROM batches WHERE id=?").get(a.batchId) as { status: string }).status).not.toBe("running");
  });

  it("stops a running company at its next step, before any email is written or sent", async () => {
    // The kill switch is flipped while the contact search is running.
    const inner = new MockContactProvider();
    const contact: ContactProvider = {
      name: "flip",
      dataSource: "mock",
      domainSearch: async (d: string) => {
        setKillSwitch(true);
        return inner.domainSearch(d);
      },
    };
    useProviders({ contact });
    const a = queue("vaultlane.example");
    expect(await processCompany(a.runId)).toBe("failed");
    expect(runRow(a.runId).error_log).toContain("kill switch");
    expect(getDb().prepare("SELECT COUNT(*) n FROM emails").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) n FROM email_sends").get()).toEqual({ n: 0 });
  });

  it("blocks AI calls, can be resumed, and can be forced on from the environment", async () => {
    useProviders();
    setKillSwitch(true);
    await expect(runPrompt({ name: "m", model: "m", dataSource: "mock", complete: async () => ({ model: "m", text: "{}" }) }, qualificationPrompt, {} as never)).rejects.toBeInstanceOf(KilledError);
    setKillSwitch(false);
    expect(killSwitchOn()).toBe(false);
    process.env.AGENT_KILL_SWITCH = "true";
    expect(killSwitchOn()).toBe(true);
  });
});

describe("source cap", () => {
  beforeEach(() => freshDb());
  it("reads at most 5 sources per company (website + outside together)", async () => {
    useProviders();
    const a = queue("ledgerly.example");
    await processCompany(a.runId);
    const pages = getDb().prepare("SELECT COUNT(*) n FROM pages WHERE company_id=?").get(a.companyId) as { n: number };
    expect(pages.n).toBeLessThanOrEqual(5);
    const rr = getDb().prepare("SELECT sources_checked FROM research_runs WHERE company_id=? ORDER BY id DESC").get(a.companyId) as { sources_checked: number };
    expect(rr.sources_checked).toBeLessThanOrEqual(5);
  });
});
