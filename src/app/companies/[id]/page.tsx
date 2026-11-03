"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Refs, SourceBadge, StageList, StatusBadge, postJson } from "@/components/ui";
import { SCORING_RUBRIC } from "@/lib/config";
import type { CompanyProfile, QualificationResult } from "@/lib/schemas";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = any;

const LEVEL_TEXT: Record<string, string> = {
  confirmed: "Confirmed SaaS",
  likely: "Likely SaaS (inferred)",
  not_saas: "Not SaaS",
  unknown: "Unknown",
  series_a_c: "Verified Series A–C",
  growth_indicators: "Growth indicators (stage unverified)",
  other_verified: "Other verified stage",
  active_or_planned: "Active / planned certification or audit",
  initiative_timing_uncertain: "Compliance initiative, timing uncertain",
  already_certified: "Already certified",
  generic_material: "Generic security/compliance material",
  none: "No evidence",
  direct_requirement: "Customers require certification",
  security_reviews: "Security questionnaires / reviews",
  enterprise_positioning: "Enterprise positioning only",
};

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");

export default function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ kind: "info" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${id}`, { cache: "no-store" });
    if (!res.ok) return setErr(res.status === 404 ? "Company not found" : `HTTP ${res.status}`);
    setD(await res.json());
  }, [id]);

  const running = d?.run?.status === "running" || d?.run?.status === "queued";
  useEffect(() => {
    load();
    const t = setInterval(load, running ? 1500 : 8000);
    return () => clearInterval(t);
  }, [load, running]);

  const showEvidence = (ref: string) => {
    setHighlight(ref);
    document.getElementById(`ev-${ref}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
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

  if (err) return <div className="shell"><p className="notice n-bad" style={{ marginTop: 24 }}>{err}</p><Link href="/">← Dashboard</Link></div>;
  if (!d) return <div className="shell"><p className="empty">Loading…</p></div>;

  const c = d.company;
  const profile: CompanyProfile | null = c.profile;
  const q: (QualificationResult & { override_note?: string }) | null = d.qualifications.length ? { ...d.qualifications.at(-1).result, override_note: d.qualifications.at(-1).override_note } : null;
  const selected = d.contacts.find((x: any) => x.selected);
  const email = d.email;
  const send = d.sends[0];
  const evidence: any[] = d.evidence;
  const isMock = c.data_source === "mock";
  const rounds: any[] = d.research?.rounds ?? [];

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <Link href="/" className="sub">← Dashboard</Link>
          <div className="row" style={{ marginTop: 4 }}>
            <h1>{c.name ?? c.domain}</h1>
            <StatusBadge status={running ? "running" : c.current_status} />
            <SourceBadge source={c.data_source} />
          </div>
          <div className="sub">
            {isMock ? c.domain : <a href={`https://${c.domain}`} target="_blank" rel="noreferrer noopener">{c.domain} ↗</a>} · last updated {fmt(c.updated_at)}
          </div>
        </div>
        {!d.readOnly && <div className="row">
          <button className="btn btn-sm" disabled={running} onClick={() => act({ action: "retry" }, "Re-running the full pipeline…")}>Re-run pipeline</button>
          {email && ["failed", "validated"].includes(email.status) && (
            <button className="btn btn-sm" disabled={running} onClick={() => act({ action: "retry_send", confirmUnknownOutcome: send?.status === "outcome_unknown" ? confirm("The last send attempt has an UNKNOWN outcome. Check your inbox first. Send again anyway?") : false }, "Send retried")}>
              Retry send
            </button>
          )}
        </div>}
      </header>

      {isMock && <div className="notice n-mock" style={{ marginBottom: 12 }}><b>MOCK DATA.</b> This company, its website, people and analysis come from mock providers. Nothing here is real research.</div>}
      {actionMsg && <div className={`notice ${actionMsg.kind === "bad" ? "n-bad" : "n-info"}`} style={{ marginBottom: 12 }}>{actionMsg.text}</div>}

      <div className="grid-2">
        <section className="panel">
          <h2>Pipeline</h2>
          <StageList stages={d.stages} />
          {d.run?.errors?.length > 0 && (
            <div className="notice n-warn" style={{ marginTop: 10 }}>
              <b>Issues recorded</b>
              <ul className="list-tight">
                {d.run.errors.map((e: any, i: number) => <li key={i}><b>{e.stage}:</b> {e.message}</li>)}
              </ul>
            </div>
          )}
          <p className="sub" style={{ marginBottom: 0 }}>
            Providers: {Object.entries(d.run?.providers ?? {}).map(([k, v]) => `${k}=${v}`).join(" · ") || "—"}
            {d.llm && d.llm.calls > 0 && <> · {d.llm.calls} model calls{d.llm.cost > 0 ? ` (est. $${Number(d.llm.cost).toFixed(3)})` : ""}</>}
            {d.run?.duration_ms ? ` · ${(d.run.duration_ms / 1000).toFixed(1)}s` : ""}
          </p>
        </section>

        <section className="panel">
          <h2>Why — decision summary</h2>
          <div className="why"><b>Why did this company {q?.decision === "qualified" ? "qualify" : "get this result"}?</b>{q ? q.explanation : "Not assessed yet."}</div>
          <div className="why"><b>Why this person?</b>{selected?.reason ?? (q?.decision === "qualified" ? "No reliable contact selected yet." : "Contact discovery only runs for qualified companies.")}</div>
          <div className="why"><b>Why these pain points?</b>{d.painPoints.length ? d.painPoints.map((p: any) => `${p.type === "direct" ? "Directly evidenced" : "Inferred"}: ${p.relevance}`).join(" ") : "—"}</div>
          <div className="why"><b>Why this email?</b>{email?.personalisation?.personalisation_explanation ?? "—"}</div>
        </section>
      </div>

      {/* A — Company profile */}
      <section className="panel" style={{ marginTop: 16 }}>
        <h3>A · Company profile</h3>
        {profile ? (
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Company</dt><dd>{profile.company_name}</dd>
            <dt>Description</dt><dd>{profile.description}</dd>
            <dt>Business model</dt><dd>{profile.business_model} <Refs ids={profile.saas_evidence_ids} onClick={showEvidence} /></dd>
            <dt>SaaS fit</dt><dd>{profile.is_saas}</dd>
            <dt>Funding stage</dt><dd>{profile.funding_stage} <Refs ids={profile.funding_evidence_ids} onClick={showEvidence} /></dd>
            <dt>Company size</dt><dd>{profile.company_size ?? "Unknown"}</dd>
            <dt>Target customer</dt><dd>{profile.target_customer}</dd>
            <dt>Enterprise positioning</dt><dd>{profile.enterprise_focus} <Refs ids={profile.enterprise_evidence_ids} onClick={showEvidence} /></dd>
            <dt>Audit signals</dt><dd><Signals s={profile.audit_signals} onRef={showEvidence} /></dd>
            <dt>Compliance signals</dt><dd><Signals s={profile.compliance_signals} onRef={showEvidence} /></dd>
            <dt>Security signals</dt><dd><Signals s={profile.security_signals} onRef={showEvidence} /></dd>
            <dt>Growth signals</dt><dd><Signals s={profile.growth_signals} onRef={showEvidence} /></dd>
            <dt>Unknowns</dt><dd>{profile.unknowns.length ? profile.unknowns.join("; ") : "None"}</dd>
            {profile.contradictions?.length > 0 && <><dt>Contradictions</dt><dd>{profile.contradictions.join("; ")}</dd></>}
          </dl>
        ) : <p className="sub">Not extracted yet.</p>}
      </section>

      {/* B — Qualification */}
      <section className="panel">
        <div className="panel-head">
          <h3>B · ICP qualification</h3>
          {q && <div className="row"><StatusBadge status={q.decision} /><span className="score" style={{ fontSize: 20 }}>{q.fit_score}/100</span><span className="sub">confidence {Math.round(q.confidence * 100)}%</span></div>}
        </div>
        {q ? (
          <>
            <p style={{ marginTop: 0 }}>{q.explanation}</p>
            {q.override_note && <div className="notice n-warn">Manually approved by reviewer: {q.override_note}</div>}
            <ScoreBar label="SaaS fit" value={q.score_breakdown.saas} max={SCORING_RUBRIC.saas.confirmed} level={q.saas_status} />
            <ScoreBar label="Company stage" value={q.score_breakdown.stage} max={SCORING_RUBRIC.stage.series_a_c} level={q.stage_status} extra={q.stage_label !== "Unknown" ? q.stage_label : undefined} />
            <ScoreBar label="Audit / compliance intent" value={q.score_breakdown.audit} max={SCORING_RUBRIC.audit.active_or_planned} level={q.audit_trigger} />
            <ScoreBar label="Enterprise pressure" value={q.score_breakdown.enterprise} max={SCORING_RUBRIC.enterprise.direct_requirement} level={q.enterprise_pressure} />
            <p className="sub">
              Rule: <b>Qualified</b> = confirmed SaaS <b>and</b> (audit/certification preparation <b>or</b> enterprise certification pressure). Funding stage affects the score only. The score never overrides this rule.
            </p>
            <div className="sub">Supporting evidence: <Refs ids={q.evidence_ids} onClick={showEvidence} /></div>
            {q.adjustments?.length > 0 && <div className="notice n-info" style={{ marginTop: 8 }}><b>Evidence checks downgraded the model&apos;s classification:</b><ul className="list-tight">{q.adjustments.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
            {q.missing_information?.length > 0 && <><h3 style={{ marginTop: 12 }}>Missing information</h3><ul className="list-tight">{q.missing_information.map((m, i) => <li key={i}>{m}</li>)}</ul></>}
            {rounds.length > 0 && (
              <div className="section">
                <h3>Research loop</h3>
                {rounds.map((r: any) => (
                  <div key={r.round} className="evidence-item">
                    <b>Round {r.round}</b> · {r.decisionBefore} ({r.scoreBefore}) → {r.decisionAfter} ({r.scoreAfter}){r.stopReason ? ` · stopped: ${r.stopReason}` : ""}
                    <div className="meta">Gaps: {r.gaps.join(" | ")}</div>
                    <div className="meta">Action: {r.action.urls.length ? `fetched ${r.action.urls.join(", ")}` : "no pages fetched"}{r.action.searchQueries.length ? ` · searched: ${r.action.searchQueries.join("; ")}` : ""}</div>
                    <div className="meta">New evidence: {r.newEvidence.length ? <Refs ids={r.newEvidence} onClick={showEvidence} /> : "none"}</div>
                  </div>
                ))}
              </div>
            )}
            {q.decision === "needs_review" && !running && !d.readOnly && (
              <ApproveForm onSubmit={(note) => act({ action: "approve", note }, "Approved — resuming from contact discovery…")} />
            )}
          </>
        ) : <p className="sub">Not qualified yet.</p>}
      </section>

      {/* C — Evidence */}
      <section className="panel">
        <div className="panel-head">
          <h3>C · Research evidence</h3>
          <span className="sub">{d.pages.length} sources · {evidence.filter((e) => e.evidence_type === "observed").length} observed facts · {evidence.filter((e) => e.evidence_type === "inference").length} inferences · {evidence.filter((e) => e.evidence_type === "unknown").length} unknowns{d.research?.reused_from ? " · reused from cache" : ""}</span>
        </div>
        {evidence.length === 0 && <p className="sub">No evidence collected.</p>}
        {evidence.map((e) => (
          <div key={e.ref} id={`ev-${e.ref}`} className={`evidence-item ${e.evidence_type}`} style={highlight === e.ref ? { outline: "2px solid var(--accent)" } : undefined}>
            <div><span className="ref">{e.ref}</span><span className={`badge ${e.evidence_type === "observed" ? "b-ok" : e.evidence_type === "inference" ? "b-warn" : "b-mute"}`}>{e.evidence_type === "observed" ? "Observed fact" : e.evidence_type === "inference" ? "Inference" : "Unknown"}</span> {e.claim}</div>
            {e.evidence_type === "observed" && <div className="quote">“{e.supporting_text}”</div>}
            {e.evidence_type !== "observed" && <div className="meta">{e.supporting_text}</div>}
            <div className="meta">
              {e.source_url ? (e.data_source === "mock" || !/^https?:/.test(e.source_url) ? e.source_url : <a href={e.source_url} target="_blank" rel="noreferrer noopener">{e.source_url}</a>) : "no source"}
              {" · "}{e.category} · retrieved {fmt(e.retrieved_at)}{e.published_at ? ` · published ${e.published_at}` : ""} · {e.source_type}{e.data_source === "mock" ? " · MOCK" : ""}
            </div>
          </div>
        ))}
        {d.pages.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="sub">Pages read ({d.pages.length})</summary>
            <ul className="list-tight sub">{d.pages.map((pg: any) => <li key={pg.id}>round {pg.round} · {pg.source_type} · {pg.url} · {pg.chars} chars</li>)}</ul>
          </details>
        )}
      </section>

      {/* D — Decision-maker */}
      <section className="panel">
        <h3>D · Decision-maker</h3>
        {selected ? (
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Name</dt><dd><b>{selected.name}</b> {selected.data_source === "mock" && <span className="badge b-mock">MOCK PERSON</span>}</dd>
            <dt>Role</dt><dd>{selected.title}</dd>
            <dt>Department</dt><dd>{selected.department ?? "—"}</dd>
            <dt>Business email (metadata)</dt><dd>{selected.business_email ?? "—"} <span className="sub">— stored only; never used as a recipient</span></dd>
            <dt>Verification</dt><dd>{selected.verification_status ?? "not reported"}</dd>
            <dt>Confidence</dt><dd>{Math.round(selected.confidence * 100)}%</dd>
            <dt>Source</dt><dd>{selected.provider === "hunter" ? "Hunter.io Domain Search" : selected.provider === "manual" ? "Manual entry" : "Mock provider"} <Refs ids={JSON.parse(selected.evidence_ids_json || "[]")} onClick={showEvidence} /></dd>
            <dt>Why selected</dt><dd>{selected.reason}</dd>
          </dl>
        ) : <p className="sub">{q?.decision === "qualified" ? "No reliable decision-maker found." : "Only searched for qualified companies."}</p>}
        {d.contacts.filter((x: any) => !x.selected).length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary className="sub">Other ranked contacts ({d.contacts.filter((x: any) => !x.selected).length})</summary>
            <table style={{ marginTop: 6 }}>
              <thead><tr><th>#</th><th>Name</th><th>Title</th><th>Category</th><th>Score</th><th>Eligible</th><th>Notes</th></tr></thead>
              <tbody>{d.contacts.filter((x: any) => !x.selected).map((x: any) => <tr key={x.id}><td>{x.rank}</td><td>{x.name ?? "—"}</td><td>{x.title ?? "—"}</td><td>{x.role_category ?? "—"}</td><td>{x.rank_score ?? "—"}</td><td>{x.eligible ? "yes" : "no"}</td><td className="sub">{x.reason}</td></tr>)}</tbody>
            </table>
          </details>
        )}
        {c.current_status === "contact_not_found" && q?.decision === "qualified" && !running && !d.readOnly && (
          <button className="btn btn-sm" style={{ marginTop: 10, marginRight: 8 }} onClick={() => act({ action: "resume" }, "Resuming from contact discovery…")}>
            Retry contact discovery
          </button>
        )}
        {(q?.decision === "qualified" || c.current_status === "contact_not_found") && !running && !d.readOnly && <ManualContact domain={c.domain} onSubmit={(b) => act({ action: "manual_contact", ...b }, "Contact saved — resuming from contact stage…")} />}
      </section>

      {/* E — Pain points */}
      <section className="panel">
        <h3>E · Two pain points</h3>
        {d.painPoints.length ? (
          <div className="grid-2b" style={{ marginTop: 10 }}>
            {d.painPoints.map((p: any) => (
              <div key={p.id} className="why" style={{ marginTop: 0 }}>
                <div className="row"><b style={{ margin: 0 }}>Pain point {p.position}</b><span className={`badge ${p.type === "direct" ? "b-ok" : "b-warn"}`}>{p.type === "direct" ? "Directly evidenced" : "Inferred"}</span><span className="sub">confidence {Math.round(p.confidence * 100)}%</span></div>
                <p style={{ margin: "6px 0" }}>{p.statement}</p>
                <div className="sub"><b style={{ display: "inline" }}>Why it matters to {selected?.name?.split(" ")[0] ?? "them"}:</b> {p.relevance}</div>
                <div style={{ marginTop: 4 }}><Refs ids={p.evidence_ids} onClick={showEvidence} /></div>
              </div>
            ))}
          </div>
        ) : <p className="sub">Not generated.</p>}
      </section>

      {/* F — Email */}
      <section className="panel">
        <div className="panel-head">
          <h3>F · Personalised email</h3>
          {email && <div className="row"><StatusBadge status={email.status} /><span className="badge b-mute">Validation: {email.validation_status}</span><span className="sub">{email.attempts} attempt{email.attempts > 1 ? "s" : ""}</span></div>}
        </div>
        {email ? (
          <>
            <div className="grid-2b">
              <div className="notice n-info"><b>Prospect (contact metadata only):</b> {selected?.name} · {selected?.title}{selected?.business_email ? ` · ${selected.business_email}` : ""}</div>
              <div className="notice n-warn"><b>Delivery recipient:</b> your own inbox only — {send?.delivery_recipient ?? "DEMO_INBOX_EMAIL"}. The prospect is never in To, Cc or Bcc.</div>
            </div>
            <div className="email-preview" style={{ marginTop: 10 }}>
              <div className="hdr">
                <div><span className="sub">To:</span> {send?.delivery_recipient ?? "(your inbox)"}</div>
                <div><span className="sub">Addressed to:</span> {email.personalisation?.prospect_name} ({email.personalisation?.prospect_role})</div>
                <div><span className="sub">Subject:</span> <b>{email.subject}</b></div>
              </div>
              <div className="body">{email.body}</div>
            </div>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Personalisation hook</dt><dd>{email.personalisation?.personalisation_hook}</dd>
              <dt>Pain point used</dt><dd>{email.personalisation?.pain_point_used}</dd>
              <dt>How Sprinto relates</dt><dd>{email.personalisation?.sprinto_connection}</dd>
              <dt>Supporting evidence</dt><dd><Refs ids={email.evidence_ids} onClick={showEvidence} /></dd>
            </dl>
            <details style={{ marginTop: 10 }}>
              <summary className="sub">Validation log</summary>
              {(email.validation?.attempts ?? []).map((a: any) => (
                <div key={a.attempt} className="evidence-item">
                  <b>Attempt {a.attempt}: {a.verdict}</b>
                  {a.deterministic.length > 0 && <div className="meta">Rule checks failed: {a.deterministic.join("; ")}</div>}
                  {a.critic && <div className="meta">Critic: {a.critic.verdict}{a.critic.issues.length ? ` — ${a.critic.issues.join("; ")}` : ""}</div>}
                </div>
              ))}
            </details>
          </>
        ) : <p className="sub">No email generated.</p>}
      </section>

      {/* G — Delivery */}
      <section className="panel">
        <h3>G · Delivery status</h3>
        {send ? (
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Status</dt><dd><StatusBadge status={send.status} />{send.status === "simulated" && <span className="sub"> — no email was sent (Gmail not connected)</span>}</dd>
            <dt>Delivered to</dt><dd>{send.delivery_recipient}</dd>
            <dt>Provider</dt><dd>{send.provider}</dd>
            <dt>Gmail message id</dt><dd className="mono">{send.gmail_message_id ?? "—"}</dd>
            <dt>Timestamp</dt><dd>{fmt(send.completed_at ?? send.attempted_at)}</dd>
            {send.error && <><dt>Error</dt><dd style={{ color: "var(--bad)" }}>{send.error}</dd></>}
          </dl>
        ) : <p className="sub">Not sent.</p>}
      </section>
    </div>
  );
}

function Signals({ s, onRef }: { s: { summary: string; evidence_ids: string[] }[]; onRef: (r: string) => void }) {
  if (!s?.length) return <span className="sub">None found</span>;
  return <ul className="list-tight" style={{ marginTop: 0 }}>{s.map((x, i) => <li key={i}>{x.summary} <Refs ids={x.evidence_ids} onClick={onRef} /></li>)}</ul>;
}

function ScoreBar({ label, value, max, level, extra }: { label: string; value: number; max: number; level: string; extra?: string }) {
  return (
    <div className="scorebar">
      <span>{label}</span>
      <div className="track"><div className="fill" style={{ width: `${(value / max) * 100}%` }} /></div>
      <span className="score">{value}/{max}</span>
      <span />
      <span className="sub" style={{ gridColumn: "2 / 4", marginTop: -4 }}>{LEVEL_TEXT[level] ?? level}{extra ? ` (${extra})` : ""}</span>
    </div>
  );
}

function ApproveForm({ onSubmit }: { onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="why">
      <b>Human review</b>
      <p className="sub" style={{ margin: "2px 0 6px" }}>If you have verified a buying trigger yourself, approve to continue to contact discovery. Your note is stored with the decision.</p>
      <div className="row">
        <input type="text" placeholder="e.g. Confirmed on a call that they need SOC 2 for an enterprise deal" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <button className="btn btn-sm" disabled={note.trim().length < 5} onClick={() => onSubmit(note)}>Approve &amp; continue</button>
      </div>
    </div>
  );
}

function ManualContact({ domain, onSubmit }: { domain: string; onSubmit: (b: { name: string; title: string; email?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", title: "", email: "" });
  if (!open) return <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>Enter contact manually (e.g. from Apollo)</button>;
  return (
    <div className="why">
      <b>Manual contact</b>
      <div className="grid-2b">
        <div><label className="field">Full name</label><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="field">Job title</label><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
      </div>
      <label className="field">Business email (optional, @{domain}) — stored as metadata only</label>
      <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-sm btn-primary" disabled={f.name.trim().length < 2 || f.title.trim().length < 2} onClick={() => onSubmit({ name: f.name, title: f.title, email: f.email || undefined })}>Save &amp; continue</button>
        <button className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
