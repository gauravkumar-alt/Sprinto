"use client";
import { PIPELINE_STAGES, STAGE_LABELS } from "@/lib/config";

export type StageRow = { stage: string; status: string; summary: string | null; error?: string | null };

const STATUS_STYLE: Record<string, [string, string]> = {
  pending: ["b-mute", "Pending"],
  running: ["b-info", "Running"],
  qualified: ["b-ok", "Qualified"],
  not_qualified: ["b-bad", "Not qualified"],
  needs_review: ["b-warn", "Needs review"],
  research_more: ["b-info", "Researching"],
  contact_not_found: ["b-warn", "Contact not found"],
  email_needs_review: ["b-warn", "Email needs review"],
  email_sent: ["b-ok", "Sent to your inbox"],
  email_simulated: ["b-mock", "Simulated"],
  failed: ["b-bad", "Failed"],
  // email statuses
  generated: ["b-info", "Generated"],
  validated: ["b-info", "Validated"],
  sent: ["b-ok", "Sent"],
  simulated: ["b-mock", "SIMULATED"],
  skipped: ["b-mute", "Skipped"],
  outcome_unknown: ["b-warn", "Outcome unknown"],
  sending: ["b-info", "Sending"],
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge b-mute">—</span>;
  const [cls, label] = STATUS_STYLE[status] ?? ["b-mute", status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function SourceBadge({ source }: { source: string | null | undefined }) {
  return source === "mock" ? (
    <span className="badge b-mock" title="Produced by mock providers — not real research">MOCK DATA</span>
  ) : (
    <span className="badge b-real" title="Produced from real sources/providers">REAL DATA</span>
  );
}

const ICON: Record<string, string> = { completed: "✓", running: "•", failed: "✕", needs_review: "!", skipped: "–", pending: "" };

export function StageList({ stages }: { stages: StageRow[] }) {
  const by = new Map(stages.map((s) => [s.stage, s]));
  return (
    <ul className="steps">
      {PIPELINE_STAGES.map((st) => {
        const s = by.get(st);
        const status = s?.status ?? "pending";
        return (
          <li key={st} className={`step s-${status}`}>
            <span className="icon">{ICON[status]}</span>
            <span className="name">{STAGE_LABELS[st]}</span>
            <span className="sum">{s?.summary ?? ""}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Refs({ ids, onClick }: { ids: string[] | undefined; onClick?: (id: string) => void }) {
  if (!ids?.length) return <span className="sub">no evidence cited</span>;
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
  const cls = state === "real" ? "b-real" : state === "mock" ? "b-mock" : state === "off" ? "b-mute" : "b-bad";
  const word = state === "real" ? "live" : state === "mock" ? "mock" : state === "off" ? "off" : "missing";
  return (
    <span className={`badge ${cls}`} title={detail}>
      {label}: {word}
    </span>
  );
}

export async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}
