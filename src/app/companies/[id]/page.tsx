"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Refs, SourceBadge, StageList, StatusBadge, ThemeToggle, postJson } from "@/components/ui";
import { SCORING_RUBRIC } from "@/lib/config";
import type { CompanyProfile, QualificationResult } from "@/lib/schemas";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = any;
type Tab = "overview" | "qualification" | "evidence" | "contact" | "email";

const LEVEL: Record<string, string> = {
  confirmed: "Confirmed SaaS",
  likely: "Likely SaaS",
  not_saas: "Not SaaS",
  unknown: "Unknown",
  series_a_c: "Series A–C",
  growth_indicators: "Growth signals, stage unknown",
  other_verified: "Other stage",
  active_or_planned: "Preparing for an audit",
  initiative_timing_uncertain: "Compliance work, no date",
  already_certified: "Already certified",
  generic_material: "Generic security wording",
  none: "None found",
  direct_requirement: "Customers require certification",
  security_reviews: "Security reviews / questionnaires",
  enterprise_positioning: "Enterprise focus only",
};

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
/** First sentence only — the full text stays available on hover. */
const firstSentence = (s?: string | null) => {
  const first = (s ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
  const clause = first.split(/;\s+/)[0];
  return clause === first ? first : `${clause}.`;
};

const TRIGGER: Record<string, string> = {
  active_or_planned: "preparing for an audit",
  initiative_timing_uncertain: "working on compliance",
  direct_requirement: "customers require certification",
  security_reviews: "facing security reviews",
};

/** One-line verdict built from the stored classification (consistent for old and new runs). */
function verdict(q: QualificationResult & { override_note?: string }): string {
  if (q.override_note) return `Approved by reviewer: ${q.override_note}`;
  const triggers = [TRIGGER[q.audit_trigger], TRIGGER[q.enterprise_pressure]].filter(Boolean);
  if (q.decision === "qualified") return `SaaS company ${triggers.join(" and ")}.`;
  if (q.decision === "not_qualified") return q.saas_status === "not_saas" ? "Not a SaaS business." : q.explanation;
  if (q.audit_trigger === "already_certified" && !triggers.length) return "Already certified — no new audit or customer pressure found.";
  if (q.saas_status !== "confirmed") return triggers.length ? "Has a buying trigger, but SaaS model unconfirmed." : "Couldn't confirm it sells SaaS.";
  return "SaaS, but no audit or enterprise trigger found.";
}
const initials = (n?: string | null) => (n ?? "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export default function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "observed" | "inference" | "unknown">("all");
  const [actionMsg, setActionMsg] = useState<{ kind: "info" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${id}`, { cache: "no-store" });
    if (!res.ok) return setErr(res.status === 404 ? "Company not found." : `Couldn't load (HTTP ${res.status}).`);
    setD(await res.json());
  }, [id]);

  const running = d?.run?.status === "running" || d?.run?.status === "queued";
  useEffect(() => {
    load();
    const t = setInterval(load, running ? 1500 : 8000);
    return () => clearInterval(t);
  }, [load, running]);

  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.slice(1) as Tab;
      if (["overview", "qualification", "evidence", "contact", "email"].includes(h)) setTab(h);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };

  const showEvidence = (ref: string) => {
    setFilter("all");
    go("evidence");
    setHighlight(ref);
    setTimeout(() => document.getElementById(`ev-${ref}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  async function act(body: Record<string, unknown>, okText: string) {
    setActionMsg(null);
    try {
      await postJson(`/api/companies/${id}/actions`, body);
      setActionMsg({ kind: "info", text: okText });
      setTimeout(load, 400);
    } catch (e) {
      setActionMsg({ kind: "bad", text: (e as Error).message });
    }
  }

  if (err) return <div className="shell"><p className="notice n-bad" style={{ marginTop: 24 }}>{err}</p><Link href="/">← Back</Link></div>;
  if (!d) return <div className="shell"><p className="empty">Loading…</p></div>;

  const c = d.company;
  const profile: CompanyProfile | null = c.profile;
  const lastQ = d.qualifications.at(-1);
  const q: (QualificationResult & { override_note?: string }) | null = lastQ ? { ...lastQ.result, override_note: lastQ.override_note } : null;
  const selected = d.contacts.find((x: any) => x.selected);
  const others = d.contacts.filter((x: any) => !x.selected);
  const email = d.email;
  const send = d.sends[0];
  const evidence: any[] = d.evidence;
  const isMock = c.data_source === "mock";
  const rounds: any[] = d.research?.rounds ?? [];
  const status = running ? "running" : c.current_status;
  const shown = evidence.filter((e) => filter === "all" || e.evidence_type === filter);
  const count = (t: string) => evidence.filter((e) => e.evidence_type === t).length;

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <Link href="/" className="sub">← All companies</Link>
          <div className="row" style={{ marginTop: 6 }}>
            <h1>{c.name ?? c.domain}</h1>
            <StatusBadge status={status} />
            <SourceBadge source={c.data_source} />
          </div>
          <div className="sub" style={{ marginTop: 2 }}>
            {isMock ? c.domain : <a href={`https://${c.domain}`} target="_blank" rel="noreferrer noopener">{c.domain} ↗</a>}
            <span className="faint"> · updated {fmt(c.updated_at)}</span>
          </div>
        </div>
        <div className="row">
          {!d.readOnly && (
            <>
              <button className="btn btn-sm" disabled={running} onClick={() => act({ action: "retry" }, "Re-running…")}>Re-run</button>
              {email && ["failed", "validated"].includes(email.status) && (
                <button
                  className="btn btn-sm"
                  disabled={running}
                  onClick={() => act({ action: "retry_send", confirmUnknownOutcome: send?.status === "outcome_unknown" ? confirm("Last send has an unknown outcome — check your inbox first. Send anyway?") : false }, "Send retried.")}
                >
                  Retry send
                </button>
              )}
            </>
          )}
          <ThemeToggle />
        </div>
      </header>

      {isMock && <div className="notice n-mock" style={{ marginBottom: 12 }}>Fictional demo company — not real research.</div>}
      {actionMsg && <div className={`notice ${actionMsg.kind === "bad" ? "n-bad" : "n-info"}`} style={{ marginBottom: 12 }}>{actionMsg.text}</div>}

      {/* Result banner: the whole story in one line */}
      <div className="hero">
        <div>
          <div className="k">ICP score</div>
          <div className="v">{q ? `${q.fit_score}/100` : "—"}</div>
          <div className="s">{q ? <StatusBadge status={q.decision} /> : "Not assessed"}</div>
        </div>
        <div>
          <div className="k">Decision-maker</div>
          <div className="v ellipsis">{selected?.name ?? "—"}</div>
          <div className="s ellipsis">{selected?.title ?? (q?.decision === "qualified" ? "Not found" : "Qualified companies only")}</div>
        </div>
        <div>
          <div className="k">Pain points</div>
          <div className="v">{d.painPoints.length || "—"}</div>
          <div className="s">{d.painPoints.length ? `${d.painPoints.filter((p: any) => p.type === "direct").length} evidenced · ${d.painPoints.filter((p: any) => p.type !== "direct").length} inferred` : "—"}</div>
        </div>
        <div>
          <div className="k">Email</div>
          <div className="v">{send ? <StatusBadge status={send.status} /> : email ? <StatusBadge status={email.status} /> : "—"}</div>
          <div className="s ellipsis">{send?.completed_at ? fmt(send.completed_at) : email ? `Validation: ${email.validation_status}` : "Not written"}</div>
        </div>
      </div>

      <nav className="tabs" role="tablist">
        {(
          [
            ["overview", "Overview", null],
            ["qualification", "Qualification", null],
            ["evidence", "Evidence", evidence.length],
            ["contact", "Contact", d.contacts.length || null],
            ["email", "Email", null],
          ] as [Tab, string, number | null][]
        ).map(([key, label, n]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " active" : ""}`} onClick={() => go(key)}>
            {label}
            {n ? <span className="count">{n}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="stack">
          <div className="why-grid">
            <Why q={q?.decision === "qualified" ? "Why qualified" : "Why not qualified"} a={q ? verdict(q) : "Not assessed yet."} full={q?.explanation} />
            <Why q="Why this person" a={selected?.reason ?? (q?.decision === "qualified" ? "No reliable contact found." : "Only qualified companies get a contact.")} />
            <Why q="Why these pain points" a={d.painPoints.length ? d.painPoints.map((p: any) => firstSentence(p.relevance)).join(" ") : "—"} full={d.painPoints.map((p: any) => p.relevance).join(" ")} />
            <Why q="Why this email" a={firstSentence(email?.personalisation?.personalisation_explanation) || "—"} full={email?.personalisation?.personalisation_explanation} />
          </div>
          <section className="panel">
            <div className="panel-head" style={{ marginBottom: 0 }}>
              <h3>Pipeline</h3>
              <span className="faint" style={{ fontSize: 12 }}>
                {d.llm?.calls ? `${d.llm.calls} AI calls` : ""}
                {d.run?.duration_ms ? ` · ${(d.run.duration_ms / 1000).toFixed(0)}s` : ""}
              </span>
            </div>
            <StageList stages={d.stages} />
            {d.run?.errors?.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary>Issues ({d.run.errors.length})</summary>
                <ul className="list-tight sub">{d.run.errors.map((e: any, i: number) => <li key={i}><b>{e.stage}:</b> {e.message}</li>)}</ul>
              </details>
            )}
          </section>
        </div>
      )}

      {tab === "qualification" && (
        <section className="panel">
          {q ? (
            <>
              <div className="panel-head">
                <div className="row"><span className="score" style={{ fontSize: 22 }}>{q.fit_score}/100</span><StatusBadge status={q.decision} /></div>
                <span className="faint">Confidence {Math.round(q.confidence * 100)}%</span>
              </div>
              <p style={{ margin: 0 }} title={q.explanation}>{verdict(q)}</p>
              {q.override_note && <div className="notice n-warn" style={{ marginTop: 10 }}>Approved by reviewer: {q.override_note}</div>}
              <Bar label="SaaS" value={q.score_breakdown.saas} max={SCORING_RUBRIC.saas.confirmed} level={q.saas_status} />
              <Bar label="Stage" value={q.score_breakdown.stage} max={SCORING_RUBRIC.stage.series_a_c} level={q.stage_status} extra={q.stage_label !== "Unknown" ? q.stage_label : undefined} />
              <Bar label="Audit intent" value={q.score_breakdown.audit} max={SCORING_RUBRIC.audit.active_or_planned} level={q.audit_trigger} />
              <Bar label="Enterprise pressure" value={q.score_breakdown.enterprise} max={SCORING_RUBRIC.enterprise.direct_requirement} level={q.enterprise_pressure} />
              <p className="faint" style={{ fontSize: 12, margin: "14px 0 0" }}>Qualifies when SaaS is confirmed and there is an audit or enterprise trigger. Stage only affects the score.</p>
              {q.evidence_ids?.length > 0 && <div style={{ marginTop: 8 }}><Refs ids={q.evidence_ids} onClick={showEvidence} /></div>}
              {q.adjustments?.length > 0 && (
                <div className="notice n-info" style={{ marginTop: 12 }}>
                  Downgraded for weak evidence:
                  <ul className="list-tight">{q.adjustments.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </div>
              )}
              {q.missing_information?.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary>Missing information ({q.missing_information.length})</summary>
                  <ul className="list-tight sub">{q.missing_information.map((m, i) => <li key={i}>{m}</li>)}</ul>
                </details>
              )}
              {rounds.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h3>Research loop</h3>
                  {rounds.map((r: any) => (
                    <div key={r.round} className="evidence-item">
                      <b>Round {r.round}</b> <span className="sub">· {r.scoreBefore} → {r.scoreAfter}{r.stopReason ? ` · ${r.stopReason}` : ""}</span>
                      <div className="meta">{r.action.urls.length ? r.action.urls.join(", ") : "No pages fetched"}</div>
                      {r.newEvidence.length > 0 && <div style={{ marginTop: 4 }}><Refs ids={r.newEvidence} onClick={showEvidence} /></div>}
                    </div>
                  ))}
                </div>
              )}
              {q.decision === "needs_review" && !running && !d.readOnly && <ApproveForm onSubmit={(note) => act({ action: "approve", note }, "Approved — finding a contact…")} />}
            </>
          ) : (
            <p className="sub" style={{ margin: 0 }}>Not assessed yet.</p>
          )}
        </section>
      )}

      {tab === "evidence" && (
        <div className="stack">
          {profile && (
            <section className="panel">
              <h3>Profile</h3>
              <dl className="kv" style={{ marginTop: 12 }}>
                <dt>About</dt><dd>{profile.description}</dd>
                <dt>Model</dt><dd>{profile.business_model} <Refs ids={profile.saas_evidence_ids} onClick={showEvidence} /></dd>
                <dt>Funding</dt><dd>{profile.funding_stage} <Refs ids={profile.funding_evidence_ids} onClick={showEvidence} /></dd>
                <dt>Size</dt><dd>{profile.company_size ?? "Unknown"}</dd>
                <dt>Customers</dt><dd>{profile.target_customer} <Refs ids={profile.enterprise_evidence_ids} onClick={showEvidence} /></dd>
                <dt>Audit</dt><dd><Signals s={profile.audit_signals} onRef={showEvidence} /></dd>
                <dt>Compliance</dt><dd><Signals s={profile.compliance_signals} onRef={showEvidence} /></dd>
                <dt>Security</dt><dd><Signals s={profile.security_signals} onRef={showEvidence} /></dd>
                <dt>Growth</dt><dd><Signals s={profile.growth_signals} onRef={showEvidence} /></dd>
                {profile.unknowns.length > 0 && <><dt>Unknown</dt><dd className="sub">{profile.unknowns.join(" · ")}</dd></>}
              </dl>
            </section>
          )}
          <section className="panel">
            <div className="panel-head">
              <h3>Sources & evidence</h3>
              <div className="filters">
                {(["all", "observed", "inference", "unknown"] as const).map((f) => (
                  <button key={f} className={`filter${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
                    {f === "all" ? `All ${evidence.length}` : f === "observed" ? `Facts ${count("observed")}` : f === "inference" ? `Inferences ${count("inference")}` : `Unknowns ${count("unknown")}`}
                  </button>
                ))}
              </div>
            </div>
            {shown.length === 0 && <p className="sub">Nothing here.</p>}
            {shown.map((e) => (
              <div key={e.ref} id={`ev-${e.ref}`} className={`evidence-item ${e.evidence_type}${highlight === e.ref ? " hl" : ""}`}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="ref">{e.ref}</span>
                  <span className="sub">{e.category}</span>
                </div>
                <div className="quote">{e.evidence_type === "observed" ? `“${e.supporting_text}”` : e.claim}</div>
                <div className="meta">
                  {e.source_url && e.data_source !== "mock" && /^https?:/.test(e.source_url) ? <a href={e.source_url} target="_blank" rel="noreferrer noopener">{e.source_url}</a> : e.source_url ?? "No source"}
                  {e.retrieved_at ? ` · ${fmt(e.retrieved_at)}` : ""}
                </div>
              </div>
            ))}
            {d.pages.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary>Pages read ({d.pages.length})</summary>
                <ul className="list-tight sub">{d.pages.map((pg: any) => <li key={pg.id} className="ellipsis">{pg.url}</li>)}</ul>
              </details>
            )}
          </section>
        </div>
      )}

      {tab === "contact" && (
        <section className="panel">
          {selected ? (
            <>
              <div className="person">
                <div className="avatar">{initials(selected.name)}</div>
                <div>
                  <div className="row" style={{ gap: 6 }}><b style={{ fontSize: 16 }}>{selected.name}</b>{selected.data_source === "mock" && <span className="badge b-mock">Mock</span>}</div>
                  <div className="sub">{selected.title}{selected.department ? ` · ${selected.department}` : ""}</div>
                </div>
                <span className="spacer" />
                <span className="badge b-mute">{Math.round(selected.confidence * 100)}% confidence</span>
              </div>
              <p style={{ margin: "14px 0 0" }}>{selected.reason}</p>
              <dl className="kv" style={{ marginTop: 14 }}>
                <dt>Source</dt><dd>{selected.provider === "hunter" ? "Hunter.io" : selected.provider === "manual" ? "Entered manually" : "Mock"} <Refs ids={JSON.parse(selected.evidence_ids_json || "[]")} onClick={showEvidence} /></dd>
                <dt>Email (not used)</dt><dd>{selected.business_email ?? "—"}{selected.verification_status ? <span className="faint"> · {selected.verification_status}</span> : null}</dd>
              </dl>
            </>
          ) : (
            <p className="sub" style={{ margin: 0 }}>{q?.decision === "qualified" ? "No reliable decision-maker found." : "Only qualified companies get a contact."}</p>
          )}
          {others.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary>Other people ranked ({others.length})</summary>
              <div className="table-wrap" style={{ margin: "8px 0 0" }}>
                <table>
                  <thead><tr><th>Name</th><th>Title</th><th>Score</th><th>Eligible</th></tr></thead>
                  <tbody>{others.map((x: any) => <tr key={x.id} title={x.reason ?? undefined}><td>{x.name ?? "—"}</td><td>{x.title ?? "—"}</td><td>{x.rank_score ?? "—"}</td><td>{x.eligible ? "Yes" : "No"}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          )}
          {!running && !d.readOnly && (q?.decision === "qualified" || c.current_status === "contact_not_found") && (
            <div className="row" style={{ marginTop: 14 }}>
              {c.current_status === "contact_not_found" && q?.decision === "qualified" && (
                <button className="btn btn-sm" onClick={() => act({ action: "resume" }, "Searching again…")}>Search again</button>
              )}
              <ManualContact domain={c.domain} onSubmit={(b) => act({ action: "manual_contact", ...b }, "Saved — continuing…")} />
            </div>
          )}
        </section>
      )}

      {tab === "email" && (
        <div className="stack">
          {d.painPoints.length > 0 && (
            <div className="why-grid">
              {d.painPoints.map((p: any) => (
                <div key={p.id} className="why">
                  <div className="row" style={{ marginBottom: 4 }}>
                    <span className="q" style={{ margin: 0 }}>Pain point {p.position}</span>
                    <span className={`badge ${p.type === "direct" ? "b-ok" : "b-warn"}`}>{p.type === "direct" ? "Evidenced" : "Inferred"}</span>
                  </div>
                  <div>{p.statement}</div>
                  <div style={{ marginTop: 6 }}><Refs ids={p.evidence_ids} onClick={showEvidence} /></div>
                </div>
              ))}
            </div>
          )}
          {email ? (
            <div className="mail">
              <div className="mail-head">
                <div className="avatar">S</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <b>{email.personalisation?.prospect_name ? `To ${email.personalisation.prospect_name}` : "Draft"}</b>
                    <span className="faint">· {email.personalisation?.prospect_role}</span>
                  </div>
                  <div className="mail-meta ellipsis">Delivered to {send?.delivery_recipient ?? "your inbox"} · never to the prospect</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <StatusBadge status={send?.status ?? email.status} />
                </div>
              </div>
              <div className="mail-subject">{email.subject}</div>
              <div className="mail-body">{email.body}</div>
            </div>
          ) : (
            <section className="panel"><p className="sub" style={{ margin: 0 }}>No email yet.</p></section>
          )}
          {email && (
            <section className="panel">
              <dl className="kv">
                <dt>Hook</dt><dd>{email.personalisation?.personalisation_hook}</dd>
                <dt>Pain point</dt><dd>{email.personalisation?.pain_point_used}</dd>
                <dt>Evidence</dt><dd><Refs ids={email.evidence_ids} onClick={showEvidence} /></dd>
                <dt>Validation</dt><dd>{email.validation_status} · {email.attempts} attempt{email.attempts > 1 ? "s" : ""}</dd>
                {send && (
                  <>
                    <dt>Delivery</dt>
                    <dd>
                      <StatusBadge status={send.status} /> <span className="faint">{fmt(send.completed_at ?? send.attempted_at)}</span>
                      {send.gmail_message_id && <div className="mono faint" style={{ marginTop: 2 }}>{send.gmail_message_id}</div>}
                      {send.error && <div style={{ color: "var(--bad)", marginTop: 2 }}>{send.error}</div>}
                    </dd>
                  </>
                )}
              </dl>
              {(email.validation?.attempts ?? []).length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary>Validation log</summary>
                  {(email.validation?.attempts ?? []).map((a: any) => (
                    <div key={a.attempt} className="evidence-item">
                      <b>Attempt {a.attempt}: {a.verdict}</b>
                      {a.deterministic.length > 0 && <div className="meta">{a.deterministic.join("; ")}</div>}
                      {a.critic?.issues?.length > 0 && <div className="meta">{a.critic.issues.join("; ")}</div>}
                    </div>
                  ))}
                </details>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Why({ q, a, full }: { q: string; a: string; full?: string }) {
  return (
    <div className="why" title={full && full !== a ? full : undefined}>
      <div className="q">{q}</div>
      <div className="clamp3">{a}</div>
    </div>
  );
}

function Signals({ s, onRef }: { s: { summary: string; evidence_ids: string[] }[]; onRef: (r: string) => void }) {
  if (!s?.length) return <span className="faint">None</span>;
  return <ul className="list-tight" style={{ marginTop: 0 }}>{s.map((x, i) => <li key={i}>{x.summary} <Refs ids={x.evidence_ids} onClick={onRef} /></li>)}</ul>;
}

function Bar({ label, value, max, level, extra }: { label: string; value: number; max: number; level: string; extra?: string }) {
  return (
    <div className="bar">
      <span>{label}</span>
      <div className="track"><div className="fill" style={{ width: `${(value / max) * 100}%` }} /></div>
      <span className="score">{value}/{max}</span>
      <span />
      <span className="lvl">{LEVEL[level] ?? level}{extra ? ` (${extra})` : ""}</span>
    </div>
  );
}

function ApproveForm({ onSubmit }: { onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="why" style={{ marginTop: 16 }}>
      <div className="q">Approve manually</div>
      <div className="row">
        <input type="text" placeholder="Why it qualifies (e.g. confirmed SOC 2 need on a call)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <button className="btn btn-sm" disabled={note.trim().length < 5} onClick={() => onSubmit(note)}>Approve</button>
      </div>
    </div>
  );
}

function ManualContact({ domain, onSubmit }: { domain: string; onSubmit: (b: { name: string; title: string; email?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", title: "", email: "" });
  if (!open) return <button className="btn btn-sm" onClick={() => setOpen(true)}>Add contact</button>;
  return (
    <div className="why" style={{ flexBasis: "100%" }}>
      <div className="grid-2b">
        <div><label className="field">Name</label><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="field">Title</label><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
      </div>
      <label className="field">Email (optional, @{domain})</label>
      <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-sm btn-primary" disabled={f.name.trim().length < 2 || f.title.trim().length < 2} onClick={() => onSubmit({ name: f.name, title: f.title, email: f.email || undefined })}>Save</button>
        <button className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
