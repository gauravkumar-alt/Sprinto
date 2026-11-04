/**
 * MockLLMProvider — a deterministic, keyword-based stand-in for the language
 * model so the whole pipeline can run without an API key. It is NOT an AI:
 * every output it produces is labelled MOCK (data_source = "mock"). It only
 * ever quotes text that exists in the input, so it cannot invent facts, but its
 * judgement is crude compared with a real model.
 */
import { detectInjection } from "@/lib/security/injection";
import type {
  ContactSelectionPromptInput,
  EmailGenerationPromptInput,
  EmailValidationPromptInput,
  EvidenceView,
  ExtractionPromptInput,
  MissingInformationPromptInput,
  PainPointPromptInput,
  QualificationPromptInput,
  ResearchPromptInput,
} from "@/lib/prompts";
import type {
  CompanyProfileOutput,
  ContactClassificationOutput,
  EmailCritique,
  GeneratedEmail,
  MissingInformationOutput,
  PainPoint,
  QualificationFindings,
  ResearchEvidenceOutput,
  RoleCategory,
} from "@/lib/schemas";
import type { z } from "zod/v4";
import type { LLMProvider, LLMRawResponse, LLMRequest } from "./types";

const RX = {
  saasStrong: /\bsaas\b|subscription|per seat|per user per month|billed annually|software delivered/i,
  software: /software|cloud(-based)? platform|platform|app\b/i,
  services: /services (and staffing )?firm|consult(ing|ants)|staffing|time-and-materials|do not sell a software/i,
  series: /series ([abc])\b/i,
  laterStage: /series [d-z]\b|ipo|publicly traded|seed round|pre-seed/i,
  growth: /grown to|up from|expand|raises?|raised|hiring|employees/i,
  auditActive: /(preparing for|plan(s|ning)? to pursue|undergoing|expect the report|working towards (our )?(soc|iso))/i,
  auditInitiative: /working to formali[sz]e|hiring .*(soc|iso|compliance)|lead our (soc|iso)|compliance program/i,
  certified: /(soc ?2|iso ?27001)[^.]*(certified|attested|report available)|we are (soc ?2|iso ?27001) (certified|compliant)/i,
  frameworks: /soc ?2|iso ?27001|gdpr|hipaa|audit|certif/i,
  generic: /security|encrypt|privacy|gdpr/i,
  enterpriseDirect: /require[sd]? (iso|soc|certif)|certification before signing|require .* certification/i,
  questionnaires: /security questionnaire|security review|vendor (security|procurement)/i,
  enterprise: /enterprise|fortune 500/i,
  vendor: /compliance automation (platform|software)/i,
};

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 400);
}

function categorize(s: string): string | null {
  if (RX.series.test(s) || /raises?|funding/i.test(s)) return "funding";
  if (RX.auditActive.test(s) || RX.certified.test(s) || /audit/i.test(s)) return "audit";
  if (/soc ?2|iso ?27001|gdpr|compliance|certif/i.test(s)) return "compliance";
  if (RX.questionnaires.test(s) || /procurement/i.test(s)) return "enterprise";
  if (/security|encrypt/i.test(s)) return "security";
  if (RX.enterprise.test(s) || /customers?|teams/i.test(s)) return "customers";
  if (/hiring|careers/i.test(s)) return "hiring";
  if (RX.growth.test(s)) return "growth";
  if (RX.services.test(s)) return "business_model";
  if (RX.saasStrong.test(s) || RX.software.test(s)) return "product";
  if (/founded|team|headquarter/i.test(s)) return "company";
  return null;
}

const find = (ev: EvidenceView[], re: RegExp) => ev.filter((e) => re.test(e.quote) || re.test(e.claim));
const ids = (ev: EvidenceView[]) => ev.map((e) => e.ref);

function research(input: ResearchPromptInput): ResearchEvidenceOutput {
  const evidence: ResearchEvidenceOutput["evidence"] = [];
  let suspicious = false;
  for (const p of input.pages) {
    for (const s of sentences(p.text)) {
      if (detectInjection(s).length) {
        suspicious = true;
        continue;
      }
      const cat = categorize(s);
      if (!cat) continue;
      evidence.push({ page_id: p.id, category: cat as never, claim: `The page states: ${s}`, quote: s, confidence: 0.8 });
    }
  }
  return { evidence: evidence.slice(0, 25), suspicious_instructions_detected: suspicious };
}

function extraction(input: ExtractionPromptInput): CompanyProfileOutput {
  const ev = input.evidence.filter((e) => e.type === "observed");
  const services = find(ev, RX.services);
  const saasStrong = find(ev, RX.saasStrong);
  const software = find(ev, RX.software);
  const is_saas = services.length ? "no" : saasStrong.length ? "yes" : software.length ? "unknown" : "unknown";
  const series = ev.find((e) => RX.series.test(e.quote));
  const stageLetter = series?.quote.match(RX.series)?.[1]?.toUpperCase();
  const enterprise = find(ev, RX.enterprise);
  const name = input.domain.split(".")[0].replace(/(^|-)([a-z])/g, (_, d, c) => (d ? " " : "") + c.toUpperCase());
  const sig = (re: RegExp) => find(ev, re).map((e) => ({ summary: e.quote, evidence_ids: [e.ref] }));
  const unknowns: string[] = [];
  if (!stageLetter) unknowns.push("Funding stage could not be verified");
  if (!find(ev, RX.frameworks).length) unknowns.push("No evidence about certification/audit plans");
  if (!find(ev, RX.questionnaires).length && !find(ev, RX.enterpriseDirect).length)
    unknowns.push("Whether customers require certification or security reviews");
  return {
    company_name: name,
    description: (find(ev, RX.software)[0] ?? ev[0])?.quote ?? "Unknown",
    business_model: is_saas === "yes" ? "Subscription software (SaaS)" : is_saas === "no" ? "Services" : "Unknown",
    industry: "Unknown",
    is_saas,
    saas_evidence_ids: ids(is_saas === "no" ? services : saasStrong.length ? saasStrong : software).slice(0, 3),
    funding_stage: stageLetter ? (`Series ${stageLetter}` as "Series A") : "Unknown",
    funding_evidence_ids: series ? [series.ref] : [],
    company_size: find(ev, /\d+\s+(employees|consultants)/i)[0]?.quote ?? null,
    target_customer: enterprise[0]?.quote ?? "Unknown",
    enterprise_focus: enterprise.length ? "yes" : "unknown",
    enterprise_evidence_ids: ids(enterprise).slice(0, 3),
    is_compliance_automation_vendor: find(ev, RX.vendor).length > 0,
    audit_signals: sig(/audit|certif|soc ?2|iso ?27001/i),
    compliance_signals: sig(/gdpr|compliance/i),
    security_signals: sig(/security|encrypt/i),
    customer_signals: sig(/customer|procurement|questionnaire|fortune/i),
    growth_signals: sig(/series|raise|funding|hiring|grown|employees|up from/i),
    inferences:
      is_saas === "yes"
        ? [{ claim: "The company appears to operate a SaaS business model.", basis_evidence_ids: ids(saasStrong).slice(0, 2), confidence: 0.7 }]
        : [],
    unknowns,
    contradictions: [],
    confidence: ev.length > 4 ? 0.7 : 0.4,
  };
}

function qualification(input: QualificationPromptInput): QualificationFindings {
  const ev = input.evidence.filter((e) => e.type === "observed");
  const services = find(ev, RX.services);
  const saasEv = find(ev, RX.saasStrong);
  const softwareEv = find(ev, RX.software);
  const b2cEv = find(ev, /consumers|individuals|personal use|shoppers|households/i);
  const b2bEv = find(ev, /teams|businesses|companies|enterprise|finance leaders|marketers|studios|organi[sz]ations/i);
  const series = find(ev, RX.series);
  const rolesEv = ev.find((e) => /(\d+)\s+open (roles|positions)/i.test(e.quote));
  const crit = (id: QualificationFindings["criteria"][number]["id"], hits: EvidenceView[], found = hits.length > 0) => ({
    id,
    found,
    evidence_ids: ids(hits).slice(0, 3),
    confidence: found ? 0.8 : 0,
    note: "MOCK keyword match",
  });
  const certified = find(ev, RX.certified);
  return {
    company_name: input.company_name_hint ?? input.domain.split(".")[0].replace(/(^|-)([a-z])/g, (_, d, ch) => (d ? " " : "") + ch.toUpperCase()),
    business_description: (softwareEv[0] ?? ev[0])?.quote ?? "Unknown",
    product_or_service: softwareEv.length ? "Software platform" : "Unknown",
    is_saas: services.length ? "no" : saasEv.length ? "yes" : "unknown",
    audience: b2cEv.length && !b2bEv.length ? "b2c" : b2bEv.length ? "b2b" : "unknown",
    funding_stage: series[0]?.quote.match(RX.series)?.[0].replace(/^s/, "S") ?? "Unknown",
    open_roles_count: rolesEv ? Number(rolesEv.quote.match(/(\d+)\s+open/i)![1]) : null,
    criteria: [
      crit("saas", services.length ? services : saasEv, !services.length && saasEv.length > 0),
      crit("b2b", b2cEv.length && !b2bEv.length ? b2cEv : b2bEv, b2bEv.length > 0),
      crit("product", softwareEv),
      crit("funding_series_ac", series),
      crit("open_roles", rolesEv ? [rolesEv] : []),
      crit("enterprise_pricing", find(ev, /enterprise (plan|pricing|tier)|enterprise:/i)),
      crit("preparing_certification", find(ev, RX.auditActive).filter((e) => RX.frameworks.test(e.quote))),
      crit("compliance_hiring", find(ev, /hiring .*(security|compliance|grc)/i)),
      crit("enterprise_security_reviews", [...find(ev, RX.questionnaires), ...find(ev, RX.enterpriseDirect)]),
      crit("named_enterprise_customers", find(ev, /customers include|case stud/i)),
      crit("targets_enterprise", find(ev, RX.enterprise)),
    ],
    existing_certifications: certified.map((e) => ({ name: frameworksIn(e.quote), evidence_ids: [e.ref] })),
    outside_target: { flag: find(ev, RX.vendor).length > 0, reason: "Sells compliance automation", evidence_ids: ids(find(ev, RX.vendor)) },
  };
}

function missingInformation(input: MissingInformationPromptInput): MissingInformationOutput {
  const wanted = new Set<string>();
  for (const g of input.gaps) {
    if (g.dimension === "audit" || g.dimension === "enterprise") ["security/compliance", "customers", "enterprise", "hiring"].forEach((t) => wanted.add(t));
    if (g.dimension === "stage") ["funding/news", "about", "hiring"].forEach((t) => wanted.add(t));
    if (g.dimension === "saas") ["product", "pricing", "about"].forEach((t) => wanted.add(t));
  }
  const urls = input.candidate_urls.filter((c) => wanted.has(c.tag)).slice(0, input.max_urls).map((c) => c.url);
  return {
    gaps: input.gaps.map((g) => ({ dimension: g.dimension, what_is_missing: g.question })),
    urls_to_fetch: urls,
    search_queries: [],
    reasoning_summary: urls.length ? "Fetch pages whose URL suggests they cover the open gaps." : "No candidate page is likely to resolve the gaps.",
  };
}

function classifyTitle(title: string): RoleCategory {
  const t = title.toLowerCase();
  if (/\bciso\b|chief information security/.test(t)) return "ciso";
  if (/head of (information )?security|vp,? security|director of security/.test(t)) return "head_of_security";
  if (/head of compliance|chief compliance|director of compliance/.test(t)) return "head_of_compliance";
  if (/compliance (manager|lead|officer)|grc/.test(t)) return "compliance_manager";
  if (/security (lead|engineer|manager)/.test(t)) return "security_lead";
  if (/\bcto\b|chief technology/.test(t)) return "cto";
  if (/vp,? engineering|head of engineering|director of engineering/.test(t)) return "vp_engineering";
  if (/\bcoo\b|chief operating|head of operations/.test(t)) return "coo";
  if (/founder|\bceo\b|chief executive|managing director|managing partner/.test(t)) return "founder_ceo";
  return "irrelevant";
}

function contactSelection(input: ContactSelectionPromptInput): z.infer<typeof ContactClassificationOutput> {
  return { classifications: input.titles.map((t) => ({ index: t.index, category: classifyTitle(t.title), note: "MOCK keyword match" })) };
}

function frameworksIn(text: string): string {
  const f = new Set<string>();
  if (/soc ?2/i.test(text)) f.add("SOC 2");
  if (/iso ?27001/i.test(text)) f.add("ISO 27001");
  if (/gdpr/i.test(text)) f.add("GDPR");
  return [...f].join(" and ") || "security certification";
}

function roleAngle(title: string): string {
  const c = classifyTitle(title);
  if (c === "cto" || c === "vp_engineering") return "engineering time spent on compliance work is time not spent on the product";
  if (c === "coo") return "certification timelines directly affect deal velocity and operational load";
  if (c === "founder_ceo") return "certification gaps can hold back enterprise revenue the company is pursuing";
  return "this person is likely to own the controls and evidence that audits and reviews depend on";
}

function painPoints(input: PainPointPromptInput): { insufficient_evidence: boolean; pain_points: PainPoint[] } {
  const ev = input.evidence.filter((e) => e.type === "observed");
  const out: PainPoint[] = [];
  const why = `As ${input.contact.title}, ${roleAngle(input.contact.title)}.`;
  const active = find(ev, RX.auditActive).filter((e) => RX.frameworks.test(e.quote));
  const direct = find(ev, RX.enterpriseDirect);
  const reviews = find(ev, RX.questionnaires);
  const growth = find(ev, /series|raises?|up from|expand/i);
  if (active.length) {
    out.push({
      statement: `Preparing for ${frameworksIn(active.map((e) => e.quote).join(" "))} likely means a lot of manual evidence collection and control upkeep, which can pull engineering time away from the product.`,
      why_it_matters_to_this_person: why,
      evidence_ids: ids(active).slice(0, 2),
      type: "direct",
      confidence: 0.75,
    });
  }
  if (direct.length) {
    out.push({
      statement: `Enterprise prospects that require ${frameworksIn(direct[0].quote)} before signing may slow deals down until certification is in place.`,
      why_it_matters_to_this_person: why,
      evidence_ids: ids(direct).slice(0, 2),
      type: "direct",
      confidence: 0.75,
    });
  }
  if (reviews.length && out.length < 2) {
    out.push({
      statement: "Security questionnaires from enterprise buyers may be taking repeated, manual effort to answer during procurement.",
      why_it_matters_to_this_person: why,
      evidence_ids: ids(reviews).slice(0, 2),
      type: "direct",
      confidence: 0.65,
    });
  }
  if (growth.length && out.length < 2) {
    out.push({
      statement: "Rapid growth may be increasing the number of customers, systems and frameworks that need to stay compliant at the same time.",
      why_it_matters_to_this_person: why,
      evidence_ids: ids(growth).slice(0, 2),
      type: "inferred",
      confidence: 0.5,
    });
  }
  return { insufficient_evidence: out.length < 2, pain_points: out.slice(0, 2) };
}

function emailGeneration(input: EmailGenerationPromptInput): GeneratedEmail {
  const pain = input.pain_points[0];
  const hookEv = input.evidence.find((e) => pain.evidence_ids.includes(e.ref)) ?? input.evidence[0];
  const page = hookEv?.source_url ? new URL(hookEv.source_url).pathname.replace(/^\/|\/$/g, "").split("/")[0] || "home" : "website";
  const hook = `I was reading the ${page} page on ${input.company_name}'s website, which says: "${hookEv?.quote ?? ""}"`;
  const body = [
    `Hi ${input.contact.first_name},`,
    "",
    hook,
    "",
    `${pain.statement} Given your role as ${input.contact.title}, I thought this might be relevant.`,
    "",
    "Sprinto helps SaaS companies automate the evidence collection and control monitoring behind frameworks like SOC 2, ISO 27001 and GDPR, so teams stay audit-ready with much less manual work.",
    "",
    "Would a short call next week be useful to compare notes?",
    "",
    "Best,",
    input.sender_name,
  ].join("\n");
  return {
    subject: `${input.company_name} and ${frameworksIn(pain.statement)} readiness`,
    body,
    prospect_name: input.contact.full_name,
    prospect_role: input.contact.title,
    personalisation_hook: hook,
    pain_point_used: pain.statement,
    evidence_ids: [...new Set([...(hookEv ? [hookEv.ref] : []), ...pain.evidence_ids])],
    personalisation_explanation: `MOCK template: quotes a verified page (${hookEv?.ref ?? "n/a"}) and uses the first evidence-backed pain point.`,
  };
}

function emailValidation(input: EmailValidationPromptInput): EmailCritique {
  void input;
  return {
    verdict: "PASS",
    checks: [{ check: "mock_critic", passed: true, note: "MOCK critic: no contextual review performed; deterministic checks still apply." }],
    issues: [],
  };
}

export class MockLLMProvider implements LLMProvider {
  readonly name = "mock-llm";
  readonly model = "mock-heuristic";
  readonly dataSource = "mock" as const;

  async complete<T>(req: LLMRequest<T>): Promise<LLMRawResponse> {
    const i = req.input as never;
    const handlers: Record<LLMRequest<T>["task"], () => unknown> = {
      research: () => research(i),
      extraction: () => extraction(i),
      qualification: () => qualification(i),
      missing_information: () => missingInformation(i),
      contact_selection: () => contactSelection(i),
      pain_points: () => painPoints(i),
      email_generation: () => emailGeneration(i),
      email_validation: () => emailValidation(i),
    };
    return { object: handlers[req.task](), model: this.model, inputTokens: 0, outputTokens: 0 };
  }
}
