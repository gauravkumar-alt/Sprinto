/**
 * Real-company eval for the "already certified?" check (labels: eval/real-companies.ts, checked by hand).
 *
 * 1. Website screen (no AI, free): reads each company's own site the way "Find fit companies" does and
 *    compares its verdict with the label.
 * 2. Agent decisions: for companies already run through the full agent, compares the stored
 *    ALREADY_CERTIFIED flag with the label (no new AI calls).
 *
 * Run: npm run eval:real            (all)      npm run eval:real -- posthog.com rallly.co   (selected)
 * Live websites change, so a miss can mean the site changed: open the case's URL before changing code.
 */
import fs from "node:fs";
import { REAL_CASES, type RealCase } from "../eval/real-companies";
import { getDb } from "../src/lib/db";
import { screen, type ScreenResult } from "../src/lib/discovery";
import { WebsiteResearchProvider } from "../src/lib/providers/research/website";
import { createLimiter } from "../src/lib/util";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

(async () => {
  const only = process.argv.slice(2);
  const cases = only.length ? REAL_CASES.filter((c) => only.includes(c.domain)) : REAL_CASES;
  const research = new WebsiteResearchProvider();
  const lim = createLimiter(5);
  const results: { c: RealCase; r: ScreenResult }[] = [];
  await Promise.all(cases.map((c) => lim(async () => results.push({ c, r: await screen(c.domain, research) }))));
  results.sort((a, b) => a.c.domain.localeCompare(b.c.domain));

  const read = results.filter((x) => x.r.verdict !== "unreachable");
  const said = (x: { r: ScreenResult }) => x.r.verdict === "certified";
  const right = read.filter((x) => said(x) === x.c.certified);
  const certified = read.filter((x) => x.c.certified);
  const suggested = read.filter((x) => !said(x));
  const wrongSuggestions = suggested.filter((x) => x.c.certified);
  const missedFits = read.filter((x) => !x.c.certified && said(x));

  console.log(`\nWebsite screen (no AI) — ${cases.length} real companies, labelled by hand\n`);
  for (const x of results) {
    const ok = x.r.verdict === "unreachable" ? "  ?" : said(x) === x.c.certified ? "  ✓" : "  ✗";
    console.log(`${ok} ${x.c.domain.padEnd(18)} label=${x.c.certified ? "certified" : "not certified"}${x.c.preparing ? " (preparing)" : ""}  screen=${x.r.verdict}${ok === "  ✗" ? `  ← ${x.r.quote ?? x.r.reason}` : ""}`);
  }
  console.log(`
  Accuracy:                         ${right.length}/${read.length} (${pct(right.length, read.length)})   [${results.length - read.length} site(s) unreadable, not counted]
  Certified companies caught:       ${certified.filter(said).length}/${certified.length} (${pct(certified.filter(said).length, certified.length)})
  Suggestions that are real fits:   ${suggested.length - wrongSuggestions.length}/${suggested.length} (${pct(suggested.length - wrongSuggestions.length, suggested.length)})
  Real fits wrongly set aside:      ${missedFits.length}${missedFits.length ? ` (${missedFits.map((x) => x.c.domain).join(", ")})` : ""}
  "Preparing" companies spotted:    ${read.filter((x) => x.c.preparing && x.r.verdict === "preparing").length}/${read.filter((x) => x.c.preparing).length}`);

  // Agent decisions already stored locally (no new runs).
  const rows = getDb()
    .prepare(
      `SELECT c.domain, q.result_json FROM qualifications q JOIN companies c ON c.id = q.company_id
       WHERE q.id IN (SELECT MAX(id) FROM qualifications GROUP BY company_id)`,
    )
    .all() as { domain: string; result_json: string }[];
  const byDomain = new Map(rows.map((r) => [r.domain, (JSON.parse(r.result_json).flags ?? []) as string[]]));
  const agent = cases.filter((c) => byDomain.has(c.domain)).map((c) => ({ c, flagged: byDomain.get(c.domain)!.includes("ALREADY_CERTIFIED") }));
  if (agent.length) {
    console.log(`\nFull agent (stored decisions) — ${agent.length} of these companies have been run\n`);
    for (const a of agent) console.log(`${a.flagged === a.c.certified ? "  ✓" : "  ✗"} ${a.c.domain.padEnd(18)} label=${a.c.certified ? "certified" : "not certified"}  agent=${a.flagged ? "ALREADY_CERTIFIED" : "not flagged"}`);
    const ok = agent.filter((a) => a.flagged === a.c.certified).length;
    console.log(`\n  Agent accuracy: ${ok}/${agent.length} (${pct(ok, agent.length)})`);
  }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/eval-real-results.json", JSON.stringify({ at: new Date().toISOString(), results, agent }, null, 1));
  process.exit(0);
})();
