import type { Database } from "better-sqlite3";
import {
  AgentResultSchema,
  AgentTaskSchema,
  BenchmarkRecordSchema,
  RunEventSchema,
  SiteAdapterSchema,
  SkillSchema,
  TraceRecordSchema,
  ValidationResultSchema,
  type AgentResult,
  type AgentTask,
  type BenchmarkRecord,
  type RunEvent,
  type SiteAdapter,
  type Skill,
  type TraceRecord,
  type ValidationResult,
} from "../types/domain.js";
import { getDatabase } from "./database.js";

export class Repository {
  private db: Database;

  constructor(customDb?: Database) {
    this.db = customDb ?? getDatabase();
  }

  // ==========================================================================
  // Site Adapters & Atomic Version Promotion
  // ==========================================================================

  saveSiteAdapter(adapter: SiteAdapter): void {
    const validated = SiteAdapterSchema.parse(adapter);
    const stmt = this.db.prepare(`
      INSERT INTO site_adapters (domain, version, status, data_json, created_at, promoted_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, version) DO UPDATE SET
        status = excluded.status,
        data_json = excluded.data_json,
        promoted_at = excluded.promoted_at
    `);

    stmt.run(
      validated.domain,
      validated.adapterVersion,
      validated.status,
      JSON.stringify(validated),
      validated.createdAt,
      validated.promotedAt ?? null
    );
  }

  getSiteAdapter(domain: string, version: string): SiteAdapter | null {
    const stmt = this.db.prepare(`
      SELECT data_json FROM site_adapters WHERE domain = ? AND version = ?
    `);
    const row = stmt.get(domain, version) as { data_json: string } | undefined;
    if (!row) return null;
    return SiteAdapterSchema.parse(JSON.parse(row.data_json));
  }

  getActiveSiteAdapter(domain: string): SiteAdapter | null {
    const stmt = this.db.prepare(`
      SELECT data_json FROM site_adapters WHERE domain = ? AND status = 'ACTIVE' LIMIT 1
    `);
    const row = stmt.get(domain) as { data_json: string } | undefined;
    if (!row) return null;
    return SiteAdapterSchema.parse(JSON.parse(row.data_json));
  }

  listSiteAdapters(domain: string): SiteAdapter[] {
    const stmt = this.db.prepare(`
      SELECT data_json FROM site_adapters WHERE domain = ? ORDER BY created_at DESC
    `);
    const rows = stmt.all(domain) as Array<{ data_json: string }>;
    return rows.map((r) => SiteAdapterSchema.parse(JSON.parse(r.data_json)));
  }

  /**
   * Promotes a candidate adapter to ACTIVE status.
   * Atomically retires any currently active adapter for the domain.
   */
  promoteSiteAdapter(domain: string, version: string): SiteAdapter {
    const promoteTx = this.db.transaction(() => {
      // 1. Fetch target candidate
      const target = this.getSiteAdapter(domain, version);
      if (!target) {
        throw new Error(`Cannot promote non-existent adapter: ${domain}@${version}`);
      }

      const now = new Date().toISOString();

      // 2. Retire any currently active version for this domain and sync data_json
      const existingActive = this.getActiveSiteAdapter(domain);
      if (existingActive && existingActive.adapterVersion !== version) {
        const retired: SiteAdapter = { ...existingActive, status: "RETIRED" };
        this.db
          .prepare(
            `UPDATE site_adapters SET status = 'RETIRED', data_json = ? WHERE domain = ? AND status = 'ACTIVE'`
          )
          .run(JSON.stringify(retired), domain);
      }

      // 3. Mark target as ACTIVE
      const updated: SiteAdapter = {
        ...target,
        status: "ACTIVE",
        promotedAt: now,
      };

      const updateStmt = this.db.prepare(`
        UPDATE site_adapters
        SET status = 'ACTIVE', promoted_at = ?, data_json = ?
        WHERE domain = ? AND version = ?
      `);
      updateStmt.run(now, JSON.stringify(updated), domain, version);

      return updated;
    });

    return promoteTx();
  }

  /**
   * Rolls back the active adapter for a domain to a previous approved version.
   * Atomically sets the target version to ACTIVE and retires the superseded active version.
   */
  rollbackSiteAdapter(domain: string, targetVersion: string): SiteAdapter {
    return this.promoteSiteAdapter(domain, targetVersion);
  }

  // ==========================================================================
  // Skills & Skill Versioning
  // ==========================================================================

  saveSkill(skill: Skill): void {
    const validated = SkillSchema.parse(skill);
    const stmt = this.db.prepare(`
      INSERT INTO skills (id, name, task_type, version, status, data_json, created_at, updated_at, promoted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at,
        promoted_at = excluded.promoted_at
    `);

    stmt.run(
      validated.id,
      validated.name,
      validated.taskType,
      validated.version,
      validated.status,
      JSON.stringify(validated),
      validated.timestamps.createdAt,
      validated.timestamps.updatedAt,
      validated.timestamps.promotedAt ?? null
    );
  }

  getSkill(skillId: string): Skill | null {
    const stmt = this.db.prepare(`SELECT data_json FROM skills WHERE id = ?`);
    const row = stmt.get(skillId) as { data_json: string } | undefined;
    if (!row) return null;
    return SkillSchema.parse(JSON.parse(row.data_json));
  }

  getActiveSkill(taskType: string = "PRODUCT_LOOKUP"): Skill | null {
    const stmt = this.db.prepare(`
      SELECT data_json FROM skills WHERE task_type = ? AND status = 'ACTIVE' LIMIT 1
    `);
    const row = stmt.get(taskType) as { data_json: string } | undefined;
    if (!row) return null;
    return SkillSchema.parse(JSON.parse(row.data_json));
  }

  listSkills(): Skill[] {
    const stmt = this.db.prepare(`SELECT data_json FROM skills ORDER BY created_at DESC`);
    const rows = stmt.all() as Array<{ data_json: string }>;
    return rows.map((r) => SkillSchema.parse(JSON.parse(r.data_json)));
  }

  promoteSkill(skillId: string): Skill {
    const promoteTx = this.db.transaction(() => {
      const target = this.getSkill(skillId);
      if (!target) {
        throw new Error(`Cannot promote non-existent skill: ${skillId}`);
      }

      const now = new Date().toISOString();

      // Retire existing active skill of this taskType and sync data_json
      const existingActive = this.getActiveSkill(target.taskType);
      if (existingActive && existingActive.id !== skillId) {
        const retired: Skill = {
          ...existingActive,
          status: "RETIRED",
          timestamps: {
            ...existingActive.timestamps,
            updatedAt: now,
          },
        };
        this.db
          .prepare(
            `UPDATE skills SET status = 'RETIRED', updated_at = ?, data_json = ? WHERE task_type = ? AND status = 'ACTIVE'`
          )
          .run(now, JSON.stringify(retired), target.taskType);
      }

      const updated: Skill = {
        ...target,
        status: "ACTIVE",
        timestamps: {
          ...target.timestamps,
          updatedAt: now,
          promotedAt: now,
        },
      };

      this.db
        .prepare(
          `UPDATE skills SET status = 'ACTIVE', updated_at = ?, promoted_at = ?, data_json = ? WHERE id = ?`
        )
        .run(now, now, JSON.stringify(updated), skillId);

      return updated;
    });

    return promoteTx();
  }

  // ==========================================================================
  // Run Events & Audit Trail
  // ==========================================================================

  logEvent(event: RunEvent): void {
    const validated = RunEventSchema.parse(event);
    const stmt = this.db.prepare(`
      INSERT INTO run_events (event_id, job_id, run_id, agent_role, state, site, step_id, timestamp, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      validated.eventId,
      validated.jobId,
      validated.runId,
      validated.agentRole,
      validated.state,
      validated.site,
      validated.stepId ?? null,
      validated.timestamp,
      JSON.stringify(validated)
    );
  }

  getEventsByJob(jobId: string): RunEvent[] {
    const stmt = this.db.prepare(`
      SELECT data_json FROM run_events WHERE job_id = ? ORDER BY sequence_id ASC
    `);
    const rows = stmt.all(jobId) as Array<{ data_json: string }>;
    return rows.map((r) => RunEventSchema.parse(JSON.parse(r.data_json)));
  }

  listRecentEvents(limit: number = 50): RunEvent[] {
    const stmt = this.db.prepare(`
      SELECT data_json FROM run_events ORDER BY sequence_id DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{ data_json: string }>;
    return rows.map((r) => RunEventSchema.parse(JSON.parse(r.data_json)));
  }

  // ==========================================================================
  // Task & Execution Runs
  // ==========================================================================

  saveTask(task: AgentTask): void {
    const validated = AgentTaskSchema.parse(task);
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO runs (task_id, job_id, role, status, task_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        task_json = excluded.task_json
    `);

    stmt.run(
      validated.taskId,
      validated.jobId,
      validated.role,
      "RUNNING",
      JSON.stringify(validated),
      now
    );
  }

  saveResult(result: AgentResult): void {
    const validated = AgentResultSchema.parse(result);
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE runs
      SET status = ?, result_json = ?, completed_at = ?
      WHERE task_id = ?
    `);

    stmt.run(validated.status, JSON.stringify(validated), now, validated.taskId);
  }

  getRun(taskId: string): { task: AgentTask; result: AgentResult | null } | null {
    const stmt = this.db.prepare(`
      SELECT task_json, result_json FROM runs WHERE task_id = ?
    `);
    const row = stmt.get(taskId) as { task_json: string; result_json: string | null } | undefined;
    if (!row) return null;

    return {
      task: AgentTaskSchema.parse(JSON.parse(row.task_json)),
      result: row.result_json ? AgentResultSchema.parse(JSON.parse(row.result_json)) : null,
    };
  }

  saveRun(task: AgentTask, result: AgentResult): void {
    this.saveTask(task);
    this.saveResult(result);
  }

  getRunsByJob(jobId: string): Array<{ taskId: string; status: string; task: AgentTask; result: AgentResult | null }> {
    const stmt = this.db.prepare(`
      SELECT task_id, status, task_json, result_json FROM runs WHERE job_id = ?
    `);
    const rows = stmt.all(jobId) as Array<{
      task_id: string;
      status: string;
      task_json: string;
      result_json: string | null;
    }>;
    return rows.map((r) => ({
      taskId: r.task_id,
      status: r.status,
      task: AgentTaskSchema.parse(JSON.parse(r.task_json)),
      result: r.result_json ? AgentResultSchema.parse(JSON.parse(r.result_json)) : null,
    }));
  }

  // ==========================================================================
  // Validation Records
  // ==========================================================================

  saveValidation(record: ValidationResult): void {
    const validated = ValidationResultSchema.parse(record);
    const stmt = this.db.prepare(`
      INSERT INTO validation_records (validation_id, status, data_json, validated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(validation_id) DO UPDATE SET
        status = excluded.status,
        data_json = excluded.data_json
    `);

    stmt.run(
      validated.validationId,
      validated.status,
      JSON.stringify(validated),
      validated.validatedAt
    );
  }

  getValidation(validationId: string): ValidationResult | null {
    const stmt = this.db.prepare(`
      SELECT data_json FROM validation_records WHERE validation_id = ?
    `);
    const row = stmt.get(validationId) as { data_json: string } | undefined;
    if (!row) return null;
    return ValidationResultSchema.parse(JSON.parse(row.data_json));
  }

  // ==========================================================================
  // Benchmark Records
  // ==========================================================================

  saveBenchmark(record: BenchmarkRecord): void {
    const validated = BenchmarkRecordSchema.parse(record);
    const stmt = this.db.prepare(`
      INSERT INTO benchmark_records (benchmark_id, trial_type, site, query, success, latency_ms, total_cost_usd, data_json, executed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(benchmark_id) DO UPDATE SET
        data_json = excluded.data_json
    `);

    stmt.run(
      validated.benchmarkId,
      validated.trialType,
      validated.site,
      validated.query,
      validated.success ? 1 : 0,
      validated.latencyMs,
      validated.costs.totalCostUsd,
      JSON.stringify(validated),
      validated.executedAt
    );
  }

  listBenchmarks(site?: string): BenchmarkRecord[] {
    const stmt = site
      ? this.db.prepare(`SELECT data_json FROM benchmark_records WHERE site = ? ORDER BY executed_at DESC`)
      : this.db.prepare(`SELECT data_json FROM benchmark_records ORDER BY executed_at DESC`);

    const rows = (site ? stmt.all(site) : stmt.all()) as Array<{ data_json: string }>;
    return rows.map((r) => BenchmarkRecordSchema.parse(JSON.parse(r.data_json)));
  }

  // ==========================================================================
  // Execution Traces & Auditing
  // ==========================================================================

  saveTrace(trace: TraceRecord): void {
    const validated = TraceRecordSchema.parse(trace);
    const stmt = this.db.prepare(`
      INSERT INTO traces (trace_id, job_id, run_id, trace_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(trace_id) DO UPDATE SET
        data_json = excluded.data_json
    `);

    stmt.run(
      validated.traceId,
      validated.jobId,
      validated.runId,
      validated.traceType,
      JSON.stringify(validated.data),
      validated.createdAt
    );
  }

  getTracesByJob(jobId: string): TraceRecord[] {
    const stmt = this.db.prepare(`
      SELECT trace_id, job_id, run_id, trace_type, data_json, created_at
      FROM traces
      WHERE job_id = ?
      ORDER BY created_at ASC
    `);

    const rows = stmt.all(jobId) as Array<{
      trace_id: string;
      job_id: string;
      run_id: string;
      trace_type: string;
      data_json: string;
      created_at: string;
    }>;

    return rows.map((r) =>
      TraceRecordSchema.parse({
        traceId: r.trace_id,
        jobId: r.job_id,
        runId: r.run_id,
        traceType: r.trace_type,
        data: JSON.parse(r.data_json),
        createdAt: r.created_at,
      })
    );
  }

  // ==========================================================================
  // Storage Reset (Safe Demo Reset)
  // ==========================================================================

  /**
   * Resets demo database tables to cold state.
   * Safety guarantee: ONLY purges database rows; NEVER touches source files, .env, or configuration.
   */
  resetDemoStorage(): void {
    const resetTx = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM run_events;
        DELETE FROM runs;
        DELETE FROM validation_records;
        DELETE FROM benchmark_records;
        DELETE FROM traces;
        DELETE FROM site_adapters;
        DELETE FROM skills;
        DELETE FROM jobs;
      `);
    });
    resetTx();
  }
}
