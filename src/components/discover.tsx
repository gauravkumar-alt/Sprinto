"use client";
/**
 * "Find fit companies": screens YC-backed B2B companies' own websites for SOC 2 and suggests the ones
 * that don't have it yet. Nothing runs until the user adds suggestions to the agent's list.
 */
import { useCallback, useEffect, useState } from "react";
import { postJson } from "@/components/ui";

type Verdict = "fit" | "preparing" | "certified" | "unreachable";
type Item = {
  domain: string;
  name: string;
  source: string;
  verdict: Verdict;
  reason: string;
  quote: string | null;
  quoteUrl: string | null;
  details: { oneLiner: string; teamSize: number | null; batch: string; location: string; sector: string };
  inAgent: boolean;
};
type Status = { running: boolean; screened: number; total: number; error: string | null; counts: Partial<Record<Verdict, number>>; items: Item[] };

export function DiscoverPanel({ onAdd }: { onAdd: (lines: string[]) => void }) {
  const [s, setS] = useState<Status | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/discover", { cache: "no-store" }).catch(() => null);
    if (r?.ok) setS(await r.json());
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!s?.running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [s?.running, load]);

  async function find() {
    setErr(null);
    try {
      setS(await postJson<Status>("/api/discover", {}));
    } catch (e) {
      setErr((e as Error).message);
      load();
    }
  }

  const fits = (s?.items ?? []).filter((i) => (i.verdict === "fit" || i.verdict === "preparing") && !i.inAgent);
  const shown = showAll ? fits : fits.slice(0, 8);
  const setAside = (s?.counts.certified ?? 0) + (s?.counts.unreachable ?? 0);
  const toggle = (d: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  return (
    <section className="panel discover" style={{ marginTop: 16 }} data-reveal>
      <div className="panel-head">
        <div>
          <h2>Find fit companies</h2>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            Checks the websites of hiring, YC-backed B2B companies (15–300 people) and suggests the ones that don&apos;t show SOC 2 or ISO 27001 yet. No AI used.
          </p>
        </div>
        <div className="row">
          {picked.size > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => {
                onAdd(fits.filter((f) => picked.has(f.domain)).map((f) => `${f.name} | ${f.domain}`));
                setPicked(new Set());
              }}
            >
              Add {picked.size} to the list
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={find} disabled={s?.running}>
            {s?.running ? `Checking ${s.screened}/${s.total || "…"}` : fits.length ? "Find more" : "Find fit companies"}
          </button>
        </div>
      </div>
      {err && <div className="notice n-bad">{err}</div>}
      {s?.error && <div className="notice n-bad">Last check failed: {s.error}</div>}
      {s && (s.items.length > 0 || s.running) && (
        <div className="sub" style={{ marginBottom: 8 }}>
          {s.items.length} checked · <b style={{ color: "var(--text)" }}>{fits.length}</b> suggested · {setAside} set aside ({s.counts.certified ?? 0} already certified, {s.counts.unreachable ?? 0} site unreadable)
        </div>
      )}
      {shown.length > 0 && (
        <ul className="discover-list">
          {shown.map((f) => (
            <li key={f.domain}>
              <label>
                <input type="checkbox" checked={picked.has(f.domain)} onChange={() => toggle(f.domain)} />
                <span className="d-main">
                  <span className="d-name">
                    {f.name} <span className="sub">· {f.domain}</span>
                    {f.verdict === "preparing" && <span className="badge b-ok">Working toward SOC 2</span>}
                  </span>
                  <span className="sub">
                    {[f.details.oneLiner, f.details.sector, f.details.teamSize ? `${f.details.teamSize} people` : "", f.details.batch].filter(Boolean).join(" · ")}
                  </span>
                  <span className="d-why">{f.quote ? <>“{f.quote}”</> : f.reason}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {fits.length > 8 && (
        <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${fits.length}`}
        </button>
      )}
    </section>
  );
}
