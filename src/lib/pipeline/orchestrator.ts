/**
 * Central orchestrator. Runs the seven stages for one company in order, owns
 * every workflow transition (including the bounded research loop and the
 * qualification gate), persists each stage's status/evidence, and never lets a
 * failure in one company stop the batch.
 *
 *   1 research → 2 extract → 3 qualify (+ research loop) → [gate] →
 *   4 contact → 5 pain points → 6 email (+ validation) → 7 send (own inbox only)
 */
import { getConfig, PIPELINE_STAGES, SPRINTO_OFFERING, type PipelineStage } from "@/lib/config";
import { getDb } from "@/lib/db";
import {
  contactSelectionPrompt,
  emailGenerationPrompt,
  emailValidationPrompt,
  extractionPrompt,
  painPointPrompt,
  qualificationPrompt,
  researchPrompt,
  type EvidenceView,
  type QualificationPromptInput,
} from "@/lib/prompts";
import { getProvidersFor, type ProviderSet } from "@/lib/providers";
import { sameSite } from "@/lib/providers/research/prioritize";
import { ContactProviderError } from "@/lib/providers/contact/types";
import { MockEmailProvider } from "@/lib/providers/email/mock";
import { EmailSendError, type EmailProvider } from "@/lib/providers/email/types";
import { runPrompt } from "@/lib/providers/llm";
import { LLMError, type LLMProvider } from "@/lib/providers/llm/types";
import type { CrawlSession, FetchedPage } from "@/lib/providers/research/types";
import * as repo from "@/lib/repo";
import { isMockDomain } from "@/lib/security/domain";
import { cleanField, detectInjection } from "@/lib/security/injection";
import type {
  CompanyOutcome,
  CompanyProfile,
  ContactCandidate,
  EvidenceRecord,
  GeneratedEmail,
  PainPoint,
  QualificationResult,
  RoleCategory,
} from "@/lib/schemas";
import { clamp01, createLimiter, errorMessage, sha256, truncate } from "@/lib/util";
import { checkEmail, checkPainPoints, quoteAppearsIn, validRefs } from "./checks";
import { classifyTitleByRules, companyScale, contactConfidence, rankContacts, selectionReason } from "./contactRanking";
import { decideQualification, finalizeUnresolved, researchTargets } from "./qualification";
import { condensePages, pageType } from "./research";
import { publishAfterRun } from "@/lib/showroom-publish";

/** Thrown to end a company's pipeline early with a recorded outcome (not a crash). */
class StageStop extends Error {
  constructor(readonly outcome: CompanyOutcome, message: string) {
    super(message);
  }
}

interface Ctx {
  runId: number;
  companyId: number;
  domain: string;
  P: ProviderSet;
  llm: LLMProvider;
  mock: Set<string>;
  researchRunId: number;
  evidence: EvidenceRecord[];
  profile?: CompanyProfile;
  qualification?: QualificationResult;
  session?: CrawlSession;
  reusedResearch: boolean;
  /** Company name supplied with the input (optional hint). */
  nameHint: string | null;
  /** Page types fetched or looked for (a missing page counts as checked → NOT_FOUND rather than UNKNOWN). */
  checkedPages: Set<string>;
  pagesScraped: string[];
  additionalFetched: number;
}

export interface ProcessOptions {
  /** "contact": resume after manual contact entry / review approval, reusing stored research + qualification. */
  startAt?: "research" | "contact";
  overrideNote?: string;
  /** Ignore cached research (used for explicit user re-runs). */
  freshResearch?: boolean;
}

const view = (e: EvidenceRecord): EvidenceView => ({
  ref: e.ref,
  category: e.category,
  type: e.evidenceType,
  claim: e.claim,
  quote: truncate(e.supportingText, 400),
  source_url: e.sourceUrl,
});
const evMap = (ev: EvidenceRecord[]) => new Map(ev.map((e) => [e.ref, { type: e.evidenceType, text: `${e.claim} ${e.supportingText}` }]));

const AUDIT_TEXT: Record<string, string> = {
  active_or_planned: "Preparing for an audit or certification",
  initiative_timing_uncertain: "Hiring for security / compliance",
  already_certified: "Already certified",
  none: "No audit signal found",
};
const ENTERPRISE_TEXT: Record<string, string> = {
  security_reviews: "Faces enterprise security reviews / customer requirements",
  enterprise_positioning: "Targets enterprise buyers",
  none: "No enterprise signal found",
};

// ─────────────────────────────── Stage 1 helpers ───────────────────────────────

async function storePagesAndCollectEvidence(ctx: Ctx, pages: FetchedPage[], round: number, focus: string[]) {
  const stored = pages.map((p) => ({
    ...p,
    id: repo.insertPage(ctx.researchRunId, ctx.companyId, {
      url: p.url,
      title: p.title,
      text: p.text,
      contentHash: sha256(p.text),
      round,
      sourceType: p.sourceType,
      dataSource: ctx.mock.has("research") ? "mock" : "real",
      retrievedAt: p.retrievedAt,
      publishedAt: p.publishedAt,
    }),
  }));
  const injectionFlags = stored.flatMap((p) => detectInjection(`${p.title}\n${p.text}`).map((hit) => ({ url: p.url, hit })));
  for (const p of stored) {
    if (p.sourceType === "website") ctx.checkedPages.add(pageType(p.url, ctx.domain));
    ctx.pagesScraped.push(p.url);
  }
  if (stored.length === 0) return { added: [] as EvidenceRecord[], discarded: 0, injectionFlags, modelFlaggedInjection: false };

  // Only the signal-dense lines go to the model (~2,000 tokens per pass); quotes are verified against the full page.
  const cfg = getConfig().research;
  const condensed = condensePages(stored, cfg.contextBudgetChars);
  const out = await runPrompt(
    ctx.llm,
    researchPrompt,
    { domain: ctx.domain, pages: condensed.map((p) => ({ id: p.id, url: p.url, title: cleanField(p.title, 200), text: p.condensed })), focus },
    { agentRunId: ctx.runId },
  );
  const byId = new Map(stored.map((p) => [p.id, p]));
  const added: EvidenceRecord[] = [];
  let discarded = 0;
  const seen = new Set<string>();
  for (const item of out.evidence) {
    const page = byId.get(item.page_id);
    // Every observed fact must be a verbatim quote from a page we actually fetched.
    if (!page || !quoteAppearsIn(item.quote, page.text) || detectInjection(item.quote).length) {
      discarded++;
      continue;
    }
    const key = item.quote.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Text from third-party sites (search results) is never treated as an observed fact about the company:
    // it is stored as an inference, so it cannot satisfy a direct qualification level on its own.
    const thirdParty = page.sourceType === "search_result" && !sameSite(new URL(page.url), ctx.domain);
    // Sentences recovered from embedded page data (not visible to visitors) are never observed facts.
    const hiddenOnly = page.visibleChars !== undefined && !quoteAppearsIn(item.quote, page.text.slice(0, page.visibleChars));
    added.push(
      repo.insertEvidence({
        companyId: ctx.companyId,
        researchRunId: ctx.researchRunId,
        pageId: page.id,
        claim: truncate(thirdParty ? `Third-party source reports: ${item.claim}` : hiddenOnly ? `Page data (not visible text) states: ${item.claim}` : item.claim, 500),
        supportingText: truncate(item.quote, 600),
        sourceUrl: page.url,
        sourceType: page.sourceType,
        evidenceType: thirdParty || hiddenOnly ? "inference" : "observed",
        category: item.category,
        confidence: clamp01(item.confidence),
        retrievedAt: page.retrievedAt,
        publishedAt: page.publishedAt,
        dataSource: ctx.mock.has("research") || ctx.mock.has("llm") ? "mock" : "real",
      }),
    );
  }
  return { added, discarded, injectionFlags, modelFlaggedInjection: out.suspicious_instructions_detected };
}

// ─────────────────────────────── Stage 2 ───────────────────────────────

async function extractProfile(ctx: Ctx): Promise<CompanyProfile> {
  const observed = ctx.evidence.filter((e) => e.evidenceType === "observed");
  const out = await runPrompt(ctx.llm, extractionPrompt, { domain: ctx.domain, evidence: observed.map(view) }, { agentRunId: ctx.runId });
  const known = new Set(observed.map((e) => e.ref));
  const v = (ids: string[]) => validRefs(ids, known);
  const sig = (s: { summary: string; evidence_ids: string[] }[]) =>
    s.map((x) => ({ summary: x.summary, evidence_ids: v(x.evidence_ids) })).filter((x) => x.evidence_ids.length > 0);

  // Deterministic sanitising: no claim survives without valid evidence.
  const profile: CompanyProfile = {
    ...out,
    domain: ctx.domain,
    saas_evidence_ids: v(out.saas_evidence_ids),
    funding_evidence_ids: v(out.funding_evidence_ids),
    enterprise_evidence_ids: v(out.enterprise_evidence_ids),
    audit_signals: sig(out.audit_signals),
    compliance_signals: sig(out.compliance_signals),
    security_signals: sig(out.security_signals),
    customer_signals: sig(out.customer_signals),
    growth_signals: sig(out.growth_signals),
    inferences: out.inferences.map((i) => ({ ...i, basis_evidence_ids: v(i.basis_evidence_ids), confidence: clamp01(i.confidence) })).filter((i) => i.basis_evidence_ids.length),
    confidence: clamp01(out.confidence),
    source_evidence_ids: [...known],
    data_source: ctx.mock.size ? "mock" : "real",
    extracted_at: new Date().toISOString(),
  };
  if (profile.is_saas !== "unknown" && profile.saas_evidence_ids.length === 0) {
    profile.unknowns.push("SaaS status (model claim had no supporting evidence)");
    profile.is_saas = "unknown";
  }
  if (profile.funding_stage !== "Unknown" && profile.funding_evidence_ids.length === 0) {
    profile.unknowns.push("Funding stage (model claim had no supporting evidence)");
    profile.funding_stage = "Unknown";
  }
  if (profile.enterprise_focus === "yes" && profile.enterprise_evidence_ids.length === 0) profile.enterprise_focus = "unknown";
  profile.company_name = cleanField(profile.company_name, 100);
  if (!profile.company_name || profile.company_name === "Unknown" || detectInjection(profile.company_name).length) profile.company_name = ctx.domain;

  // Persist inferences and unknowns as first-class evidence (never as facts).
  repo.deleteDerivedEvidence(ctx.researchRunId);
  const byRef = new Map(observed.map((e) => [e.ref, e]));
  const derived: EvidenceRecord[] = [];
  for (const inf of profile.inferences) {
    const basis = byRef.get(inf.basis_evidence_ids[0]);
    derived.push(
      repo.insertEvidence({
        companyId: ctx.companyId,
        researchRunId: ctx.researchRunId,
        claim: inf.claim,
        supportingText: `Inferred from ${inf.basis_evidence_ids.join(", ")}`,
        sourceUrl: basis?.sourceUrl ?? null,
        sourceType: "derived",
        evidenceType: "inference",
        category: "company",
        confidence: inf.confidence,
        retrievedAt: basis?.retrievedAt ?? null,
        publishedAt: null,
        dataSource: profile.data_source,
      }),
    );
  }
  for (const u of [...new Set(profile.unknowns)]) {
    derived.push(
      repo.insertEvidence({
        companyId: ctx.companyId,
        researchRunId: ctx.researchRunId,
        claim: u,
        supportingText: "Could not be established from the sources collected.",
        sourceUrl: null,
        sourceType: "derived",
        evidenceType: "unknown",
        category: "company",
        confidence: 0,
        retrievedAt: null,
        publishedAt: null,
        dataSource: profile.data_source,
      }),
    );
  }
  ctx.evidence = [...observed, ...derived];
  return profile;
}

// ─────────────────────────────── Stage 3 ───────────────────────────────

async function classifyAndDecide(ctx: Ctx, canResearchMore: boolean): Promise<QualificationResult> {
  let profileForPrompt: QualificationPromptInput["profile"] = null;
  if (ctx.profile) {
    const p: Partial<CompanyProfile> = { ...ctx.profile };
    delete p.source_evidence_ids;
    profileForPrompt = p as QualificationPromptInput["profile"];
  }
  const usable = ctx.evidence.filter((e) => e.evidenceType !== "unknown");
  const findings = await runPrompt(
    ctx.llm,
    qualificationPrompt,
    { domain: ctx.domain, company_name_hint: ctx.nameHint, profile: profileForPrompt, pages_checked: [...ctx.checkedPages], evidence: usable.map(view) },
    { agentRunId: ctx.runId },
  );
  return decideQualification({
    findings,
    evidence: usable.map((e) => ({ ref: e.ref, type: e.evidenceType, text: `${e.claim} ${e.supportingText}`, url: e.sourceUrl, pageTag: e.sourceUrl ? pageType(e.sourceUrl, ctx.domain) : null })),
    checkedPages: ctx.checkedPages,
    pagesScraped: ctx.pagesScraped,
    canResearchMore,
  });
}

interface LoopRound {
  round: number;
  gaps: string[];
  action: { urls: string[]; pageTypes: string[]; searchQueries: string[] };
  newSources: string[];
  newEvidence: string[];
  decisionBefore: string;
  decisionAfter: string;
  scoreBefore: number;
  scoreAfter: number;
  stopReason?: string;
}

/**
 * Targeted research loop: after the homepage, fetch only the page type most likely to answer each open
 * critical question (Product/About → business model, Careers → growth, Security/Trust → compliance and
 * certification, Customers/Pricing → enterprise). At most RESEARCH_MAX_ADDITIONAL_PAGES fetches.
 */
async function qualifyWithResearchLoop(ctx: Ctx, eventId: number) {
  const cfg = getConfig().research;
  const canFetch = () => Boolean(ctx.session) && !ctx.reusedResearch && ctx.additionalFetched < cfg.maxAdditionalPages;
  const rounds: LoopRound[] = [];
  let round = 0;
  let searched = false;
  let result = await classifyAndDecide(ctx, canFetch());
  repo.insertQualification(ctx.companyId, ctx.runId, round, result);

  while (result.decision === "research_more" && canFetch() && round < cfg.maxAdditionalRounds) {
    round++;
    const wanted = researchTargets(result, ctx.checkedPages);
    repo.stageEnd(eventId, "completed", `Checking ${wanted.slice(0, 3).join(", ") || "more pages"}…`);
    getDb().prepare("UPDATE stage_events SET status='running' WHERE id=?").run(eventId);
    const rec: LoopRound = {
      round,
      gaps: result.missing_information,
      action: { urls: [], pageTypes: [], searchQueries: [] },
      newSources: [],
      newEvidence: [],
      decisionBefore: result.decision,
      decisionAfter: result.decision,
      scoreBefore: result.fit_score,
      scoreAfter: result.fit_score,
    };

    // One best candidate URL per wanted page type, taken from links the site actually has (or common paths).
    const budget = Math.min(cfg.maxPagesPerRound, cfg.maxAdditionalPages - ctx.additionalFetched);
    const candidates = ctx.session!.unvisitedCandidates(80);
    const pages: FetchedPage[] = [];
    for (const tag of wanted) {
      if (pages.length >= budget) break;
      const options = candidates.filter((c) => c.tag === tag).slice(0, 2);
      let got = false;
      for (const opt of options) {
        const r = await ctx.session!.fetchUrls([opt.url], 1);
        rec.action.urls.push(opt.url);
        if (r.pages.length) {
          pages.push(...r.pages);
          ctx.additionalFetched++;
          got = true;
          break;
        }
      }
      // Looked for this page type: checked, even if the site has no such page (→ NOT_FOUND, not UNKNOWN).
      ctx.checkedPages.add(tag);
      rec.action.pageTypes.push(got ? tag : `${tag} (none)`);
    }

    // Optional external search (only when configured) for funding facts the website rarely states.
    if (!searched && ctx.P.search.available && result.stage_status === "unknown") {
      searched = true;
      const q = `${ctx.domain} funding round Series`;
      rec.action.searchQueries.push(q);
      try {
        const nameRoot = ctx.domain.split(".")[0].toLowerCase();
        for (const r of (await ctx.P.search.search(q)).slice(0, 3)) {
          if (r.snippet.length < 40 || !`${r.url} ${r.title} ${r.snippet}`.toLowerCase().includes(nameRoot)) continue;
          pages.push({ url: r.url, title: r.title, text: r.snippet, publishedAt: r.publishedAt, retrievedAt: new Date().toISOString(), sourceType: "search_result" });
        }
      } catch (err) {
        repo.appendRunError(ctx.runId, "qualify", `Search failed: ${errorMessage(err)}`);
      }
    }

    rec.newSources = pages.map((p) => p.url);
    const { added } = pages.length ? await storePagesAndCollectEvidence(ctx, pages, round, result.missing_information) : { added: [] as EvidenceRecord[] };
    rec.newEvidence = added.map((e) => e.ref);
    if (added.length) ctx.evidence = [...ctx.evidence, ...added];
    result = await classifyAndDecide(ctx, canFetch() && round < cfg.maxAdditionalRounds && researchTargets(result, ctx.checkedPages).length > 0);
    repo.insertQualification(ctx.companyId, ctx.runId, round, result);
    rec.decisionAfter = result.decision;
    rec.scoreAfter = result.fit_score;
    if (!pages.length) rec.stopReason = "No matching pages on the site";
    rounds.push(rec);
    if (!pages.length && !researchTargets(result, ctx.checkedPages).length) break;
  }

  // Research limit reached with critical evidence still missing → NEEDS_REVIEW (never a guess).
  if (result.decision === "research_more") {
    result = finalizeUnresolved(result);
    repo.insertQualification(ctx.companyId, ctx.runId, round, result);
  }
  repo.updateResearchRun(ctx.researchRunId, { rounds, researchRounds: round, status: "completed", complete: true });
  return { result, rounds };
}

// ─────────────────────────────── Stage 4 ───────────────────────────────

async function findContact(ctx: Ctx) {
  const manual = repo.getSelectedContact(ctx.companyId);
  if (manual && manual.provider === "manual") return { contact: manual, ranked: 0, note: "Using the manually entered contact." };

  if (!ctx.P.contact) throw new StageStop("contact_not_found", ctx.P.unavailable.contact ?? "No contact provider configured.");
  if (ctx.P.contact.dataSource === "mock") ctx.mock.add("contact");
  let result;
  try {
    result = await ctx.P.contact.domainSearch(ctx.domain);
  } catch (err) {
    if (err instanceof ContactProviderError) throw new StageStop("contact_not_found", `${err.message}`);
    throw err;
  }
  const candidates: ContactCandidate[] = result.candidates;
  if (candidates.length === 0) throw new StageStop("contact_not_found", "The contact provider returned no people for this domain. Add a contact manually.");

  const profile = ctx.profile!;
  const scale = companyScale(ctx.qualification!.stage_label || profile.funding_stage, profile.company_size);
  // Titles the rule table can't classify go to the model (classification only; ranking stays deterministic).
  const unknownTitles = candidates.map((c, i) => ({ i, c })).filter(({ c }) => c.title && !classifyTitleByRules(c.title));
  let llmCategories: Map<number, RoleCategory> | undefined;
  if (unknownTitles.length) {
    try {
      const out = await runPrompt(
        ctx.llm,
        contactSelectionPrompt,
        { titles: unknownTitles.map(({ i, c }) => ({ index: i, title: c.title!, department: c.department })) },
        { agentRunId: ctx.runId },
      );
      llmCategories = new Map(out.classifications.filter((x) => unknownTitles.some((u) => u.i === x.index)).map((x) => [x.index, x.category]));
    } catch (err) {
      repo.appendRunError(ctx.runId, "contact", `Title classification skipped: ${errorMessage(err)}`);
    }
  }
  const ranked = rankContacts(candidates, { scale, domain: ctx.domain, llmCategories });
  const best = ranked.find((r) => r.eligible) ?? null;
  let evidenceRefs: string[] = [];
  let reason: string | null = null;
  let conf = 0;
  if (best) {
    const c = best.candidate;
    const src = c.sources[0]?.uri ?? (c.provider === "hunter" ? `https://hunter.io (domain search: ${ctx.domain})` : null);
    const ev = repo.insertEvidence({
      companyId: ctx.companyId,
      researchRunId: ctx.researchRunId,
      claim: `${c.name} is listed as "${c.title}" at ${ctx.domain}`,
      supportingText: `${c.provider === "hunter" ? "Hunter.io" : c.provider === "mock" ? "MOCK contact provider" : "Manual entry"}: ${c.name}, ${c.title}${c.department ? `, department ${c.department}` : ""}${c.verificationStatus ? `, email verification ${c.verificationStatus}` : ""}`,
      sourceUrl: src,
      sourceType: "contact_provider",
      evidenceType: "observed",
      category: "contact",
      confidence: c.providerConfidence !== null ? clamp01(c.providerConfidence) : 0.5,
      retrievedAt: new Date().toISOString(),
      publishedAt: c.sources[0]?.extractedOn ?? null,
      dataSource: c.dataSource,
    });
    ctx.evidence.push(ev);
    evidenceRefs = [ev.ref];
    reason = selectionReason(best, scale);
    conf = contactConfidence(best);
  }
  repo.insertRankedContacts(ctx.companyId, ctx.runId, ranked, best ? ranked.indexOf(best) : null, reason, conf, evidenceRefs);
  if (!best) {
    throw new StageStop(
      "contact_not_found",
      `${candidates.length} people found, but none is a reliable, relevant decision-maker (needs a name, a relevant title and a valid email). Add a contact manually.`,
    );
  }
  return { contact: repo.getSelectedContact(ctx.companyId)!, ranked: ranked.length, note: `${result.fromCache ? "Cached" : "Fresh"} ${ctx.P.contact.name} search · ${ranked.length} people ranked` };
}

// ─────────────────────────────── orchestrator ───────────────────────────────

/**
 * One email per company per campaign (per delivery kind). Re-runs that pick a different contact, or a
 * contact re-entered with an email, still map to the same key and are never sent twice.
 * To deliberately send again, use a new CAMPAIGN_ID.
 */
function idempotencyKey(domain: string, providerKind: "gmail" | "mock") {
  return sha256(`${getConfig().campaignId}|${domain}|${providerKind}`);
}

/** Mock data (fixture companies, mock model output) is never delivered through real Gmail: it is always SIMULATED. */
function deliveryProvider(P: ProviderSet, mockData: boolean): EmailProvider | null {
  if (mockData) return new MockEmailProvider();
  return P.email;
}

const providerKind = (e: EmailProvider | null): "gmail" | "mock" => (e?.dataSource === "real" ? "gmail" : "mock");

export async function processCompany(runId: number, opts: ProcessOptions = {}): Promise<CompanyOutcome> {
  const run = repo.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const startedMs = Date.now();
  const P = getProvidersFor(run.domain);
  const mock = new Set<string>();
  if (P.research.dataSource === "mock") mock.add("research");
  if (P.llm?.dataSource === "mock") mock.add("llm");
  repo.startRun(runId, {
    research: P.research.name,
    search: P.search.available ? P.search.name : "none",
    llm: P.llm ? `${P.llm.name}:${P.llm.model}` : "unavailable",
    contact: P.contact?.name ?? "unavailable",
    email: P.email?.name ?? "unavailable",
  });
  repo.setCompanyStatus(run.company_id, "running");

  let outcome: CompanyOutcome = "failed";
  let current: PipelineStage = "research";
  let eventId = 0;
  const skipRest = (from: PipelineStage, why: string) => {
    for (const s of PIPELINE_STAGES.slice(PIPELINE_STAGES.indexOf(from) + 1)) repo.stageSkip(runId, s, why);
  };

  try {
    if (!P.llm) {
      eventId = repo.stageStart(runId, "research");
      throw new StageStop("failed", P.unavailable.llm!);
    }
    const nameHint = (getDb().prepare("SELECT name FROM companies WHERE id=?").get(run.company_id) as { name: string | null }).name;
    const ctx: Ctx = {
      runId,
      companyId: run.company_id,
      domain: run.domain,
      P,
      llm: P.llm,
      mock,
      researchRunId: 0,
      evidence: [],
      reusedResearch: false,
      nameHint,
      checkedPages: new Set(),
      pagesScraped: [],
      additionalFetched: 0,
    };

    if (opts.startAt === "contact") {
      // Resume: reuse stored research, profile and qualification.
      const rr = repo.latestResearchRun(ctx.companyId);
      const q = repo.latestQualification(ctx.companyId);
      const company = getDb().prepare("SELECT profile_json, data_source FROM companies WHERE id=?").get(ctx.companyId) as { profile_json: string | null; data_source: string };
      if (!rr || !q || !company.profile_json) throw new StageStop("failed", "No previous research to resume from. Run the full pipeline first.");
      ctx.researchRunId = rr.id;
      ctx.evidence = repo.getEvidenceForResearchRun(rr.id).filter((e) => e.sourceType !== "contact_provider");
      ctx.profile = repo.parseJson<CompanyProfile>(company.profile_json, {} as CompanyProfile);
      if (company.data_source === "mock") mock.add("research");
      ctx.qualification = q;
      for (const s of ["research", "extract"] as const) repo.stageSkip(runId, s, "Reused from the previous run");
      if (q.decision !== "qualified") {
        if (!opts.overrideNote) throw new StageStop((q.decision as CompanyOutcome) ?? "needs_review", `Company is "${q.decision}"; only qualified companies proceed to contact discovery.`);
        const overridden: QualificationResult = { ...q, decision: "qualified", explanation: `Manually approved after review: ${opts.overrideNote}. Original decision: ${q.decision} — ${q.explanation}` };
        repo.insertQualification(ctx.companyId, runId, 99, overridden, opts.overrideNote);
        ctx.qualification = overridden;
        repo.stageSkip(runId, "qualify", `Manually approved by reviewer (was ${q.decision}, ${q.fit_score}/100)`);
      } else repo.stageSkip(runId, "qualify", `Reused: qualified · ${q.fit_score}/100`);
    } else {
      // ── 1. Research ──
      current = "research";
      eventId = repo.stageStart(runId, "research", "Crawling public website…");
      const cfg = getConfig().research;
      const cached = repo.latestResearchRun(ctx.companyId);
      const cacheFresh = cached && Date.now() - Date.parse(cached.completed_at) < cfg.cacheHours * 3_600_000 && cached.data_source === (mock.size ? "mock" : "real");
      if (cacheFresh && P.research.dataSource === "real" && !opts.freshResearch) {
        ctx.researchRunId = repo.createResearchRun(ctx.companyId, runId, "real", cached!.id);
        repo.cloneResearch(cached!.id, ctx.researchRunId);
        ctx.evidence = repo.getEvidenceForResearchRun(ctx.researchRunId);
        ctx.reusedResearch = true;
        for (const pg of repo.getPages(ctx.researchRunId)) {
          ctx.pagesScraped.push(pg.url);
          if (pg.source_type === "website") ctx.checkedPages.add(pageType(pg.url, ctx.domain));
        }
        repo.stageEnd(eventId, "completed", `Reused research from ${cached!.completed_at.slice(0, 16).replace("T", " ")} (cache) · ${ctx.evidence.length} evidence items`, { reusedFrom: cached!.id });
      } else {
        ctx.researchRunId = repo.createResearchRun(ctx.companyId, runId, mock.size ? "mock" : "real");
        ctx.session = P.research.startSession(run.domain);
        // One initial request: the homepage. Further pages are fetched only when evidence is missing.
        const crawl = await ctx.session.initialCrawl(1);
        if (!crawl.reachable) {
          repo.updateResearchRun(ctx.researchRunId, { status: "failed", complete: true });
          repo.stageEnd(eventId, "failed", "Website unreachable", { log: crawl.log }, crawl.log.map((l) => `${l.url}: ${l.detail ?? l.outcome}`).join("; "));
          eventId = 0;
          throw new StageStop("failed", "The website could not be reached (DNS, TLS, timeout or blocked). Check the domain and retry.");
        }
        if (crawl.pages.length === 0) {
          repo.updateResearchRun(ctx.researchRunId, { status: "failed", complete: true });
          repo.stageEnd(eventId, "failed", "No readable pages", { log: crawl.log }, "robots.txt disallows crawling, or pages have no readable text");
          eventId = 0;
          throw new StageStop("needs_review", "No readable public pages could be collected (robots.txt restrictions or a JavaScript-only site).");
        }
        const r = await storePagesAndCollectEvidence(ctx, crawl.pages, 0, []);
        ctx.evidence = r.added;
        const warn = r.injectionFlags.length || r.modelFlaggedInjection ? " · ⚠ injected instructions ignored" : "";
        repo.stageEnd(
          eventId,
          "completed",
          `Homepage · ${r.added.length} facts${r.discarded ? ` · ${r.discarded} unverifiable dropped` : ""}${crawl.log.some((l) => l.detail?.includes("headless")) ? " · rendered" : ""}${warn}`,
          { log: crawl.log, discardedEvidence: r.discarded, injectionFlags: r.injectionFlags, modelFlaggedInjection: r.modelFlaggedInjection },
        );
      }

      // ── 2. Extract ──
      current = "extract";
      eventId = repo.stageStart(runId, "extract", "Building structured company profile…");
      ctx.profile = await extractProfile(ctx);
      repo.setCompanyStatus(ctx.companyId, "running", { name: ctx.profile.company_name, profile: ctx.profile, dataSource: mock.size ? "mock" : "real" });
      repo.stageEnd(
        eventId,
        "completed",
        `${ctx.profile.company_name} · SaaS: ${ctx.profile.is_saas} · Stage: ${ctx.profile.funding_stage} · ${ctx.profile.unknowns.length} unknowns`,
      );

      // ── 3. Qualify (+ controlled research loop) ──
      current = "qualify";
      eventId = repo.stageStart(runId, "qualify", "Classifying ICP signals…");
      const { result, rounds } = await qualifyWithResearchLoop(ctx, eventId);
      ctx.qualification = result;
      // Refresh the profile with everything the targeted pages added (used by the UI, pain points and email).
      if (rounds.some((r) => r.newEvidence.length)) {
        ctx.profile = await extractProfile(ctx);
        repo.setCompanyStatus(ctx.companyId, "running", { name: ctx.profile.company_name, profile: ctx.profile });
      }
      const loopNote = ` · ${ctx.pagesScraped.length} page${ctx.pagesScraped.length === 1 ? "" : "s"}`;
      const label = result.decision === "qualified" ? "Qualified" : result.decision === "not_qualified" ? "Not qualified" : "Needs review";
      repo.stageEnd(eventId, result.decision === "qualified" ? "completed" : result.decision === "needs_review" ? "needs_review" : "completed", `${label} · ${result.fit_score}/100${loopNote}`, { rounds });
      eventId = 0;

      // Qualification gate: only qualified companies continue.
      if (result.decision !== "qualified") {
        outcome = result.decision === "not_qualified" ? "not_qualified" : "needs_review";
        skipRest("qualify", result.decision === "not_qualified" ? "Stopped: company did not qualify" : "Stopped: saved for human review");
        repo.setCompanyStatus(ctx.companyId, outcome);
        repo.finishRun(runId, "completed", outcome, startedMs);
        return outcome;
      }
    }

    // ── 4. Contact ──
    current = "contact";
    eventId = repo.stageStart(runId, "contact", "Searching for the right decision-maker…");
    const { contact, note } = await findContact(ctx);
    repo.stageEnd(eventId, "completed", `${contact.name} · ${contact.title} · ${note}`);

    if (!P.email) {
      // Without a delivery provider there is nothing to send; still useful to generate for review.
      repo.appendRunError(runId, "send", P.unavailable.email!);
    }
    const mockData = mock.size > 0 || isMockDomain(ctx.domain);
    const key = idempotencyKey(ctx.domain, providerKind(deliveryProvider(P, mockData)));
    const prior = repo.getSendByKey(key);
    if (prior && (prior.status === "sent" || prior.status === "simulated")) {
      outcome = prior.status === "sent" ? "email_sent" : "email_simulated";
      for (const s of ["pain_points", "email"] as const) repo.stageSkip(runId, s, "Reused: email already generated for this contact in this campaign");
      repo.stageSkip(runId, "send", `Duplicate prevented: already ${prior.status} on ${prior.completed_at?.slice(0, 16).replace("T", " ")} (id ${prior.gmail_message_id})`);
      repo.setCompanyStatus(ctx.companyId, outcome);
      repo.finishRun(runId, "completed", outcome, startedMs);
      return outcome;
    }

    // ── 5. Pain points ──
    current = "pain_points";
    eventId = repo.stageStart(runId, "pain_points", "Identifying two evidence-backed pain points…");
    const q = ctx.qualification!;
    const ppInput = {
      company: {
        name: ctx.profile!.company_name,
        domain: ctx.domain,
        description: ctx.profile!.description,
        funding_stage: ctx.profile!.funding_stage,
        enterprise_focus: ctx.profile!.enterprise_focus,
      },
      qualification: {
        saas: q.saas_status === "confirmed" ? "Confirmed B2B SaaS" : q.saas_status,
        stage: q.stage_label,
        audit: AUDIT_TEXT[q.audit_trigger] ?? q.audit_trigger,
        enterprise: ENTERPRISE_TEXT[q.enterprise_pressure] ?? q.enterprise_pressure,
        explanation: q.explanation,
      },
      contact: { name: contact.name, title: contact.title, department: contact.department },
      evidence: ctx.evidence.filter((e) => e.evidenceType !== "unknown").map(view),
    };
    const known = evMap(ctx.evidence.filter((e) => e.evidenceType !== "unknown"));
    let pp = checkPainPoints(await runPrompt(ctx.llm, painPointPrompt, ppInput, { agentRunId: runId }), known);
    if (!pp.ok && !pp.problems.some((p) => p.startsWith("Model reported insufficient"))) {
      pp = checkPainPoints(await runPrompt(ctx.llm, painPointPrompt, ppInput, { agentRunId: runId }), known); // one bounded retry
    }
    if (!pp.ok) {
      repo.stageEnd(eventId, "needs_review", "Too little evidence for two pain points", { problems: pp.problems, draft: pp.painPoints });
      eventId = 0;
      skipRest("pain_points", "Stopped: pain points need human review");
      outcome = "needs_review";
      repo.setCompanyStatus(ctx.companyId, outcome);
      repo.finishRun(runId, "completed", outcome, startedMs);
      return outcome;
    }
    repo.insertPainPoints(ctx.companyId, runId, contact.id, pp.painPoints);
    const evidenced = pp.painPoints.filter((p) => p.type === "direct").length;
    repo.stageEnd(eventId, "completed", `2 pain points · ${evidenced} evidenced, ${2 - evidenced} inferred`);

    // ── 6. Email generation + validation ──
    current = "email";
    eventId = repo.stageStart(runId, "email", "Writing personalised email…");
    const emailRes = await generateValidatedEmail(ctx, contact, pp.painPoints);
    const dataSource = mock.size ? "mock" : "real";
    const emailId = repo.insertEmail({
      companyId: ctx.companyId,
      runId,
      contactId: contact.id,
      subject: emailRes.email.subject,
      body: emailRes.email.body,
      status: emailRes.passed ? "validated" : "needs_review",
      validationStatus: emailRes.passed ? "PASS" : "NEEDS_REVIEW",
      validation: { attempts: emailRes.history },
      attempts: emailRes.history.length,
      personalisation: {
        prospect_name: emailRes.email.prospect_name,
        prospect_role: emailRes.email.prospect_role,
        personalisation_hook: emailRes.email.personalisation_hook,
        pain_point_used: emailRes.email.pain_point_used,
        personalisation_explanation: emailRes.email.personalisation_explanation,
        sprinto_connection: SPRINTO_OFFERING.oneLiner,
      },
      evidenceIds: validRefs(emailRes.email.evidence_ids, new Set(known.keys())),
      dataSource,
    });
    if (!emailRes.passed) {
      repo.stageEnd(eventId, "needs_review", `Failed validation (${emailRes.history.length} tries) · not sent`, { history: emailRes.history });
      eventId = 0;
      repo.stageSkip(runId, "send", "Not sent: email failed validation");
      outcome = "email_needs_review";
      repo.setCompanyStatus(ctx.companyId, outcome);
      repo.finishRun(runId, "completed", outcome, startedMs);
      return outcome;
    }
    repo.stageEnd(eventId, "completed", `Validated · ${emailRes.history.length} attempt${emailRes.history.length > 1 ? "s" : ""}`, { history: emailRes.history });

    // ── 7. Send (own inbox only) ──
    current = "send";
    outcome = await sendEmail({ runId, companyId: ctx.companyId, emailId, key, P, mockData, prospectEmails: [contact.business_email] });
    repo.setCompanyStatus(ctx.companyId, outcome);
    repo.finishRun(runId, outcome === "failed" ? "failed" : "completed", outcome, startedMs);
    return outcome;
  } catch (err) {
    const stop = err instanceof StageStop ? err : null;
    const msg =
      err instanceof LLMError
        ? `AI step failed (${err.kind}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    outcome = stop ? stop.outcome : "failed";
    if (eventId) repo.stageEnd(eventId, stop && stop.outcome !== "failed" ? "needs_review" : "failed", truncate(msg, 300), undefined, msg);
    repo.appendRunError(runId, current, msg);
    skipRest(current, `Stopped at ${current}`);
    repo.setCompanyStatus(run.company_id, outcome);
    repo.finishRun(runId, outcome === "failed" ? "failed" : "completed", outcome, startedMs);
    return outcome;
  } finally {
    repo.finishBatchIfDone(run.batch_id);
  }
}

async function generateValidatedEmail(ctx: Ctx, contact: NonNullable<ReturnType<typeof repo.getSelectedContact>>, painPoints: PainPoint[]) {
  const cfg = getConfig();
  const usable = ctx.evidence.filter((e) => e.evidenceType !== "unknown");
  const known = evMap(usable);
  const others = (getDb().prepare("SELECT name FROM companies WHERE id != ? AND name IS NOT NULL").all(ctx.companyId) as { name: string }[]).map((r) => r.name);
  const history: { attempt: number; subject: string; deterministic: string[]; critic: { verdict: string; issues: string[]; checks: unknown[] } | null; verdict: string }[] = [];
  let issues: string[] = [];
  let last: GeneratedEmail | null = null;
  const first = contact.first_name || contact.name.split(/\s+/)[0];
  for (let attempt = 1; attempt <= 1 + cfg.email.maxRegenerations; attempt++) {
    const email = await runPrompt(
      ctx.llm,
      emailGenerationPrompt,
      {
        company_name: ctx.profile!.company_name,
        domain: ctx.domain,
        contact: { first_name: first, full_name: contact.name, title: contact.title },
        audit_level: ctx.qualification!.audit_trigger,
        enterprise_level: ctx.qualification!.enterprise_pressure,
        pain_points: painPoints,
        evidence: usable.map(view),
        sender_name: cfg.senderName,
        min_words: cfg.email.minWords,
        max_words: cfg.email.maxWords,
        previous_issues: issues,
      },
      { agentRunId: ctx.runId },
    );
    last = email;
    const det = checkEmail(email, {
      companyName: ctx.profile!.company_name,
      domain: ctx.domain,
      contactFullName: contact.name,
      contactFirstName: first,
      contactTitle: contact.title,
      prospectEmail: contact.business_email,
      knownEvidence: known,
      auditLevel: ctx.qualification!.audit_trigger,
      enterpriseLevel: ctx.qualification!.enterprise_pressure,
      otherCompanyNames: others,
    });
    if (!det.passed) {
      history.push({ attempt, subject: email.subject, deterministic: det.issues, critic: null, verdict: "REGENERATE" });
      issues = det.issues;
      continue;
    }
    // Contextual LLM critic only after cheap deterministic checks pass (one call per attempt).
    const critic = await runPrompt(
      ctx.llm,
      emailValidationPrompt,
      { email, company_name: ctx.profile!.company_name, contact: { full_name: contact.name, title: contact.title }, pain_points: painPoints, evidence: usable.map(view) },
      { agentRunId: ctx.runId },
    );
    const criticPass = critic.verdict === "PASS" && critic.checks.every((c) => c.passed);
    history.push({ attempt, subject: email.subject, deterministic: [], critic: { verdict: critic.verdict, issues: critic.issues, checks: critic.checks }, verdict: criticPass ? "PASS" : "REGENERATE" });
    if (criticPass) return { passed: true, email, history };
    issues = critic.issues.length ? critic.issues : critic.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.note}`);
  }
  return { passed: false, email: last!, history };
}

export async function sendEmail(p: {
  runId: number;
  companyId: number;
  emailId: number;
  key: string;
  P: ProviderSet;
  mockData: boolean;
  prospectEmails: (string | null)[];
  confirmUnknownOutcome?: boolean;
}): Promise<CompanyOutcome> {
  const db = getDb();
  const eventId = repo.stageStart(p.runId, "send", "Sending to your own inbox…");
  const stored = db.prepare("SELECT data_source FROM emails WHERE id=?").get(p.emailId) as { data_source: string };
  const provider = deliveryProvider(p.P, p.mockData || stored.data_source === "mock");
  // Every address known for this company (all ranked contacts) must be absent from the outgoing message.
  const knownAddresses = (db.prepare("SELECT business_email FROM contacts WHERE company_id=? AND business_email IS NOT NULL").all(p.companyId) as { business_email: string }[]).map(
    (r) => r.business_email,
  );
  const prospectEmails = [...new Set([...p.prospectEmails, ...knownAddresses])];

  // Already delivered (or simulated) for this company in this campaign: report the duplicate, keep the status.
  const already = repo.getSendByKey(p.key);
  if (already && (already.status === "sent" || already.status === "simulated")) {
    repo.stageEnd(eventId, "skipped", `Duplicate prevented: already ${already.status} (id ${already.gmail_message_id})`);
    return already.status === "sent" ? "email_sent" : "email_simulated";
  }
  if (!provider) {
    repo.setEmailStatus(p.emailId, "skipped");
    repo.stageEnd(eventId, "failed", "Not sent: Gmail is not configured", undefined, p.P.unavailable.email);
    return "email_needs_review";
  }
  const email = db.prepare("SELECT subject, body, status FROM emails WHERE id=?").get(p.emailId) as { subject: string; body: string; status: string };
  if (email.status !== "validated" && email.status !== "failed") {
    repo.stageEnd(eventId, "failed", `Refused: email status is "${email.status}"; only validated emails are sent`);
    return "email_needs_review";
  }

  // Idempotency: claim the key before calling Gmail.
  const existing = repo.getSendByKey(p.key);
  if (existing) {
    if (existing.status === "sent" || existing.status === "simulated") {
      repo.stageEnd(eventId, "skipped", `Duplicate prevented: already ${existing.status} (id ${existing.gmail_message_id})`);
      return existing.status === "sent" ? "email_sent" : "email_simulated";
    }
    if ((existing.status === "outcome_unknown" || existing.status === "sending") && !p.confirmUnknownOutcome) {
      repo.setEmailStatus(p.emailId, "failed");
      repo.stageEnd(eventId, "failed", "Previous attempt has an unknown outcome — check your inbox, then confirm a resend", undefined, existing.error ?? undefined);
      return "failed";
    }
    db.prepare("UPDATE email_sends SET status='sending', email_id=?, attempted_at=?, error=NULL WHERE id=?").run(p.emailId, new Date().toISOString(), existing.id);
  } else {
    db.prepare(
      "INSERT INTO email_sends (email_id, idempotency_key, delivery_recipient, provider, status, attempted_at) VALUES (?,?,?,?, 'sending', ?)",
    ).run(p.emailId, p.key, provider.deliveryRecipient, provider.name, new Date().toISOString());
  }
  const sendRow = repo.getSendByKey(p.key)!;

  const contactMeta = db
    .prepare("SELECT c.name, c.title, co.name AS company FROM emails e JOIN contacts c ON c.id=e.contact_id JOIN companies co ON co.id=e.company_id WHERE e.id=?")
    .get(p.emailId) as { name: string; title: string; company: string };
  const footer = `\n\n—\nDemo delivery note: this email was generated for ${contactMeta.name} (${contactMeta.title}, ${contactMeta.company}). It was delivered only to your own inbox; the prospect was not contacted.`;

  try {
    const res = await provider.send({ subject: email.subject, body: email.body + footer, prospectEmails });
    db.prepare("UPDATE email_sends SET status=?, gmail_message_id=?, gmail_thread_id=?, delivery_recipient=?, completed_at=? WHERE id=?").run(
      res.status,
      res.messageId,
      res.threadId,
      res.recipient,
      new Date().toISOString(),
      sendRow.id,
    );
    repo.setEmailStatus(p.emailId, res.status);
    repo.stageEnd(
      eventId,
      "completed",
      res.status === "sent" ? `Sent to your inbox (${res.recipient}) · Gmail id ${res.messageId}` : `SIMULATED (no email sent) · Gmail not configured`,
      { messageId: res.messageId, recipient: res.recipient },
    );
    return res.status === "sent" ? "email_sent" : "email_simulated";
  } catch (err) {
    const unknown = err instanceof EmailSendError && err.kind === "timeout";
    const msg = errorMessage(err);
    db.prepare("UPDATE email_sends SET status=?, error=?, completed_at=? WHERE id=?").run(unknown ? "outcome_unknown" : "failed", msg, new Date().toISOString(), sendRow.id);
    repo.setEmailStatus(p.emailId, "failed");
    repo.stageEnd(eventId, "failed", unknown ? "Delivery outcome unknown — not retried automatically" : "Gmail send failed", undefined, msg);
    repo.appendRunError(p.runId, "send", msg);
    return "failed";
  }
}

/** Retry only the send step for a company's latest validated/failed email. */
export async function retrySend(companyId: number, confirmUnknownOutcome: boolean): Promise<CompanyOutcome> {
  const db = getDb();
  const email = db.prepare("SELECT e.id, e.contact_id, e.data_source FROM emails e WHERE e.company_id=? ORDER BY e.id DESC LIMIT 1").get(companyId) as
    | { id: number; contact_id: number; data_source: string }
    | undefined;
  if (!email) throw new Error("No email to send");
  const company = db.prepare("SELECT domain FROM companies WHERE id=?").get(companyId) as { domain: string };
  const contact = db.prepare("SELECT name, business_email FROM contacts WHERE id=?").get(email.contact_id) as { name: string; business_email: string | null };
  const P = getProvidersFor(company.domain);
  const runId = repo.createSingleRun(companyId, null);
  repo.startRun(runId, { email: P.email?.name ?? "unavailable" });
  for (const s of ["research", "extract", "qualify", "contact", "pain_points", "email"] as const) repo.stageSkip(runId, s, "Reused from the previous run");
  const mockData = email.data_source === "mock" || isMockDomain(company.domain);
  const key = idempotencyKey(company.domain, providerKind(deliveryProvider(P, mockData)));
  const started = Date.now();
  const outcome = await sendEmail({ runId, companyId, emailId: email.id, key, P, mockData, prospectEmails: [contact.business_email], confirmUnknownOutcome });
  repo.setCompanyStatus(companyId, outcome);
  repo.finishRun(runId, outcome === "failed" ? "failed" : "completed", outcome, started);
  void publishAfterRun();
  return outcome;
}

// ─────────────────────────────── batch runner ───────────────────────────────

export async function runBatch(runIds: number[], opts: ProcessOptions = {}) {
  const limit = createLimiter(Math.max(1, getConfig().batch.concurrency));
  // Each company is isolated: processCompany never throws for business failures.
  await Promise.all(runIds.map((id) => limit(() => processCompany(id, opts).catch((e) => {
    repo.appendRunError(id, "orchestrator", errorMessage(e));
    return "failed" as const;
  }))));
}

const g = globalThis as unknown as { __outreachJobs?: Set<Promise<unknown>>; __outreachRecovered?: boolean };

/** Fire-and-forget execution inside the long-running Node server; progress is durable in SQLite. */
export function runInBackground(runIds: number[], opts: ProcessOptions = {}) {
  g.__outreachJobs ??= new Set();
  // After each batch, refresh the public read-only copy (Supabase) if configured.
  const job = runBatch(runIds, opts)
    .then(() => publishAfterRun())
    .finally(() => g.__outreachJobs!.delete(job));
  g.__outreachJobs.add(job);
}

export function recoverOnce() {
  if (g.__outreachRecovered) return;
  g.__outreachRecovered = true;
  repo.markInterruptedRuns();
}
