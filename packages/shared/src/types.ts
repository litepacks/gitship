export type DeploymentStatus = "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
export type StepStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface Project {
  id: string;
  name: string;
  owner: string;
  repo: string;
  branch: string;
  target_type: "ssh" | "local";
  target_host?: string;
  target_path: string;
  install_cmd?: string;
  build_cmd?: string;
  restart_cmd?: string;
  healthcheck_path?: string;
  healthcheck_port?: number;
  healthcheck_retries?: number;
  healthcheck_interval_ms?: number;
  healthcheck_timeout_ms?: number;
  webhook_secret: string;
  created_at: number;
  updated_at: number;
}

export interface Webhook {
  id: string;
  project_id: string;
  github_webhook_id: number | null;
  url: string;
  secret: string;
  active: boolean;
  created_at: number;
}

export interface Deployment {
  id: string;
  project_id: string;
  branch: string;
  commit_sha: string | null;
  commit_message: string | null;
  author: string | null;
  status: DeploymentStatus;
  started_at: number | null;
  finished_at: number | null;
  total_duration_ms: number | null;
  rollback_of_id: string | null;
  created_at: number;
}

export interface DeploymentStep {
  id: string;
  deployment_id: string;
  step_name: "clone" | "install" | "build" | "restart" | "healthcheck";
  status: StepStatus;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
}

export interface DeploymentLog {
  deployment_id: string;
  log_data: string;
}

export interface DeploymentProvider {
  deploy(): Promise<void>;
  rollback(): Promise<void>;
  validate(): Promise<void>;
}
