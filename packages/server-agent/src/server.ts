import express, { Request, Response } from "express";
import crypto from "crypto";
import {
  getProjects,
  enqueueDeployment,
  isWebhookDeliveryProcessed,
  recordWebhookDelivery,
} from "gitship-core";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to capture raw body for HMAC signature verification
app.use(
  express.json({
    verify: (req: any, _res: any, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);

function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  try {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawBody);
    const digest = "sha256=" + hmac.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

app.post("/webhook/github", async (req: Request, res: Response): Promise<void> => {
  const event = req.headers["x-github-event"];
  const signature = req.headers["x-hub-signature-256"] as string;
  const deliveryId = req.headers["x-github-delivery"] as string;

  if (!event || event !== "push") {
    res.status(200).send("Ignored: Not a push event");
    return;
  }

  // Replay Protection
  if (deliveryId) {
    if (isWebhookDeliveryProcessed(deliveryId)) {
      console.log(`[Webhook] Ignored duplicate delivery: ${deliveryId}`);
      res.status(200).send("Ignored: Duplicate delivery");
      return;
    }
    recordWebhookDelivery(deliveryId);
  }

  const payload = req.body;
  if (!payload || !payload.repository || !payload.ref) {
    res.status(400).send("Bad Request: Missing payload details");
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const branch = payload.ref.replace("refs/heads/", "");

  // Find matching projects in the database
  const projects = getProjects().filter(
    (p) =>
      p.owner.toLowerCase() === owner.toLowerCase() &&
      p.repo.toLowerCase() === repo.toLowerCase() &&
      p.branch.toLowerCase() === branch.toLowerCase()
  );

  if (projects.length === 0) {
    console.log(`[Webhook] No matching active project found for ${owner}/${repo} branch ${branch}`);
    res.status(200).send(`Ignored: No active project matching ${owner}/${repo}:${branch}`);
    return;
  }

  const rawBody = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));

  // Process all matching projects (usually just 1, but we loop for safety)
  let authorizedCount = 0;
  for (const project of projects) {
    if (!verifyGitHubSignature(rawBody, signature, project.webhook_secret)) {
      console.warn(`[Webhook] Signature verification failed for project: ${project.name}`);
      continue;
    }

    authorizedCount++;

    const commitSha = payload.after !== "0000000000000000000000000000000000000000" ? payload.after : null;
    const commitMessage = payload.head_commit?.message || "Webhook trigger";
    const author = payload.head_commit?.author?.username || payload.pusher?.name || "github";

    console.log(`[Webhook] Enqueuing deployment for project ${project.name} (commit: ${commitSha})`);
    
    await enqueueDeployment(
      project.id,
      branch,
      commitSha,
      commitMessage,
      author
    );
  }

  if (authorizedCount === 0) {
    res.status(401).send("Unauthorized: Signature verification failed");
    return;
  }

  res.status(202).send("Accepted: Deployment enqueued");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "OK", time: new Date() });
});

app.listen(PORT, () => {
  console.log(`DeployKit Server Agent listening on port ${PORT}`);
});
