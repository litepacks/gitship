import Database from "better-sqlite3";
import fs from "fs";
import { DB_PATH, ensureDirsExist } from "./paths.js";
import {
  Project,
  Webhook,
  Deployment,
  DeploymentStep,
  DeploymentLog,
  DeploymentStatus,
  StepStatus,
} from "@gitship/shared";

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  ensureDirsExist();
  dbInstance = new Database(DB_PATH);
  try {
    fs.chmodSync(DB_PATH, 0o600);
  } catch {}
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  initDb(dbInstance);
  return dbInstance;
}

function initDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_host TEXT,
      target_path TEXT NOT NULL,
      install_cmd TEXT,
      build_cmd TEXT,
      restart_cmd TEXT,
      healthcheck_path TEXT,
      healthcheck_port INTEGER,
      healthcheck_retries INTEGER,
      healthcheck_interval_ms INTEGER,
      healthcheck_timeout_ms INTEGER,
      webhook_secret TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      github_webhook_id INTEGER,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT,
      commit_message TEXT,
      author TEXT,
      status TEXT NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      total_duration_ms INTEGER,
      rollback_of_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deployment_steps (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      duration_ms INTEGER,
      FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deployment_logs (
      deployment_id TEXT PRIMARY KEY,
      log_data TEXT NOT NULL,
      FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
}

// Project Repositories
export function addProject(project: Omit<Project, "created_at" | "updated_at">): Project {
  const db = getDb();
  const now = Date.now();
  const fullProject = { ...project, created_at: now, updated_at: now };
  const stmt = db.prepare(`
    INSERT INTO projects (id, name, owner, repo, branch, target_type, target_host, target_path, install_cmd, build_cmd, restart_cmd, healthcheck_path, healthcheck_port, healthcheck_retries, healthcheck_interval_ms, healthcheck_timeout_ms, webhook_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      owner = excluded.owner,
      repo = excluded.repo,
      branch = excluded.branch,
      target_type = excluded.target_type,
      target_host = excluded.target_host,
      target_path = excluded.target_path,
      install_cmd = excluded.install_cmd,
      build_cmd = excluded.build_cmd,
      restart_cmd = excluded.restart_cmd,
      healthcheck_path = excluded.healthcheck_path,
      healthcheck_port = excluded.healthcheck_port,
      healthcheck_retries = excluded.healthcheck_retries,
      healthcheck_interval_ms = excluded.healthcheck_interval_ms,
      healthcheck_timeout_ms = excluded.healthcheck_timeout_ms,
      webhook_secret = excluded.webhook_secret,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    fullProject.id,
    fullProject.name,
    fullProject.owner,
    fullProject.repo,
    fullProject.branch,
    fullProject.target_type,
    fullProject.target_host || null,
    fullProject.target_path,
    fullProject.install_cmd || null,
    fullProject.build_cmd || null,
    fullProject.restart_cmd || null,
    fullProject.healthcheck_path || null,
    fullProject.healthcheck_port || null,
    fullProject.healthcheck_retries || null,
    fullProject.healthcheck_interval_ms || null,
    fullProject.healthcheck_timeout_ms || null,
    fullProject.webhook_secret,
    fullProject.created_at,
    fullProject.updated_at
  );
  return fullProject;
}

export function getProject(idOrName: string): Project | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM projects WHERE id = ? OR name = ?");
  const res = stmt.get(idOrName, idOrName) as Project | undefined;
  return res || null;
}

export function getProjects(): Project[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM projects ORDER BY name ASC");
  return stmt.all() as Project[];
}

export function removeProject(id: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM projects WHERE id = ?");
  stmt.run(id);
}

// Webhook Repositories
export function saveWebhook(webhook: Webhook): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO webhooks (id, project_id, github_webhook_id, url, secret, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      github_webhook_id = excluded.github_webhook_id,
      url = excluded.url,
      secret = excluded.secret,
      active = excluded.active
  `);
  stmt.run(
    webhook.id,
    webhook.project_id,
    webhook.github_webhook_id,
    webhook.url,
    webhook.secret,
    webhook.active ? 1 : 0,
    webhook.created_at
  );
}

export function getWebhookByProjectId(projectId: string): Webhook | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM webhooks WHERE project_id = ?");
  const res = stmt.get(projectId) as any;
  if (!res) return null;
  return {
    ...res,
    active: res.active === 1,
  };
}

// Deployment Repositories
export function createDeployment(deployment: Omit<Deployment, "created_at">): Deployment {
  const db = getDb();
  const now = Date.now();
  const fullDeployment = { ...deployment, created_at: now };
  const stmt = db.prepare(`
    INSERT INTO deployments (id, project_id, branch, commit_sha, commit_message, author, status, started_at, finished_at, total_duration_ms, rollback_of_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    fullDeployment.id,
    fullDeployment.project_id,
    fullDeployment.branch,
    fullDeployment.commit_sha || null,
    fullDeployment.commit_message || null,
    fullDeployment.author || null,
    fullDeployment.status,
    fullDeployment.started_at || null,
    fullDeployment.finished_at || null,
    fullDeployment.total_duration_ms || null,
    fullDeployment.rollback_of_id || null,
    fullDeployment.created_at
  );

  // Initialize empty logs for this deployment
  const logStmt = db.prepare("INSERT INTO deployment_logs (deployment_id, log_data) VALUES (?, ?)");
  logStmt.run(fullDeployment.id, "");

  return fullDeployment;
}

export function updateDeploymentStatus(
  id: string,
  status: DeploymentStatus,
  fields: Partial<Deployment> = {}
): void {
  const db = getDb();
  const updates: string[] = ["status = ?"];
  const params: any[] = [status];

  for (const [key, val] of Object.entries(fields)) {
    if (key !== "id" && key !== "status") {
      updates.push(`${key} = ?`);
      params.push(val);
    }
  }

  params.push(id);
  const stmt = db.prepare(`UPDATE deployments SET ${updates.join(", ")} WHERE id = ?`);
  stmt.run(...params);
}

export function getDeployment(id: string): Deployment | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM deployments WHERE id = ?");
  const res = stmt.get(id) as Deployment | undefined;
  return res || null;
}

export function getDeployments(projectId?: string, limit?: number): Deployment[] {
  const db = getDb();
  let query = "SELECT * FROM deployments";
  const params: any[] = [];

  if (projectId) {
    query += " WHERE project_id = ?";
    params.push(projectId);
  }

  query += " ORDER BY created_at DESC";

  if (limit) {
    query += " LIMIT ?";
    params.push(limit);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params) as Deployment[];
}

export function getQueuedDeployments(projectId: string): Deployment[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM deployments WHERE project_id = ? AND status = 'QUEUED' ORDER BY created_at ASC");
  return stmt.all(projectId) as Deployment[];
}

export function getRunningDeployment(projectId: string): Deployment | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM deployments WHERE project_id = ? AND status = 'RUNNING'");
  const res = stmt.get(projectId) as Deployment | undefined;
  return res || null;
}

// Steps Repositories
export function createDeploymentStep(step: DeploymentStep): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO deployment_steps (id, deployment_id, step_name, status, started_at, finished_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(step.id, step.deployment_id, step.step_name, step.status, step.started_at, step.finished_at, step.duration_ms);
}

export function updateDeploymentStep(id: string, fields: Partial<DeploymentStep>): void {
  const db = getDb();
  const updates: string[] = [];
  const params: any[] = [];

  for (const [key, val] of Object.entries(fields)) {
    if (key !== "id") {
      updates.push(`${key} = ?`);
      params.push(val);
    }
  }

  params.push(id);
  const stmt = db.prepare(`UPDATE deployment_steps SET ${updates.join(", ")} WHERE id = ?`);
  stmt.run(...params);
}

export function getDeploymentSteps(deploymentId: string): DeploymentStep[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM deployment_steps WHERE deployment_id = ? ORDER BY started_at ASC");
  return stmt.all(deploymentId) as DeploymentStep[];
}

// Log Repositories
export function appendDeploymentLog(deploymentId: string, text: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE deployment_logs
    SET log_data = log_data || ?
    WHERE deployment_id = ?
  `);
  stmt.run(text, deploymentId);
}

export function getDeploymentLog(deploymentId: string): string | null {
  const db = getDb();
  const stmt = db.prepare("SELECT log_data FROM deployment_logs WHERE deployment_id = ?");
  const res = stmt.get(deploymentId) as { log_data: string } | undefined;
  return res ? res.log_data : null;
}

// Stats Repository
export interface ProjectStats {
  totalDeployments: number;
  successRate: number;
  avgDeployTimeMs: number;
  avgBuildTimeMs: number;
  slowestDeployMs: number;
  fastestDeployMs: number;
}

export function getStats(projectId?: string): ProjectStats {
  const db = getDb();
  const filter = projectId ? "WHERE project_id = ?" : "WHERE 1=1";
  const params = projectId ? [projectId] : [];

  const totalRow = db.prepare(`SELECT count(*) as count FROM deployments ${filter}`).get(...params) as { count: number };
  const total = totalRow.count;

  if (total === 0) {
    return {
      totalDeployments: 0,
      successRate: 0,
      avgDeployTimeMs: 0,
      avgBuildTimeMs: 0,
      slowestDeployMs: 0,
      fastestDeployMs: 0,
    };
  }

  const successRow = db.prepare(`SELECT count(*) as count FROM deployments ${filter} AND status = 'SUCCESS'`).get(...params) as { count: number };
  const successRate = total > 0 ? (successRow.count / total) * 100 : 0;

  const durationRow = db.prepare(`
    SELECT
      avg(total_duration_ms) as avg_duration,
      max(total_duration_ms) as max_duration,
      min(total_duration_ms) as min_duration
    FROM deployments
    ${filter} AND status = 'SUCCESS'
  `).get(...params) as { avg_duration: number | null; max_duration: number | null; min_duration: number | null };

  const buildDurationRow = db.prepare(`
    SELECT avg(ds.duration_ms) as avg_build
    FROM deployment_steps ds
    JOIN deployments d ON ds.deployment_id = d.id
    ${projectId ? "WHERE d.project_id = ?" : "WHERE 1=1"} AND ds.step_name = 'build' AND ds.status = 'SUCCESS'
  `).get(projectId ? [projectId] : []) as { avg_build: number | null };

  return {
    totalDeployments: total,
    successRate: parseFloat(successRate.toFixed(1)),
    avgDeployTimeMs: Math.round(durationRow.avg_duration || 0),
    avgBuildTimeMs: Math.round(buildDurationRow.avg_build || 0),
    slowestDeployMs: durationRow.max_duration || 0,
    fastestDeployMs: durationRow.min_duration || 0,
  };
}

export function isWebhookDeliveryProcessed(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare("SELECT count(*) as count FROM webhook_deliveries WHERE id = ?");
  const res = stmt.get(id) as { count: number };
  return res.count > 0;
}

export function recordWebhookDelivery(id: string): void {
  const db = getDb();
  const now = Date.now();
  const insertStmt = db.prepare("INSERT OR IGNORE INTO webhook_deliveries (id, created_at) VALUES (?, ?)");
  insertStmt.run(id, now);

  // Prune older than 24 hours (86,400,000 ms)
  const pruneStmt = db.prepare("DELETE FROM webhook_deliveries WHERE created_at < ?");
  pruneStmt.run(now - 86400000);
}
