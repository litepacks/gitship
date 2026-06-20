import { Octokit } from "octokit";

export function getOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

export async function validateToken(token: string): Promise<{ username: string; name: string | null }> {
  const octokit = getOctokit(token);
  const { data } = await octokit.rest.users.getAuthenticated();
  return {
    username: data.login,
    name: data.name || null,
  };
}

export interface GitRepo {
  owner: string;
  name: string;
  fullName: string;
  url: string;
}

export async function listRepositories(token: string): Promise<GitRepo[]> {
  const octokit = getOctokit(token);
  const repos: GitRepo[] = [];
  
  // Fetch up to 100 repositories. In a real-world scenario we could paginate further,
  // but for an MVP 100 is typically enough or we can list top repos.
  const response = await octokit.rest.repos.listForAuthenticatedUser({
    per_page: 100,
    sort: "updated",
  });

  for (const repo of response.data) {
    repos.push({
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      url: repo.clone_url,
    });
  }

  return repos;
}

export async function listBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const octokit = getOctokit(token);
  const response = await octokit.rest.repos.listBranches({
    owner,
    repo,
    per_page: 100,
  });
  return response.data.map(b => b.name);
}

export interface WebhookConfig {
  owner: string;
  repo: string;
  webhookUrl: string;
  secret: string;
}

export async function setupWebhook(
  token: string,
  config: WebhookConfig
): Promise<{ id: number; url: string }> {
  const octokit = getOctokit(config.webhookUrl ? token : token); // ensure unused warning bypass
  
  // 1. List existing webhooks to find a duplicate
  const webhooks = await octokit.rest.repos.listWebhooks({
    owner: config.owner,
    repo: config.repo,
    per_page: 100,
  });

  const existing = webhooks.data.find(h => h.config.url === config.webhookUrl);

  if (existing) {
    // 2. Update webhook
    await octokit.rest.repos.updateWebhook({
      owner: config.owner,
      repo: config.repo,
      hook_id: existing.id,
      config: {
        url: config.webhookUrl,
        content_type: "json",
        secret: config.secret,
        insecure_ssl: "1",
      },
      events: ["push"],
      active: true,
    });
    return { id: existing.id, url: config.webhookUrl };
  } else {
    // 3. Create webhook
    const response = await octokit.rest.repos.createWebhook({
      owner: config.owner,
      repo: config.repo,
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: config.webhookUrl,
        content_type: "json",
        secret: config.secret,
        insecure_ssl: "1",
      },
    });
    return { id: response.data.id, url: config.webhookUrl };
  }
}

import { execa } from "execa";

export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    await execa("open", [url]);
  } else if (platform === "win32") {
    await execa("cmd", ["/c", "start", url]);
  } else {
    await execa("xdg-open", [url]);
  }
}
