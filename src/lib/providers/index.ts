/**
 * Provider registry. Chooses real providers when credentials exist; in demo
 * mode falls back to clearly-labelled mocks; in live mode a missing credential
 * makes the provider unavailable (the stage fails with a setup message instead
 * of fabricating results).
 */
import { getConfig } from "@/lib/config";
import { isMockDomain } from "@/lib/security/domain";
import { HunterContactProvider, hunterUsageThisMonth } from "./contact/hunter";
import { MockContactProvider } from "./contact/mock";
import type { ContactProvider } from "./contact/types";
import { GmailEmailProvider, getStoredRefreshToken } from "./email/gmail";
import { MockEmailProvider } from "./email/mock";
import type { EmailProvider } from "./email/types";
import { AnthropicLLMProvider } from "./llm/anthropic";
import { GeminiLLMProvider } from "./llm/gemini";
import { MockLLMProvider } from "./llm/mock";
import type { LLMProvider } from "./llm/types";
import { MockResearchProvider } from "./research/mock";
import { getSearchProvider } from "./research/search";
import type { ResearchProvider, SearchProvider } from "./research/types";
import { WebsiteResearchProvider } from "./research/website";

export interface ProviderSet {
  research: ResearchProvider;
  search: SearchProvider;
  llm: LLMProvider | null;
  contact: ContactProvider | null;
  email: EmailProvider | null;
  unavailable: Partial<Record<"llm" | "contact" | "email", string>>;
}

/** Test seam: lets integration tests inject providers. */
let override: ((domain: string) => ProviderSet) | null = null;
export function setProviderOverride(fn: ((domain: string) => ProviderSet) | null) {
  override = fn;
}

export function gmailConfigured(): boolean {
  const c = getConfig();
  return Boolean(c.gmail.clientId && c.gmail.clientSecret && getStoredRefreshToken() && c.demoInboxEmail);
}

export function getProvidersFor(domain: string): ProviderSet {
  if (override) return override(domain);
  const cfg = getConfig();
  const demo = cfg.mode === "demo";
  const mockDomain = isMockDomain(domain);
  const unavailable: ProviderSet["unavailable"] = {};

  const llm: LLMProvider | null = realLLM() ?? (demo ? new MockLLMProvider() : null);
  if (!llm) unavailable.llm = "No LLM configured. Set LLM_PROVIDER (anthropic or gemini) and LLM_API_KEY.";

  let contact: ContactProvider | null = null;
  if (mockDomain) contact = new MockContactProvider();
  else if (cfg.hunter.apiKey) contact = new HunterContactProvider(cfg.hunter.apiKey);
  else unavailable.contact = "Hunter.io is not configured (HUNTER_API_KEY). Add the contact manually from the company page.";

  const email: EmailProvider | null = gmailConfigured() ? new GmailEmailProvider() : demo ? new MockEmailProvider() : null;
  if (!email) unavailable.email = "Gmail is not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, refresh token, DEMO_INBOX_EMAIL).";

  return {
    research: mockDomain ? new MockResearchProvider() : new WebsiteResearchProvider(),
    search: mockDomain ? { name: "none", available: false, search: async () => [] } : getSearchProvider(),
    llm,
    contact,
    email,
    unavailable,
  };
}

function realLLM(): LLMProvider | null {
  const { provider, apiKey } = getConfig().llm;
  if (!apiKey) return null;
  if (provider === "anthropic") return new AnthropicLLMProvider(apiKey);
  if (provider === "gemini") return new GeminiLLMProvider(apiKey);
  return null;
}

/** Configuration status for the dashboard (no secrets). */
export function providerStatus() {
  const cfg = getConfig();
  const search = getSearchProvider();
  return {
    mode: cfg.mode,
    llm: realLLM()
      ? { state: "real", detail: `${cfg.llm.provider} · ${cfg.llm.model}` }
      : {
          state: cfg.mode === "demo" ? "mock" : "missing",
          detail: cfg.llm.apiKey ? `Unsupported LLM_PROVIDER "${cfg.llm.provider}" (use anthropic or gemini)` : "LLM_API_KEY not set",
        },
    research: { state: "real", detail: "Website crawler (robots.txt-aware); .example domains use mock fixtures" },
    search: search.available ? { state: "real", detail: search.name } : { state: "off", detail: "No external search configured — website research only" },
    hunter: cfg.hunter.apiKey
      ? { state: "real", detail: `${hunterUsageThisMonth()}/${cfg.hunter.monthlyLimit} searches used this month` }
      : { state: "missing", detail: "HUNTER_API_KEY not set — real domains need manual contacts" },
    gmail: gmailConfigured()
      ? { state: "real", detail: `Delivers only to ${cfg.demoInboxEmail}` }
      : { state: cfg.mode === "demo" ? "mock" : "missing", detail: cfg.demoInboxEmail ? "OAuth not completed — sends are SIMULATED" : "DEMO_INBOX_EMAIL not set — sends are SIMULATED" },
    demoInbox: cfg.demoInboxEmail || null,
    canAuthorizeGmail: Boolean(cfg.gmail.clientId && cfg.gmail.clientSecret && cfg.demoInboxEmail),
  };
}
