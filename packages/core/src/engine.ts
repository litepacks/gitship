import { execa } from "execa";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import {
  Project,
  Deployment,
  DeploymentStep,
  StepStatus,
  DeploymentStatus,
} from "@deploykit/shared";
import {
  updateDeploymentStatus,
  createDeploymentStep,
  updateDeploymentStep,
  appendDeploymentLog,
  getDeployment,
} from "./db.js";
import { BUILDS_DIR, readAuthConfig } from "./paths.js";
import { activeProcesses } from "./queue.js";

interface StepResult {
  status: StepStatus;
  durationMs: number;
}

export async function runDeploymentPipeline(
  project: Project,
  deployment: Deployment
): Promise<void> {
  const auth = readAuthConfig();
  const token = auth.github_token;

  if (!token) {
    const errorMsg = "Error: GitHub authentication token is missing. Please run 'deploykit auth github'.\n";
    appendDeploymentLog(deployment.id, errorMsg);
    updateDeploymentStatus(deployment.id, "FAILED", {
      finished_at: Date.now(),
      total_duration_ms: 0,
    });
    return;
  }

  // Prevent shell command injection via branch or commit SHA inputs
  const safeBranchRegex = /^[a-zA-Z0-9/_.-]+$/;
  if (!safeBranchRegex.test(deployment.branch)) {
    const errorMsg = `Error: Unsafe branch name format: "${deployment.branch}". Deployment aborted.\n`;
    appendDeploymentLog(deployment.id, errorMsg);
    updateDeploymentStatus(deployment.id, "FAILED", {
      finished_at: Date.now(),
      total_duration_ms: 0,
    });
    return;
  }

  if (deployment.commit_sha && !/^[a-zA-Z0-9]+$/.test(deployment.commit_sha)) {
    const errorMsg = `Error: Unsafe commit SHA format: "${deployment.commit_sha}". Deployment aborted.\n`;
    appendDeploymentLog(deployment.id, errorMsg);
    updateDeploymentStatus(deployment.id, "FAILED", {
      finished_at: Date.now(),
      total_duration_ms: 0,
    });
    return;
  }

  const startTime = Date.now();
  updateDeploymentStatus(deployment.id, "RUNNING", { started_at: startTime });

  appendDeploymentLog(
    deployment.id,
    `=== Starting deployment ${deployment.id} for project "${project.name}" ===\n` +
      `Branch: ${deployment.branch}\n` +
      `Commit: ${deployment.commit_sha || "latest"}\n` +
      `Author: ${deployment.author || "system"}\n` +
      `Target: ${project.target_type} (${
        project.target_type === "ssh"
          ? `${project.target_host}:${project.target_path}`
          : project.target_path
      })\n\n`
  );

  let status: DeploymentStatus = "SUCCESS";

  try {
    // Step 1: Clone or Pull
    const cloneSuccess = await runStep(
      deployment.id,
      "clone",
      async (log) => {
        // Double check cancellation
        checkCancelled(deployment.id);

        const repoUrl = `https://${token}@github.com/${project.owner}/${project.repo}.git`;
        if (project.target_type === "local") {
          const projectPath = path.join(BUILDS_DIR, project.name);
          if (!fs.existsSync(projectPath)) {
            log(`Cloning repository into local path ${projectPath}...\n`);
            await execLocal(
              deployment.id,
              "git",
              ["clone", "--branch", deployment.branch, repoUrl, "."],
              BUILDS_DIR,
              project.name, // create dir
              log
            );
          } else {
            log(`Repository directory exists. Fetching latest changes...\n`);
            await execLocal(deployment.id, "git", ["fetch", "origin"], projectPath, undefined, log);
            
            const checkoutTarget = deployment.commit_sha || `origin/${deployment.branch}`;
            log(`Checking out target: ${checkoutTarget}...\n`);
            await execLocal(deployment.id, "git", ["checkout", "-B", deployment.branch], projectPath, undefined, log);
            await execLocal(deployment.id, "git", ["reset", "--hard", checkoutTarget], projectPath, undefined, log);
          }
        } else {
          // SSH Target
          const port = project.target_host?.split(":")[1] || "22";
          const host = project.target_host?.split(":")[0] || "";
          
          log(`Ensuring target path ${project.target_path} exists on remote server...\n`);
          await execSSH(deployment.id, host, port, `mkdir -p ${project.target_path}`, log);

          // Check if git repository exists on the remote target path
          log(`Checking if repository is already initialized on remote...\n`);
          let isInitialized = false;
          try {
            await execSSH(deployment.id, host, port, `cd ${project.target_path} && git rev-parse --is-inside-work-tree`, () => {});
            isInitialized = true;
          } catch {
            isInitialized = false;
          }

          checkCancelled(deployment.id);

          if (!isInitialized) {
            log(`Cloning repository on remote server into ${project.target_path}...\n`);
            await execSSH(deployment.id, host, port, `git clone --branch ${deployment.branch} ${repoUrl} ${project.target_path}`, log);
          } else {
            log(`Fetching updates on remote server...\n`);
            await execSSH(deployment.id, host, port, `cd ${project.target_path} && git fetch origin`, log);
            
            const checkoutTarget = deployment.commit_sha || `origin/${deployment.branch}`;
            log(`Checking out target on remote server: ${checkoutTarget}...\n`);
            await execSSH(deployment.id, host, port, `cd ${project.target_path} && git checkout -B ${deployment.branch} && git reset --hard ${checkoutTarget}`, log);
          }
        }
      }
    );

    if (!cloneSuccess) throw new Error("Step 'clone' failed.");

    // Step 2: Install dependencies
    if (project.install_cmd) {
      const installSuccess = await runStep(
        deployment.id,
        "install",
        async (log) => {
          checkCancelled(deployment.id);
          log(`Running install command: ${project.install_cmd}\n`);
          if (project.target_type === "local") {
            const projectPath = path.join(BUILDS_DIR, project.name);
            await execShell(deployment.id, project.install_cmd!, projectPath, log);
          } else {
            const port = project.target_host?.split(":")[1] || "22";
            const host = project.target_host?.split(":")[0] || "";
            await execSSH(deployment.id, host, port, `cd ${project.target_path} && ${project.install_cmd}`, log);
          }
        }
      );
      if (!installSuccess) throw new Error("Step 'install' failed.");
    } else {
      skipStep(deployment.id, "install");
    }

    // Step 3: Build project
    if (project.build_cmd) {
      const buildSuccess = await runStep(
        deployment.id,
        "build",
        async (log) => {
          checkCancelled(deployment.id);
          log(`Running build command: ${project.build_cmd}\n`);
          if (project.target_type === "local") {
            const projectPath = path.join(BUILDS_DIR, project.name);
            await execShell(deployment.id, project.build_cmd!, projectPath, log);
          } else {
            const port = project.target_host?.split(":")[1] || "22";
            const host = project.target_host?.split(":")[0] || "";
            await execSSH(deployment.id, host, port, `cd ${project.target_path} && ${project.build_cmd}`, log);
          }
        }
      );
      if (!buildSuccess) throw new Error("Step 'build' failed.");
    } else {
      skipStep(deployment.id, "build");
    }

    // Step 4: Restart application
    if (project.restart_cmd) {
      const restartSuccess = await runStep(
        deployment.id,
        "restart",
        async (log) => {
          checkCancelled(deployment.id);
          log(`Running restart command: ${project.restart_cmd}\n`);
          if (project.target_type === "local") {
            const projectPath = path.join(BUILDS_DIR, project.name);
            await execShell(deployment.id, project.restart_cmd!, projectPath, log);
          } else {
            const port = project.target_host?.split(":")[1] || "22";
            const host = project.target_host?.split(":")[0] || "";
            await execSSH(deployment.id, host, port, `cd ${project.target_path} && ${project.restart_cmd}`, log);
          }
        }
      );
      if (!restartSuccess) throw new Error("Step 'restart' failed.");
    } else {
      skipStep(deployment.id, "restart");
    }

    // Step 5: Health Check
    if (project.healthcheck_path) {
      const healthSuccess = await runStep(
        deployment.id,
        "healthcheck",
        async (log) => {
          checkCancelled(deployment.id);
          const pathStr = project.healthcheck_path || "/";
          const portNum = project.healthcheck_port;
          const retries = project.healthcheck_retries || 5;
          const interval = project.healthcheck_interval_ms || 1000;
          const timeout = project.healthcheck_timeout_ms || 2000;

          const url = portNum ? `http://localhost:${portNum}${pathStr}` : `http://localhost${pathStr}`;
          log(`Performing health check on: ${url} (Retries: ${retries}, Interval: ${interval}ms)\n`);

          let lastError: any = null;
          for (let i = 1; i <= retries; i++) {
            checkCancelled(deployment.id);
            log(`Attempt ${i} of ${retries}... `);

            try {
              if (project.target_type === "local") {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);
                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (res.ok) {
                  log(`OK (${res.status})\n`);
                  return;
                } else {
                  throw new Error(`HTTP status ${res.status}`);
                }
              } else {
                // SSH Target
                const sshPort = project.target_host?.split(":")[1] || "22";
                const host = project.target_host?.split(":")[0] || "";
                const maxTimeSecs = Math.max(1, Math.round(timeout / 1000));
                await execSSH(
                  deployment.id,
                  host,
                  sshPort,
                  `curl -s -f --max-time ${maxTimeSecs} ${url}`,
                  () => {}
                );
                log(`OK (exit code 0)\n`);
                return;
              }
            } catch (err: any) {
              lastError = err;
              log(`FAILED: ${err.message || err}\n`);
              if (i < retries) {
                await new Promise((r) => setTimeout(r, interval));
              }
            }
          }
          throw new Error(`Health check failed after ${retries} retries. Last error: ${lastError?.message || lastError}`);
        }
      );
      if (!healthSuccess) throw new Error("Step 'healthcheck' failed.");
    } else {
      skipStep(deployment.id, "healthcheck");
    }

    // Check if cancelled at the very end
    const currentDep = getDeployment(deployment.id);
    if (currentDep?.status === "CANCELLED") {
      status = "CANCELLED";
    } else {
      appendDeploymentLog(deployment.id, `\n=== Deployment SUCCESS ===\n`);
    }
  } catch (err: any) {
    const currentDep = getDeployment(deployment.id);
    if (currentDep?.status === "CANCELLED") {
      status = "CANCELLED";
      appendDeploymentLog(deployment.id, `\n=== Deployment CANCELLED ===\n`);
    } else {
      status = "FAILED";
      appendDeploymentLog(deployment.id, `\n=== Deployment FAILED ===\nReason: ${err.message || err}\n`);
    }
  } finally {
    const endTime = Date.now();
    const duration = endTime - startTime;
    updateDeploymentStatus(deployment.id, status, {
      finished_at: endTime,
      total_duration_ms: duration,
    });
  }
}

function checkCancelled(deploymentId: string) {
  const currentDep = getDeployment(deploymentId);
  if (currentDep?.status === "CANCELLED") {
    throw new Error("Deployment cancelled by user.");
  }
}

// Execa locally helper
async function execLocal(
  deploymentId: string,
  cmd: string,
  args: string[],
  cwd: string,
  createDir?: string,
  log?: (chunk: string) => void
): Promise<void> {
  const finalCwd = createDir ? cwd : cwd;
  if (createDir) {
    fs.mkdirSync(path.join(cwd, createDir), { recursive: true });
  }

  const proc = execa(cmd, args, {
    cwd: createDir ? path.join(cwd, createDir) : finalCwd,
    all: true,
  });

  activeProcesses.set(deploymentId, proc);

  if (log && proc.all) {
    proc.all.on("data", (chunk) => {
      log(chunk.toString());
    });
  }

  try {
    await proc;
  } finally {
    activeProcesses.delete(deploymentId);
  }
}

// Execa locally with shell helper
async function execShell(
  deploymentId: string,
  cmd: string,
  cwd: string,
  log: (chunk: string) => void
): Promise<void> {
  const proc = execa({ shell: true, cwd, all: true })`${cmd}`;
  
  activeProcesses.set(deploymentId, proc);

  if (proc.all) {
    proc.all.on("data", (chunk) => {
      log(chunk.toString());
    });
  }

  try {
    await proc;
  } finally {
    activeProcesses.delete(deploymentId);
  }
}

// Execa SSH command helper
async function execSSH(
  deploymentId: string,
  host: string,
  port: string,
  cmd: string,
  log: (chunk: string) => void
): Promise<void> {
  // Execute via SSH CLI
  const proc = execa("ssh", ["-o", "StrictHostKeyChecking=no", "-p", port, host, cmd], {
    all: true,
  });

  activeProcesses.set(deploymentId, proc);

  if (proc.all) {
    proc.all.on("data", (chunk) => {
      log(chunk.toString());
    });
  }

  try {
    await proc;
  } finally {
    activeProcesses.delete(deploymentId);
  }
}

async function runStep(
  deploymentId: string,
  name: "clone" | "install" | "build" | "restart" | "healthcheck",
  fn: (log: (text: string) => void) => Promise<void>
): Promise<boolean> {
  const stepId = nanoid();
  const startTime = Date.now();

  const step: DeploymentStep = {
    id: stepId,
    deployment_id: deploymentId,
    step_name: name,
    status: "RUNNING",
    started_at: startTime,
    finished_at: null,
    duration_ms: null,
  };

  createDeploymentStep(step);
  appendDeploymentLog(deploymentId, `[Step: ${name}] Started...\n`);

  try {
    await fn((text: string) => {
      appendDeploymentLog(deploymentId, text);
    });

    // Check cancellation again
    checkCancelled(deploymentId);

    const endTime = Date.now();
    const duration = endTime - startTime;

    updateDeploymentStep(stepId, {
      status: "SUCCESS",
      finished_at: endTime,
      duration_ms: duration,
    });
    appendDeploymentLog(deploymentId, `[Step: ${name}] Completed successfully (${Math.round(duration / 1000)}s).\n\n`);
    return true;
  } catch (err: any) {
    const endTime = Date.now();
    const duration = endTime - startTime;

    const currentDep = getDeployment(deploymentId);
    const isCancelled = currentDep?.status === "CANCELLED";

    updateDeploymentStep(stepId, {
      status: isCancelled ? "FAILED" : "FAILED", // or can mark as cancelled if step structure supported it, but FAILED is robust
      finished_at: endTime,
      duration_ms: duration,
    });
    
    appendDeploymentLog(deploymentId, `[Step: ${name}] ${isCancelled ? 'Cancelled' : 'Failed'} (${Math.round(duration / 1000)}s).\nError detail: ${err.message || err}\n\n`);
    return false;
  }
}

function skipStep(
  deploymentId: string,
  name: "clone" | "install" | "build" | "restart" | "healthcheck"
) {
  const stepId = nanoid();
  const step: DeploymentStep = {
    id: stepId,
    deployment_id: deploymentId,
    step_name: name,
    status: "SUCCESS",
    started_at: Date.now(),
    finished_at: Date.now(),
    duration_ms: 0,
  };
  createDeploymentStep(step);
  appendDeploymentLog(deploymentId, `[Step: ${name}] Skipped (not configured).\n\n`);
}
