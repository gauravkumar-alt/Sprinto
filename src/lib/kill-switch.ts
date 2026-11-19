/**
 * Kill switch: stops all agent work at once and keeps it stopped until switched off.
 *
 * When on:
 *  - queued runs are cancelled immediately;
 *  - a running company stops at its next checkpoint (next stage, next AI call, next research round),
 *    and no email is ever sent: the send step checks it right before calling Gmail;
 *  - new batches, retries, sends and "Find fit companies" screens are refused.
 *
 * It is stored in the database (survives restarts) and can also be forced on with AGENT_KILL_SWITCH=true,
 * which cannot be switched off from the dashboard.
 */
import { getDb, nowIso } from "@/lib/db";
import { finishBatchIfDone } from "@/lib/repo";

const KEY = "kill_switch";
export const KILLED_MESSAGE = "Stopped by the kill switch — nothing further runs or sends until it is switched off.";

export class KilledError extends Error {
  constructor() {
    super(KILLED_MESSAGE);
    this.name = "KilledError";
  }
}

export const killSwitchForcedByEnv = () => (process.env.AGENT_KILL_SWITCH ?? "").trim().toLowerCase() === "true";

export function killSwitchOn(): boolean {
  if (killSwitchForcedByEnv()) return true;
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key=?").get(KEY) as { value: string } | undefined;
    return row?.value === "on";
  } catch {
    return false;
  }
}

/** Throws KilledError when the switch is on. Call before anything that costs money, contacts a site or sends. */
export function assertNotKilled() {
  if (killSwitchOn()) throw new KilledError();
}

/** Switch on or off. Switching on cancels every queued run straight away. Returns the number cancelled. */
export function setKillSwitch(on: boolean): { on: boolean; cancelled: number } {
  const db = getDb();
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(KEY, on ? "on" : "off", nowIso());
  let cancelled = 0;
  if (on) {
    const now = nowIso();
    const queued = db.prepare("SELECT id, company_id, batch_id FROM agent_runs WHERE status='queued'").all() as { id: number; company_id: number; batch_id: number | null }[];
    const cancel = db.transaction(() => {
      for (const r of queued) {
        db.prepare("UPDATE agent_runs SET status='failed', outcome='failed', completed_at=?, error_log=json_insert(coalesce(error_log,'[]'), '$[#]', json_object('stage','orchestrator','message',?,'at',?)) WHERE id=?").run(now, KILLED_MESSAGE, now, r.id);
        db.prepare("UPDATE companies SET current_status='failed', updated_at=? WHERE id=? AND current_status IN ('queued','running','pending')").run(now, r.company_id);
      }
    });
    cancel();
    for (const b of new Set(queued.map((r) => r.batch_id))) finishBatchIfDone(b);
    cancelled = queued.length;
  }
  return { on: killSwitchOn(), cancelled };
}
