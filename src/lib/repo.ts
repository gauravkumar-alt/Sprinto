/** Data-access helpers. All SQL lives here or in db.ts. */
import { getDb, nowIso } from "./db";
import { cleanField } from "./security/injection";
import type { CompanyProfile, EvidenceRecord, QualificationResult, RankedContact } from "./schemas";

const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
export { pj as parseJson };

export const evRef = (id: number) => `E${id}`;
export const refToId = (ref: string) => (/^E\d+$/.test(ref) ? Number(ref.slice(1)) : NaN);

// ───────── companies / batches / runs ─────────

export function upsertCompany(domain: string, dataSource: "real" | "mock", name?: string): number {
  const db = getDb();
  const now = nowIso();
  const cleanName = name ? cleanField(name, 120) || null : null;
  db.prepare(
    `INSERT INTO companies (domain, name, data_source, created_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(domain) DO UPDATE SET updated_at = excluded.updated_at, name = COALESCE(excluded.name, companies.name)`,
  ).run(domain, cleanName, dataSource, now, now);
  return (db.prepare("SELECT id FROM companies WHERE domain=?").get(domain) as { id: number }).id;
}

export function setCompanyStatus(companyId: number, status: string, extra: { name?: string; profile?: CompanyProfile; dataSource?: string } = {}) {
  const db = getDb();
  db.prepare(
    `UPDATE companies SET current_status=?, updated_at=?,
       name = COALESCE(?, name), profile_json = COALESCE(?, profile_json), data_source = COALESCE(?, data_source)
     WHERE id=?`,
  ).run(status, nowIso(), extra.name ?? null, extra.profile ? j(extra.profile) : null, extra.dataSource ?? null, companyId);
}

export function createBatch(campaignId: string, mode: string, companyIds: number[]): { batchId: number; runIds: number[] } {
  const db = getDb();
  return db.transaction(() => {
    const b = db
      .prepare("INSERT INTO batches (campaign_id, status, app_mode, domain_count, created_at) VALUES (?, 'queued', ?, ?, ?)")
      .run(campaignId, mode, companyIds.length, nowIso());
    const batchId = Number(b.lastInsertRowid);
    const runIds = companyIds.map((cid) => {
      setCompanyStatus(cid, "pending");
      return Number(db.prepare("INSERT INTO agent_runs (batch_id, company_id, status) VALUES (?, ?, 'queued')").run(batchId, cid).lastInsertRowid);
    });
    return { batchId, runIds };
  })();
}

export function createSingleRun(companyId: number, batchId: number | null): number {
  return Number(getDb().prepare("INSERT INTO agent_runs (batch_id, company_id, status) VALUES (?, ?, 'queued')").run(batchId, companyId).lastInsertRowid);
}

export function getRun(runId: number) {
  return getDb()
    .prepare("SELECT ar.*, c.domain FROM agent_runs ar JOIN companies c ON c.id = ar.company_id WHERE ar.id=?")
    .get(runId) as { id: number; company_id: number; batch_id: number | null; domain: string; status: string; attempts: number } | undefined;
}

export function startRun(runId: number, providers: Record<string, string>) {
  getDb()
    .prepare("UPDATE agent_runs SET status='running', started_at=?, attempts = attempts + 1, providers_json=? WHERE id=?")
    .run(nowIso(), j(providers), runId);
}

export function setRunStage(runId: number, stage: string) {
  getDb().prepare("UPDATE agent_runs SET current_stage=? WHERE id=?").run(stage, runId);
}

export function appendRunError(runId: number, stage: string, message: string) {
  const db = getDb();
  const row = db.prepare("SELECT error_log FROM agent_runs WHERE id=?").get(runId) as { error_log: string };
  const log = pj<{ stage: string; message: string; at: string }[]>(row.error_log, []);
  log.push({ stage, message, at: nowIso() });
  db.prepare("UPDATE agent_runs SET error_log=? WHERE id=?").run(j(log), runId);
}

export function finishRun(runId: number, status: "completed" | "failed", outcome: string, startedMs: number) {
  getDb()
    .prepare("UPDATE agent_runs SET status=?, outcome=?, completed_at=?, duration_ms=? WHERE id=?")
    .run(status, outcome, nowIso(), Date.now() - startedMs, runId);
}

export function finishBatchIfDone(batchId: number | null) {
  if (!batchId) return;
  const db = getDb();
  const open = db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE batch_id=? AND status IN ('queued','running')").get(batchId) as { n: number };
  if (open.n === 0) db.prepare("UPDATE batches SET status='completed', completed_at=? WHERE id=? AND status!='completed'").run(nowIso(), batchId);
  else db.prepare("UPDATE batches SET status='running' WHERE id=? AND status='queued'").run(batchId);
}

/** On process start: runs left 'running' by a previous process cannot be resumed mid-call. */
export function markInterruptedRuns() {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `UPDATE stage_events SET status='failed', error='Interrupted (server restarted)', completed_at=? WHERE status='running'`,
  ).run(now);
  const runs = db.prepare("SELECT id, company_id FROM agent_runs WHERE status IN ('running','queued')").all() as { id: number; company_id: number }[];
  for (const r of runs) {
    db.prepare("UPDATE agent_runs SET status='failed', outcome='failed', completed_at=? WHERE id=?").run(now, r.id);
    appendRunError(r.id, "orchestrator", "Run interrupted by a server restart. Use Retry to run it again.");
    setCompanyStatus(r.company_id, "failed");
  }
  db.prepare("UPDATE batches SET status='interrupted' WHERE status IN ('queued','running')").run();
  db.prepare("UPDATE email_sends SET status='outcome_unknown', error='Interrupted while sending — check your inbox before retrying' WHERE status='sending'").run();
}

// ───────── stage events ─────────

export function stageStart(runId: number, stage: string, summary = "Running…"): number {
  setRunStage(runId, stage);
  return Number(
    getDb()
      .prepare("INSERT INTO stage_events (agent_run_id, stage, status, summary, started_at) VALUES (?,?, 'running', ?, ?)")
      .run(runId, stage, summary, nowIso()).lastInsertRowid,
  );
}

export function stageEnd(eventId: number, status: "completed" | "skipped" | "failed" | "needs_review", summary: string, detail?: unknown, error?: string) {
  getDb()
    .prepare("UPDATE stage_events SET status=?, summary=?, detail_json=?, error=?, completed_at=? WHERE id=?")
    .run(status, summary, detail === undefined ? null : j(detail), error ?? null, nowIso(), eventId);
}

export function stageSkip(runId: number, stage: string, summary: string) {
  const id = Number(
    getDb()
      .prepare("INSERT INTO stage_events (agent_run_id, stage, status, summary, started_at, completed_at) VALUES (?,?, 'skipped', ?, ?, ?)")
      .run(runId, stage, summary, nowIso(), nowIso()).lastInsertRowid,
  );
  return id;
}

// ───────── research / pages / evidence ─────────

export function createResearchRun(companyId: number, runId: number, dataSource: string, reusedFrom: number | null = null): number {
  return Number(
    getDb()
      .prepare("INSERT INTO research_runs (company_id, agent_run_id, status, data_source, reused_from, started_at) VALUES (?,?, 'running', ?, ?, ?)")
      .run(companyId, runId, dataSource, reusedFrom, nowIso()).lastInsertRowid,
  );
}

export function updateResearchRun(id: number, p: { status?: string; rounds?: unknown; researchRounds?: number; complete?: boolean }) {
  const db = getDb();
  const sourceCount = (db.prepare("SELECT COUNT(*) n FROM pages WHERE research_run_id=?").get(id) as { n: number }).n;
  db.prepare(
    `UPDATE research_runs SET status=COALESCE(?, status), rounds_json=COALESCE(?, rounds_json), research_rounds=COALESCE(?, research_rounds),
       source_count=?, completed_at=CASE WHEN ? THEN ? ELSE completed_at END WHERE id=?`,
  ).run(p.status ?? null, p.rounds ? j(p.rounds) : null, p.researchRounds ?? null, sourceCount, p.complete ? 1 : 0, nowIso(), id);
}

export function insertPage(
  researchRunId: number,
  companyId: number,
  p: { url: string; title: string; text: string; contentHash: string; round: number; sourceType: string; dataSource: string; retrievedAt: string; publishedAt: string | null },
): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO pages (research_run_id, company_id, url, title, text, content_hash, round, source_type, data_source, retrieved_at, published_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(researchRunId, companyId, p.url, p.title, p.text, p.contentHash, p.round, p.sourceType, p.dataSource, p.retrievedAt, p.publishedAt).lastInsertRowid,
  );
}

export function getPages(researchRunId: number) {
  return getDb().prepare("SELECT * FROM pages WHERE research_run_id=? ORDER BY id").all(researchRunId) as {
    id: number;
    url: string;
    title: string;
    text: string;
    content_hash: string;
    round: number;
    source_type: "website" | "search_result";
    data_source: "real" | "mock";
    retrieved_at: string;
    published_at: string | null;
  }[];
}

export function insertEvidence(e: Omit<EvidenceRecord, "id" | "ref"> & { researchRunId: number | null; pageId?: number | null }): EvidenceRecord {
  const id = Number(
    getDb()
      .prepare(
        `INSERT INTO evidence (company_id, research_run_id, page_id, claim, supporting_text, source_url, source_type, evidence_type, category, confidence, data_source, retrieved_at, published_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.companyId,
        e.researchRunId,
        e.pageId ?? null,
        e.claim,
        e.supportingText,
        e.sourceUrl,
        e.sourceType,
        e.evidenceType,
        e.category,
        e.confidence,
        e.dataSource,
        e.retrievedAt,
        e.publishedAt,
        nowIso(),
      ).lastInsertRowid,
  );
  return { ...e, id, ref: evRef(id) };
}

type EvidenceRow = {
  id: number;
  company_id: number;
  claim: string;
  supporting_text: string;
  source_url: string | null;
  source_type: EvidenceRecord["sourceType"];
  evidence_type: EvidenceRecord["evidenceType"];
  category: string;
  confidence: number;
  retrieved_at: string | null;
  published_at: string | null;
  data_source: "real" | "mock";
};

const mapEvidence = (r: EvidenceRow): EvidenceRecord => ({
  id: r.id,
  ref: evRef(r.id),
  companyId: r.company_id,
  claim: r.claim,
  supportingText: r.supporting_text,
  sourceUrl: r.source_url,
  sourceType: r.source_type,
  evidenceType: r.evidence_type,
  category: r.category,
  confidence: r.confidence,
  retrievedAt: r.retrieved_at,
  publishedAt: r.published_at,
  dataSource: r.data_source,
});

export function getEvidenceForResearchRun(researchRunId: number): EvidenceRecord[] {
  return (getDb().prepare("SELECT * FROM evidence WHERE research_run_id=? ORDER BY id").all(researchRunId) as EvidenceRow[]).map(mapEvidence);
}

export function deleteDerivedEvidence(researchRunId: number) {
  getDb().prepare("DELETE FROM evidence WHERE research_run_id=? AND evidence_type IN ('inference','unknown') AND source_type='derived'").run(researchRunId);
}

export function latestResearchRun(companyId: number) {
  return getDb()
    .prepare("SELECT * FROM research_runs WHERE company_id=? AND status='completed' ORDER BY id DESC LIMIT 1")
    .get(companyId) as { id: number; completed_at: string; data_source: string; rounds_json: string; research_rounds: number } | undefined;
}

/** Copy a previous research run's pages and observed evidence into a new run (research cache). */
export function cloneResearch(fromRunId: number, toRunId: number) {
  const db = getDb();
  db.transaction(() => {
    const pageMap = new Map<number, number>();
    for (const p of getPages(fromRunId)) {
      const companyId = (db.prepare("SELECT company_id FROM research_runs WHERE id=?").get(toRunId) as { company_id: number }).company_id;
      const newId = insertPage(toRunId, companyId, {
        url: p.url,
        title: p.title,
        text: p.text,
        contentHash: p.content_hash,
        round: p.round,
        sourceType: p.source_type,
        dataSource: p.data_source,
        retrievedAt: p.retrieved_at,
        publishedAt: p.published_at,
      });
      pageMap.set(p.id, newId);
    }
    const rows = db.prepare("SELECT * FROM evidence WHERE research_run_id=? AND evidence_type='observed' AND source_type!='contact_provider' ORDER BY id").all(fromRunId) as (EvidenceRow & { page_id: number | null })[];
    for (const r of rows) {
      insertEvidence({ ...mapEvidence(r), researchRunId: toRunId, pageId: r.page_id ? pageMap.get(r.page_id) ?? null : null });
    }
  })();
}

// ───────── qualification ─────────

export function insertQualification(companyId: number, runId: number, round: number, r: QualificationResult, overrideNote: string | null = null) {
  getDb()
    .prepare(
      `INSERT INTO qualifications (company_id, agent_run_id, round, score, decision, result_json, reasons_json, missing_json, evidence_ids_json, confidence, override_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(companyId, runId, round, r.fit_score, r.decision, j(r), j(r.reasons), j(r.missing_information), j(r.evidence_ids), r.confidence, overrideNote, nowIso());
}

export function latestQualification(companyId: number): (QualificationResult & { override_note: string | null; research_run_id?: number }) | null {
  const row = getDb()
    .prepare("SELECT result_json, override_note, decision FROM qualifications WHERE company_id=? ORDER BY id DESC LIMIT 1")
    .get(companyId) as { result_json: string; override_note: string | null; decision: string } | undefined;
  if (!row) return null;
  return { ...pj<QualificationResult>(row.result_json, {} as QualificationResult), decision: row.decision as QualificationResult["decision"], override_note: row.override_note };
}

// ───────── contacts ─────────

export function insertRankedContacts(companyId: number, runId: number, ranked: RankedContact[], selectedIndex: number | null, selectedReason: string | null, selectedConfidence: number, selectedEvidence: string[]) {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO contacts (company_id, agent_run_id, name, first_name, title, department, business_email, verification_status, provider_confidence, confidence,
       role_category, rank_score, rank, selected, eligible, reason, evidence_ids_json, provider, data_source, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let selectedId: number | null = null;
  db.transaction(() => {
    db.prepare("UPDATE contacts SET selected=0 WHERE company_id=?").run(companyId);
    ranked.forEach((r, i) => {
      const c = r.candidate;
      const isSel = i === selectedIndex;
      const id = Number(
        ins.run(
          companyId,
          runId,
          c.name,
          c.firstName,
          c.title,
          c.department,
          c.email,
          c.verificationStatus,
          c.providerConfidence,
          isSel ? selectedConfidence : 0,
          r.category,
          r.score,
          i + 1,
          isSel ? 1 : 0,
          r.eligible ? 1 : 0,
          isSel ? selectedReason : r.reasons.join("; "),
          j(isSel ? selectedEvidence : []),
          c.provider,
          c.dataSource,
          nowIso(),
        ).lastInsertRowid,
      );
      if (isSel) selectedId = id;
    });
  })();
  return selectedId;
}

export function getSelectedContact(companyId: number) {
  return getDb().prepare("SELECT * FROM contacts WHERE company_id=? AND selected=1 ORDER BY id DESC LIMIT 1").get(companyId) as
    | {
        id: number;
        name: string;
        first_name: string;
        title: string;
        department: string | null;
        business_email: string | null;
        verification_status: string | null;
        provider: string;
        data_source: string;
        evidence_ids_json: string;
        confidence: number;
        reason: string;
      }
    | undefined;
}

export function insertManualContact(companyId: number, raw: { name: string; title: string; email: string | null; department: string | null; note: string }) {
  const db = getDb();
  const c = { ...raw, name: cleanField(raw.name, 120), title: cleanField(raw.title, 120), department: raw.department ? cleanField(raw.department, 60) : null, note: cleanField(raw.note, 300) };
  const first = c.name.split(/\s+/)[0];
  db.transaction(() => {
    db.prepare("UPDATE contacts SET selected=0 WHERE company_id=?").run(companyId);
    db.prepare(
      `INSERT INTO contacts (company_id, name, first_name, title, department, business_email, verification_status, confidence, role_category, rank, selected, eligible, reason, evidence_ids_json, provider, data_source, created_at)
       VALUES (?,?,?,?,?,?, 'manual_entry', 0.6, NULL, 1, 1, 1, ?, '[]', 'manual', 'real', ?)`,
    ).run(companyId, c.name.trim(), first, c.title.trim(), c.department, c.email, `Entered manually by the user. ${c.note}`.trim(), nowIso());
  })();
}

// ───────── pain points / emails / sends ─────────

export function insertPainPoints(companyId: number, runId: number, contactId: number, pps: { statement: string; why_it_matters_to_this_person: string; type: string; evidence_ids: string[]; confidence: number }[]) {
  const ins = getDb().prepare(
    `INSERT INTO pain_points (company_id, agent_run_id, contact_id, position, statement, relevance, type, evidence_ids_json, confidence, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  pps.forEach((p, i) => ins.run(companyId, runId, contactId, i + 1, p.statement, p.why_it_matters_to_this_person, p.type, j(p.evidence_ids), p.confidence, nowIso()));
}

export function insertEmail(p: {
  companyId: number;
  runId: number;
  contactId: number;
  subject: string;
  body: string;
  status: string;
  validationStatus: string;
  validation: unknown;
  attempts: number;
  personalisation: unknown;
  evidenceIds: string[];
  dataSource: string;
}): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO emails (company_id, agent_run_id, contact_id, subject, body, status, validation_status, validation_json, attempts, personalisation_json, evidence_ids_json, data_source, generated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.companyId, p.runId, p.contactId, p.subject, p.body, p.status, p.validationStatus, j(p.validation), p.attempts, j(p.personalisation), j(p.evidenceIds), p.dataSource, nowIso()).lastInsertRowid,
  );
}

export function setEmailStatus(emailId: number, status: string) {
  getDb().prepare("UPDATE emails SET status=? WHERE id=?").run(status, emailId);
}

export function getSendByKey(key: string) {
  return getDb().prepare("SELECT * FROM email_sends WHERE idempotency_key=?").get(key) as
    | { id: number; email_id: number; status: string; gmail_message_id: string | null; completed_at: string | null; attempted_at: string; error: string | null }
    | undefined;
}
