/**
 * SQLite persistence (better-sqlite3). A single local file keeps the prototype
 * dependency-free while still giving durable progress, relations and indexes.
 * The database is only ever opened server-side.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config";

type DB = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',          -- queued | running | completed | interrupted
  app_mode TEXT NOT NULL,
  domain_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  name TEXT,
  profile_json TEXT,
  current_status TEXT NOT NULL DEFAULT 'pending',
  data_source TEXT NOT NULL DEFAULT 'real',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  current_stage TEXT,
  status TEXT NOT NULL DEFAULT 'queued',          -- queued | running | completed | failed
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_log TEXT NOT NULL DEFAULT '[]',
  providers_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_company ON agent_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_batch ON agent_runs(batch_id);

CREATE TABLE IF NOT EXISTS stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,                            -- running | completed | skipped | failed | needs_review
  summary TEXT,
  detail_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_stage_events_run ON stage_events(agent_run_id);

CREATE TABLE IF NOT EXISTS research_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  rounds_json TEXT NOT NULL DEFAULT '[]',
  research_rounds INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  reused_from INTEGER,
  data_source TEXT NOT NULL DEFAULT 'real',
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_runs_company ON research_runs(company_id);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'website',
  data_source TEXT NOT NULL DEFAULT 'real',
  retrieved_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pages_run ON pages(research_run_id);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  research_run_id INTEGER REFERENCES research_runs(id) ON DELETE SET NULL,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  claim TEXT NOT NULL,
  supporting_text TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT NOT NULL,
  evidence_type TEXT NOT NULL,                     -- observed | inference | unknown
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'real',
  retrieved_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_company ON evidence(company_id);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(research_run_id);

CREATE TABLE IF NOT EXISTS qualifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  round INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL,
  decision TEXT NOT NULL,
  result_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  missing_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  override_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qualifications_company ON qualifications(company_id);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  name TEXT,
  first_name TEXT,
  title TEXT,
  department TEXT,
  business_email TEXT,
  verification_status TEXT,
  provider_confidence REAL,
  confidence REAL NOT NULL DEFAULT 0,
  role_category TEXT,
  rank_score REAL,
  rank INTEGER,
  selected INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'real',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

CREATE TABLE IF NOT EXISTS pain_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,
  statement TEXT NOT NULL,
  relevance TEXT NOT NULL,
  type TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pain_points_company ON pain_points(company_id);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,                             -- pending | generated | validated | sent | simulated | failed | skipped | needs_review
  validation_status TEXT NOT NULL,                  -- PASS | REGENERATE | NEEDS_REVIEW
  validation_json TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  personalisation_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'real',
  generated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_company ON emails(company_id);

CREATE TABLE IF NOT EXISTS email_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  delivery_recipient TEXT NOT NULL,
  provider TEXT NOT NULL,                           -- gmail | mock
  status TEXT NOT NULL,                             -- sending | sent | simulated | failed | outcome_unknown
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  error TEXT,
  attempted_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS contact_search_cache (
  domain TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  response_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_usage (
  provider TEXT NOT NULL,
  period TEXT NOT NULL,                             -- YYYY-MM
  requests INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, period)
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id INTEGER,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function resolvePath(url: string): string {
  if (url === ":memory:" || url === "file::memory:") return ":memory:";
  const p = url.startsWith("file:") ? url.slice(5) : url;
  return path.resolve(process.cwd(), p);
}

const g = globalThis as unknown as { __outreachDb?: DB };

export function getDb(): DB {
  if (!g.__outreachDb) g.__outreachDb = openDb(getConfig().databaseUrl);
  return g.__outreachDb;
}

export function openDb(url: string): DB {
  const file = resolvePath(url);
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.exec(SCHEMA);
  if (file !== ":memory:") {
    // The database holds the Gmail refresh token and contact data: owner-only access.
    fs.chmodSync(path.dirname(file), 0o700);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  }
  return db;
}

/** Test helper: swap in a fresh database (e.g. in-memory). */
export function setDbForTests(db: DB) {
  g.__outreachDb = db;
}

export const nowIso = () => new Date().toISOString();
