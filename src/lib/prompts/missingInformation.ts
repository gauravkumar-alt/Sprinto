import { MissingInformationOutput } from "@/lib/schemas";
import { UNTRUSTED_DATA_RULES, json } from "./common";

export interface MissingInformationPromptInput {
  domain: string;
  gaps: { dimension: string; question: string }[];
  candidate_urls: { url: string; tag: string }[];
  search_available: boolean;
  max_urls: number;
  max_queries: number;
  previous_actions: string[];
}

export const missingInformationPrompt = {
  name: "missing_information" as const,
  schema: MissingInformationOutput,
  system: `ROLE: You plan one bounded round of additional research for a prospect-qualification agent.

TASK: Given the information gaps, choose which of the CANDIDATE URLS to fetch (and, only if search is available, which web search queries to run) to resolve the gaps.

RULES:
- urls_to_fetch MUST be copied exactly from the candidate list. Any other URL is discarded by the system.
- Choose at most max_urls URLs and max_queries queries. Prefer security/trust/compliance, press/funding, customers/enterprise and careers pages, matched to the gaps.
- If search_available is false, return an empty search_queries array.
- Search queries must target the company by name/domain, e.g. "acme.com Series B funding" or "acme SOC 2 certification".
- Do not repeat previous actions.
- If no candidate can plausibly resolve the gaps, return empty arrays; the system will stop and mark the company for review.

${UNTRUSTED_DATA_RULES}`,
  buildUser(input: MissingInformationPromptInput): string {
    return `Company domain: ${input.domain}
${json({
  gaps: input.gaps,
  candidate_urls: input.candidate_urls,
  search_available: input.search_available,
  max_urls: input.max_urls,
  max_queries: input.max_queries,
  previous_actions: input.previous_actions,
})}

Return the research plan JSON object.`;
  },
};
