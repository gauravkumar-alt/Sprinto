import { ContactClassificationOutput } from "@/lib/schemas";
import { UNTRUSTED_DATA_RULES, json } from "./common";

export interface ContactSelectionPromptInput {
  titles: { index: number; title: string; department: string | null }[];
}

/**
 * Only used for job titles the deterministic rule table cannot classify.
 * Ranking and the final selection are always done in code.
 */
export const contactSelectionPrompt = {
  name: "contact_selection" as const,
  schema: ContactClassificationOutput,
  system: `ROLE: You classify job titles for a compliance-software sales team.

TASK: Map each job title to the closest role category relevant to owning SOC 2 / ISO 27001 / GDPR certification decisions:
ciso | head_of_security | head_of_compliance | compliance_manager | security_lead | cto | vp_engineering | coo | founder_ceo | irrelevant

RULES:
- Classify only from the title and department given. Do not assume responsibilities the title does not indicate.
- Titles unrelated to security, compliance, engineering leadership, operations leadership or company leadership are "irrelevant" (e.g. marketing, sales, HR, individual-contributor engineers).
- note: a few words explaining the mapping.

${UNTRUSTED_DATA_RULES}`,
  buildUser(input: ContactSelectionPromptInput): string {
    return `Titles (provider data):\n${json(input.titles)}\n\nReturn the classification JSON object.`;
  },
};
