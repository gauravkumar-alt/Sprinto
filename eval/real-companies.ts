/**
 * Real-company test set for the "already certified?" check — the rule that decides most outcomes,
 * since a company that already holds SOC 2 / ISO 27001 is not a Sprinto prospect.
 *
 * Labelled by hand on 2026-11-19 by reading each company's own pages (homepage, security / trust /
 * compliance pages, trust subdomain). `basis`:
 *  - "explicit": the quote below says so on the company's own site.
 *  - "none_found": no certification is mentioned on the homepage, security page or trust subdomain.
 *    That is absence of evidence, so these labels are weaker; re-check them if a case starts failing.
 * Companies whose evidence was unclear (e.g. a trust center that only renders with JavaScript, or
 * bare "SOC 2" badges with no statement) were left out rather than guessed.
 * Websites change: a failing case can mean the site changed, so check the page before "fixing" code.
 */
export interface RealCase {
  domain: string;
  certified: boolean;
  /** Says it is working toward a certification (the strongest buying signal). */
  preparing?: boolean;
  basis: "explicit" | "none_found";
  quote?: string;
  url?: string;
}

const yes = (domain: string, url: string, quote: string): RealCase => ({ domain, certified: true, basis: "explicit", url, quote });
const none = (domain: string): RealCase => ({ domain, certified: false, basis: "none_found" });

export const REAL_CASES: RealCase[] = [
  // ── Not certified ──
  { domain: "rallly.co", certified: false, basis: "explicit", url: "https://rallly.co/security", quote: "Do you hold SOC 2 or ISO 27001 certification? Not currently." },
  { domain: "reflag.com", certified: false, preparing: true, basis: "explicit", url: "https://reflag.com/pricing", quote: "SOC2 (pending) … ISO27001 (pending)" },
  none("openpanel.dev"),
  none("salespatriot.com"),
  none("re2.ai"),
  none("firstbase.io"),
  none("fondo.com"),
  none("elyos.ai"),
  none("middleware.io"),
  none("numeral.com"),
  none("campfire.ai"),

  // ── Certified (quote from the company's own site) ──
  yes("posthog.com", "https://posthog.com/handbook/company/security", "PostHog is certified as SOC 2 Type 2 compliant, following an external audit."),
  yes("documenso.com", "https://documenso.com/compliance", "SOC 2 — Compliant (ISO 27001 listed as planned)"),
  yes("e2b.dev", "https://e2b.dev/security", "E2B is SOC 2 Type II compliant and signs HIPAA BAAs on Enterprise plans."),
  yes("hatchet.run", "https://hatchet.run/pricing", "Built for production — SOC 2 Type II on every plan"),
  yes("plane.so", "https://plane.so/enterprise-grid", "SOC 2 Type II, ISO 27001, GDPR, and CCPA compliant."),
  yes("cal.com", "https://cal.com/compliance", "Cal.com is SOC 2 Type II and ISO 27001 certified"),
  yes("trigger.dev", "https://trigger.dev/security", "Yes, Trigger.dev is SOC 2 Type II compliant."),
  yes("formbricks.com", "https://formbricks.com/security", "We are SOC 2 Type II compliant."),
  yes("langfuse.com", "https://langfuse.com/", "Langfuse Cloud is SOC 2 Type II certified, ISO 27001 compliant"),
  yes("getlago.com", "https://getlago.com/security", "Lago Cloud has completed a SOC 2 Type II audit."),
  yes("chatwoot.com", "https://chatwoot.com/security", "Chatwoot is SOC 2 Type II compliant."),
  yes("papermark.com", "https://papermark.com/security", "Papermark has achieved SOC 2 Type II certification"),
  yes("fleetdm.com", "https://fleetdm.com/cybersecurity", "SOC 2 Type II and ISO 27001 · Visit trust center"),
  yes("cap.so", "https://cap.so/hipaa-compliant-screen-recording", "SOC 2 Type II and ISO 27001 certified"),
  yes("resend.com", "https://resend.com/security", "SOC 2 compliant"),
  yes("tooljet.com", "https://tooljet.com/security", "Review SOC 2 audit information, ISO 27001, and GDPR compliance resources in our Trust Center."),
  yes("jitsu.com", "https://jitsu.com/security", "Jitsu is SOC 2 compliant"),
  yes("spott.io", "https://spott.io/security", "Spott is ISO 27001 certified and fully GDPR compliant."),
  yes("windmill.dev", "https://www.windmill.dev/pricing", "SOC 2 Type II report: Yes"),
  yes("nango.dev", "https://nango.dev/pricing", "Certified SOC 2 Type 2 for security and data protection."),
  yes("outset.ai", "https://outset.ai/trust-safety", "SOC 2 Type II Certified"),
  yes("alex.com", "https://www.alex.com/blog/alex-achieves-soc-2-type-ii-compliance", "In 2024, Alex received certification for SOC 2 Type II compliance."),
  yes("pointone.com", "https://pointone.com/", "SOC 2 Type 2 certified our security controls are independently audited"),
  yes("fours.com", "https://www.fours.com/resources/security/", "Fours is SOC 2 Type II certified, with annual third-party audits"),
  yes("rallyuxr.com", "https://rallyuxr.com/security", "Rally is SOC 2 Type II certified"),
  yes("infisical.com", "https://infisical.com/", "SOC 2, HIPAA, and FIPS 140-3 compliant."),
  yes("rootly.com", "https://rootly.com/security", "SOC 2 Type II attested"),
  yes("doublehq.com", "https://doublehq.com/security-statement/", "Double is SOC 2 accredited."),
  yes("sully.ai", "https://sully.ai/trust", "HITRUST certification … validates our comprehensive controls"),
  yes("confidotech.com", "https://confidotech.com/", "Confido has successfully completed our SOC 2 audit"),
  yes("humaans.io", "https://humaans.io/security", "SOC2 Type 2 certified"),
  yes("luminai.com", "https://luminai.com/security", "SOC 2, GDPR, and HIPAA compliant."),
  yes("signoz.io", "https://signoz.io/pricing/", "SOC2 Type II Compliant"),
  yes("draftwise.com", "https://draftwise.com/", "Draftwise is SOC 2 Type II & ISO 27001 certified"),
  yes("okteto.com", "https://okteto.com/pricing/", "it is SOC 2 Type 2 audited and pen-tested every year"),
  yes("inevent.com", "https://inevent.com/en/security-data-privacy.php", "InEvent is certified and compliant with … HIPAA"),
  yes("middesk.com", "https://www.middesk.com/", "SOC 2 Type II compliant"),
  yes("concourse.ai", "https://concourse.ai/security", "Concourse is SOC 2 Type II certified for security."),
  yes("syncly.app", "https://syncly.app/security", "Syncly is SOC 2 Type II compliant."),
  yes("oneschema.co", "https://oneschema.co/security", "OneSchema is SOC 2 Type 2, SOC 3, GDPR, CCPA and HIPAA compliant"),
  // Holds a SOC 2 Type 1 report and is part-way through Type 2: already certified.
  yes("vector.co", "https://www.vector.co/security", "SOC 2 Type 1 · We're in the midst of our SOC 2 Type 2 audit."),
  yes("soraban.com", "https://soraban.com/security", "Soraban is SOC 2 Type II certified"),
  // Spanish: "We are ISO 27001 certified by AENOR".
  yes("payflow.es", "https://www.payflow.es/", "Estamos certificados en ISO 27001 por AENOR"),
  yes("quicknode.com", "https://quicknode.com/", "Quicknode is audited for SOC 1 and SOC 2 Type 2 and certified for ISO 27001."),
];
