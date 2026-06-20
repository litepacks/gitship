import fs from "fs";
import { describe, it, expect, afterAll } from "vitest";
import {
  addProject,
  getProject,
  getProjects,
  removeProject,
  saveWebhook,
  getWebhookByProjectId,
  createDeployment,
  getDeployment,
  getDeployments,
  getQueuedDeployments,
  getRunningDeployment,
  updateDeploymentStatus,
  createDeploymentStep,
  updateDeploymentStep,
  getDeploymentSteps,
  appendDeploymentLog,
  getDeploymentLog,
  getStats,
  isWebhookDeliveryProcessed,
  recordWebhookDelivery,
} from "../packages/core/src/db.js";
import { GITSHIP_DIR } from "../packages/core/src/paths.js";
import { Project, Deployment, Webhook, DeploymentStep } from "gitship-shared";

describe("SQLite Database Operations", () => {
  afterAll(() => {
    // Cleanup test dir
    if (fs.existsSync(GITSHIP_DIR)) {
      fs.rmSync(GITSHIP_DIR, { recursive: true, force: true });
    }
  });

  const sampleProject: Omit<Project, "created_at" | "updated_at"> = {
    id: "proj_test123",
    name: "testproject",
    owner: "iamaroott",
    repo: "webspresso",
    branch: "main",
    target_type: "local",
    target_path: "/tmp/deploy",
    install_cmd: "npm ci",
    build_cmd: "npm run build",
    restart_cmd: "pm2 restart webspresso",
    webhook_secret: "secret123",
  };

  it("should return empty stats if no deployments exist", () => {
    // Make sure database is initialized by adding project
    addProject(sampleProject);
    const stats = getStats("proj_test123");
    expect(stats.totalDeployments).toBe(0);
    expect(stats.successRate).toBe(0);
  });

  it("should add and get a project", () => {
    const saved = addProject(sampleProject);
    expect(saved.name).toBe("testproject");
    expect(saved.created_at).toBeGreaterThan(0);

    const fetched = getProject("proj_test123");
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("testproject");
    expect(fetched!.webhook_secret).toBe("secret123");
  });

  it("should list projects", () => {
    const list = getProjects();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("proj_test123");
  });

  it("should handle webhook repositories", () => {
    const webhookData: Webhook = {
      id: "wh_test1",
      project_id: "proj_test123",
      github_webhook_id: 12345,
      url: "http://localhost:3000/webhook/github",
      secret: "secret123",
      active: true,
      created_at: Date.now(),
    };

    saveWebhook(webhookData);

    const fetchedNull = getWebhookByProjectId("non-existent");
    expect(fetchedNull).toBeNull();

    const fetched = getWebhookByProjectId("proj_test123");
    expect(fetched).not.toBeNull();
    expect(fetched!.github_webhook_id).toBe(12345);
    expect(fetched!.active).toBe(true);
  });

  it("should record deployment runs and updates", () => {
    const sampleDeployment = {
      id: "dep_test001",
      project_id: "proj_test123",
      branch: "main",
      commit_sha: "a8f31c2",
      commit_message: "feat: add user auth",
      author: "iamaroott",
      status: "QUEUED" as const,
      started_at: null,
      finished_at: null,
      total_duration_ms: null,
      rollback_of_id: null,
    };

    const saved = createDeployment(sampleDeployment);
    expect(saved.status).toBe("QUEUED");

    const fetched = getDeployment("dep_test001");
    expect(fetched).not.toBeNull();
    expect(fetched!.commit_sha).toBe("a8f31c2");

    // Queued check
    const queuedList = getQueuedDeployments("proj_test123");
    expect(queuedList.length).toBe(1);
    expect(queuedList[0].id).toBe("dep_test001");

    // Running check before update
    expect(getRunningDeployment("proj_test123")).toBeNull();

    // Update status to RUNNING
    updateDeploymentStatus("dep_test001", "RUNNING", { started_at: Date.now() });
    const runningDep = getRunningDeployment("proj_test123");
    expect(runningDep).not.toBeNull();
    expect(runningDep!.id).toBe("dep_test001");

    // Steps CRUD
    const stepData: DeploymentStep = {
      id: "step_build_1",
      deployment_id: "dep_test001",
      step_name: "build",
      status: "RUNNING",
      started_at: Date.now(),
      finished_at: null,
      duration_ms: null,
    };

    createDeploymentStep(stepData);
    
    const stepsRunning = getDeploymentSteps("dep_test001");
    expect(stepsRunning.length).toBe(1);
    expect(stepsRunning[0].step_name).toBe("build");

    updateDeploymentStep("step_build_1", {
      status: "SUCCESS",
      finished_at: Date.now(),
      duration_ms: 1200,
    });

    const stepsFinished = getDeploymentSteps("dep_test001");
    expect(stepsFinished[0].status).toBe("SUCCESS");
    expect(stepsFinished[0].duration_ms).toBe(1200);

    // Logs appending
    appendDeploymentLog("dep_test001", "Cloning repo...\n");
    appendDeploymentLog("dep_test001", "Building project...\n");
    
    const logs = getDeploymentLog("dep_test001");
    expect(logs).toBe("Cloning repo...\nBuilding project...\n");
    expect(getDeploymentLog("non-existent-dep")).toBeNull();

    // Set success
    updateDeploymentStatus("dep_test001", "SUCCESS", {
      finished_at: Date.now(),
      total_duration_ms: 5000,
    });
    
    // Test getDeployments lists and filters
    const allRuns = getDeployments();
    expect(allRuns.length).toBe(1);
    
    const projectRuns = getDeployments("proj_test123", 1);
    expect(projectRuns.length).toBe(1);

    const stats = getStats("proj_test123");
    expect(stats.totalDeployments).toBe(1);
    expect(stats.successRate).toBe(100);
    expect(stats.avgDeployTimeMs).toBe(5000);
    expect(stats.avgBuildTimeMs).toBe(1200);
  });

  it("should handle webhook delivery replay logging", () => {
    const deliveryId = "del_998877";
    
    expect(isWebhookDeliveryProcessed(deliveryId)).toBe(false);
    
    recordWebhookDelivery(deliveryId);
    expect(isWebhookDeliveryProcessed(deliveryId)).toBe(true);
    
    // Test ignore/overwrite
    recordWebhookDelivery(deliveryId);
    expect(isWebhookDeliveryProcessed(deliveryId)).toBe(true);
  });

  it("should remove project and cascade delete", () => {
    removeProject("proj_test123");
    const fetched = getProject("proj_test123");
    expect(fetched).toBeNull();

    // Deployment should be deleted by cascade foreign key
    const fetchedDeployment = getDeployment("dep_test001");
    expect(fetchedDeployment).toBeNull();
  });
});
