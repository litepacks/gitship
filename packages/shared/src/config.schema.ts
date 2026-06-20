import { z } from "zod";

import { parse, stringify } from "yaml";

export const RepositorySchema = z.object({
  owner: z.string().min(1, "Repository owner is required"),
  repo: z.string().min(1, "Repository name is required"),
  branch: z.string().min(1, "Branch name is required"),
});

export const TargetSchema = z.object({
  type: z.enum(["ssh", "local"]),
  host: z.string().optional(),
  port: z.number().optional().default(22),
  username: z.string().optional(),
  path: z.string().min(1, "Deployment target path is required"),
});

export const HealthCheckSchema = z.object({
  path: z.string().default("/"),
  port: z.number().optional(),
  retries: z.number().default(5),
  interval_ms: z.number().default(1000),
  timeout_ms: z.number().default(2000),
});

export const DeploySchema = z.object({
  node_version: z.string().optional(),
  install: z.string().optional(),
  build: z.string().optional(),
  restart: z.string().optional(),
  healthcheck: HealthCheckSchema.optional(),
});

export const LoggingSchema = z.object({
  enabled: z.boolean().default(true),
});

export const ProjectConfigSchema = z.object({
  project: z.string().min(1, "Project name is required").regex(/^[a-zA-Z0-9_-]+$/, "Project name can only contain letters, numbers, underscores, and dashes"),
  repository: RepositorySchema,
  target: TargetSchema,
  deploy: DeploySchema,
  logging: LoggingSchema.optional().default({ enabled: true }),
});

export const AuthConfigSchema = z.object({
  github_token: z.string().min(1, "GitHub token is required"),
  github_username: z.string().optional(),
});

export type RepositoryConfig = z.infer<typeof RepositorySchema>;
export type TargetConfig = z.infer<typeof TargetSchema>;
export type DeployConfig = z.infer<typeof DeploySchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export function parseProjectConfig(yamlStr: string): ProjectConfig {
  const parsed = parse(yamlStr);
  return ProjectConfigSchema.parse(parsed);
}

export function stringifyProjectConfig(config: ProjectConfig): string {
  return stringify(config);
}
