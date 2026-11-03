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
      model: str("LLM_MODEL", isGemini ? "gemini-3.8-flash" : "claude-opus-5-5"),
      /** Tried in order when the primary model is overloaded (HTTP 503) or out of quota (429). Gemini only. */
      fallbackModels: str("LLM_FALLBACK_MODELS", isGemini ? "gemini-3.5-flash-lite,gemini-3.1-flash-lite" : "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      effort: str("LLM_EFFORT", "medium") as "low" | "medium" | "high",
      maxJsonRetries: num("LLM_MAX_JSON_RETRIES", 1),
      timeoutMs: num("LLM_TIMEOUT_MS", 120_000),
      refusalFallback: str("LLM_REFUSAL_FALLBACK", "true") !== "false",
    },

    research: {
      provider: str("RESEARCH_PROVIDER", ""), // "tavily" or empty (website only)
      apiKey: str("RESEARCH_API_KEY"),
      maxPagesPerCompany: num("RESEARCH_MAX_PAGES", 8),
      maxPagesPerRound: num("RESEARCH_MAX_PAGES_PER_ROUND", 4),
      maxAdditionalRounds: num("RESEARCH_MAX_ROUNDS", 2),
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
 * Initial ICP scoring rubric. These are business assumptions for the case,
 * NOT facts supplied by Sprinto. Adjust here; scoring code reads this table.
 */
export const SCORING_RUBRIC = {
  saas: { confirmed: 30, likely: 15, not_saas: 0, unknown: 0 },
  stage: { series_a_c: 15, growth_indicators: 8, other_verified: 5, unknown: 0 },
  audit: {
    active_or_planned: 30,
    initiative_timing_uncertain: 20,
    already_certified: 10,
    generic_material: 5,
    none: 0,
  },
  enterprise: {
    direct_requirement: 25,
    security_reviews: 20,
    enterprise_positioning: 5,
    none: 0,
  },
} as const;

/** Signal levels that count as a credible buying trigger (the ICP's OR clause). */
export const QUALIFYING_TRIGGERS = {
  audit: ["active_or_planned", "initiative_timing_uncertain"] as const,
  enterprise: ["direct_requirement", "security_reviews"] as const,
};

/** Whether an inferred ("likely") SaaS model may qualify. The case says "SaaS companies"; we require confirmation by default. */
export const ALLOW_LIKELY_SAAS_TO_QUALIFY = false;

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
