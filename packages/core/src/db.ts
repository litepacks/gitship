import fs from "fs";
import path from "path";
import { DB_PATH, ensureDirsExist } from "./paths.js";
import {
  Project,
  Webhook,
  Deployment,
  DeploymentStep,
  DeploymentStatus,
  StepStatus,
} from "gitship-shared";

export interface ProjectStats {
  totalDeployments: number;
  successRate: number;
  avgDeployTimeMs: number;
  avgBuildTimeMs: number;
  slowestDeployMs: number;
  fastestDeployMs: number;
}

interface JsonDbSchema {
  projects: Project[];
  webhooks: Webhook[];
  deployments: Deployment[];
  deployment_steps: DeploymentStep[];
  deployment_logs: Record<string, string>;
  webhook_deliveries: { id: string; created_at: number }[];
}

function readDb(): JsonDbSchema {
  ensureDirsExist();
  if (!fs.existsSync(DB_PATH)) {
    const empty: JsonDbSchema = {
      projects: [],
      webhooks: [],
      deployments: [],
      deployment_steps: [],
      deployment_logs: {},
      webhook_deliveries: [],
    };
    writeDb(empty);
    return empty;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    const empty: JsonDbSchema = {
      projects: [],
      webhooks: [],
      deployments: [],
      deployment_steps: [],
      deployment_logs: {},
      webhook_deliveries: [],
    };
    writeDb(empty);
    return empty;
  }
}

function writeDb(data: JsonDbSchema) {
  ensureDirsExist();
  const tempPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {}
  fs.renameSync(tempPath, DB_PATH);
}

// Project Repositories
export function addProject(project: Omit<Project, "created_at" | "updated_at">): Project {
  const data = readDb();
  const now = Date.now();
  const existingIndex = data.projects.findIndex(p => p.name === project.name || p.id === project.id);
  let fullProject: Project;
  if (existingIndex !== -1) {
    const oldProj = data.projects[existingIndex];
    fullProject = {
      ...oldProj,
      ...project,
      updated_at: now,
    };
    data.projects[existingIndex] = fullProject;
  } else {
    fullProject = {
      ...project,
      created_at: now,
      updated_at: now,
    };
    data.projects.push(fullProject);
  }
  writeDb(data);
  return fullProject;
}

export function getProject(idOrName: string): Project | null {
  const data = readDb();
  const found = data.projects.find(p => p.id === idOrName || p.name === idOrName);
  return found || null;
}

export function getProjects(): Project[] {
  const data = readDb();
  return [...data.projects].sort((a, b) => a.name.localeCompare(b.name));
}

export function removeProject(id: string): void {
  const data = readDb();
  data.projects = data.projects.filter(p => p.id !== id);
  data.webhooks = data.webhooks.filter(w => w.project_id !== id);
  const depIds = data.deployments.filter(d => d.project_id === id).map(d => d.id);
  data.deployments = data.deployments.filter(d => d.project_id !== id);
  data.deployment_steps = data.deployment_steps.filter(ds => !depIds.includes(ds.deployment_id));
  for (const depId of depIds) {
    delete data.deployment_logs[depId];
  }
  writeDb(data);
}

// Webhook Repositories
export function saveWebhook(webhook: Webhook): void {
  const data = readDb();
  const idx = data.webhooks.findIndex(w => w.id === webhook.id);
  if (idx !== -1) {
    data.webhooks[idx] = { ...data.webhooks[idx], ...webhook };
  } else {
    data.webhooks.push(webhook);
  }
  writeDb(data);
}

export function getWebhookByProjectId(projectId: string): Webhook | null {
  const data = readDb();
  const found = data.webhooks.find(w => w.project_id === projectId);
  return found || null;
}

// Deployment Repositories
export function createDeployment(deployment: Omit<Deployment, "created_at">): Deployment {
  const data = readDb();
  const fullDeployment: Deployment = { ...deployment, created_at: Date.now() };
  data.deployments.push(fullDeployment);
  writeDb(data);
  return fullDeployment;
}

export function getDeployment(id: string): Deployment | null {
  const data = readDb();
  const found = data.deployments.find(d => d.id === id);
  return found || null;
}

export function getDeployments(projectId?: string, limit?: number): Deployment[] {
  const data = readDb();
  let list = [...data.deployments];
  if (projectId) {
    list = list.filter(d => d.project_id === projectId);
  }
  list.sort((a, b) => b.created_at - a.created_at);
  if (limit !== undefined) {
    list = list.slice(0, limit);
  }
  return list;
}

export function getQueuedDeployments(projectId: string): Deployment[] {
  const data = readDb();
  return data.deployments
    .filter(d => d.project_id === projectId && d.status === "QUEUED")
    .sort((a, b) => a.created_at - b.created_at);
}

export function getRunningDeployment(projectId: string): Deployment | null {
  const data = readDb();
  const found = data.deployments.find(d => d.project_id === projectId && d.status === "RUNNING");
  return found || null;
}

export function updateDeploymentStatus(
  id: string,
  status: DeploymentStatus,
  extraFields?: Partial<Omit<Deployment, "id" | "status">>
): void {
  const data = readDb();
  const idx = data.deployments.findIndex(d => d.id === id);
  if (idx !== -1) {
    data.deployments[idx] = {
      ...data.deployments[idx],
      status,
      ...extraFields,
    };
    writeDb(data);
  }
}

// Deployment Steps Repositories
export function createDeploymentStep(step: DeploymentStep): void {
  const data = readDb();
  data.deployment_steps.push(step);
  writeDb(data);
}

export function updateDeploymentStep(
  id: string,
  updates: Partial<Omit<DeploymentStep, "id">>
): void {
  const data = readDb();
  const idx = data.deployment_steps.findIndex(ds => ds.id === id);
  if (idx !== -1) {
    data.deployment_steps[idx] = {
      ...data.deployment_steps[idx],
      ...updates,
    } as DeploymentStep;
    writeDb(data);
  }
}

export function getDeploymentSteps(deploymentId: string): DeploymentStep[] {
  const data = readDb();
  return data.deployment_steps.filter(ds => ds.deployment_id === deploymentId);
}

// Deployment Logs Repositories
export function appendDeploymentLog(deploymentId: string, logText: string): void {
  const data = readDb();
  const existing = data.deployment_logs[deploymentId] || "";
  data.deployment_logs[deploymentId] = existing + logText;
  writeDb(data);
}

export function getDeploymentLog(deploymentId: string): string | null {
  const data = readDb();
  return data.deployment_logs[deploymentId] !== undefined ? data.deployment_logs[deploymentId] : null;
}

// Stats & Metrics
export function getStats(projectId?: string): ProjectStats {
  const data = readDb();
  let deploys = [...data.deployments];
  if (projectId) {
    deploys = deploys.filter(d => d.project_id === projectId);
  }
  const total = deploys.length;

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

  const successDeploys = deploys.filter(d => d.status === "SUCCESS");
  const successCount = successDeploys.length;
  const successRate = total > 0 ? (successCount / total) * 100 : 0;

  const successDurations = successDeploys
    .map(d => d.total_duration_ms)
    .filter((d): d is number => d !== null && d !== undefined);

  const avgDeployTimeMs = successDurations.length > 0
    ? Math.round(successDurations.reduce((sum, val) => sum + val, 0) / successDurations.length)
    : 0;

  const slowestDeployMs = successDurations.length > 0 ? Math.max(...successDurations) : 0;
  const fastestDeployMs = successDurations.length > 0 ? Math.min(...successDurations) : 0;

  const depIds = deploys.map(d => d.id);
  const buildSteps = data.deployment_steps.filter(ds => 
    depIds.includes(ds.deployment_id) && 
    ds.step_name === "build" && 
    ds.status === "SUCCESS"
  );
  const buildDurations = buildSteps
    .map(ds => ds.duration_ms)
    .filter((d): d is number => d !== null && d !== undefined);

  const avgBuildTimeMs = buildDurations.length > 0
    ? Math.round(buildDurations.reduce((sum, val) => sum + val, 0) / buildDurations.length)
    : 0;

  return {
    totalDeployments: total,
    successRate: parseFloat(successRate.toFixed(1)),
    avgDeployTimeMs,
    avgBuildTimeMs,
    slowestDeployMs,
    fastestDeployMs,
  };
}

// Webhook Delivery Processed Protection
export function isWebhookDeliveryProcessed(id: string): boolean {
  const data = readDb();
  return data.webhook_deliveries.some(d => d.id === id);
}

export function recordWebhookDelivery(id: string): void {
  const data = readDb();
  const now = Date.now();
  if (!data.webhook_deliveries.some(d => d.id === id)) {
    data.webhook_deliveries.push({ id, created_at: now });
  }
  data.webhook_deliveries = data.webhook_deliveries.filter(d => d.created_at >= now - 86400000);
  writeDb(data);
}
