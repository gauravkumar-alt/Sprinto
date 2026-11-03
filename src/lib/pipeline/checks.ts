/**
 * Deterministic validation used between stages: evidence-id checks, quote
 * verification, unsupported-number detection, pain-point checks and the
 * email rule set. None of these need a model.
 */
import { getConfig } from "@/lib/config";
import type { GeneratedEmail, PainPoint } from "@/lib/schemas";
import { normalizeForMatch, wordCount } from "@/lib/util";

/** Does `quote` appear (normalised) in `pageText`? */
export function quoteAppearsIn(quote: string, pageText: string): boolean {
  const q = normalizeForMatch(quote).replace(/[….]+$/, "");
  if (q.length < 12) return false;
  return normalizeForMatch(pageText).includes(q);
}

const NUMBER_RE = /([$€£₹])?(\d[\d,]*(?:\.\d+)?)\s?(%|percent|[kmb]n?\b|million|billion|x\b)?/gi;

interface NumberToken {
  raw: string;
  /** value + unit, e.g. "40|m" for "$40M"/"40 million", "40|%" for "40%", "40|" for a bare 40. */
  key: string;
  value: string;
  exempt: boolean;
}

function scaleOf(unit: string | undefined): string {
  const u = (unit ?? "").toLowerCase();
  if (u === "%" || u === "percent") return "%";
  if (u === "x") return "x";
  if (u === "k" || u === "kn") return "k";
  if (u === "m" || u === "mn" || u === "million") return "m";
  if (u === "b" || u === "bn" || u === "billion") return "b";
  return "";
}

function numberTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const value = m[2].replace(/,/g, "").replace(/\.$/, "");
    const scale = scaleOf(m[3]);
    const before = text.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0);
    // Framework names and calendar years are not claims: "SOC 2", "ISO 27001", "in 2026".
    const exempt =
      (value === "2" && !scale && /soc\s*-?$/i.test(before)) ||
      (value === "27001" && /iso\s*-?$/i.test(before)) ||
      (!scale && !m[1] && /^(19|20)\d\d$/.test(value));
    out.push({ raw: m[0].trim(), key: `${value}|${scale}`, value, exempt });
  }
  return out;
}

/**
 * Numbers/amounts in `text` that are not supported by an identical value AND unit in the evidence.
 * "20" is not supported by "2024"; "$40M" is not supported by "40 employees"; "$32 million" is supported by "$32M".
 */
export function unsupportedNumbers(text: string, supporting: string[]): string[] {
  const support = new Set(numberTokens(supporting.join(" ")).map((t) => t.key));
  return numberTokens(text)
    .filter((t) => !t.exempt && !support.has(t.key))
    .map((t) => t.raw);
}

const EMAIL_ADDRESS_RE = /[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}/i;

export function validRefs(ids: string[], known: Set<string>): string[] {
  return [...new Set(ids.filter((id) => known.has(id)))];
}

// ───────── pain points ─────────

export interface PainPointCheck {
  ok: boolean;
  painPoints: PainPoint[];
  problems: string[];
}

export function checkPainPoints(
  raw: { insufficient_evidence: boolean; pain_points: PainPoint[] },
  evidence: Map<string, { type: string; text: string }>,
): PainPointCheck {
  const problems: string[] = [];
  const known = new Set(evidence.keys());
  const cleaned = raw.pain_points.map((p) => {
    const refs = validRefs(p.evidence_ids, known);
    let type = p.type;
    if (type === "direct" && !refs.some((r) => evidence.get(r)!.type === "observed")) type = "inferred";
    const nums = unsupportedNumbers(p.statement, refs.map((r) => evidence.get(r)!.text));
    if (nums.length) problems.push(`Pain point cites unsupported numbers: ${nums.join(", ")}`);
    if (refs.length === 0) problems.push(`Pain point has no valid evidence: "${p.statement.slice(0, 60)}…"`);
    return { ...p, evidence_ids: refs, type, confidence: Math.max(0, Math.min(1, p.confidence > 1 ? p.confidence / 100 : p.confidence)) };
  });
  if (raw.insufficient_evidence) problems.push("Model reported insufficient evidence for two credible pain points");
  if (cleaned.length !== 2) problems.push(`Expected exactly 2 pain points, got ${cleaned.length}`);
  if (cleaned.length === 2 && normalizeForMatch(cleaned[0].statement) === normalizeForMatch(cleaned[1].statement))
    problems.push("The two pain points are identical");
  return { ok: problems.length === 0, painPoints: cleaned.slice(0, 2), problems };
}

// ───────── email ─────────

export const BANNED_PHRASES = [
  "hope this email finds you",
  "hope you're doing well",
  "hope you are doing well",
  "i came across",
  "following your journey",
  "incredible journey",
  "amazing journey",
  "synergy",
  "synergies",
  "leverage",
  "game-changer",
  "game changer",
  "revolutionize",
  "revolutionise",
  "cutting-edge",
  "best-in-class",
  "world-class",
  "seamless",
  "act now",
  "limited time",
  "urgent",
  "don't miss",
  "guarantee",
  "100%",
  "touch base",
  "circle back",
  "i'd love to pick your brain",
];

export interface EmailCheckResult {
  passed: boolean;
  checks: { check: string; passed: boolean; note: string }[];
  issues: string[];
}

export function checkEmail(
  email: GeneratedEmail,
  ctx: {
    companyName: string;
    domain: string;
    contactFullName: string;
    contactFirstName: string;
    contactTitle: string;
    prospectEmail: string | null;
    knownEvidence: Map<string, { type: string; text: string }>;
    auditLevel: string;
    enterpriseLevel: string;
    otherCompanyNames?: string[];
  },
): EmailCheckResult {
  const cfg = getConfig().email;
  const checks: EmailCheckResult["checks"] = [];
  const add = (check: string, passed: boolean, note = "") => checks.push({ check, passed, note });
  const body = email.body.trim();
  const lower = body.toLowerCase();
  const words = wordCount(body);

  add("subject_present", email.subject.trim().length > 0 && email.subject.length <= 100, email.subject.length > 100 ? "Subject too long" : "");
  add("body_present", body.length > 0);
  const firstLine = body.split(/\n/)[0].trim();
  add(
    "greets_prospect_by_name",
    new RegExp(`^(hi|hello|dear)\\s+${escapeRe(ctx.contactFirstName)}\\b`, "i").test(firstLine),
    `First line: "${firstLine}"`,
  );
  add("prospect_name_matches", normalizeForMatch(email.prospect_name) === normalizeForMatch(ctx.contactFullName), email.prospect_name);
  add("company_name_present", lower.includes(ctx.companyName.toLowerCase()) || lower.includes(ctx.domain.toLowerCase()), ctx.companyName);
  const wrongCompanies = (ctx.otherCompanyNames ?? []).filter((n) => n.length > 3 && n.toLowerCase() !== ctx.companyName.toLowerCase() && lower.includes(n.toLowerCase()));
  add("no_other_company_names", wrongCompanies.length === 0, wrongCompanies.join(", "));
  const domainsInBody = (body.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|io|ai|co|net|org|app|dev|example|in|so)\b/gi) ?? [])
    .map((d) => d.toLowerCase())
    .filter((d) => d !== ctx.domain && !d.endsWith("." + ctx.domain) && !/sprinto/.test(d));
  add("no_foreign_domains", domainsInBody.length === 0, domainsInBody.join(", "));
  add("length_ok", words >= cfg.minWords && words <= cfg.maxWords, `${words} words (allowed ${cfg.minWords}–${cfg.maxWords})`);
  const subjectDomains = (email.subject.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|io|ai|co|net|org|app|dev|example|in|so)\b/gi) ?? []).filter(
    (d) => d.toLowerCase() !== ctx.domain,
  );
  add("subject_clean", subjectDomains.length === 0 && !/[\r\n]/.test(email.subject), subjectDomains.join(", "));
  const banned = BANNED_PHRASES.filter((p) => lower.includes(p) || email.subject.toLowerCase().includes(p));
  add("no_banned_phrases", banned.length === 0, banned.join(", "));
  add("no_exclamation_overuse", (body.match(/!/g) ?? []).length <= 1);
  add("mentions_sprinto", /sprinto/i.test(body));
  const lastLines = body.split(/\n/).slice(-6).join(" ");
  add("clear_cta", /\?/.test(lastLines) || /\b(call|chat|conversation|meeting)\b/i.test(lastLines));
  add("no_prospect_email_in_body", !ctx.prospectEmail || !lower.includes(ctx.prospectEmail.toLowerCase()));
  // No email address of any kind in the subject or body (the email must never carry a prospect/company address).
  add("no_email_addresses", !EMAIL_ADDRESS_RE.test(body) && !EMAIL_ADDRESS_RE.test(email.subject));
  const refs = validRefs(email.evidence_ids, new Set(ctx.knownEvidence.keys()));
  add("evidence_cited", refs.length > 0, refs.length ? refs.join(", ") : "No valid evidence ids");
  const nums = unsupportedNumbers(`${email.subject}\n${body}`.replace(/\b\d+[- ]minute\b/gi, ""), refs.map((r) => ctx.knownEvidence.get(r)!.text));
  add("no_unsupported_numbers", nums.length === 0, nums.join(", "));
  const claimsPrep = /\b(you('re| are)|you've been|team is|is) (currently )?(preparing|getting ready) for (your |a |the )?(soc|iso)/i.test(body);
  add("prep_claim_supported", !claimsPrep || ctx.auditLevel === "active_or_planned", claimsPrep ? `audit level is ${ctx.auditLevel}` : "");
  const claimsRequirement = /(customers|prospects|buyers) (are )?(requir|demand|ask(ing)? for)\w* (soc|iso|certif)/i.test(body);
  add("requirement_claim_supported", !claimsRequirement || ctx.enterpriseLevel === "direct_requirement", claimsRequirement ? `enterprise level is ${ctx.enterpriseLevel}` : "");

  const issues = checks.filter((c) => !c.passed).map((c) => `${c.check}${c.note ? `: ${c.note}` : ""}`);
  return { passed: issues.length === 0, checks, issues };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
