"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CountUp, Fill, Reveal, focusSection } from "@/components/motion";
import { Meter, Pips, ProviderChip, SourceBadge, StatusBadge, ThemeToggle, currentStepLabel, postJson, tone, type StageRow } from "@/components/ui";
import { parseDomainCsv, parseDomainList } from "@/lib/security/domain";

type Provider = { state: string; detail: string };
type Company = {
  id: number;
  domain: string;
  name: string | null;
  status: string;
  dataSource: string;
  score: number | null;
  decision: string | null;
  reason: string | null;
  signals: { saas: string; audit: string; enterprise: string } | null;
  breakdown: { business: number; growth: number; compliance: number; enterprise: number } | null;
  disqualification: string[];
  contactName: string | null;
  contactTitle: string | null;
  painPoint1: string | null;
  painPoint2: string | null;
  emailStatus: string | null;
  run: { id: number; status: string; batchId: number | null; stages: StageRow[] } | null;
};
type Status = {
  providers: { mode: "demo" | "live"; llm: Provider; research: Provider; search: Provider; hunter: Provider; gmail: Provider; demoInbox: string | null; canAuthorizeGmail: boolean };
  metrics: { totalCompanies: number; qualified: number; notQualified: number; needsReview: number; emailsGenerated: number; emailsSent: number; emailsSimulated: number; running: number; llmCostUsd: number; llmCalls: number };
  batches: { id: number }[];
  companies: Company[];
  readOnly: boolean;
  snapshotAt?: string | null;
};

type Filter = "all" | "qualified" | "needs_review" | "not_qualified" | "emailed" | "sent";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["qualified", "Qualified"],
  ["needs_review", "Needs review"],
  ["not_qualified", "Not qualified"],
  ["sent", "Emailed"],
];
const matches = (c: Company, f: Filter) =>
  f === "all" ? true : f === "emailed" ? Boolean(c.emailStatus) : f === "sent" ? ["sent", "simulated"].includes(c.emailStatus ?? "") : c.decision === f;
/** An email that went out under an earlier scoring, for a company that no longer qualifies. */
const sentEarlier = (c: Company) => ["sent", "simulated"].includes(c.emailStatus ?? "") && c.decision !== "qualified";

const MOCK_DEMO = "vaultlane.example\nledgerly.example\nnorthpeak-consulting.example\norbitboard.example\npromptbait.example";

/** Two-to-three word reason for the results table; the full explanation is the tooltip. */
function shortReason(c: Company): string {
  const s = c.signals;
  if (!s) return "—";
  if (c.disqualification?.includes("ALREADY_CERTIFIED") && c.decision === "not_qualified") return "Already certified";
  const dq = c.disqualification?.find((d) => d !== "ALREADY_CERTIFIED");
  if (dq && c.decision === "not_qualified") return dq.startsWith("Not a SaaS") ? "Not SaaS" : dq.startsWith("Primarily B2C") ? "B2C" : "Outside target";
  if (c.breakdown && c.decision === "needs_review") return c.signals?.saas !== "confirmed" ? "Model unclear" : "Borderline";
  if (c.breakdown && c.decision === "not_qualified") return c.breakdown.compliance === 0 ? "No compliance signal" : "Low score";
  const audit = ["active_or_planned", "initiative_timing_uncertain"].includes(s.audit);
  const ent = ["direct_requirement", "security_reviews"].includes(s.enterprise);
  if (c.decision === "qualified") {
    if (audit && ent) return "Audit + enterprise";
    if (audit) return "Audit prep";
    if (ent) return "Enterprise pressure";
    return s.audit === "already_certified" ? "Certified · renewal" : "Reviewer approved";
  }
  if (c.decision === "not_qualified") return s.saas === "not_saas" ? "Not SaaS" : "Outside target";
  if (s.audit === "already_certified") return "Already certified";
  if (s.saas !== "confirmed") return "SaaS unclear";
  return "No buying trigger";
}

export default function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [csv, setCsv] = useState<{ name: string; content: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "info" | "bad"; text: string } | null>(null);
  const [activeBatch, setActiveBatch] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const resultsRef = useRef<HTMLElement>(null);
  const pick = (f: Filter) => {
    setFilter((cur) => (cur === f && f !== "all" ? "all" : f));
    focusSection(resultsRef.current);
  };

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
    setMsg(null);
    try {
      const r = await postJson<{ batchId: number; accepted: string[] }>("/api/batches", { domains: text.trim() || undefined, csv: csv?.content });
      setActiveBatch(r.batchId);
      setMsg({ kind: "info", text: `Running on ${r.accepted.length} compan${r.accepted.length === 1 ? "y" : "ies"}.` });
      setText("");
      setCsv(null);
      load();
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  const p = data?.providers;
  const m = data?.metrics;
  const batchId = activeBatch ?? data?.batches[0]?.id ?? null;
  const progress = (data?.companies ?? []).filter((c) => c.run && (c.run.batchId === batchId || c.run.status === "running" || c.run.status === "queued"));
  const anyMock = p && [p.llm.state, p.gmail.state].includes("mock");
  const list = data?.companies ?? [];
  const total = m?.totalCompanies ?? 0;
  const sentAll = list.filter((c) => ["sent", "simulated"].includes(c.emailStatus ?? "")).length;
  const sentOld = list.filter(sentEarlier).length;
  const share = (n: number | undefined) => (total ? ((n ?? 0) / total) * 100 : 0);
  const showProgress = running || progress.some((c) => c.run?.status === "running" || c.run?.status === "queued") || (activeBatch !== null && progress.length > 0);

  return (
    <Reveal ready={Boolean(data)} className="shell">
      <header className="topbar" data-reveal>
        <div className="brand">
          <div className="logo">S</div>
          <div>
            <h1>Sprinto Outreach Agent</h1>
            <div className="sub">Research → Qualify → Contact → Email</div>
          </div>
        </div>
        <div className="chips">
          {p && (
            <>
              {data?.snapshotAt ? (
                <span className="badge b-mute" title="Frozen, read-only copy of the results">Snapshot · {new Date(data.snapshotAt).toLocaleDateString([], { day: "numeric", month: "short" })}</span>
              ) : (
                data?.readOnly && <span className="badge b-mute">View only</span>
              )}
              <ProviderChip label={p.llm.state === "real" ? p.llm.detail.split(" · ")[0].replace(/^./, (s) => s.toUpperCase()) : "AI"} {...p.llm} />
              <ProviderChip label="Hunter" {...p.hunter} />
              <ProviderChip label="Gmail" {...p.gmail} />
            </>
          )}
          <ThemeToggle />
        </div>
      </header>

      {loadError && <div className="notice n-bad" style={{ marginBottom: 12 }}>Couldn&apos;t load data ({loadError}).</div>}
      {p && anyMock && !data?.readOnly && (
        <div className="notice n-mock" style={{ marginBottom: 16 }}>
          {p.llm.state !== "real" && <>Mock AI in use. </>}
          {p.gmail.state !== "real" && (
            <>
              Gmail not connected — sends are simulated.{" "}
              {p.canAuthorizeGmail && <a href="/api/auth/gmail/start">Connect Gmail</a>}
            </>
          )}
        </div>
      )}

      <section className="metrics" aria-label="Summary — click a card to filter the results">
        <Metric label="Companies" value={m?.totalCompanies} pct={total ? 100 : 0} on={filter === "all"} onClick={() => pick("all")} />
        <Metric label="Qualified" value={m?.qualified} pct={share(m?.qualified)} tone="ok" on={filter === "qualified"} onClick={() => pick("qualified")} />
        <Metric label="Needs review" value={m?.needsReview} pct={share(m?.needsReview)} tone="warn" on={filter === "needs_review"} onClick={() => pick("needs_review")} />
        <Metric label="Not qualified" value={m?.notQualified} pct={share(m?.notQualified)} tone="bad" on={filter === "not_qualified"} onClick={() => pick("not_qualified")} />
        <Metric label="Emails written" value={m?.emailsGenerated} pct={share(m?.emailsGenerated)} on={filter === "emailed"} onClick={() => pick("emailed")} />
        <Metric
          label="Sent to your inbox"
          value={sentAll}
          pct={share(sentAll)}
          tone="ok"
          hint={sentOld ? `${sentOld} under earlier scoring` : m?.emailsSimulated ? `incl. ${m.emailsSimulated} simulated` : undefined}
          on={filter === "sent"}
          onClick={() => pick("sent")}
        />
      </section>

      <div className={`run-row${showProgress ? " with-progress" : ""}`} data-reveal>
        {data?.readOnly ? (
          <section className="panel">
            <h2>Shared view</h2>
            <p className="sub" style={{ margin: "6px 0 0" }}>
              Browse each company&apos;s research, contact and email.{" "}
              {data?.snapshotAt ? `Results as of ${new Date(data.snapshotAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.` : "Runs happen on the host machine."}
            </p>
          </section>
        ) : (
          <section className="panel">
            <div className="panel-head" style={{ marginBottom: 10 }}>
              <h2>Run the agent</h2>
              {p?.mode === "demo" && (
                <button className="btn btn-sm" onClick={() => setText(MOCK_DEMO)} title="Five fictional .example companies">
                  Demo set
                </button>
              )}
            </div>
            <textarea placeholder={"acme.com\nAcme Inc | acme.io"} value={text} onChange={(e) => setText(e.target.value)} aria-label="Company domains, one per line" />
            {(text.trim() || csv) && (
              <div className="sub" style={{ marginTop: 6 }}>
                <b style={{ color: "var(--text)" }}>{preview.unique.length}</b> valid
                {preview.dupCount > 0 && <> · {preview.dupCount} duplicate{preview.dupCount === 1 ? "" : "s"} removed</>}
                {preview.invalid.length > 0 && <> · {preview.invalid.length} invalid</>}
                {preview.csvError && <div style={{ color: "var(--bad)" }}>{preview.csvError}</div>}
                {preview.invalid.length > 0 && (
                  <ul className="list-tight">
                    {preview.invalid.slice(0, 5).map((i, k) => (
                      <li key={k}>
                        <code>{i.input || "(empty)"}</code> — {i.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <label className="btn btn-sm" title="CSV with a domain, website or company_url column">
                {csv ? csv.name : "Upload CSV"}
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
                <button className="btn btn-sm" onClick={() => setCsv(null)}>
                  Remove
                </button>
              )}
              <span className="spacer" />
              <button className="btn btn-primary" disabled={submitting || preview.unique.length === 0} onClick={run}>
                {submitting ? "Starting…" : "Run outreach agent"}
              </button>
            </div>
            {msg && <div className={`notice ${msg.kind === "bad" ? "n-bad" : "n-info"}`} style={{ marginTop: 10 }}>{msg.text}</div>}
            <div className="guard">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
              Emails go only to {p?.demoInbox ?? "your inbox"} — never to prospects
            </div>
          </section>
        )}

        {showProgress && (
        <section className="panel">
          <div className="panel-head" style={{ marginBottom: 10 }}>
            <h2>Progress</h2>
            {running && <span className="badge b-info">{m?.running} running</span>}
          </div>
          {progress.length === 0 ? (
            <div className="empty">{data?.readOnly ? "Nothing running." : "Run the agent to watch each step here."}</div>
          ) : (
            progress.map((c) => (
              <Link key={c.id} href={`/companies/${c.id}`} className="progress-card" style={{ display: "block", color: "inherit", textDecoration: "none" }}>
                <div className="row">
                  <b>{c.name ?? c.domain}</b>
                  {c.dataSource === "mock" && <SourceBadge source="mock" />}
                  <span className="spacer" />
                  <StatusBadge status={c.run?.status === "running" || c.run?.status === "queued" ? c.run.status : c.status} />
                </div>
                <Pips stages={c.run?.stages ?? []} />
                <div className="sub ellipsis" style={{ marginTop: 6 }}>{currentStepLabel(c.run?.stages ?? [])}</div>
              </Link>
            ))
          )}
        </section>
        )}
      </div>

      <section className="panel" style={{ marginTop: 16, scrollMarginTop: 16 }} ref={resultsRef} data-reveal>
        <div className="panel-head">
          <h2>Results</h2>
          <div className="filters">
            {FILTERS.map(([k, label]) => (
              <button key={k} className={`filter${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>
                {label} {list.filter((c) => matches(c, k)).length}
              </button>
            ))}
          </div>
        </div>
        {data?.companies.length ? (
          <div className="table-wrap">
            <table className="results-table">
              <thead>
                <tr>
                  <th style={{ padding: 0 }} />
                  <th>Company</th>
                  <th>Score</th>
                  <th title="Business model · Growth · Compliance · Enterprise">Breakdown</th>
                  <th>Status</th>
                  <th>Why</th>
                  <th>Decision-maker</th>
                  <th>Pain points</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {list.filter((c) => matches(c, filter)).map((c) => {
                  const status = c.run?.status === "running" || c.run?.status === "queued" ? c.run.status : c.status;
                  return (
                    <tr key={c.id} className="clickable" onClick={() => router.push(`/companies/${c.id}`)}>
                      <td className={`rail ${tone(status)}`}><span /></td>
                      <td className="c-company">
                        <b style={{ whiteSpace: "nowrap" }}>{c.name ?? c.domain}</b>
                        <div className="faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                          {c.domain}
                          {c.dataSource === "mock" && <span style={{ color: "var(--mock)", fontWeight: 600 }}> · mock</span>}
                        </div>
                      </td>
                      <td data-label="Score" data-empty={c.score === null || undefined}>
                        {c.score !== null ? (
                          <button className="meter-btn" onClick={(e) => { e.stopPropagation(); router.push(`/companies/${c.id}#qualification`); }} title="Open the score breakdown" aria-label={`Score ${c.score} of 100 — open breakdown`}>
                            <Meter value={c.score} status={c.decision} />
                          </button>
                        ) : (
                          <Meter value={c.score} status={c.decision} />
                        )}
                      </td>
                      <td data-label="Breakdown" data-empty={!c.breakdown || undefined}>
                        {c.breakdown ? (
                          <button
                            className="breakdown"
                            onClick={(e) => { e.stopPropagation(); router.push(`/companies/${c.id}#qualification`); }}
                            title={`Business model ${c.breakdown.business}/30 · Growth ${c.breakdown.growth}/25 · Compliance ${c.breakdown.compliance}/35 · Enterprise ${c.breakdown.enterprise}/10 — click for evidence`}
                          >
                            <span>{c.breakdown.business}</span>
                            <span>{c.breakdown.growth}</span>
                            <span className={c.breakdown.compliance ? "hot" : ""}>{c.breakdown.compliance}</span>
                            <span>{c.breakdown.enterprise}</span>
                          </button>
                        ) : (
                          <span className="faint" title="Assessed with the previous rubric — re-run to see the breakdown">—</span>
                        )}
                      </td>
                      <td className="c-status"><StatusBadge status={status} /></td>
                      <td data-label="Why" className="c-why" data-empty={shortReason(c) === "—" || undefined} title={c.reason ?? undefined}>{shortReason(c)}</td>
                      <td data-label="Decision-maker" className="c-wide" data-empty={!c.contactName || undefined}>
                        {c.contactName ? (
                          <>
                            <div>{c.contactName}</div>
                            <div className="faint clamp1" style={{ fontSize: 12 }}>{c.contactTitle}</div>
                          </>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td data-label="Pain points" className="c-pain c-wide" data-empty={!c.painPoint1 || undefined} style={{ maxWidth: 280 }}>
                        {c.painPoint1 ? (
                          <>
                            <div className="clamp1" title={c.painPoint1}>1. {c.painPoint1}</div>
                            {c.painPoint2 && <div className="clamp1 sub" title={c.painPoint2}>2. {c.painPoint2}</div>}
                          </>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td data-label="Email" data-empty={!c.emailStatus || undefined}>
                        {sentEarlier(c) ? <span className="badge b-mute" title="Sent under an earlier scoring; this company no longer qualifies">Sent earlier</span> : <StatusBadge status={c.emailStatus} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="legend">
              <span><b>Breakdown</b> business /30 · growth /25 · compliance /35 · enterprise /10</span>
              <span>Click a score for its evidence</span>
              {m && m.llmCalls > 0 && <span>{m.llmCalls} AI calls{m.llmCostUsd > 0 ? ` · ~$${m.llmCostUsd.toFixed(2)}` : ""}</span>}
            </div>
          </div>
        ) : (
          <div className="empty">No companies yet.</div>
        )}
      </section>
    </Reveal>
  );
}

function Metric({ label, value, hint, pct, tone, on, onClick }: { label: string; value: number | undefined; hint?: string; pct: number; tone?: "ok" | "warn" | "bad"; on?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`metric${tone ? ` t-${tone}` : ""}${on ? " on" : ""}`} onClick={onClick} aria-pressed={on} data-reveal>
      <span className="go" aria-hidden>↓</span>
      <div className="label">{label}</div>
      <div className="value"><CountUp value={value} /></div>
      {hint && <div className="sent-note">{hint}</div>}
      <div className="mbar"><Fill pct={pct} /></div>
    </button>
  );
}
