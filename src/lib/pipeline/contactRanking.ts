/**
 * Deterministic contact ranking. Picks the person most likely to own the
 * compliance/certification problem — not simply the most senior person.
 * Company stage changes the weights: in early-stage companies founders/CTOs
 * usually own compliance; in larger ones security/compliance leaders do.
 */
import type { ContactCandidate, RankedContact, RoleCategory } from "@/lib/schemas";

const TITLE_RULES: { re: RegExp; category: RoleCategory }[] = [
  { re: /\bciso\b|chief information security|chief security officer|\bcso\b/i, category: "ciso" },
  { re: /head of (information |infra(structure)? )?security|(vp|vice president|director)[ ,of-]*(information )?security|security director/i, category: "head_of_security" },
  { re: /chief compliance|head of (compliance|grc|risk)|(vp|director)[ ,of-]*(compliance|grc|risk)/i, category: "head_of_compliance" },
  { re: /compliance (manager|lead|officer|analyst)|grc (manager|lead)|risk (and|&) compliance/i, category: "compliance_manager" },
  { re: /security (lead|manager|engineer|architect)|devsecops|infosec/i, category: "security_lead" },
  { re: /\bcto\b|chief technology|chief technical/i, category: "cto" },
  { re: /(vp|vice president|head|director)[ ,of-]*(engineering|technology|infrastructure|platform|it\b)/i, category: "vp_engineering" },
  { re: /\bcoo\b|chief operating|head of operations|(vp|director)[ ,of-]*operations/i, category: "coo" },
  { re: /founder|\bceo\b|chief executive|managing director|\bpresident\b|managing partner/i, category: "founder_ceo" },
];

export function classifyTitleByRules(title: string | null): RoleCategory | null {
  if (!title) return null;
  for (const r of TITLE_RULES) if (r.re.test(title)) return r.category;
  return null;
}

export type CompanyScale = "early" | "growth" | "large";

/** Infer scale from verified stage/size only; unknown → "growth" (neutral weights). */
export function companyScale(stageLabel: string, sizeText: string | null): CompanyScale {
  const s = stageLabel.toLowerCase();
  if (/pre-seed|seed|series a/.test(s)) return "early";
  if (/series d|public|ipo/.test(s)) return "large";
  const n = Number(sizeText?.match(/(\d[\d,]*)\s*(\+)?\s*(employees|people|staff)/i)?.[1]?.replace(/,/g, ""));
  if (Number.isFinite(n) && n > 0) return n < 60 ? "early" : n > 500 ? "large" : "growth";
  return "growth";
}

const ROLE_WEIGHTS: Record<CompanyScale, Record<RoleCategory, number>> = {
  early: { ciso: 85, head_of_security: 85, head_of_compliance: 85, compliance_manager: 70, security_lead: 70, cto: 90, vp_engineering: 70, coo: 75, founder_ceo: 80, irrelevant: 0 },
  growth: { ciso: 95, head_of_security: 92, head_of_compliance: 92, compliance_manager: 80, security_lead: 72, cto: 78, vp_engineering: 65, coo: 60, founder_ceo: 50, irrelevant: 0 },
  large: { ciso: 100, head_of_security: 95, head_of_compliance: 95, compliance_manager: 85, security_lead: 70, cto: 60, vp_engineering: 55, coo: 45, founder_ceo: 30, irrelevant: 0 },
};

export const ROLE_REASON: Record<RoleCategory, string> = {
  ciso: "leads information security, which directly owns certification and audit readiness",
  head_of_security: "leads the security function, which typically owns SOC 2 / ISO 27001 controls",
  head_of_compliance: "leads compliance, the function that owns certifications and audits",
  compliance_manager: "manages compliance work day to day, including audits and evidence collection",
  security_lead: "works hands-on on security controls that audits test",
  cto: "leads technology; in companies without a dedicated security leader the CTO usually owns SOC 2 / ISO 27001 work",
  vp_engineering: "leads engineering, whose time is consumed by compliance evidence and control work",
  coo: "leads operations; compliance programmes and enterprise deal requirements often sit with the COO",
  founder_ceo: "is the founder/CEO; at smaller companies the founder often sponsors certification to unblock enterprise sales",
  irrelevant: "title is not related to security, compliance or technical/operational leadership",
};

const VERIFICATION_POINTS: Record<string, number> = { valid: 10, accept_all: 3, unknown: 0, webmail: -5, disposable: -20, invalid: -20 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function rankContacts(
  candidates: ContactCandidate[],
  opts: { scale: CompanyScale; domain: string; llmCategories?: Map<number, RoleCategory> },
): RankedContact[] {
  const weights = ROLE_WEIGHTS[opts.scale];
  const ranked = candidates.map((c, i): RankedContact => {
    const reasons: string[] = [];
    const ruleCat = classifyTitleByRules(c.title);
    const category = ruleCat ?? opts.llmCategories?.get(i) ?? "irrelevant";
    let score = weights[category];
    reasons.push(c.title ? `Title "${c.title}" → ${category.replace(/_/g, " ")}${ruleCat ? "" : " (model-classified)"}` : "No job title provided");

    const dept = (c.department ?? "").toLowerCase();
    if (/security|it|engineering|legal|compliance/.test(dept)) score += 5;
    else if (/executive|management|operations/.test(dept)) score += 3;
    else if (dept && /marketing|sales|hr|finance|support|communication|design/.test(dept)) score -= 10;

    const emailOk = Boolean(c.email && EMAIL_RE.test(c.email));
    const emailOnDomain = emailOk && c.email!.toLowerCase().endsWith("@" + opts.domain);
    if (!c.email) reasons.push("No email address available");
    else if (!emailOk) reasons.push("Email address is malformed");
    else if (!emailOnDomain) reasons.push("Email is not on the company's domain");
    if (emailOnDomain) score += 5;
    const v = (c.verificationStatus ?? "").toLowerCase();
    score += VERIFICATION_POINTS[v] ?? 0;
    if (v) reasons.push(`Email verification: ${v}`);
    else if (c.email) reasons.push("Email verification status not reported");
    if (typeof c.providerConfidence === "number") score += Math.round((c.providerConfidence - 50) / 10);
    if (c.emailType === "generic") score -= 30;

    const hasName = Boolean(c.name && c.name.trim().split(/\s+/).length >= 1 && c.firstName);
    const eligible = hasName && category !== "irrelevant" && emailOk && v !== "invalid" && c.emailType !== "generic";
    if (!hasName) reasons.push("No person name — not eligible");
    if (v === "invalid") reasons.push("Email marked invalid — not eligible");
    return { candidate: c, category, score: Math.max(0, score), reasons, eligible };
  });
  return ranked.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
}

export function selectionReason(r: RankedContact, scale: CompanyScale): string {
  const c = r.candidate;
  const scaleText = scale === "early" ? "an early-stage company" : scale === "large" ? "a larger company" : "a growth-stage company";
  return `Selected ${c.name} (${c.title}) because this person ${ROLE_REASON[r.category]}. Ranked for ${scaleText}; contact data from ${c.provider === "manual" ? "manual entry" : c.provider === "hunter" ? "Hunter.io" : "MOCK provider"}${c.verificationStatus ? `, email verification "${c.verificationStatus}"` : ""}.`;
}

/** Confidence in the selected contact (0-1), from role fit and data quality. */
export function contactConfidence(r: RankedContact): number {
  const v = (r.candidate.verificationStatus ?? "").toLowerCase();
  const base = Math.min(1, r.score / 110);
  const dq = v === "valid" ? 1 : v === "accept_all" ? 0.85 : 0.7;
  return Math.round(base * dq * 100) / 100;
}
