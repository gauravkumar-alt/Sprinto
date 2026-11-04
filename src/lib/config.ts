/**
 * Central configuration. Every business rule and limit lives here so it can be
 * tuned without touching agent code. Secrets are read from the environment and
 * are only ever used server-side.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined ? fallback : v.trim();
}

export type AppMode = "demo" | "live";

export function getConfig() {
  const mode: AppMode = str("APP_MODE", "demo") === "live" ? "live" : "demo";
  const llmProvider = str("LLM_PROVIDER", "anthropic").toLowerCase();
  const isGemini = llmProvider === "gemini";
  return {
    mode,
    databaseUrl: str("APP_DATABASE_URL", "file:./data/outreach.db"),
    campaignId: str("CAMPAIGN_ID", "sprinto-mesa-demo"),
    senderName: str("SENDER_NAME", "Sprinto Growth Team"),

    llm: {
      provider: llmProvider, // "anthropic" | "gemini"
      apiKey: str("LLM_API_KEY") || (isGemini ? str("GEMINI_API_KEY") || str("GOOGLE_API_KEY") : str("ANTHROPIC_API_KEY")),
      model: str("LLM_MODEL", isGemini ? "gemini-3.6-flash" : "claude-opus-5-5"),
      /** Tried in order when the primary model is overloaded (HTTP 503) or out of quota (429). Gemini only. */
      fallbackModels: str("LLM_FALLBACK_MODELS", isGemini ? "gemini-3.5-flash,gemini-3.5-flash-lite" : "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      effort: str("LLM_EFFORT", "medium") as "low" | "medium" | "high",
      maxJsonRetries: num("LLM_MAX_JSON_RETRIES", 1),
      timeoutMs: num("LLM_TIMEOUT_MS", isGemini ? 75_000 : 120_000),
      refusalFallback: str("LLM_REFUSAL_FALLBACK", "true") !== "false",
    },

    research: {
      provider: str("RESEARCH_PROVIDER", ""), // "tavily" or empty (website only)
      apiKey: str("RESEARCH_API_KEY"),
      /** One homepage request, then at most this many targeted page fetches per company. */
      maxAdditionalPages: num("RESEARCH_MAX_ADDITIONAL_PAGES", 4),
      maxPagesPerRound: num("RESEARCH_MAX_PAGES_PER_ROUND", 2),
      maxAdditionalRounds: num("RESEARCH_MAX_ROUNDS", 3),
      /** Cleaned content sent to the model per research pass (~2,000 tokens). */
      contextBudgetChars: num("RESEARCH_CONTEXT_CHARS", 8000),
      /** Render JavaScript-only pages with a headless browser when plain HTML has too little text. */
      browserFallback: str("RESEARCH_BROWSER_FALLBACK", "true") !== "false",
      maxSearchCalls: num("RESEARCH_MAX_SEARCH_CALLS", 2),
      pageTimeoutMs: num("RESEARCH_PAGE_TIMEOUT_MS", 12_000),
      maxRedirects: num("RESEARCH_MAX_REDIRECTS", 4),
      maxBytesPerPage: num("RESEARCH_MAX_BYTES", 2_000_000),
      maxCharsPerPage: num("RESEARCH_MAX_CHARS_PER_PAGE", 12_000),
      perHostDelayMs: num("RESEARCH_HOST_DELAY_MS", 600),
      cacheHours: num("RESEARCH_CACHE_HOURS", 72),
      userAgent: str(
        "RESEARCH_USER_AGENT",
        "SprintoOutreachResearchBot/0.1 (+case-study prototype; respects robots.txt)",
      ),
    },

    hunter: {
      apiKey: str("HUNTER_API_KEY"),
      monthlyLimit: num("HUNTER_MONTHLY_LIMIT", 25),
      resultLimit: num("HUNTER_RESULT_LIMIT", 10),
      cacheDays: num("HUNTER_CACHE_DAYS", 30),
    },

    gmail: {
      clientId: str("GMAIL_CLIENT_ID"),
      clientSecret: str("GMAIL_CLIENT_SECRET"),
      refreshToken: str("GMAIL_REFRESH_TOKEN"),
      senderEmail: str("GMAIL_SENDER_EMAIL").toLowerCase(),
      redirectUri: str("GMAIL_REDIRECT_URI", "http://localhost:3000/api/auth/gmail/callback"),
    },

    demoInboxEmail: str("DEMO_INBOX_EMAIL").toLowerCase(),

    batch: {
      concurrency: num("BATCH_CONCURRENCY", 2),
      maxDomains: num("BATCH_MAX_DOMAINS", 50),
    },

    email: {
      minWords: num("EMAIL_MIN_WORDS", 60),
      maxWords: num("EMAIL_MAX_WORDS", 170),
      maxRegenerations: num("EMAIL_MAX_REGENERATIONS", 2),
    },
  };
}

export type AppConfig = ReturnType<typeof getConfig>;

/**
 * 100-point qualification rubric (Sprinto Evidence Map). Points are business assumptions for the
 * prototype; tune them here. `pages` are the page types that can answer a criterion — used to tell
 * NOT_FOUND (a relevant page was checked) from UNKNOWN (no relevant page could be checked).
 */
export const RUBRIC = {
  business_model_fit: {
    label: "Business model fit",
    criteria: {
      saas: { label: "Sells software as SaaS", points: 15, pages: ["homepage", "product", "pricing", "about"] },
      b2b: { label: "Serves business customers (B2B)", points: 10, pages: ["homepage", "product", "customers", "about"] },
      product: { label: "Identifiable software product", points: 5, pages: ["homepage", "product"] },
    },
  },
  growth_stage: {
    label: "Growth stage",
    criteria: {
      funding_series_ac: { label: "Series A, B or C funding", points: 15, pages: ["funding/news", "about"] },
      open_roles: { label: "5+ open job positions", points: 5, pages: ["hiring"] },
      enterprise_pricing: { label: "Enterprise pricing or plan", points: 5, pages: ["pricing", "enterprise"] },
    },
  },
  compliance_buying_signals: {
    label: "Compliance buying signals",
    criteria: {
      preparing_certification: { label: "Preparing for SOC 2 / ISO 27001 / similar", points: 20, pages: ["security/compliance"] },
      compliance_hiring: { label: "Hiring security / compliance / GRC roles", points: 10, pages: ["hiring"] },
      enterprise_security_reviews: { label: "Enterprise security reviews or customer compliance requirements", points: 5, pages: ["security/compliance", "enterprise"] },
    },
  },
  enterprise_readiness: {
    label: "Enterprise readiness",
    criteria: {
      named_enterprise_customers: { label: "Named enterprise customers or case studies", points: 5, pages: ["customers", "homepage"] },
      targets_enterprise: { label: "Explicitly targets enterprise buyers", points: 5, pages: ["homepage", "enterprise", "pricing", "customers"] },
    },
  },
} as const;

export type RubricCategory = keyof typeof RUBRIC;
export type CriterionId = {
  [C in RubricCategory]: keyof (typeof RUBRIC)[C]["criteria"];
}[RubricCategory];

export const CRITERIA: { id: CriterionId; category: RubricCategory; label: string; points: number; pages: readonly string[] }[] = (
  Object.entries(RUBRIC) as [RubricCategory, (typeof RUBRIC)[RubricCategory]][]
).flatMap(([category, c]) =>
  Object.entries(c.criteria).map(([id, v]) => ({ id: id as CriterionId, category, label: v.label, points: v.points, pages: v.pages })),
);

/** Minimum open roles for the "growth" hiring criterion. */
export const OPEN_ROLES_THRESHOLD = 5;

/** Qualification thresholds (configurable). A high score never overrides a disqualification or a missing SaaS/B2B requirement. */
export function getThresholds() {
  const n = (k: string, d: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return { qualified: n("QUALIFY_THRESHOLD", 75), needsReview: n("REVIEW_THRESHOLD", 55) };
}

/**
 * Prototype rule (Sprinto Evidence Map): a company that already holds a named certification such as
 * SOC 2 or ISO 27001 is flagged ALREADY_CERTIFIED and disqualified. Set ALREADY_CERTIFIED_QUALIFIES=true
 * to keep scoring them instead (renewal / expansion prospects).
 */
export const ALREADY_CERTIFIED_QUALIFIES = (process.env.ALREADY_CERTIFIED_QUALIFIES ?? "false").trim() === "true";

/** What Sprinto does — the only product claims emails are allowed to make. */
export const SPRINTO_OFFERING = {
  oneLiner:
    "Sprinto is a compliance automation platform that helps SaaS companies get and stay compliant with frameworks such as SOC 2, ISO 27001 and GDPR.",
  capabilities: [
    "automates evidence collection and control monitoring across the company's cloud stack",
    "keeps the company continuously audit-ready instead of scrambling before each audit",
    "reduces the manual engineering and operations effort that certification work takes",
    "supports multiple frameworks (SOC 2, ISO 27001, GDPR and others) from one place",
  ],
};

/** Rough per-million-token prices used for cost visibility only. */
export const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

export const PIPELINE_STAGES = [
  "research",
  "extract",
  "qualify",
  "contact",
  "pain_points",
  "email",
  "send",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABELS: Record<PipelineStage, string> = {
  research: "1. Website research",
  extract: "2. Company data extraction",
  qualify: "3. ICP qualification",
  contact: "4. Point of contact",
  pain_points: "5. Two pain points",
  email: "6. Personalised email",
  send: "7. Gmail delivery (your inbox)",
};
