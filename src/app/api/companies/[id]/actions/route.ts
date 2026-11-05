/**
 * Human-in-the-loop actions on a company:
 *  - retry:          re-run the full pipeline
 *  - manual_contact: store a contact entered by the user, then resume from stage 4
 *  - approve:        reviewer approves a "needs review" company (note required), then resume from stage 4
 *  - resume:         re-run from stage 4 for a qualified company (e.g. after adding a Hunter key)
 *  - retry_send:     retry stage 7 for the latest email (confirmUnknownOutcome required if the last attempt's outcome is unknown)
 */
import { NextResponse } from "next/server";
import { agentBusyMessage, agentLockHolder } from "@/lib/agent-lock";
import { z } from "zod/v4";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { isMockDomain } from "@/lib/security/domain";
import { recoverOnce, retrySend, runInBackground } from "@/lib/pipeline/orchestrator";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry") }),
  z.object({
    action: z.literal("manual_contact"),
    name: z.string().trim().min(2).max(120),
    title: z.string().trim().min(2).max(120),
    email: z.string().trim().max(200).optional(),
    department: z.string().trim().max(80).optional(),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({ action: z.literal("approve"), note: z.string().trim().min(5).max(500) }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("retry_send"), confirmUnknownOutcome: z.boolean().optional() }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  recoverOnce();
  const lockHolder = agentLockHolder();
  if (lockHolder !== null) return NextResponse.json({ error: agentBusyMessage(lockHolder) }, { status: 409 });
  const companyId = Number((await params).id);
  const company = getDb().prepare("SELECT id, domain FROM companies WHERE id=?").get(companyId) as { id: number; domain: string } | undefined;
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = Action.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  const busy = getDb().prepare("SELECT COUNT(*) n FROM agent_runs WHERE company_id=? AND status IN ('queued','running')").get(companyId) as { n: number };
  if (busy.n > 0) return NextResponse.json({ error: "This company is already being processed." }, { status: 409 });

  const a = parsed.data;
  if (getConfig().mode === "live" && isMockDomain(company.domain)) {
    return NextResponse.json({ error: "Mock .example companies can only be processed in demo mode." }, { status: 400 });
  }
  switch (a.action) {
    case "retry": {
      // An explicit re-run re-researches the website instead of reusing the cache.
      runInBackground([repo.createSingleRun(companyId, null)], { freshResearch: true });
      return NextResponse.json({ ok: true });
    }
    case "manual_contact": {
      const email = a.email ? a.email.toLowerCase() : null;
      if (email && (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || !email.endsWith("@" + company.domain))) {
        return NextResponse.json({ error: `Email must be a valid business address on @${company.domain}` }, { status: 400 });
      }
      repo.insertManualContact(companyId, { name: a.name, title: a.title, email, department: a.department ?? null, note: a.note ?? "" });
      const q = repo.latestQualification(companyId);
      if (q?.decision === "qualified") runInBackground([repo.createSingleRun(companyId, null)], { startAt: "contact" });
      return NextResponse.json({ ok: true, resumed: q?.decision === "qualified" });
    }
    case "approve": {
      // A reviewer can approve a borderline company — never override a disqualification or a low score.
      const q = repo.latestQualification(companyId);
      if (q?.decision !== "needs_review" || (q.disqualification_reasons ?? []).length) {
        return NextResponse.json({ error: `Only companies marked "needs review" can be approved (this one is "${q?.decision ?? "not researched"}").` }, { status: 400 });
      }
      runInBackground([repo.createSingleRun(companyId, null)], { startAt: "contact", overrideNote: a.note });
      return NextResponse.json({ ok: true });
    }
    case "resume": {
      if (repo.latestQualification(companyId)?.decision !== "qualified") {
        return NextResponse.json({ error: "Only qualified companies can resume from contact discovery." }, { status: 400 });
      }
      runInBackground([repo.createSingleRun(companyId, null)], { startAt: "contact" });
      return NextResponse.json({ ok: true });
    }
    case "retry_send": {
      const outcome = await retrySend(companyId, Boolean(a.confirmUnknownOutcome));
      return NextResponse.json({ ok: outcome !== "failed", outcome });
    }
  }
}
