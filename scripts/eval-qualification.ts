/**
 * Qualification accuracy eval: runs the real research + qualification prompts and the deterministic rubric
 * over the labelled cases in eval/qualification-cases.ts and reports accuracy. Uses only fictional .example
 * sites (no crawling, no Hunter, no email). Costs ~2 LLM calls per case.
 *
 * Run: npm run eval            (all cases)    npm run eval -- clear-fit b2c-app   (selected cases)
 */
import fs from "node:fs";
import { CASES, type EvalCase } from "../eval/qualification-cases";
import { getConfig } from "../src/lib/config";
import { quoteAppearsIn } from "../src/lib/pipeline/checks";
import { decideQualification, type EvidenceLite } from "../src/lib/pipeline/qualification";
import { condensePages, pageType } from "../src/lib/pipeline/research";
import { qualificationPrompt, researchPrompt } from "../src/lib/prompts";
import { AnthropicLLMProvider } from "../src/lib/providers/llm/anthropic";
import { GeminiLLMProvider } from "../src/lib/providers/llm/gemini";
import { runPrompt } from "../src/lib/providers/llm";
import type { LLMProvider } from "../src/lib/providers/llm/types";
import { detectInjection } from "../src/lib/security/injection";

function llm(): LLMProvider {
  const { provider, apiKey } = getConfig().llm;
  if (!apiKey) throw new Error("LLM_API_KEY is not set — the eval needs a real model.");
  return provider === "anthropic" ? new AnthropicLLMProvider(apiKey) : new GeminiLLMProvider(apiKey);
}

async function runCase(model: LLMProvider, c: EvalCase) {
  const pages = c.pages.map((p, i) => ({ id: i + 1, url: `https://${c.domain}${p.path}`, title: p.title, text: p.text }));
  const research = await runPrompt(model, researchPrompt, {
    domain: c.domain,
    pages: condensePages(pages, getConfig().research.contextBudgetChars).map((p) => ({ id: p.id, url: p.url, title: p.title, text: p.condensed })),
    focus: [],
  });
  const evidence: (EvidenceLite & { claim: string; quote: string; category: string })[] = [];
  for (const item of research.evidence) {
    const page = pages.find((p) => p.id === item.page_id);
    if (!page || !quoteAppearsIn(item.quote, page.text) || detectInjection(item.quote).length) continue;
    const ref = `E${evidence.length + 1}`;
    evidence.push({ ref, type: "observed", text: `${item.claim} ${item.quote}`, url: page.url, pageTag: pageType(page.url, c.domain), claim: item.claim, quote: item.quote, category: item.category });
  }
  const checkedPages = new Set(pages.map((p) => pageType(p.url, c.domain)));
  const findings = await runPrompt(model, qualificationPrompt, {
    domain: c.domain,
    company_name_hint: c.name,
    profile: null,
    pages_checked: [...checkedPages],
    evidence: evidence.map((e) => ({ ref: e.ref, category: e.category, type: e.type, claim: e.claim, quote: e.quote, source_url: e.url ?? null })),
  } as Parameters<typeof qualificationPrompt.buildUser>[0]);
  const q = decideQualification({ findings, evidence, checkedPages, pagesScraped: pages.map((p) => p.url), canResearchMore: false });

  const problems: string[] = [];
  if (!c.accept.includes(q.decision as EvalCase["accept"][number])) problems.push(`decision ${q.decision} (expected ${c.accept.join(" or ")})`);
  const certified = q.flags.includes("ALREADY_CERTIFIED");
  if (c.certified !== undefined && certified !== c.certified) problems.push(certified ? "wrongly flagged ALREADY_CERTIFIED" : "missed ALREADY_CERTIFIED");
  const status = (id: string) => Object.values(q.categories).flatMap((cat) => cat.criteria).find((cr) => cr.id === id)?.status;
  for (const id of c.mustFind ?? []) if (status(id) !== "FOUND") problems.push(`${id} not found`);
  for (const id of c.mustNotFind ?? []) if (status(id) === "FOUND") problems.push(`${id} wrongly found`);
  return { id: c.id, decision: q.decision, score: q.fit_score, flags: q.flags, problems };
}

async function main() {
  const only = process.argv.slice(2);
  const cases = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;
  const model = llm();
  console.log(`Qualification eval · ${cases.length} cases · ${getConfig().llm.provider}/${model.model}\n`);
  const results = [];
  for (const c of cases) {
    try {
      // The provider being overloaded (503/429) isn't a wrong answer: retry the case a couple of times.
      let r: Awaited<ReturnType<typeof runCase>> | undefined;
      for (let attempt = 0; !r; attempt++) {
        try {
          r = await runCase(model, c);
        } catch (err) {
          if (attempt >= 2 || !/503|429|overload|timed out/i.test((err as Error).message)) throw err;
          await new Promise((res) => setTimeout(res, 20_000 * (attempt + 1)));
        }
      }
      results.push(r);
      console.log(`${r.problems.length ? "✗" : "✓"} ${c.id.padEnd(24)} ${r.decision.padEnd(14)} ${String(r.score).padStart(3)}  ${r.flags.join(",")}${r.problems.length ? `\n    → ${r.problems.join("; ")}` : ""}`);
    } catch (err) {
      results.push({ id: c.id, decision: "error", score: 0, flags: [], problems: [(err as Error).message] });
      console.log(`! ${c.id.padEnd(24)} ERROR ${(err as Error).message.slice(0, 160)}`);
    }
  }
  const passed = results.filter((r) => !r.problems.length).length;
  const decisionsRight = results.filter((r) => cases.find((c) => c.id === r.id)!.accept.includes(r.decision as never)).length;
  console.log(`\nFully correct: ${passed}/${results.length} · decision correct: ${decisionsRight}/${results.length}`);
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/eval-results.json", JSON.stringify({ at: new Date().toISOString(), model: model.model, passed, total: results.length, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}
main();
