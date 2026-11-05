/**
 * Only one server process may run the agent against a database. A second copy (e.g. `next dev` next to
 * `next start`) would otherwise mark the first one's in-flight runs as interrupted and could re-send an
 * email whose Gmail call is still running. The lock is a pid file next to the database.
 */
import fs from "node:fs";
import { activeDbFile } from "./db";

const g = globalThis as unknown as { __agentLock?: boolean };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** null when this process may run the agent; otherwise the pid that holds the lock. */
export function agentLockHolder(): number | null {
  if (g.__agentLock) return null;
  const db = activeDbFile();
  if (db === ":memory:") return (g.__agentLock = true), null;
  const file = `${db}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      g.__agentLock = true;
      process.once("exit", () => {
        try {
          if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (pid === process.pid) return (g.__agentLock = true), null;
      if (pid && alive(pid)) return pid;
      fs.rmSync(file, { force: true }); // stale lock from a process that's gone
    }
  }
  return -1;
}

export const agentBusyMessage = (pid: number) =>
  `Another copy of the agent is running on this computer (process ${pid}). Stop it first — two copies could send the same email twice.`;
