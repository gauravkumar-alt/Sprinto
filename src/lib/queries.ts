/** Read models for the dashboard and company detail views. All counts come from stored records. */
import { getDb } from "./db";
import { parseJson } from "./repo";
import type { CompanyProfile, QualificationResult } from "./schemas";

export function dashboardMetrics() {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    totalCompanies: one("SELECT COUNT(*) n FROM companies"),
    qualified: one(
      "SELECT COUNT(*) n FROM qualifications q WHERE q.id = (SELECT MAX(id) FROM qualifications WHERE company_id = q.company_id) AND q.decision = 'qualified'",
    ),
    notQualified: one("SELECT COUNT(*) n FROM companies WHERE current_status='not_qualified'"),
    needsReview: one("SELECT COUNT(*) n FROM companies WHERE current_status IN ('needs_review','contact_not_found','email_needs_review')"),
    emailsGenerated: one("SELECT COUNT(DISTINCT company_id) n FROM emails"),
    emailsSent: one("SELECT COUNT(*) n FROM email_sends WHERE status='sent'"),
    emailsSimulated: one("SELECT COUNT(*) n FROM email_sends WHERE status='simulated'"),
    running: one("SELECT COUNT(*) n FROM agent_runs WHERE status IN ('queued','running')"),
    llmCostUsd: (db.prepare("SELECT COALESCE(SUM(cost_usd),0) n FROM llm_calls").get() as { n: number }).n,
    llmCalls: one("SELECT COUNT(*) n FROM llm_calls"),
    llmFailures: one("SELECT COUNT(*) n FROM llm_calls WHERE ok=0"),
  };
}

type StageRow = { stage: string; status: string; summary: string | null; error: string | null; started_at: string; completed_at: string | null };

function latestRun(companyId: number) {
  return getDb().prepare("SELECT * FROM agent_runs WHERE company_id=? ORDER BY id DESC LIMIT 1").get(companyId) as
    | { id: number; status: string; outcome: string | null; current_stage: string | null; error_log: string; providers_json: string | null; started_at: string | null; completed_at: string | null; duration_ms: number | null; batch_id: number | null }
    | undefined;
}

type StageEventRow = StageRow & { detail_json: string | null; agent_run_id: number };

/**
 * Stage view for a company's latest run. Steps the latest run only reused ("Reused from the previous run")
 * show the most recent run where that step actually executed, so resumed/retried companies still display
 * their real research, qualification, contact, pain-point and email results.
 */
function stagesFor(runId: number): (StageEventRow & { reused: boolean })[] {
  const db = getDb();
  const rows = db.prepare("SELECT agent_run_id, stage, status, summary, detail_json, error, started_at, completed_at FROM stage_events WHERE agent_run_id=? ORDER BY id").all(runId) as StageEventRow[];
  const by = new Map<string, StageEventRow>();
  for (const r of rows) by.set(r.stage, r); // keep the last event per stage
  const companyId = (db.prepare("SELECT company_id FROM agent_runs WHERE id=?").get(runId) as { company_id: number } | undefined)?.company_id;
  const earlier = db.prepare(
    `SELECT se.agent_run_id, se.stage, se.status, se.summary, se.detail_json, se.error, se.started_at, se.completed_at
     FROM stage_events se JOIN agent_runs ar ON ar.id = se.agent_run_id
     WHERE ar.company_id = ? AND se.agent_run_id < ? AND se.stage = ?
       AND NOT (se.status = 'skipped' AND (se.summary LIKE 'Reused%' OR se.summary LIKE 'Duplicate prevented%'))
     ORDER BY (se.status = 'completed') DESC, se.id DESC LIMIT 1`,
  );
  return [...by.values()].map((r) => {
    if (companyId && r.status === "skipped" && (r.summary?.startsWith("Reused") || r.summary?.startsWith("Duplicate prevented"))) {
      const real = earlier.get(companyId, runId, r.stage) as StageEventRow | undefined;
      if (real) return { ...real, reused: true };
    }
    return { ...r, reused: false };
  });
}

export function listCompanies() {
  const db = getDb();
  const companies = db.prepare("SELECT * FROM companies ORDER BY updated_at DESC").all() as {
    id: number;
    domain: string;
    name: string | null;
    current_status: string;
    data_source: string;
    updated_at: string;
  }[];
  return companies.map((c) => {
    const run = latestRun(c.id);
    const q = db.prepare("SELECT result_json, decision, score FROM qualifications WHERE company_id=? ORDER BY id DESC LIMIT 1").get(c.id) as
      | { result_json: string; decision: string; score: number }
      | undefined;
    const qr = q ? parseJson<QualificationResult>(q.result_json, {} as QualificationResult) : null;
    const contact = db.prepare("SELECT name, title, provider, data_source FROM contacts WHERE company_id=? AND selected=1 ORDER BY id DESC LIMIT 1").get(c.id) as
      | { name: string; title: string; provider: string; data_source: string }
      | undefined;
    const pps = db
      .prepare("SELECT statement FROM pain_points WHERE company_id=? AND agent_run_id=(SELECT MAX(agent_run_id) FROM pain_points WHERE company_id=?) ORDER BY position")
      .all(c.id, c.id) as { statement: string }[];
    const email = db.prepare("SELECT status FROM emails WHERE company_id=? ORDER BY id DESC LIMIT 1").get(c.id) as { status: string } | undefined;
    return {
      id: c.id,
      domain: c.domain,
      name: c.name,
      status: c.current_status,
      dataSource: c.data_source,
      score: q?.score ?? null,
      decision: q?.decision ?? null,
      reason: qr?.explanation ?? null,
      signals: qr ? { saas: qr.saas_status, audit: qr.audit_trigger, enterprise: qr.enterprise_pressure } : null,
      contactName: contact?.name ?? null,
      contactTitle: contact?.title ?? null,
      painPoint1: pps[0]?.statement ?? null,
      painPoint2: pps[1]?.statement ?? null,
      emailStatus: email?.status ?? null,
      run: run
        ? { id: run.id, status: run.status, outcome: run.outcome, currentStage: run.current_stage, batchId: run.batch_id, stages: stagesFor(run.id) }
        : null,
      updatedAt: c.updated_at,
    };
  });
}

export function companyDetail(id: number) {
  const db = getDb();
  const c = db.prepare("SELECT * FROM companies WHERE id=?").get(id) as
    | { id: number; domain: string; name: string | null; profile_json: string | null; current_status: string; data_source: string; created_at: string; updated_at: string }
    | undefined;
  if (!c) return null;
  const run = latestRun(id);
  const qualifications = (db.prepare("SELECT id, round, score, decision, result_json, override_note, created_at FROM qualifications WHERE company_id=? ORDER BY id").all(id) as {
    id: number;
    round: number;
    score: number;
    decision: string;
    result_json: string;
    override_note: string | null;
    created_at: string;
  }[]).map((q) => ({ ...q, result: parseJson<QualificationResult>(q.result_json, {} as QualificationResult), result_json: undefined }));
  const rr = db.prepare("SELECT * FROM research_runs WHERE company_id=? ORDER BY id DESC LIMIT 1").get(id) as
    | { id: number; rounds_json: string; research_rounds: number; source_count: number; status: string; data_source: string; reused_from: number | null; started_at: string; completed_at: string | null }
    | undefined;
  const evidence = rr
    ? (db.prepare("SELECT * FROM evidence WHERE research_run_id=? ORDER BY id").all(rr.id) as Record<string, unknown>[])
    : [];
  const pages = rr ? db.prepare("SELECT id, url, title, round, source_type, data_source, retrieved_at, published_at, length(text) AS chars FROM pages WHERE research_run_id=? ORDER BY id").all(rr.id) : [];
  const contacts = db.prepare("SELECT * FROM contacts WHERE company_id=? AND (agent_run_id = (SELECT MAX(agent_run_id) FROM contacts WHERE company_id=?) OR provider='manual') ORDER BY selected DESC, rank").all(id, id);
  const painPoints = db
    .prepare("SELECT * FROM pain_points WHERE company_id=? AND agent_run_id=(SELECT MAX(agent_run_id) FROM pain_points WHERE company_id=?) ORDER BY position")
    .all(id, id) as Record<string, unknown>[];
  const email = db.prepare("SELECT * FROM emails WHERE company_id=? ORDER BY id DESC LIMIT 1").get(id) as Record<string, unknown> | undefined;
  const sends = email ? db.prepare("SELECT * FROM email_sends WHERE email_id IN (SELECT id FROM emails WHERE company_id=?) ORDER BY id DESC").all(id) : [];
  const llm = run
    ? (db.prepare("SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cost_usd),0) cost, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) failures FROM llm_calls WHERE agent_run_id=?").get(run.id) as Record<string, number>)
    : null;
  const stageDetails = run
    ? stagesFor(run.id).map((s) => ({
        ...s,
        detail: parseJson<unknown>(s.detail_json, null),
        detail_json: undefined,
      }))
    : [];
  return {
    company: { ...c, profile: parseJson<CompanyProfile | null>(c.profile_json, null), profile_json: undefined },
    run: run ? { ...run, errors: parseJson<{ stage: string; message: string; at: string }[]>(run.error_log, []), providers: parseJson<Record<string, string>>(run.providers_json, {}) } : null,
    stages: stageDetails,
    qualifications,
    research: rr ? { ...rr, rounds: parseJson<unknown[]>(rr.rounds_json, []) } : null,
    pages,
    evidence: evidence.map((e) => ({ ...e, ref: `E${e.id}` })),
    contacts,
    painPoints: painPoints.map((p) => ({ ...p, evidence_ids: parseJson<string[]>(p.evidence_ids_json as string, []) })),
    email: email
      ? {
          ...email,
          validation: parseJson<unknown>(email.validation_json as string, null),
          personalisation: parseJson<Record<string, string>>(email.personalisation_json as string, {}),
          evidence_ids: parseJson<string[]>(email.evidence_ids_json as string, []),
        }
      : null,
    sends,
    llm,
  };
}

export function recentBatches(limit = 5) {
  return getDb()
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM agent_runs WHERE batch_id=b.id AND status IN ('completed','failed')) AS done
       FROM batches b ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}
