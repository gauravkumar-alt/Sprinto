import { openDb, setDbForTests } from "@/lib/db";
import { setProviderOverride, type ProviderSet } from "@/lib/providers";
import { MockContactProvider } from "@/lib/providers/contact/mock";
import { MockEmailProvider } from "@/lib/providers/email/mock";
import { MockLLMProvider } from "@/lib/providers/llm/mock";
import type { LLMProvider, LLMRawResponse, LLMRequest, PromptName } from "@/lib/providers/llm/types";
import { MockResearchProvider } from "@/lib/providers/research/mock";
import type { QualificationClassification } from "@/lib/schemas";

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

export function classification(over: Partial<QualificationClassification> = {}): QualificationClassification {
  return {
    saas: { level: "unknown", evidence_ids: [], rationale: "" },
    stage: { level: "unknown", evidence_ids: [], rationale: "", stage_label: "Unknown" },
    audit: { level: "none", evidence_ids: [], rationale: "" },
    enterprise: { level: "none", evidence_ids: [], rationale: "" },
    outside_target: { flag: false, reason: "", evidence_ids: [] },
    missing_information: [],
    ...over,
  };
}
