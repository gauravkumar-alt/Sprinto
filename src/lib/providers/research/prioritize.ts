/** Deterministic relevance scoring of URLs for qualification research. */
const RULES: { re: RegExp; score: number; tag: string }[] = [
  { re: /trust|security|soc-?2|iso-?27001|compliance|gdpr|hipaa|certif|audit/, score: 100, tag: "security/compliance" },
  { re: /enterprise/, score: 80, tag: "enterprise" },
  { re: /about|company|who-we-are|our-story/, score: 75, tag: "about" },
  { re: /pricing|plans/, score: 70, tag: "pricing" },
  { re: /press|news|newsroom|announc|funding|series-[abc]|raises|investors/, score: 70, tag: "funding/news" },
  { re: /customers|case-stud|testimonials/, score: 60, tag: "customers" },
  { re: /product|platform|features|solutions|how-it-works/, score: 55, tag: "product" },
  { re: /careers|jobs|hiring|join-us/, score: 45, tag: "hiring" },
  { re: /integrations|partners/, score: 35, tag: "integrations" },
  { re: /privacy|dpa|subprocessors/, score: 30, tag: "privacy" },
  { re: /blog/, score: 20, tag: "blog" },
  { re: /docs|developer|api/, score: 15, tag: "docs" },
];

const SKIP = /\.(pdf|png|jpe?g|gif|svg|webp|zip|mp4|mp3|css|js|xml|json|ico|woff2?)(\?|$)|\/(login|signin|sign-in|signup|sign-up|register|account|cart|checkout|wp-admin|admin)(\/|$)|\/tag\/|\/author\/|\/page\/\d+/i;
const LOCALE = /^\/(de|fr|es|it|pt|pt-br|ja|ko|zh|zh-cn|nl|sv|pl|tr|ru)(\/|$)/i;

export interface CandidateUrl {
  url: string;
  score: number;
  tag: string;
}

export function sameSite(url: URL, domain: string): boolean {
  const h = url.hostname.replace(/^www\./, "");
  return h === domain || h.endsWith("." + domain);
}

export function scoreUrl(raw: string, domain: string): CandidateUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!sameSite(u, domain)) return null;
  const path = u.pathname.toLowerCase();
  if (SKIP.test(path) || LOCALE.test(path)) return null;
  const sub = u.hostname.replace(/^www\./, "").slice(0, -(domain.length + 1));
  if ((path === "/" || path === "") && TRUST_SUBDOMAINS.includes(sub)) return { url: u.origin + "/", score: 95, tag: "security/compliance" };
  if (path === "/" || path === "") return { url: u.origin + "/", score: 90, tag: "homepage" };
  let best = { score: 5, tag: "other" };
  for (const r of RULES) if (r.re.test(path) && r.score > best.score) best = { score: r.score, tag: r.tag };
  // prefer shallow pages; subdomains like trust.acme.com are fine
  const depth = path.split("/").filter(Boolean).length;
  const score = best.score - Math.max(0, depth - 1) * 8 + (u.hostname.startsWith("trust.") || u.hostname.startsWith("security.") ? 20 : 0);
  u.search = "";
  return { url: u.toString(), score, tag: best.tag };
}

/** Trust-centre subdomains (Vanta, Drata, SafeBase and similar host them here); often list certifications "in progress". */
export const TRUST_SUBDOMAINS = ["trust", "security"];

/** Common paths worth trying when the site's navigation/sitemap does not link them. */
export const COMMON_PATHS = [
  "/about", "/company", "/product", "/platform", "/security", "/trust", "/compliance", "/enterprise", "/pricing",
  "/customers", "/case-studies", "/press", "/news", "/careers", "/jobs", "/blog",
];
