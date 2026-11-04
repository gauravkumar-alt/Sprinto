import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { processCompany, retrySend } from "@/lib/pipeline/orchestrator";
import type { ContactProvider } from "@/lib/providers/contact/types";
import { MockContactProvider } from "@/lib/providers/contact/mock";
import type { EmailProvider } from "@/lib/providers/email/types";
import { EmailSendError } from "@/lib/providers/email/types";
import type { CrawlSession, ResearchProvider } from "@/lib/providers/research/types";
import * as repo from "@/lib/repo";
import { ScriptedLLM, findings, freshDb, useProviders } from "./helpers";

function run(domain: string) {
  const id = repo.upsertCompany(domain, "mock");
  const { runIds } = repo.createBatch("test", "demo", [id]);
  return { companyId: id, runId: runIds[0] };
}
const stages = (runId: number) =>
  Object.fromEntries((getDb().prepare("SELECT stage, status FROM stage_events WHERE agent_run_id=? ORDER BY id").all(runId) as { stage: string; status: string }[]).map((r) => [r.stage, r.status]));

class CountingContacts implements ContactProvider {
  readonly name = "counting";
  readonly dataSource = "mock" as const;
  calls = 0;
  inner = new MockContactProvider();
  async domainSearch(d: string) {
    this.calls++;
    return this.inner.domainSearch(d);
  }
}

describe("full pipeline with mock providers", () => {
  beforeEach(() => freshDb());

  it("runs all seven stages for a qualified company and simulates delivery to the demo inbox", async () => {
    useProviders();
    const { companyId, runId } = run("vaultlane.example");
    expect(await processCompany(runId)).toBe("email_simulated");
    expect(stages(runId)).toEqual({ research: "completed", extract: "completed", qualify: "completed", contact: "completed", pain_points: "completed", email: "completed", send: "completed" });
    const pps = getDb().prepare("SELECT * FROM pain_points WHERE company_id=?").all(companyId);
    expect(pps).toHaveLength(2);
    const em = getDb().prepare("SELECT * FROM emails WHERE company_id=?").get(companyId) as { body: string; status: string };
    expect(em.status).toBe("simulated");
    expect(em.body.startsWith("Hi Daniel,")).toBe(true); // 25: prospect's real (fixture) name
    expect(em.body).toContain("Vaultlane"); // 26: correct company
    const send = getDb().prepare("SELECT * FROM email_sends").get() as { delivery_recipient: string; status: string };
    expect(send).toMatchObject({ delivery_recipient: "me@inbox.test", status: "simulated" });
  });

  it("12. qualification gate: non-qualified companies never reach contact discovery", async () => {
    const contacts = new CountingContacts();
    useProviders({ contact: contacts });
    const a = run("northpeak-consulting.example");
    const b = run("orbitboard.example");
    expect(await processCompany(a.runId)).toBe("not_qualified");
    expect(await processCompany(b.runId)).toBe("not_qualified"); // SaaS, but no compliance signal on checked pages
    expect(contacts.calls).toBe(0);
    expect(stages(a.runId).contact).toBe("skipped");
    expect(getDb().prepare("SELECT COUNT(*) n FROM emails").get()).toEqual({ n: 0 });
  });

  it("homepage first, then targeted pages (ledgerly → borderline NEEDS_REVIEW)", async () => {
    useProviders();
    const { companyId, runId } = run("ledgerly.example");
    expect(await processCompany(runId)).toBe("needs_review");
    const pages = getDb().prepare("SELECT url, round FROM pages WHERE company_id=? ORDER BY id").all(companyId) as { url: string; round: number }[];
    expect(pages[0]).toMatchObject({ url: "https://ledgerly.example/", round: 0 }); // one initial homepage request
    expect(pages.filter((p) => p.round > 0).length).toBeLessThanOrEqual(4); // at most four additional fetches
    expect(pages.some((p) => p.url.endsWith("/security"))).toBe(true); // compliance question → security page
    const q = repo.latestQualification(companyId)!;
    expect(q.fit_score).toBeGreaterThanOrEqual(55);
    expect(q.fit_score).toBeLessThan(75);
    expect(q.categories.compliance_buying_signals.score).toBeGreaterThan(0);
  });

  it("qualifies vaultlane with evidence from targeted pages and sends (simulated)", async () => {
    useProviders();
    const { companyId, runId } = run("vaultlane.example");
    expect(await processCompany(runId)).toBe("email_simulated");
    const q = repo.latestQualification(companyId)!;
    expect(q.decision).toBe("qualified");
    expect(q.fit_score).toBeGreaterThanOrEqual(75);
    expect(q.pages_scraped.length).toBeLessThanOrEqual(5);
  });

  it("11. research stops at four additional fetches and never loops forever", async () => {
    let fetches = 0;
    const tags = ["product", "about", "hiring", "funding/news", "security/compliance", "customers", "pricing", "enterprise"];
    const endless: ResearchProvider = {
      name: "endless",
      dataSource: "mock",
      startSession: (domain): CrawlSession => ({
        domain,
        dataSource: "mock",
        initialCrawl: async () => ({ pages: [page(domain, 0, "/")], log: [], reachable: true }),
        fetchUrls: async (urls) => {
          fetches++;
          return { pages: [page(domain, fetches, new URL(urls[0]).pathname)], log: [] };
        },
        unvisitedCandidates: () => tags.map((tag, i) => ({ url: `https://${domain}/${["product", "about", "careers", "press", "security", "customers", "pricing", "enterprise"][i]}`, score: 50, tag })),
        pagesFetched: () => fetches + 1,
      }),
    };
    const llm = new ScriptedLLM({
      qualification: (input) => {
        const ref = (input as { evidence: { ref: string }[] }).evidence[0].ref;
        return findings({ is_saas: "yes", audience: "b2b", found: { saas: [ref], b2b: [ref], product: [ref] } });
      },
    });
    useProviders({ research: endless, llm });
    const { runId } = run("loop.example");
    const outcome = await processCompany(runId);
    expect(["needs_review", "not_qualified"]).toContain(outcome);
    expect(fetches).toBeLessThanOrEqual(4);
    expect(llm.calls.qualification).toBeLessThanOrEqual(4); // initial + at most 3 rounds
  });

  it("does not crash the batch when a stage fails (malformed model output)", async () => {
    useProviders({ llm: new ScriptedLLM({ extraction: () => "{{garbage" }) });
    const { runId } = run("vaultlane.example");
    expect(await processCompany(runId)).toBe("failed");
    expect(stages(runId).extract).toBe("failed");
    expect(stages(runId).send).toBe("skipped");
  });

  it("24. email regeneration is bounded and failing emails are never sent", async () => {
    const llm = new ScriptedLLM({ email_validation: () => ({ verdict: "REGENERATE", checks: [{ check: "human_tone", passed: false, note: "too salesy" }], issues: ["too salesy"] }) });
    const email: EmailProvider & { sends: number } = { name: "spy", dataSource: "mock", deliveryRecipient: "me@inbox.test", sends: 0, verifyIdentity: async () => ({ authenticatedEmail: "me@inbox.test" }), send: async () => { email.sends++; return { status: "simulated", messageId: "x", threadId: null, recipient: "me@inbox.test" }; } };
    useProviders({ llm, email });
    const { runId } = run("vaultlane.example");
    expect(await processCompany(runId)).toBe("email_needs_review");
    expect(llm.calls.email_generation).toBe(3); // 1 + 2 regenerations
    expect(email.sends).toBe(0);
    expect(stages(runId).send).toBe("skipped");
  });

  it("30. duplicate prevention: re-running the same company does not send twice", async () => {
    useProviders();
    const first = run("vaultlane.example");
    await processCompany(first.runId);
    const second = repo.createSingleRun(first.companyId, null);
    expect(await processCompany(second)).toBe("email_simulated");
    expect(getDb().prepare("SELECT COUNT(*) n FROM email_sends").get()).toEqual({ n: 1 });
    expect(stages(second).send).toBe("skipped");
  });

  it("31b. failed send is recorded as failed; an unknown outcome blocks blind retries", async () => {
    let mode: "timeout" | "ok" = "timeout";
    const email: EmailProvider = {
      name: "flaky-real",
      dataSource: "real",
      deliveryRecipient: "me@inbox.test",
      verifyIdentity: async () => ({ authenticatedEmail: "me@inbox.test" }),
      send: async () => {
        if (mode === "timeout") throw new EmailSendError("timeout", "timeout");
        return { status: "sent", messageId: "gmail-1", threadId: null, recipient: "me@inbox.test" };
      },
    };
    useProviders({ email });
    const { companyId } = realValidatedEmail();
    expect(await retrySend(companyId, false)).toBe("failed"); // first attempt times out
    expect((getDb().prepare("SELECT status FROM emails").get() as { status: string }).status).toBe("failed");
    expect((getDb().prepare("SELECT status FROM email_sends").get() as { status: string }).status).toBe("outcome_unknown");
    mode = "ok";
    expect(await retrySend(companyId, false)).toBe("failed"); // blocked without confirmation
    expect(await retrySend(companyId, true)).toBe("email_sent");
    expect(getDb().prepare("SELECT COUNT(*) n FROM email_sends WHERE status='sent'").get()).toEqual({ n: 1 });
    // retrying after success is a no-op that keeps the company marked as sent
    expect(await retrySend(companyId, false)).toBe("email_sent");
    expect((getDb().prepare("SELECT current_status FROM companies WHERE id=?").get(companyId) as { current_status: string }).current_status).toBe("email_sent");
    expect(getDb().prepare("SELECT COUNT(*) n FROM email_sends WHERE status='sent'").get()).toEqual({ n: 1 });
  });

  it("mock data is never delivered through a real email provider (always SIMULATED)", async () => {
    let realSends = 0;
    const realGmail: EmailProvider = {
      name: "gmail-like",
      dataSource: "real",
      deliveryRecipient: "me@inbox.test",
      verifyIdentity: async () => ({ authenticatedEmail: "me@inbox.test" }),
      send: async () => {
        realSends++;
        return { status: "sent", messageId: "g", threadId: null, recipient: "me@inbox.test" };
      },
    };
    useProviders({ email: realGmail });
    const { runId } = run("vaultlane.example");
    expect(await processCompany(runId)).toBe("email_simulated");
    expect(realSends).toBe(0);
    expect(getDb().prepare("SELECT COUNT(*) n FROM email_sends WHERE status='sent'").get()).toEqual({ n: 0 });
  });

  it("one email per company per campaign, even if a different contact is selected later", async () => {
    useProviders();
    const first = run("vaultlane.example");
    await processCompany(first.runId);
    repo.insertManualContact(first.companyId, { name: "Other Person", title: "CTO", email: "other@vaultlane.example", department: null, note: "" });
    const again = repo.createSingleRun(first.companyId, null);
    await processCompany(again, { startAt: "contact" });
    expect(getDb().prepare("SELECT COUNT(*) n FROM email_sends").get()).toEqual({ n: 1 });
    expect(stages(again).send).toBe("skipped");
  });
});

function page(domain: string, i: number, path = `/p${i}`) {
  return { url: `https://${domain}${path}`, title: "p", text: `Loop is a SaaS platform with subscription billing for business teams, page ${i}.`, publishedAt: null, retrievedAt: new Date().toISOString(), sourceType: "website" as const };
}

/** A qualified real-domain company with a validated, real (non-mock) email ready to send. */
function realValidatedEmail() {
  const db = getDb();
  const companyId = repo.upsertCompany("acme-real.com", "real");
  db.prepare("INSERT INTO contacts (company_id, name, first_name, title, business_email, selected, eligible, provider, data_source, created_at) VALUES (?, 'Jane Doe', 'Jane', 'CTO', 'jane@acme-real.com', 1, 1, 'manual', 'real', ?)").run(companyId, new Date().toISOString());
  const contactId = (db.prepare("SELECT id FROM contacts WHERE company_id=?").get(companyId) as { id: number }).id;
  const emailId = repo.insertEmail({ companyId, runId: repo.createSingleRun(companyId, null), contactId, subject: "s", body: "Hi Jane,", status: "validated", validationStatus: "PASS", validation: {}, attempts: 1, personalisation: {}, evidenceIds: [], dataSource: "real" });
  getDb().prepare("UPDATE companies SET name='Acme' WHERE id=?").run(companyId);
  return { companyId, emailId };
}
