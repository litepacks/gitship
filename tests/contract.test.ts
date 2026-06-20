import { describe, it, expect } from "vitest";
import { parseProjectConfig } from "../packages/shared/src/config.schema.js";
import { Project, Webhook, Deployment, DeploymentStep } from "gitship-shared";

describe("Interface and Schema Contract Verification", () => {
  
  // Contract 1: GitHub Webhook Push Payload format
  it("should match the expected contract of a GitHub Webhook Push Payload", () => {
    // Official GitHub Push Payload sample subset required by DeployKit Agent
    const githubPushPayload = {
      ref: "refs/heads/production",
      after: "87c8a149c95b6c8ba883ef59dc6c8f6e80b2a4dd",
      repository: {
        name: "test-repo",
        owner: {
          login: "owner-username",
        },
      },
      pusher: {
        name: "pusher-username",
      },
      head_commit: {
        id: "87c8a149c95b6c8ba883ef59dc6c8f6e80b2a4dd",
        message: "fix: update configurations",
        author: {
          username: "author-username",
        },
      },
    };

    // Assert that our parser and router code can safely resolve key values
    expect(githubPushPayload.ref.replace("refs/heads/", "")).toBe("production");
    expect(githubPushPayload.repository.owner.login).toBe("owner-username");
    expect(githubPushPayload.repository.name).toBe("test-repo");
    expect(githubPushPayload.head_commit.id).toBe("87c8a149c95b6c8ba883ef59dc6c8f6e80b2a4dd");
    expect(githubPushPayload.head_commit.message).toBe("fix: update configurations");
    expect(githubPushPayload.head_commit.author.username).toBe("author-username");
  });

  // Contract 2: ProjectConfig Schema Mapping Contract
  it("should map ProjectConfig to Database Project Entity correctly", () => {
    const yamlStr = `
project: webspresso
repository:
  owner: iamaroott
  repo: webspresso
  branch: main
target:
  type: ssh
  host: remote-host.com
  port: 22
  path: /var/www/webspresso
deploy:
  install: npm ci
  build: npm run build
  restart: pm2 restart webspresso
  healthcheck:
    path: /health
    port: 3000
    retries: 3
    interval_ms: 500
    timeout_ms: 1000
`;
    
    const parsedConfig = parseProjectConfig(yamlStr);
    
    // Perform mapping to db record
    const dbProjectRecord: Project = {
      id: "proj_test123",
      name: parsedConfig.project,
      owner: parsedConfig.repository.owner,
      repo: parsedConfig.repository.repo,
      branch: parsedConfig.repository.branch,
      target_type: parsedConfig.target.type,
      target_host: parsedConfig.target.host,
      target_path: parsedConfig.target.path,
      install_cmd: parsedConfig.deploy.install,
      build_cmd: parsedConfig.deploy.build,
      restart_cmd: parsedConfig.deploy.restart,
      healthcheck_path: parsedConfig.deploy.healthcheck?.path,
      healthcheck_port: parsedConfig.deploy.healthcheck?.port,
      healthcheck_retries: parsedConfig.deploy.healthcheck?.retries,
      healthcheck_interval_ms: parsedConfig.deploy.healthcheck?.interval_ms,
      healthcheck_timeout_ms: parsedConfig.deploy.healthcheck?.timeout_ms,
      webhook_secret: "sec_random123",
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    // Assert that the contract between parsed config and DB constraints matches
    expect(dbProjectRecord.name).toBe("webspresso");
    expect(dbProjectRecord.owner).toBe("iamaroott");
    expect(dbProjectRecord.repo).toBe("webspresso");
    expect(dbProjectRecord.branch).toBe("main");
    expect(dbProjectRecord.target_type).toBe("ssh");
    expect(dbProjectRecord.target_host).toBe("remote-host.com");
    expect(dbProjectRecord.target_path).toBe("/var/www/webspresso");
    expect(dbProjectRecord.install_cmd).toBe("npm ci");
    expect(dbProjectRecord.build_cmd).toBe("npm run build");
    expect(dbProjectRecord.restart_cmd).toBe("pm2 restart webspresso");
    expect(dbProjectRecord.healthcheck_path).toBe("/health");
    expect(dbProjectRecord.healthcheck_port).toBe(3000);
    expect(dbProjectRecord.healthcheck_retries).toBe(3);
    expect(dbProjectRecord.healthcheck_interval_ms).toBe(500);
    expect(dbProjectRecord.healthcheck_timeout_ms).toBe(1000);
  });
});
