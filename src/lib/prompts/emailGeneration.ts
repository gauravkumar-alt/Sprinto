import { SPRINTO_OFFERING } from "@/lib/config";
import { EmailOutput, type PainPoint } from "@/lib/schemas";
import { HONESTY_RULES, UNTRUSTED_DATA_RULES, json, renderEvidence, type EvidenceView } from "./common";

export interface EmailGenerationPromptInput {
  company_name: string;
  domain: string;
  contact: { first_name: string; full_name: string; title: string };
  audit_level: string;
  enterprise_level: string;
  pain_points: PainPoint[];
  evidence: EvidenceView[];
  sender_name: string;
  min_words: number;
  max_words: number;
  previous_issues: string[];
}

export const emailGenerationPrompt = {
  name: "email_generation" as const,
  schema: EmailOutput,
  system: `ROLE: You write first-touch cold emails for Sprinto's Growth Lead. You write like a thoughtful human, not a marketer.

SPRINTO (the only product claims you may make): ${SPRINTO_OFFERING.oneLiner} It ${SPRINTO_OFFERING.capabilities.join("; ")}.

TASK: Write one personalised cold email to the named decision-maker.

STRUCTURE (natural prose, no headings or bullet lists):
1. Greeting exactly "Hi <first name>," on the first line.
2. One specific, verified observation about the company (the personalisation hook) — from the evidence, cited.
3. One relevant pain point, phrased cautiously if inferred.
4. How Sprinto relates to it — plainly, no exaggeration, no statistics or customer names.
5. A simple, low-pressure call to action ending with a question mark (e.g. "Would a 20-minute call next week be useful?").
6. Sign-off "Best,\\n<sender name>".

LENGTH: between min_words and max_words words (target 80–150).

STYLE — avoid: "I hope this email finds you well", "I came across", "I've been following your journey", flattery, buzzwords (synergy, leverage, game-changer, revolutionise, cutting-edge, best-in-class, seamless), fake familiarity, fake urgency, exclamation marks, numbers or claims not present in the evidence.

ACCURACY:
- Only say the company is preparing for SOC 2/ISO 27001 if audit_level is "active_or_planned" and the evidence says so.
- If audit_level is "already_certified": acknowledge the certification they hold (from the evidence) and pitch keeping it effortless — annual re-audits, continuous control monitoring, adding frameworks. Never imply they are not certified or are preparing for it.
- Only say customers require certification if enterprise_level is "direct_requirement".
- The company name must be exactly as given. Address only the named person.

OUTPUT FIELDS: personalisation_hook = the observation used; pain_point_used = which pain point; evidence_ids = ids backing the hook and pain point; personalisation_explanation = 1–2 sentences on why this email fits this person.

If previous_issues is non-empty, this is a regeneration: fix every listed issue.

${HONESTY_RULES}

${UNTRUSTED_DATA_RULES}`,
  buildUser(input: EmailGenerationPromptInput): string {
    const { evidence, ...rest } = input;
    return `${json(rest)}

EVIDENCE:
${renderEvidence(evidence)}

Return the email JSON object.`;
  },
};
