import { SPRINTO_OFFERING } from "@/lib/config";
import { EmailCritiqueOutput, type GeneratedEmail, type PainPoint } from "@/lib/schemas";
import { UNTRUSTED_DATA_RULES, json, renderEvidence, type EvidenceView } from "./common";

export interface EmailValidationPromptInput {
  email: GeneratedEmail;
  company_name: string;
  contact: { full_name: string; title: string };
  pain_points: PainPoint[];
  evidence: EvidenceView[];
}

export const emailValidationPrompt = {
  name: "email_validation" as const,
  schema: EmailCritiqueOutput,
  system: `ROLE: You are a strict quality reviewer for outbound sales emails. Deterministic checks (names, length, banned phrases, evidence ids) have already passed; you assess what code cannot.

SPRINTO (accurate description): ${SPRINTO_OFFERING.oneLiner} It ${SPRINTO_OFFERING.capabilities.join("; ")}.

CHECK EACH (return one entry per check in "checks"):
1. hook_specific — the personalisation hook is specific to this company, not generic.
2. hook_supported — the hook is supported by the cited evidence.
3. pain_supported — the pain point is evidence-backed and phrased cautiously if inferred.
4. role_relevant — the email is relevant to this person's role.
5. sprinto_accurate — Sprinto is described accurately with no invented claims, stats or customers.
6. no_hallucination — no facts about the company that the evidence does not support.
7. human_tone — sounds like a thoughtful human; no flattery, buzzwords, fake urgency or fake familiarity.
8. clear_cta — a single clear, low-pressure call to action.

verdict = "PASS" only if every check passes; otherwise "REGENERATE" with concrete, actionable issues.

${UNTRUSTED_DATA_RULES}`,
  buildUser(input: EmailValidationPromptInput): string {
    const { evidence, ...rest } = input;
    return `${json(rest)}

EVIDENCE:
${renderEvidence(evidence)}

Return the review JSON object.`;
  },
};
