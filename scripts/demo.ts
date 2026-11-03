/**
 * CLI demo: runs the full pipeline for the given domains (default: the MOCK fixtures)
 * and prints each stage. Usage: npm run demo -- vaultlane.example ledgerly.example
 */
import { getConfig } from "../src/lib/config";
import { getDb } from "../src/lib/db";
import { runBatch } from "../src/lib/pipeline/orchestrator";
import * as repo from "../src/lib/repo";
import { isMockDomain, parseDomainList } from "../src/lib/security/domain";

async function main() {
  const args = process.argv.slice(2);
  const list = args.length ? args.join("\n") : "vaultlane.example\nledgerly.example\nnorthpeak-consulting.example\norbitboard.example\npromptbait.example";
  const parsed = parseDomainList(list);
  for (const i of parsed.invalid) console.log(`✗ ${i.input}: ${i.reason}`);
  const ids = parsed.valid.map((v) => repo.upsertCompany(v.domain, isMockDomain(v.domain) ? "mock" : "real"));
  const { runIds } = repo.createBatch(getConfig().campaignId, getConfig().mode, ids);
  await runBatch(runIds);
  const db = getDb();
  for (const runId of runIds) {
    const run = db.prepare("SELECT ar.outcome, c.domain FROM agent_runs ar JOIN companies c ON c.id=ar.company_id WHERE ar.id=?").get(runId) as { outcome: string; domain: string };
    console.log(`\n${run.domain.toUpperCase()} → ${run.outcome}`);
    const events = db.prepare("SELECT stage, status, summary, error FROM stage_events WHERE agent_run_id=? ORDER BY id").all(runId) as { stage: string; status: string; summary: string; error: string | null }[];
    for (const e of events) console.log(`  [${e.status.padEnd(12)}] ${e.stage.padEnd(11)} ${e.summary}${e.error && e.status === "failed" ? `  (${e.error})` : ""}`);
  }
  const email = db.prepare("SELECT subject, body FROM emails ORDER BY id DESC LIMIT 1").get() as { subject: string; body: string } | undefined;
  if (email) console.log(`\n--- latest email ---\nSubject: ${email.subject}\n\n${email.body}`);
}
main();
