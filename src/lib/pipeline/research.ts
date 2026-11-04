/**
 * Research helpers for the targeted loop: page-type detection and condensing cleaned page text to a
 * small, signal-dense context (~2,000 tokens per pass). Kept lines are verbatim, so quotes the model
 * extracts can still be verified against the full page.
 */
import { scoreUrl } from "@/lib/providers/research/prioritize";

/** Page type ("homepage", "product", "hiring", "security/compliance", …) for a URL on the company's site. */
export function pageType(url: string, domain: string): string {
  return scoreUrl(url, domain)?.tag ?? "other";
}

const SIGNAL = [
  /soc\s*-?\s*2|iso\s*-?\s*27001|gdpr|hipaa|compliance|certif|audit|trust|security|questionnaire|procurement/i,
  /series\s*[a-e]\b|raised|funding|investors|backed by/i,
  /hiring|open (roles|positions)|careers|join (us|our team)|we're hiring|engineer|manager|analyst/i,
  /enterprise|pricing|per (seat|user|month)|plan|tier|sso|saml/i,
  /saas|platform|software|cloud|subscription|api|product|teams|businesses|companies|customers|case stud|trusted by/i,
];

function lineScore(line: string): number {
  let s = 0;
  for (const re of SIGNAL) if (re.test(line)) s += 2;
  if (line.length < 25) s -= 1; // fragments / nav leftovers
  if (/cookie|privacy policy|terms of (use|service)|all rights reserved|subscribe to|newsletter/i.test(line)) s -= 3;
  return s;
}

/** Keep the most signal-dense lines of a page (original order), within `budget` characters. */
export function condenseText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const lines = text.split("\n").map((l, i) => ({ l: l.trim(), i })).filter((x) => x.l.length > 0);
  const ranked = [...lines].sort((a, b) => lineScore(b.l) - lineScore(a.l) || a.i - b.i);
  const keep = new Set<number>();
  let used = 0;
  for (const x of ranked) {
    if (used + x.l.length + 1 > budget) continue;
    keep.add(x.i);
    used += x.l.length + 1;
  }
  return lines.filter((x) => keep.has(x.i)).map((x) => x.l).join("\n");
}

/** Split a total character budget across pages (at least `min` each) and condense each page. */
export function condensePages<T extends { text: string }>(pages: T[], totalBudget: number, min = 600): (T & { condensed: string })[] {
  if (!pages.length) return [];
  const per = Math.max(min, Math.floor(totalBudget / pages.length));
  return pages.map((p) => ({ ...p, condensed: condenseText(p.text, per) }));
}
