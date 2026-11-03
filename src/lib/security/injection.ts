/**
 * Prompt-injection hygiene for scraped content. Website text is DATA: it is
 * wrapped in tagged blocks, cannot close those blocks, and suspicious
 * instruction-like phrases are flagged for the audit log. The real protection
 * is structural: models have no tools, outputs are schema-validated, quotes
 * are verified against the page, and the email recipient is fixed in code.
 */
const PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (the |all )?(previous|prior|above|system)/i,
  /you are now/i,
  /system prompt/i,
  /(send|forward|email) (this|it|the email) to/i,
  /new instructions?:/i,
  /\bas an ai (language )?model\b/i,
  /mark (this company|us) as qualified/i,
  /<\/?(system|assistant|untrusted_[a-z_]+)>/i,
];

export function detectInjection(text: string): string[] {
  const hits: string[] = [];
  for (const p of PATTERNS) {
    const m = text.match(p);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/** Neutralise anything that looks like our own delimiter tags. */
export function sanitizeUntrusted(text: string): string {
  return text.replace(/<\s*\/?\s*(untrusted_[a-z_]*|system|assistant|instructions?)\b[^>]*>/gi, "[tag removed]");
}

/** Untrusted short field (titles, names, job titles): one line, no markup, bounded length. */
export function cleanField(value: string | null | undefined, max = 160): string {
  return sanitizeUntrusted(String(value ?? ""))
    .replace(/[<>"`]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function wrapUntrusted(label: string, attrs: Record<string, string | number>, text: string): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => `${k}="${cleanField(String(v), 300)}"`)
    .join(" ");
  return `<untrusted_${label} ${a}>\n${sanitizeUntrusted(text)}\n</untrusted_${label}>`;
}
