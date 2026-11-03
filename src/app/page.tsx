"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProviderChip, SourceBadge, StageList, StatusBadge, postJson, type StageRow } from "@/components/ui";
import { parseDomainCsv, parseDomainList } from "@/lib/security/domain";

type Status = {
  providers: {
    mode: "demo" | "live";
    llm: { state: string; detail: string };
    research: { state: string; detail: string };
    search: { state: string; detail: string };
    hunter: { state: string; detail: string };
    gmail: { state: string; detail: string };
    demoInbox: string | null;
    canAuthorizeGmail: boolean;
  };
  metrics: {
    totalCompanies: number;
    qualified: number;
    notQualified: number;
    needsReview: number;
    emailsGenerated: number;
    emailsSent: number;
    emailsSimulated: number;
    running: number;
    llmCostUsd: number;
    llmCalls: number;
  };
  batches: { id: number; status: string; domain_count: number; done: number; created_at: string }[];
  companies: {
    id: number;
    domain: string;
    name: string | null;
    status: string;
    dataSource: string;
    score: number | null;
    decision: string | null;
    reason: string | null;
    contactName: string | null;
    contactTitle: string | null;
    painPoint1: string | null;
    painPoint2: string | null;
    emailStatus: string | null;
    run: { id: number; status: string; batchId: number | null; stages: StageRow[] } | null;
  }[];
};

const MOCK_DEMO = "vaultlane.example\nledgerly.example\nnorthpeak-consulting.example\norbitboard.example\npromptbait.example";

export default function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [csv, setCsv] = useState<{ name: string; content: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ kind: "info" | "bad"; text: string } | null>(null);
  const [activeBatch, setActiveBatch] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  const running = (data?.metrics.running ?? 0) > 0;
  useEffect(() => {
    load();
    const t = setInterval(load, running ? 1500 : 6000);
    return () => clearInterval(t);
  }, [load, running]);

  const preview = useMemo(() => {
    const t = text.trim() ? parseDomainList(text) : null;
    const c = csv ? parseDomainCsv(csv.content) : null;
    const all = [...(t?.valid ?? []), ...(c?.valid ?? [])];
    const unique = [...new Set(all.map((v) => v.domain))];
    const dupCount = all.length - unique.length + (t?.duplicates.length ?? 0) + (c?.duplicates.length ?? 0);
    return { unique, invalid: [...(t?.invalid ?? []), ...(c?.invalid ?? [])], dupCount, csvError: c && "error" in c ? c.error : undefined };
  }, [text, csv]);

  async function run() {
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const r = await postJson<{ batchId: number; accepted: string[]; invalid: { input: string; reason: string }[]; duplicates: string[] }>("/api/batches", {
        domains: text.trim() || undefined,
        csv: csv?.content,
      });
      setActiveBatch(r.batchId);
      setSubmitMsg({ kind: "info", text: `Agent started on ${r.accepted.length} compan${r.accepted.length === 1 ? "y" : "ies"}.${r.invalid.length ? ` ${r.invalid.length} invalid skipped.` : ""}${r.duplicates.length ? ` ${r.duplicates.length} duplicates removed.` : ""}` });
      setText("");
      setCsv(null);
      load();
    } catch (e) {
      setSubmitMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  const p = data?.providers;
  const m = data?.metrics;
  const batchId = activeBatch ?? data?.batches[0]?.id ?? null;
  const progress = (data?.companies ?? []).filter((c) => c.run && (c.run.batchId === batchId || c.run.status === "running" || c.run.status === "queued"));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo">S</div>
          <div>
            <h1>Sprinto Outreach Agent</h1>
            <div className="sub">Domains in → research → ICP qualification → decision-maker → 2 pain points → personalised email → your inbox</div>
          </div>
        </div>
        {p && (
          <div className="chips">
            <span className={`badge ${p.mode === "demo" ? "b-mock" : "b-real"}`}>{p.mode === "demo" ? "DEMO MODE" : "LIVE MODE"}</span>
            <ProviderChip label="LLM" {...p.llm} />
            <ProviderChip label="Search" {...p.search} />
            <ProviderChip label="Hunter" {...p.hunter} />
            <ProviderChip label="Gmail" {...p.gmail} />
          </div>
        )}
      </header>

      {loadError && <div className="notice n-bad" style={{ marginBottom: 12 }}>Could not load dashboard data: {loadError}</div>}

      {p && (p.llm.state !== "real" || p.gmail.state !== "real") && (
        <div className="notice n-mock" style={{ marginBottom: 16 }}>
          <b>Setup status.</b>{" "}
          {p.llm.state !== "real" && <>No LLM key is configured, so analysis uses a keyword-based <b>MOCK</b> model (results are labelled MOCK). </>}
          {p.gmail.state !== "real" && (
            <>
              Gmail is not connected, so deliveries are <b>SIMULATED</b> — nothing is sent.{" "}
              {p.canAuthorizeGmail ? <a href="/api/auth/gmail/start">Connect Gmail for {p.demoInbox} →</a> : "See README → Gmail setup."}
            </>
          )}
        </div>
      )}

      <section className="metrics">
        <Metric label="Total companies" value={m?.totalCompanies} />
        <Metric label="Qualified" value={m?.qualified} />
        <Metric label="Not qualified" value={m?.notQualified} />
        <Metric label="Needs review" value={m?.needsReview} />
        <Metric label="Emails generated" value={m?.emailsGenerated} />
        <Metric label="Sent to my inbox" value={m?.emailsSent} hint={m && m.emailsSimulated ? `+${m.emailsSimulated} simulated` : p?.demoInbox ?? undefined} />
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Company domains</h2>
            {p?.mode === "demo" && (
              <button className="btn btn-sm" onClick={() => setText(MOCK_DEMO)} title="Fictional .example companies — fully offline">
                Load mock demo set
              </button>
            )}
          </div>
          <textarea
            placeholder={"One per line or comma-separated\nacme.com\nhttps://www.example-saas.io"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Company domains"
          />
          <div className="row" style={{ marginTop: 8 }}>
            <label className="btn btn-sm">
              Upload CSV
              <input
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setCsv({ name: f.name, content: await f.text() });
                  e.target.value = "";
                }}
              />
            </label>
            {csv && (
              <span className="sub">
                {csv.name} <button className="btn btn-sm" onClick={() => setCsv(null)}>Remove</button>
              </span>
            )}
            <span className="sub">CSV column: domain, website or company_url</span>
          </div>

          {(text.trim() || csv) && (
            <div style={{ marginTop: 10 }}>
              {preview.csvError && <div className="notice n-bad">{preview.csvError}</div>}
              <div className="sub">
                <b style={{ color: "var(--text)" }}>{preview.unique.length}</b> valid domain{preview.unique.length === 1 ? "" : "s"}
                {preview.dupCount > 0 && <> · {preview.dupCount} duplicate{preview.dupCount === 1 ? "" : "s"} removed</>}
                {preview.invalid.length > 0 && <> · {preview.invalid.length} invalid</>}
              </div>
              {preview.invalid.length > 0 && (
                <ul className="list-tight sub">
                  {preview.invalid.slice(0, 8).map((i, k) => (
                    <li key={k}>
                      {i.row ? `Row ${i.row}: ` : ""}
                      <code>{i.input || "(empty)"}</code> — {i.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <button className="btn btn-primary btn-lg" style={{ width: "100%" }} disabled={submitting || preview.unique.length === 0} onClick={run}>
              {submitting ? "Starting…" : "RUN OUTREACH AGENT"}
            </button>
          </div>
          {submitMsg && <div className={`notice ${submitMsg.kind === "bad" ? "n-bad" : "n-info"}`} style={{ marginTop: 10 }}>{submitMsg.text}</div>}
          <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
            Emails are addressed to the identified prospect by name but are delivered <b>only to {p?.demoInbox ?? "your own inbox (DEMO_INBOX_EMAIL)"}</b>. Prospects are never contacted.
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Agent progress</h2>
            {running ? <span className="badge b-info">Running · {m?.running} active</span> : <span className="sub">{batchId ? `Batch #${batchId}` : "Idle"}</span>}
          </div>
          {progress.length === 0 ? (
            <div className="empty">Enter domains and run the agent to see each stage execute here.</div>
          ) : (
            progress.map((c) => (
              <div key={c.id} className="progress-card">
                <div className="row">
                  <b style={{ textTransform: "uppercase", letterSpacing: ".03em" }}>{c.domain}</b>
                  <SourceBadge source={c.dataSource} />
                  <span className="spacer" />
                  <StatusBadge status={c.run?.status === "running" ? "running" : c.status} />
                  <Link href={`/companies/${c.id}`} className="sub">Details →</Link>
                </div>
                <StageList stages={c.run?.stages ?? []} />
              </div>
            ))
          )}
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>Results</h2>
          <span className="sub">Click a row for the full research, evidence and email</span>
        </div>
        {data?.companies.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>ICP score</th>
                  <th>Qualification</th>
                  <th>Reason</th>
                  <th>Decision-maker</th>
                  <th>Pain point 1</th>
                  <th>Pain point 2</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {data.companies.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => router.push(`/companies/${c.id}`)}>
                    <td>
                      <b>{c.name ?? c.domain}</b>
                      <div className="sub">{c.domain}</div>
                      <SourceBadge source={c.dataSource} />
                    </td>
                    <td className="score">{c.score ?? "—"}{c.score !== null && <span className="sub">/100</span>}</td>
                    <td><StatusBadge status={c.run?.status === "running" ? "running" : c.status} /></td>
                    <td><div className="clamp sub">{c.reason ?? "—"}</div></td>
                    <td>{c.contactName ? <><b>{c.contactName}</b><div className="sub">{c.contactTitle}</div></> : "—"}</td>
                    <td><div className="clamp">{c.painPoint1 ?? "—"}</div></td>
                    <td><div className="clamp">{c.painPoint2 ?? "—"}</div></td>
                    <td><StatusBadge status={c.emailStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No companies processed yet.</div>
        )}
        {m && m.llmCalls > 0 && (
          <p className="sub" style={{ marginBottom: 0 }}>
            {m.llmCalls} model calls{m.llmCostUsd > 0 ? ` · est. $${m.llmCostUsd.toFixed(3)}` : ""} · {p?.hunter.detail}
          </p>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: number | undefined; hint?: string }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{value ?? "–"}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
