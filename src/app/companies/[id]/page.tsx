"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import gsap from "gsap";
import { Fill, Reveal, reducedMotion } from "@/components/motion";
import { Refs, SourceBadge, StageList, StatusBadge, ThemeToggle, postJson } from "@/components/ui";
import type { CompanyProfile, QualificationResult } from "@/lib/schemas";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = any;
type Tab = "overview" | "qualification" | "evidence" | "contact" | "email";


const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
/** First sentence only — the full text stays available on hover. */
const firstSentence = (s?: string | null) => {
  const first = (s ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
  const clause = first.split(/;\s+/)[0];
  return clause === first ? first : `${clause}.`;
};

const TRIGGER: Record<string, string> = {
  active_or_planned: "preparing for an audit",
  already_certified: "already certified (renewals & new frameworks)",
  initiative_timing_uncertain: "working on compliance",
  direct_requirement: "customers require certification",
  security_reviews: "facing security reviews",
};

/** One-line verdict built from the stored classification (consistent for old and new runs). */
function verdict(q: QualificationResult & { override_note?: string }): string {
  if (q.override_note) return `Approved by reviewer: ${q.override_note}`;
  if (q.categories) return q.explanation; // new rubric: already a one-line, evidence-based verdict
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
  // Tab content slides in on every switch.
  useEffect(() => {
    if (reducedMotion()) return;
    const els = document.querySelectorAll(".tab-pane > *");
    if (els.length) gsap.fromTo(els, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.45, ease: "power3.out", stagger: 0.04, clearProps: "transform,opacity,visibility" });
  }, [tab]);
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
  // Contact/email shown while the latest decision isn't "qualified" come from an earlier run.
  const earlier = q?.decision !== "qualified" && Boolean(selected || email);
  const shown = evidence.filter((e) => filter === "all" || e.evidence_type === filter);
  const count = (t: string) => evidence.filter((e) => e.evidence_type === t).length;

  return (
    <Reveal ready={Boolean(d)} className="shell">
      <header className="topbar" data-reveal>
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
      <div className="hero" data-reveal>
        <div>
          <div className="k">ICP score</div>
          <div className="v">{q ? `${q.fit_score}/100` : "—"}</div>
          <div className="s">{q ? <StatusBadge status={q.decision} /> : "Not assessed"}</div>
        </div>
        <div>
          <div className="k">Decision-maker</div>
          <div className="v ellipsis">{selected?.name ?? "—"}</div>
          <div className="s ellipsis">{selected ? `${selected.title}${earlier ? " · earlier run" : ""}` : q?.decision === "qualified" ? "Not found" : "Qualified companies only"}</div>
        </div>
        <div>
          <div className="k">Pain points</div>
          <div className="v">{d.painPoints.length || "—"}</div>
          <div className="s">{d.painPoints.length ? (d.painPoints.some((p: any) => p.type === "direct") ? `${d.painPoints.filter((p: any) => p.type === "direct").length} backed by quotes` : "From role and company profile") : "Qualified companies only"}</div>
        </div>
        <div>
          <div className="k">Email</div>
          <div className="v">{send ? (earlier ? <span className="badge b-mute">Sent earlier</span> : <StatusBadge status={send.status} />) : email ? <StatusBadge status={email.status} /> : "—"}</div>
          <div className="s ellipsis">{send?.completed_at ? (earlier ? "Under earlier scoring" : fmt(send.completed_at)) : email ? `Validation: ${email.validation_status}` : "Not written"}</div>
        </div>
      </div>

      <nav className="tabs" role="tablist" data-reveal>
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

      <div className="tab-pane" key={tab}>
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
                <div className="row">
                  <span className="faint">Confidence {Math.round(q.confidence * 100)}%</span>
                  {q.categories && <a className="btn btn-sm" href={`/api/companies/${id}/qualification`} target="_blank" rel="noreferrer">JSON</a>}
                </div>
              </div>
              <p style={{ margin: 0 }} title={q.explanation}>{verdict(q)}</p>
              {q.override_note && <div className="notice n-warn" style={{ marginTop: 10 }}>Approved by reviewer: {q.override_note}</div>}
              {(q.disqualification_reasons?.length ?? 0) > 0 && (
                <div className="notice n-bad" style={{ marginTop: 10 }}>
                  {q.flags?.includes("ALREADY_CERTIFIED") && <b>ALREADY_CERTIFIED · </b>}
                  {q.disqualification_reasons!.join(" · ")}
                </div>
              )}
              {q.recommended_next_action && <p className="sub" style={{ margin: "10px 0 0" }}>Next: {q.recommended_next_action}</p>}

              {q.categories ? (
                <div style={{ marginTop: 16 }}>
                  {(["business_model_fit", "growth_stage", "compliance_buying_signals", "enterprise_readiness"] as const).map((k) => {
                    const cat = q.categories[k];
                    return (
                      <div key={k} className="rubric-cat">
                        <div className="rubric-head">
                          <b>{cat.label}</b>
                          <span className="spacer" />
                          <div className="track"><Fill pct={(cat.score / cat.max) * 100} /></div>
                          <span className="score">{cat.score}/{cat.max}</span>
                        </div>
                        {cat.criteria.map((cr) => (
                          <div key={cr.id} className="crit">
                            <span>{cr.criterion}</span>
                            <span className="pts">{cr.points}/{cr.max_points}</span>
                            <span className={`badge st st-${cr.status}`}>{cr.status === "NOT_FOUND" ? "Not found" : cr.status === "FOUND" ? "Found" : "Unknown"}</span>
                            {cr.evidence[0] && (
                              <div className="ev">
                                <span className="ref" onClick={() => showEvidence(cr.evidence[0].ref)}>{cr.evidence[0].ref}</span>
                                “{cr.evidence[0].text.replace(/^The page states:\s*/i, "").slice(0, 220)}”
                                {cr.evidence[0].source_url && /^https?:/.test(cr.evidence[0].source_url) && !isMock && (
                                  <> · <a href={cr.evidence[0].source_url} target="_blank" rel="noreferrer noopener">source</a></>
                                )}
                                {cr.confidence ? <span className="faint"> · {Math.round(cr.confidence * 100)}%</span> : null}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="faint" style={{ marginTop: 12 }}>Assessed with the previous rubric — re-run to see the 100-point breakdown.</p>
              )}

              <dl className="kv" style={{ marginTop: 16 }}>
                {(q.existing_certifications?.length ?? 0) > 0 && (
                  <>
                    <dt>Certifications held</dt>
                    <dd>{q.existing_certifications!.map((c) => <span key={c.name} style={{ marginRight: 8 }}>{c.name} <Refs ids={c.evidence_refs} onClick={showEvidence} /></span>)}</dd>
                  </>
                )}
                {q.missing_information?.length > 0 && (<><dt>Unanswered</dt><dd>{q.missing_information.join(" · ")}</dd></>)}
                {(q.pages_scraped?.length ?? 0) > 0 && (
                  <>
                    <dt>Pages researched</dt>
                    <dd>
                      {q.pages_scraped!.map((u) => (
                        <div key={u} className="ellipsis">{isMock || !/^https?:/.test(u) ? u : <a href={u} target="_blank" rel="noreferrer noopener">{u.replace(/^https?:\/\//, "")}</a>}</div>
                      ))}
                    </dd>
                  </>
                )}
                {q.research_summary && (<><dt>Summary</dt><dd className="sub">{q.research_summary}</dd></>)}
              </dl>

              {q.adjustments?.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary>Claims not counted ({q.adjustments.length})</summary>
                  <ul className="list-tight sub">{q.adjustments.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </details>
              )}
              {rounds.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary>Research steps ({rounds.length})</summary>
                  {rounds.map((r: any) => (
                    <div key={r.round} className="evidence-item">
                      <b>Step {r.round}</b> <span className="sub">· {(r.action.pageTypes ?? []).join(", ") || "—"} · {r.scoreBefore} → {r.scoreAfter}</span>
                      {r.newEvidence.length > 0 && <div style={{ marginTop: 4 }}><Refs ids={r.newEvidence} onClick={showEvidence} /></div>}
                    </div>
                  ))}
                </details>
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
    </Reveal>
  );
}

function Why({ q, a, full }: { q: string; a: string; full?: string }) {
  const [open, setOpen] = useState(false);
  const long = (full && full !== a) || a.length > 140;
  return (
    <div className="why">
      <div className="q">{q}</div>
      <div className={open ? undefined : "clamp2"}>{open && full ? full : a}</div>
      {long && (
        <button className="more" onClick={() => setOpen(!open)}>
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

function Signals({ s, onRef }: { s: { summary: string; evidence_ids: string[] }[]; onRef: (r: string) => void }) {
  if (!s?.length) return <span className="faint">None</span>;
  return <ul className="list-tight" style={{ marginTop: 0 }}>{s.map((x, i) => <li key={i}>{x.summary} <Refs ids={x.evidence_ids} onClick={onRef} /></li>)}</ul>;
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
