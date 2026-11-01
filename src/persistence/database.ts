import fs from "node:fs";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { getEnv } from "../config/env.js";
import { logger } from "../utils/logger.js";

let instance: Database | null = null;

/**
 * Initializes and returns the shared SQLite database instance.
 * Enables WAL mode for concurrent write safety and transactional integrity.
 */
export function getDatabase(customPath?: string): Database {
  if (instance) return instance;

  const dbPath = customPath ?? getEnv().DATABASE_URL;

  // Ensure target directory exists for file-based SQLite
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  instance = new DatabaseConstructor(dbPath);

  // Configure SQLite for high concurrency and safety
  instance.pragma("journal_mode = WAL");
  instance.pragma("synchronous = NORMAL");
  instance.pragma("foreign_keys = ON");
  instance.pragma("busy_timeout = 5000");

  initSchema(instance);
  logger.debug("Database initialized with WAL mode", { path: dbPath });

  return instance;
}

/**
 * Closes the database connection (used during teardown and tests).
 */
export function closeDatabase(): void {
  if (instance) {
    try {
      instance.close();
    } catch {
      // Ignore closing errors
    } finally {
      instance = null;
    }
  }
}

/**
 * Creates database tables and indexes if they do not exist.
 */
export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      task_type TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      promoted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS site_adapters (
      domain TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      promoted_at TEXT,
      PRIMARY KEY (domain, version)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      site TEXT NOT NULL,
      query TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_events (
      sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      job_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      state TEXT NOT NULL,
      site TEXT NOT NULL,
      step_id TEXT,
      timestamp TEXT NOT NULL,
      data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      task_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      task_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS validation_records (
      validation_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      data_json TEXT NOT NULL,
      validated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS benchmark_records (
      benchmark_id TEXT PRIMARY KEY,
      trial_type TEXT NOT NULL,
      site TEXT NOT NULL,
      query TEXT NOT NULL,
      success INTEGER NOT NULL,
      latency_ms REAL NOT NULL,
      total_cost_usd REAL NOT NULL,
      data_json TEXT NOT NULL,
      executed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      trace_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Performance and lookup indexes
    CREATE INDEX IF NOT EXISTS idx_site_adapters_domain_status ON site_adapters (domain, status);
    CREATE INDEX IF NOT EXISTS idx_skills_task_status ON skills (task_type, status);
    CREATE INDEX IF NOT EXISTS idx_run_events_job ON run_events (job_id, sequence_id ASC);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON runs (job_id);
    CREATE INDEX IF NOT EXISTS idx_benchmarks_site ON benchmark_records (site);
  `);
}

