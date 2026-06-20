import { nanoid } from "nanoid";
import { Deployment, DeploymentStatus } from "gitship-shared";
import {
  createDeployment,
  getProject,
  getQueuedDeployments,
  getRunningDeployment,
  updateDeploymentStatus,
  getDeployment,
  appendDeploymentLog,
} from "./db.js";
import { runDeploymentPipeline } from "./engine.js";

// Global map to track active execa processes for cancelling running tasks
export const activeProcesses = new Map<string, { kill: () => void }>();

export async function enqueueDeployment(
  projectId: string,
  branch: string,
  commitSha: string | null,
  commitMessage: string | null,
  author: string | null,
  rollbackOfId: string | null = null
): Promise<Deployment> {
  const deploymentId = `dep_${nanoid(10)}`;
  const deployment = createDeployment({
    id: deploymentId,
    project_id: projectId,
    branch,
    commit_sha: commitSha,
    commit_message: commitMessage,
    author,
    status: "QUEUED",
    started_at: null,
    finished_at: null,
    total_duration_ms: null,
    rollback_of_id: rollbackOfId,
  });

  // Trigger queue processing asynchronously
  processQueue(projectId).catch(err => {
    console.error(`Error processing queue for project ${projectId}:`, err);
  });

  return deployment;
}

export async function processQueue(projectId: string): Promise<void> {
  // 1. Check if there is already a running deployment for this project
  const running = getRunningDeployment(projectId);
  if (running) {
    // A deployment is already running, wait for it to finish.
    // It will trigger processQueue again upon completion.
    return;
  }

  // 2. Get the next queued deployment
  const queued = getQueuedDeployments(projectId);
  if (queued.length === 0) {
    return;
  }

  const nextDeployment = queued[0];
  const project = getProject(projectId);

  if (!project) {
    console.error(`Project ${projectId} not found for deployment ${nextDeployment.id}`);
    updateDeploymentStatus(nextDeployment.id, "FAILED", {
      finished_at: Date.now(),
      total_duration_ms: 0,
    });
    return;
  }

  try {
    // Execute the deployment pipeline
    await runDeploymentPipeline(project, nextDeployment);
  } catch (err) {
    console.error(`Pipeline exception for deployment ${nextDeployment.id}:`, err);
  } finally {
    // Process the next item in the queue
    processQueue(projectId).catch(err => {
      console.error(`Error in queue recursion for project ${projectId}:`, err);
    });
  }
}

export function cancelDeployment(id: string): { success: boolean; message: string } {
  const dep = getDeployment(id);
  if (!dep) {
    return { success: false, message: "Deployment not found" };
  }

  if (dep.status === "SUCCESS" || dep.status === "FAILED" || dep.status === "CANCELLED") {
    return { success: false, message: `Deployment already finished with status: ${dep.status}` };
  }

  if (dep.status === "QUEUED") {
    updateDeploymentStatus(id, "CANCELLED", {
      finished_at: Date.now(),
      total_duration_ms: 0,
    });
    appendDeploymentLog(id, "\n=== Deployment CANCELLED while in queue ===\n");
    return { success: true, message: "Queued deployment cancelled successfully" };
  }

  if (dep.status === "RUNNING") {
    // Set status to CANCELLED in DB first
    updateDeploymentStatus(id, "CANCELLED", {
      finished_at: Date.now(),
    });
    appendDeploymentLog(id, "\n=== Deployment CANCELLATION REQUESTED ===\n");

    // Check if we have an active process to kill
    const proc = activeProcesses.get(id);
    if (proc) {
      try {
        proc.kill();
        activeProcesses.delete(id);
        return { success: true, message: "Running deployment cancelled and terminated" };
      } catch (err: any) {
        return { success: true, message: `Running deployment status set to CANCELLED, but failed to kill process: ${err.message}` };
      }
    }

    return { success: true, message: "Running deployment marked as CANCELLED" };
  }

  return { success: false, message: "Unknown status" };
}
