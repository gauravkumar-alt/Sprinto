import { openDb, setDbForTests } from "@/lib/db";
import { setProviderOverride, type ProviderSet } from "@/lib/providers";
import { MockContactProvider } from "@/lib/providers/contact/mock";
import { MockEmailProvider } from "@/lib/providers/email/mock";
import { MockLLMProvider } from "@/lib/providers/llm/mock";
import type { LLMProvider, LLMRawResponse, LLMRequest, PromptName } from "@/lib/providers/llm/types";
import { MockResearchProvider } from "@/lib/providers/research/mock";
import { CRITERION_IDS, type QualificationFindings } from "@/lib/schemas";

export function freshDb() {
  process.env.APP_MODE = "demo";
  process.env.DEMO_INBOX_EMAIL = "me@inbox.test";
  process.env.LLM_API_KEY = "";
  process.env.HUNTER_API_KEY = "";
  process.env.GMAIL_CLIENT_ID = "";
  const db = openDb(":memory:");
  setDbForTests(db);
  return db;
}

/** Wraps the mock model and lets a test override (and count) individual tasks. */
export class ScriptedLLM implements LLMProvider {
  readonly name = "scripted";
  readonly model = "scripted";
  readonly dataSource = "mock" as const;
  calls: Record<string, number> = {};
  private base = new MockLLMProvider();
  constructor(private overrides: Partial<Record<PromptName, (input: unknown, n: number) => unknown>> = {}) {}
  async complete<T>(req: LLMRequest<T>): Promise<LLMRawResponse> {
    const n = (this.calls[req.task] = (this.calls[req.task] ?? 0) + 1);
    const o = this.overrides[req.task];
    if (o) {
      const v = o(req.input, n);
      return typeof v === "string" ? { text: v, model: this.model } : { object: v, model: this.model };
    }
    return this.base.complete(req);
  }
}

export function providers(over: Partial<ProviderSet> = {}): ProviderSet {
  return {
    research: new MockResearchProvider(),
    search: { name: "none", available: false, search: async () => [] },
    llm: new MockLLMProvider(),
    contact: new MockContactProvider(),
    email: new MockEmailProvider(),
    unavailable: {},
    ...over,
  };
}

export function useProviders(over: Partial<ProviderSet> = {}) {
  const p = providers(over);
  setProviderOverride(() => p);
  return p;
}

/** Findings builder: every criterion not found unless listed in `found` as { id: evidenceIds }. */
export function findings(over: Partial<QualificationFindings> & { found?: Record<string, string[]> } = {}): QualificationFindings {
  const { found = {}, ...rest } = over;
  return {
    company_name: "Acme",
    business_description: "Acme builds software",
    product_or_service: "Platform",
    is_saas: "unknown",
    audience: "unknown",
    funding_stage: "Unknown",
    open_roles_count: null,
    criteria: CRITERION_IDS.map((id) => ({ id, found: Boolean(found[id]), evidence_ids: found[id] ?? [], confidence: 0.8, note: "" })),
    existing_certifications: [],
    outside_target: { flag: false, reason: "", evidence_ids: [] },
    ...rest,
  };
}
