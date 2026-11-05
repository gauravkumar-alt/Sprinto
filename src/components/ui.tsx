"use client";
import { useEffect, useState } from "react";
import { PIPELINE_STAGES, type PipelineStage } from "@/lib/config";
import { Fill } from "./motion";

export type StageRow = { stage: string; status: string; summary: string | null; error?: string | null };

const STATUS: Record<string, [string, string]> = {
  pending: ["b-mute", "Pending"],
  queued: ["b-mute", "Queued"],
  running: ["b-info", "Running"],
  qualified: ["b-ok", "Qualified"],
  not_qualified: ["b-bad", "Not qualified"],
  needs_review: ["b-warn", "Review"],
  research_more: ["b-info", "Researching"],
  contact_not_found: ["b-warn", "No contact"],
  email_needs_review: ["b-warn", "Email review"],
  email_sent: ["b-ok", "Sent"],
  email_simulated: ["b-mock", "Simulated"],
  failed: ["b-bad", "Failed"],
  generated: ["b-info", "Generated"],
  validated: ["b-info", "Validated"],
  sent: ["b-ok", "Sent"],
  simulated: ["b-mock", "Simulated"],
  skipped: ["b-mute", "Skipped"],
  outcome_unknown: ["b-warn", "Unknown outcome"],
  sending: ["b-info", "Sending"],
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="faint">—</span>;
  const [cls, label] = STATUS[status] ?? ["b-mute", status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/** ok / warn / bad / info tone for an outcome (row rails, meters). */
export function tone(status: string | null | undefined): "ok" | "warn" | "bad" | "info" | "" {
  if (!status) return "";
  if (["email_sent", "qualified", "sent", "email_simulated", "simulated"].includes(status)) return "ok";
  if (["not_qualified", "failed"].includes(status)) return "bad";
  if (["running", "queued", "research_more"].includes(status)) return "info";
  return "warn";
}

export function SourceBadge({ source }: { source: string | null | undefined }) {
  return source === "mock" ? <span className="badge b-mock" title="Fictional fixture data">Mock</span> : <span className="badge b-real" title="Real website, contact and model data">Real</span>;
}

const LABEL: Record<PipelineStage, string> = {
  research: "Research",
  extract: "Profile",
  qualify: "Qualify",
  contact: "Contact",
  pain_points: "Pain points",
  email: "Email",
  send: "Send",
};

/** First one or two "·"-separated parts of a stage summary, capped — full text stays in the tooltip. */
export function shortSummary(s: string | null | undefined, max = 58): string {
  if (!s) return "";
  const parts = s.split(" · ");
  let out = parts[0];
  if (parts[1] && (out + " · " + parts[1]).length <= max) out += " · " + parts[1];
  return out.length > max ? out.slice(0, max - 1).trimEnd() + "…" : out;
}

const ICON: Record<string, string> = { completed: "✓", running: "•", failed: "✕", needs_review: "!", skipped: "–", pending: "" };

export function StageList({ stages }: { stages: StageRow[] }) {
  const by = new Map(stages.map((s) => [s.stage, s]));
  return (
    <ul className="steps">
      {PIPELINE_STAGES.map((st, i) => {
        const s = by.get(st);
        const status = s?.status ?? "pending";
        return (
          <li key={st} className={`step s-${status}`} title={s?.summary ?? undefined}>
            <span className="icon">{ICON[status]}</span>
            <span className="name">
              {i + 1}. {LABEL[st]}
            </span>
            <span className="sum ellipsis">{shortSummary(s?.summary)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Seven progress pips — one per stage. */
export function Pips({ stages }: { stages: StageRow[] }) {
  const by = new Map(stages.map((s) => [s.stage, s]));
  return (
    <div className="pips">
      {PIPELINE_STAGES.map((st) => (
        <span key={st} className={`pip ${by.get(st)?.status ?? ""}`} title={`${LABEL[st]}: ${by.get(st)?.summary ?? "pending"}`} />
      ))}
    </div>
  );
}

export function currentStepLabel(stages: StageRow[]): string {
  const running = stages.find((s) => s.status === "running");
  if (running) return `${LABEL[running.stage as PipelineStage] ?? running.stage}…`;
  const last = [...stages].reverse().find((s) => s.status !== "skipped");
  return last ? shortSummary(last.summary, 48) : "Queued";
}

export function Meter({ value, max = 100, status }: { value: number | null; max?: number; status?: string | null }) {
  if (value === null || value === undefined) return <span className="faint">—</span>;
  return (
    <div className={`meter ${tone(status)}`} title={`${value}/${max}`}>
      <span className="score">{value}</span>
      <div className="track">
        <Fill pct={Math.max(2, (value / max) * 100)} />
      </div>
    </div>
  );
}

export function Refs({ ids, onClick }: { ids: string[] | undefined; onClick?: (id: string) => void }) {
  if (!ids?.length) return null;
  return (
    <>
      {ids.map((id) => (
        <span key={id} className="ref" onClick={() => onClick?.(id)} title="Show evidence">
          {id}
        </span>
      ))}
    </>
  );
}

export function ProviderChip({ label, state, detail }: { label: string; state: string; detail: string }) {
  const cls = state === "real" ? "ok" : state === "mock" ? "mock" : state === "off" ? "off" : "bad";
  const suffix = state === "mock" ? " (mock)" : state === "missing" ? " (missing)" : "";
  return (
    <span className="chip" title={detail}>
      <span className={`dot ${cls}`} />
      {label}
      {suffix}
    </span>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("theme");
    } catch {
      /* storage unavailable */
    }
    const initial = saved === "dark" || saved === "light" ? saved : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="icon-btn"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        setTheme(next);
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("theme", next);
        } catch {
          /* storage unavailable */
        }
      }}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

export async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}
