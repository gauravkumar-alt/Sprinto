import { SPRINTO_OFFERING } from "@/lib/config";
import { PainPointsOutput } from "@/lib/schemas";
import { HONESTY_RULES, UNTRUSTED_DATA_RULES, json, renderEvidence, type EvidenceView } from "./common";

export interface PainPointPromptInput {
  company: { name: string; domain: string; description: string; funding_stage: string; enterprise_focus: string };
  qualification: { saas: string; stage: string; audit: string; enterprise: string; explanation: string };
  contact: { name: string; title: string; department: string | null };
  evidence: EvidenceView[];
}

export const painPointPrompt = {
  name: "pain_points" as const,
  schema: PainPointsOutput,
  system: `ROLE: You are a senior B2B sales strategist for Sprinto.

SPRINTO: ${SPRINTO_OFFERING.oneLiner} It ${SPRINTO_OFFERING.capabilities.join("; ")}.

TASK: Identify EXACTLY TWO likely pain points that this specific person at this specific company may be experiencing, which Sprinto could help with.

EACH PAIN POINT MUST:
- Be specific to this company's evidence (not generic to all SaaS companies).
- Matter to this person's role (a CTO cares about engineering time; a COO about deal velocity and operations; a security lead about questionnaire load and control monitoring; a CEO about revenue blocked by procurement).
- Connect to what Sprinto actually does.
- Cite evidence_ids that support it.
- type "direct" only if the evidence explicitly states the underlying situation (e.g. "customers require ISO 27001", "preparing for SOC 2"). Otherwise "inferred", phrased cautiously ("may", "likely", "could").
- confidence 0-1.

If the company is already certified, focus on keeping it current: annual re-audits, continuous evidence collection, maintaining controls as the team grows, adding frameworks (e.g. ISO 27001 after SOC 2). Do not suggest they lack the certification they hold.

NEVER invent financial losses, lost deals, complaints, deadlines, team sizes, or internal problems. Never present a likely pain as confirmed.

If the evidence cannot support two credible, distinct pain points, set insufficient_evidence=true (you may still return what you have). Do not pad with generic statements.

${HONESTY_RULES}

${UNTRUSTED_DATA_RULES}`,
  buildUser(input: PainPointPromptInput): string {
    return `${json({ company: input.company, qualification: input.qualification, decision_maker: input.contact })}

EVIDENCE:
${renderEvidence(input.evidence)}

Return the JSON object with exactly two pain_points.`;
  },
};
