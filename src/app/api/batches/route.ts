import { NextResponse } from "next/server";
import { agentBusyMessage, agentLockHolder } from "@/lib/agent-lock";
import { z } from "zod/v4";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { recoverOnce, runInBackground } from "@/lib/pipeline/orchestrator";
import * as repo from "@/lib/repo";
import { isMockDomain, parseDomainCsv, parseDomainList } from "@/lib/security/domain";

export const dynamic = "force-dynamic";

const Body = z.object({ domains: z.string().max(20_000).optional(), csv: z.string().max(500_000).optional() });

export async function POST(req: Request) {
  recoverOnce();
  const lockHolder = agentLockHolder();
  if (lockHolder !== null) return NextResponse.json({ error: agentBusyMessage(lockHolder) }, { status: 409 });
  const parsedBody = Body.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success || (!parsedBody.data.domains && !parsedBody.data.csv)) {
    return NextResponse.json({ error: "Provide `domains` (text) or `csv`." }, { status: 400 });
  }
  const cfg = getConfig();
  const fromText = parsedBody.data.domains ? parseDomainList(parsedBody.data.domains) : { valid: [], invalid: [], duplicates: [] };
  const fromCsv = parsedBody.data.csv ? parseDomainCsv(parsedBody.data.csv) : { valid: [], invalid: [], duplicates: [] };
  if ("error" in fromCsv && fromCsv.error) return NextResponse.json({ error: fromCsv.error }, { status: 400 });

  const seen = new Set<string>();
  const valid: string[] = [];
  const names = new Map<string, string>();
  const duplicates = [...fromText.duplicates, ...fromCsv.duplicates];
  const invalid = [...fromText.invalid, ...fromCsv.invalid];
  for (const v of [...fromText.valid, ...fromCsv.valid]) {
    if (seen.has(v.domain)) duplicates.push(v.domain);
    else if (cfg.mode === "live" && isMockDomain(v.domain)) invalid.push({ input: v.input, reason: "Mock .example domains are only available in demo mode" });
    else {
      seen.add(v.domain);
      valid.push(v.domain);
      if (v.name) names.set(v.domain, v.name);
    }
  }
  if (valid.length === 0) return NextResponse.json({ error: "No valid domains to process.", invalid, duplicates }, { status: 400 });
  if (valid.length > cfg.batch.maxDomains) return NextResponse.json({ error: `At most ${cfg.batch.maxDomains} domains per batch.` }, { status: 400 });

  // A company already being processed is not started twice (avoids racing runs and double sends).
  const busy = getDb().prepare("SELECT COUNT(*) n FROM agent_runs ar JOIN companies c ON c.id = ar.company_id WHERE c.domain = ? AND ar.status IN ('queued','running')");
  const alreadyRunning = valid.filter((d) => (busy.get(d) as { n: number }).n > 0);
  const toRun = valid.filter((d) => !alreadyRunning.includes(d));
  if (toRun.length === 0) return NextResponse.json({ error: "All of these companies are already being processed.", alreadyRunning }, { status: 409 });

  const companyIds = toRun.map((d) => repo.upsertCompany(d, isMockDomain(d) ? "mock" : "real", names.get(d)));
  const { batchId, runIds } = repo.createBatch(cfg.campaignId, cfg.mode, companyIds);
  runInBackground(runIds);
  return NextResponse.json({ batchId, runIds, accepted: toRun, alreadyRunning, invalid, duplicates });
}
