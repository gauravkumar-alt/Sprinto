"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiscoverPanel } from "@/components/discover";
import { Collapse, CountUp, Fill, Pop, Reveal, focusSection, useGlider, useStaggerOnChange, useTilt } from "@/components/motion";
import { EmailBadge, Meter, Pips, SourceBadge, StatusBadge, ThemeToggle, currentStepLabel, postJson, tone, type StageRow } from "@/components/ui";
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
  found: string[];
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  contactEmailStatus: string | null;
  sources: { website: number; external: number; checked: number; contact: string | null };
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
  killSwitch?: { on: boolean; forced: boolean };
  snapshotAt?: string | null;
};

type Filter = "all" | "qualified" | "needs_review" | "not_qualified" | "emailed" | "sent";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["qualified", "Qualified"],
  ["needs_review", "Needs review"],
  ["not_qualified", "Not qualified"],
  ["emailed", "Drafted"],
  ["sent", "Sent"],
];
const matches = (c: Company, f: Filter) =>
  f === "all" ? true : f === "emailed" ? Boolean(c.emailStatus) : f === "sent" ? ["sent", "simulated"].includes(c.emailStatus ?? "") : c.decision === f;
/** An email that went out under an earlier scoring, for a company that no longer qualifies. */
const sentEarlier = (c: Company) => ["sent", "simulated"].includes(c.emailStatus ?? "") && c.decision !== "qualified";

const MOCK_DEMO = "vaultlane.example\nledgerly.example\nnorthpeak-consulting.example\norbitboard.example\npromptbait.example";

/** One short line saying why a company didn't qualify (or what it still lacks). */
function whyLine(c: Company, status: string): string | null {
  if (status === "failed") return "Run stopped (AI service busy) — re-run";
  if (!c.decision && status === "needs_review") return "Website couldn't be read (down or JavaScript-only)";
  if (!c.decision || c.decision === "qualified") return null;
  const dq = c.disqualification ?? [];
  const cert = dq.find((d) => d.startsWith("Already certified"));
  if (cert) return `Already has ${cert.replace(/^Already certified \(|\)$/g, "").split(", ").slice(0, 2).join(" + ")}`;
  if (dq.some((d) => d.startsWith("Not a SaaS"))) return "Not a SaaS business";
  if (dq.some((d) => d.startsWith("Primarily B2C"))) return "Sells to consumers";
  if (dq.some((d) => d.startsWith("Outside target"))) return "Outside Sprinto's target";
  const f = new Set(c.found);
  const gaps: string[] = [];
  if (!f.has("preparing_certification") && !f.has("compliance_hiring")) gaps.push("not preparing for SOC 2");
  if (!f.has("funding_series_ac") && !f.has("open_roles")) gaps.push("no funding or hiring found");
  if (!f.has("targets_enterprise") && !f.has("named_enterprise_customers")) gaps.push("no enterprise signal");
  if (!f.has("saas") || !f.has("b2b")) gaps.unshift("B2B SaaS not confirmed");
  const score = c.score ?? 0;
  return `${score}/100 (needs 65)${gaps.length ? ` · ${gaps.slice(0, 2).join(", ")}` : ""}`;
}

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
  const [showFinder, setShowFinder] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [csv, setCsv] = useState<{ name: string; content: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "info" | "bad"; text: string } | null>(null);
  const [review, setReview] = useState<{ c: Company; kind: "approve" | "reject" } | null>(null);
  const [activeBatch, setActiveBatch] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const resultsRef = useRef<HTMLElement>(null);
  const filtersRef = useGlider(".filter.on", filter);
  const rowsRef = useStaggerOnChange<HTMLTableSectionElement>("tr", filter);
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

  async function toggleKill(on: boolean) {
    if (on && !window.confirm("Stop the agent now? Queued companies are cancelled, running ones stop at their next step, and nothing is sent until you resume.")) return;
    try {
      const r = await postJson<{ on: boolean; cancelled?: number }>("/api/kill-switch", { on });
      setMsg({ kind: on ? "bad" : "info", text: on ? `Agent stopped${r.cancelled ? ` — ${r.cancelled} queued compan${r.cancelled === 1 ? "y" : "ies"} cancelled` : ""}.` : "Agent resumed." });
    } catch (e) {
      setMsg({ kind: "bad", text: (e as Error).message });
    }
    load();
  }

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
  // The run box stays hidden until asked for, but never hides a list you've typed or a run being started.
  const runOpen = showRun || Boolean(text.trim()) || Boolean(csv) || submitting;
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
            </>
          )}
          {data && !data.readOnly && !data.killSwitch?.on && (
            <button className="btn btn-sm btn-kill" onClick={() => toggleKill(true)} title="Stop all agent work now: cancels queued runs, stops running ones at the next step, blocks every send">
              Stop agent
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>

      {data?.killSwitch?.on && !data.readOnly && (
        <Pop>
        <div className="notice n-bad kill-banner" role="alert" style={{ marginBottom: 16 }}>
          <b>Agent stopped (kill switch on).</b> Nothing runs and no email is sent until you resume.
          {data.killSwitch.forced ? (
            <> Forced by <code>AGENT_KILL_SWITCH=true</code>: remove it from .env.local and restart to resume.</>
          ) : (
            <button className="btn btn-sm" style={{ marginLeft: 10 }} onClick={() => toggleKill(false)}>
              Resume
            </button>
          )}
        </div>
        </Pop>
      )}

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
        <Metric label="Email drafts" value={m?.emailsGenerated} pct={share(m?.emailsGenerated)} on={filter === "emailed"} onClick={() => pick("emailed")} />
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

      <div className={`run-row${showProgress && (data?.readOnly || runOpen) ? " with-progress" : ""}`} data-reveal>
        {data?.readOnly ? (
          <section className="panel">
            <h2>Shared view</h2>
            <p className="sub" style={{ margin: "6px 0 0" }}>
              Browse each company&apos;s research, contact and email.{" "}
              {data?.snapshotAt ? `Results as of ${new Date(data.snapshotAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.` : "Runs happen on the host machine."}
            </p>
          </section>
        ) : (
          <Collapse open={runOpen}>
          <section className="panel">
            <div className="panel-head" style={{ marginBottom: 10 }}>
              <h2>Run the agent</h2>
              <span className="spacer" />
              <button className="link-btn" onClick={() => setShowRun(false)} disabled={Boolean(text.trim() || csv || submitting)} title={text.trim() || csv ? "Clear the list to hide" : "Hide"}>
                Hide
              </button>
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
              <button className="btn btn-primary" disabled={submitting || preview.unique.length === 0 || Boolean(data?.killSwitch?.on)} onClick={run}>
                {submitting ? "Starting…" : "Run outreach agent"}
              </button>
            </div>
            {msg && <Pop k={msg.text}><div className={`notice ${msg.kind === "bad" ? "n-bad" : "n-info"}`} style={{ marginTop: 10 }}>{msg.text}</div></Pop>}
            <div className="guard">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
              Emails go only to {p?.demoInbox ?? "your inbox"} — never to prospects
            </div>
          </section>
          </Collapse>
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

      {data && !data.readOnly && (
        <>
          <div className="finder-link">
            {!runOpen && (
              <button className="link-btn" onClick={() => setShowRun(true)}>
                + Run on new companies
              </button>
            )}
            <button className="link-btn" onClick={() => setShowFinder((v) => !v)} aria-expanded={showFinder}>
              {showFinder ? "Hide company finder" : "Find new companies to research →"}
            </button>
          </div>
          <Collapse open={showFinder}>
            <DiscoverPanel
              onAdd={(lines) => {
                setText((t) => [t.trim(), ...lines].filter(Boolean).join("\n"));
                setShowRun(true); // open the run box with the added companies
              }}
            />
          </Collapse>
        </>
      )}

      <section className="panel" style={{ marginTop: 16, scrollMarginTop: 16 }} ref={resultsRef} data-reveal>
        <div className="panel-head">
          <h2>Results</h2>
          <div className="filters" ref={filtersRef}>
            <span className="glider" aria-hidden />
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
                  <th>{data?.readOnly ? "Email" : "Email / your decision"}</th>
                </tr>
              </thead>
              <tbody ref={rowsRef}>
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
                        {c.sources.checked > 0 && (
                          <div
                            className="src-count"
                            title={`${c.sources.website} from ${c.domain}, ${c.sources.external} from elsewhere (news, job boards)`}
                          >
                            {c.sources.website + c.sources.external} pages read
                          </div>
                        )}
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
                            <span><b>{c.breakdown.business}</b><small>Fit</small></span>
                            <span><b>{c.breakdown.growth}</b><small>Growth</small></span>
                            <span className={c.breakdown.compliance ? "hot" : ""}><b>{c.breakdown.compliance}</b><small>SOC 2</small></span>
                            <span><b>{c.breakdown.enterprise}</b><small>Enterp.</small></span>
                          </button>
                        ) : (
                          <span className="faint" title="Assessed with the previous rubric — re-run to see the breakdown">—</span>
                        )}
                      </td>
                      <td className="c-status"><StatusBadge status={status} /></td>
                      <td data-label="Why" className="c-why" data-empty={(whyLine(c, status) ?? shortReason(c)) === "—" || undefined} title={c.reason ?? undefined}>{whyLine(c, status) ?? shortReason(c)}</td>
                      <td data-label="Decision-maker" className="c-wide" data-empty={!c.contactName || undefined}>
                        {c.contactName ? (
                          <>
                            <div>{c.contactName}</div>
                            <div className="faint clamp1" style={{ fontSize: 12 }}>{c.contactTitle}</div>
                            {c.contactEmail && (
                              <div className="contact-email" title={c.contactEmailStatus === "valid" ? "Work email (verified)" : "Work email"}>
                                {c.contactEmail}
                                {c.contactEmailStatus === "valid" && <span className="verified" aria-label="verified">✓</span>}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="faint pending-label">{notYet(c, status)}</span>
                        )}
                      </td>
                      <td data-label="Pain points" className="c-pain c-wide" data-empty={!c.painPoint1 || undefined} style={{ maxWidth: 280 }}>
                        {c.painPoint1 ? (
                          <>
                            <div className="clamp1" title={c.painPoint1}>1. {c.painPoint1}</div>
                            {c.painPoint2 && <div className="clamp1 sub" title={c.painPoint2}>2. {c.painPoint2}</div>}
                          </>
                        ) : (
                          <span className="faint pending-label">{notYet(c, status)}</span>
                        )}
                      </td>
                      {(() => {
                        const canReview = !data?.readOnly && (c.decision ?? c.status) === "needs_review" && status !== "running" && status !== "queued";
                        return (
                          <td data-label={canReview ? "Your decision" : "Email"} data-empty={(!c.emailStatus && !canReview) || undefined}>
                            {sentEarlier(c) ? <span className="badge b-mute" title="Sent under an earlier scoring; this company no longer qualifies">Sent earlier</span> : c.emailStatus ? <EmailBadge status={c.emailStatus} /> : !canReview && <span className="faint pending-label">{notYet(c, status)}</span>}
                            {canReview && (
                              <div className="row-review">
                                <button className="mini mini-ok" disabled={!c.contactName} onClick={(e) => { e.stopPropagation(); setReview({ c, kind: "approve" }); }} title={c.contactName ? "Approve: send this email draft to your inbox" : "No decision-maker found yet: open the company and use Add contact first"}>✓ Approve</button>
                                <button className="mini mini-bad" onClick={(e) => { e.stopPropagation(); setReview({ c, kind: "reject" }); }} title="Reject: mark not qualified">✕ Reject</button>
                              </div>
                            )}
                          </td>
                        );
                      })()}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="legend">
              <span><b>Breakdown</b> business fit /30 · growth /25 · SOC 2 need /35 · enterprise /10</span>
              <span>Click a score to see the quotes behind it</span>
            </div>
          </div>
        ) : (
          <div className="empty">{data ? "No companies yet. Click “+ Run on new companies” to start." : "Loading…"}</div>
        )}
      </section>
      {review && (
        <ReviewDialog
          company={review.c}
          kind={review.kind}
          onClose={() => setReview(null)}
          onDone={(text) => {
            setReview(null);
            setMsg({ kind: "info", text });
            setShowRun(true); // the run box shows the confirmation and progress
            load();
          }}
        />
      )}
    </Reveal>
  );
}

/** Approve or reject a "needs review" company from the results list, with a reason. */
function ReviewDialog({ company, kind, onClose, onDone }: { company: Company; kind: "approve" | "reject"; onClose: () => void; onDone: (msg: string) => void }) {
  const [mode, setMode] = useState(kind);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = company.name ?? company.domain;
  const ok = mode === "reject" || note.trim().length >= 5;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await postJson(`/api/companies/${company.id}/actions`, mode === "approve" ? { action: "approve", note: note.trim() } : { action: "reject", note: note.trim() || undefined });
      onDone(mode === "approve" ? `${name} approved — finding the decision-maker and writing the email (sent only to your inbox).` : `${name} rejected — marked not qualified.`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <Pop className="dialog-wrap">
        <div className="panel dialog" role="dialog" aria-modal="true" aria-label={`Review ${name}`} onClick={(e) => e.stopPropagation()}>
          <div className="panel-head" style={{ marginBottom: 6 }}>
            <h2>Review {name}</h2>
            <button className="link-btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <p className="sub" style={{ margin: "0 0 12px" }}>
            {company.score !== null ? `${company.score}/100 · ` : ""}{company.reason ?? "The agent couldn't decide on its own."}
          </p>
          <div className="seg" role="radiogroup" aria-label="Decision">
            <button role="radio" aria-checked={mode === "approve"} className={mode === "approve" ? "on ok" : ""} onClick={() => setMode("approve")}>✓ Approve</button>
            <button role="radio" aria-checked={mode === "reject"} className={mode === "reject" ? "on bad" : ""} onClick={() => setMode("reject")}>✕ Reject</button>
          </div>
          <input
            autoFocus
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ok && !busy && submit()}
            placeholder={mode === "approve" ? "Why it's a fit (needed), e.g. confirmed SaaS on its pricing page" : "Reason (optional)"}
            aria-label="Reason"
            style={{ width: "100%", marginTop: 12 }}
          />
          <p className="sub" style={{ margin: "8px 0 0" }}>
            {mode === "approve" ? "The agent writes the final email and sends it to your own inbox (never to the company)." : "The company is marked not qualified. Its details stay; nothing is sent."}
          </p>
          {err && <div className="notice n-bad" style={{ marginTop: 10 }}>{err}</div>}
          <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
            <button className="btn btn-sm" onClick={onClose}>Cancel</button>
            <button className={`btn btn-sm ${mode === "approve" ? "btn-approve" : "btn-reject"}`} disabled={!ok || busy} onClick={submit}>
              {busy ? "Saving…" : mode === "approve" ? "Approve" : "Reject"}
            </button>
          </div>
        </div>
      </Pop>
    </div>
  );
}

/** What an empty Decision-maker / Pain points / Email cell is waiting for. */
function notYet(c: Company, status: string): string {
  if (status === "running" || status === "queued") return "In progress…";
  if (status === "failed") return "Run stopped";
  return c.decision ? "Not found" : "—";
}

function Metric({ label, value, hint, pct, tone, on, onClick }: { label: string; value: number | undefined; hint?: string; pct: number; tone?: "ok" | "warn" | "bad"; on?: boolean; onClick: () => void }) {
  const tilt = useTilt<HTMLButtonElement>(4);
  return (
    <button ref={tilt} type="button" className={`metric${tone ? ` t-${tone}` : ""}${on ? " on" : ""}`} onClick={onClick} aria-pressed={on} data-reveal>
      <span className="go" aria-hidden>↓</span>
      <div className="label">{label}</div>
      <div className="value"><CountUp value={value} /></div>
      {hint && <div className="sent-note">{hint}</div>}
      <div className="mbar"><Fill pct={pct} /></div>
    </button>
  );
}
