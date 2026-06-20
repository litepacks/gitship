#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import {
  parseProjectConfig,
  ProjectConfig,
  Project,
  Webhook,
} from "@deploykit/shared";
import http from "http";
import {
  readAuthConfig,
  writeAuthConfig,
  getDb,
  addProject,
  getProject,
  getProjects,
  removeProject,
  saveWebhook,
  getWebhookByProjectId,
  createDeployment,
  getDeployment,
  getDeployments,
  getDeploymentLog,
  getStats,
  enqueueDeployment,
  cancelDeployment,
  CONFIG_PATH,
} from "@deploykit/core";
import { validateToken, listRepositories, listBranches, setupWebhook, openBrowser } from "@deploykit/core";

const program = new Command();
program
  .name("deploykit")
  .description("Lightweight GitHub-driven deployment toolkit")
  .version("1.0.0");

// Helper to format duration
function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  return `${mins}m${remainingSecs}s`;
}

// Helper to format status with colors
function formatStatus(status: string): string {
  switch (status) {
    case "QUEUED":
      return chalk.yellow("QUEUED");
    case "RUNNING":
      return chalk.blue.bold("RUNNING");
    case "SUCCESS":
      return chalk.green("SUCCESS");
    case "FAILED":
      return chalk.red("FAILED");
    case "CANCELLED":
      return chalk.gray("CANCELLED");
    default:
      return status;
  }
}

function startCallbackServer(clientId: string, clientSecret: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = new URL(req.url || "", `http://localhost:${port}`);
        if (parsedUrl.pathname === "/callback") {
          const code = parsedUrl.searchParams.get("code");
          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end("<h1>Authentication Failed: Authorization code missing.</h1>");
            reject(new Error("Callback missing code"));
            server.close();
            return;
          }

          const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              code,
            }),
          });

          const tokenData = (await tokenRes.json()) as any;
          if (tokenData.error) {
            throw new Error(tokenData.error_description || tokenData.error);
          }

          if (!tokenData.access_token) {
            throw new Error("No access token returned from GitHub");
          }

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #f6f8fa;">
                <div style="display: inline-block; padding: 30px; background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                  <h1 style="color: #2da44e;">Authentication Successful!</h1>
                  <p style="color: #57606a;">You have successfully authenticated with DeployKit.</p>
                  <p style="color: #57606a;">You can close this tab and return to your terminal.</p>
                </div>
              </body>
            </html>
          `);

          resolve(tokenData.access_token);
          server.close();
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h1>Exchange failed: ${err.message}</h1>`);
        reject(err);
        server.close();
      }
    });

    server.listen(port, () => {
      // Server listening
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

// 1. AUTH GITHUB
program
  .command("auth")
  .description("Authentication commands")
  .command("github")
  .description("Authenticate with GitHub using a Personal Access Token or Browser OAuth")
  .action(async () => {
    try {
      const existing = readAuthConfig() as any;

      const { method } = await inquirer.prompt([
        {
          type: "list",
          name: "method",
          message: "Select authentication method:",
          choices: [
            { name: "Browser OAuth Redirect Login (Recommended)", value: "browser" },
            { name: "Personal Access Token (Manual)", value: "pat" },
          ],
        },
      ]);

      if (method === "browser") {
        console.log(chalk.cyan("\nDeployKit self-hosted Browser OAuth login flow."));
        console.log(`Please ensure you have a GitHub OAuth App registered:`);
        console.log(`1. Go to: ${chalk.bold("https://github.com/settings/developers")}`);
        console.log(`2. Register a new OAuth application.`);
        console.log(`3. Set ${chalk.bold("Homepage URL")} to: ${chalk.underline("http://localhost:4567")}`);
        console.log(`4. Set ${chalk.bold("Authorization callback URL")} to: ${chalk.underline("http://localhost:4567/callback")}\n`);

        const credentials = await inquirer.prompt([
          {
            type: "input",
            name: "clientId",
            message: "Enter your GitHub OAuth App Client ID:",
            default: existing.github_oauth_client_id || "",
            validate: (input) => (input.trim() ? true : "Client ID is required"),
          },
          {
            type: "password",
            name: "clientSecret",
            message: "Enter your GitHub OAuth App Client Secret:",
            default: existing.github_oauth_client_secret || "",
            mask: "*",
            validate: (input) => (input.trim() ? true : "Client Secret is required"),
          },
        ]);

        const port = 4567;
        const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${credentials.clientId}&redirect_uri=http://localhost:${port}/callback&scope=repo,admin:repo_hook`;

        const serverPromise = startCallbackServer(credentials.clientId, credentials.clientSecret, port);

        console.log(chalk.cyan(`\nOpening browser for GitHub authorization...`));
        await openBrowser(authorizeUrl);

        const spinner = ora("Waiting for redirection on localhost:4567...").start();

        try {
          const token = await serverPromise;
          spinner.text = "Validating acquired OAuth token...";
          
          const { username, name } = await validateToken(token);
          spinner.succeed(`Token validated! Hello, ${name || username} (@${username}).`);

          writeAuthConfig({
            ...existing,
            github_token: token,
            github_username: username,
            github_oauth_client_id: credentials.clientId,
            github_oauth_client_secret: credentials.clientSecret,
          });

          console.log(chalk.green("GitHub Browser OAuth authentication successful!"));
        } catch (err: any) {
          spinner.fail(`OAuth Authentication failed: ${err.message || err}`);
        }
      } else {
        const answers = await inquirer.prompt([
          {
            type: "password",
            name: "token",
            message: "Enter your GitHub Fine-Grained Personal Access Token:",
            mask: "*",
            validate: (input) => (input.trim() ? true : "Token cannot be empty"),
          },
        ]);

        const spinner = ora("Validating token...").start();
        try {
          const { username, name } = await validateToken(answers.token);
          spinner.succeed(`Token validated! Hello, ${name || username} (@${username}).`);
          
          // Save token
          writeAuthConfig({
            ...existing,
            github_token: answers.token,
            github_username: username,
          });

          console.log(chalk.green("GitHub authentication token saved successfully."));
        } catch (err: any) {
          spinner.fail(`Validation failed: ${err.message || err}`);
        }
      }
    } catch (err: any) {
      console.error(chalk.red(`Error during authentication: ${err.message}`));
    }
  });

// 2. PROJECT INIT
program
  .command("init")
  .description("Initialize a new DeployKit project in the current directory")
  .action(async () => {
    try {
      const auth = readAuthConfig();
      if (!auth.github_token) {
        console.error(chalk.red("Error: Not authenticated. Please run 'deploykit auth github' first."));
        return;
      }

      // Fetch user repos
      const spinner = ora("Loading repositories from GitHub...").start();
      let repos;
      try {
        repos = await listRepositories(auth.github_token);
        spinner.succeed(`Loaded ${repos.length} repositories.`);
      } catch (err: any) {
        spinner.fail(`Failed to load repositories: ${err.message}`);
        return;
      }

      if (repos.length === 0) {
        console.error(chalk.yellow("No repositories found in your GitHub account."));
        return;
      }

      const repoChoices = repos.map((r) => ({
        name: r.fullName,
        value: r,
      }));

      const { selectedRepo } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedRepo",
          message: "Select a GitHub repository to deploy:",
          choices: repoChoices,
        },
      ]);

      // Fetch branches for that repo
      const branchSpinner = ora(`Fetching branches for ${selectedRepo.fullName}...`).start();
      let branches: string[] = [];
      try {
        branches = await listBranches(auth.github_token, selectedRepo.owner, selectedRepo.name);
        branchSpinner.succeed(`Fetched ${branches.length} branches.`);
      } catch (err: any) {
        branchSpinner.fail(`Failed to fetch branches: ${err.message}`);
        branches = ["main", "master"]; // Fallbacks
      }

      const { selectedBranch } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedBranch",
          message: "Select deployment branch:",
          choices: branches,
          default: branches.includes("main") ? "main" : branches[0],
        },
      ]);

      // Auto-detect project type in current directory
      let detectedType = "Node";
      let installDefault = "npm ci";
      let buildDefault = "npm run build";
      let restartDefault = "npm start";

      if (fs.existsSync(path.join(process.cwd(), "docker-compose.yml"))) {
        detectedType = "Docker Compose";
        installDefault = "";
        buildDefault = "";
        restartDefault = "docker-compose up -d --build";
      } else if (fs.existsSync(path.join(process.cwd(), "Dockerfile"))) {
        detectedType = "Docker";
        installDefault = "";
        buildDefault = "";
        restartDefault = `docker build -t ${selectedRepo.name} . && docker run -d --name ${selectedRepo.name} -p 80:80 ${selectedRepo.name}`;
      } else if (fs.existsSync(path.join(process.cwd(), "wrangler.toml"))) {
        detectedType = "Cloudflare";
        installDefault = "npm install";
        buildDefault = "";
        restartDefault = "npx wrangler deploy";
      } else if (fs.existsSync(path.join(process.cwd(), "vercel.json"))) {
        detectedType = "Vercel";
        installDefault = "";
        buildDefault = "";
        restartDefault = "npx vercel --prod --yes";
      } else if (fs.existsSync(path.join(process.cwd(), "ecosystem.config.js"))) {
        detectedType = "PM2";
        installDefault = "npm ci";
        buildDefault = "npm run build";
        restartDefault = `pm2 restart ${selectedRepo.name}`;
      } else if (fs.existsSync(path.join(process.cwd(), "package.json"))) {
        detectedType = "Node";
        installDefault = "npm ci";
        buildDefault = "npm run build";
        restartDefault = `node dist/index.js`;
      } else {
        detectedType = "Generic/Unknown";
        installDefault = "";
        buildDefault = "";
        restartDefault = "";
      }

      console.log(chalk.cyan(`\nAuto-detected project type: ${chalk.bold(detectedType)}`));

      const details = await inquirer.prompt([
        {
          type: "input",
          name: "projectName",
          message: "Enter project name:",
          default: selectedRepo.name,
          validate: (input) =>
            /^[a-zA-Z0-9_-]+$/.test(input)
              ? true
              : "Project name can only contain letters, numbers, underscores, and dashes",
        },
        {
          type: "list",
          name: "targetType",
          message: "Select deployment target type:",
          choices: [
            { name: "Local Server (Deploy on the current agent machine)", value: "local" },
            { name: "Remote Server (Deploy via SSH)", value: "ssh" },
          ],
        },
        {
          type: "input",
          name: "sshHost",
          message: "Enter SSH Host (e.g. server.example.com or user@server.example.com):",
          when: (answers) => answers.targetType === "ssh",
          validate: (input) => (input.trim() ? true : "SSH Host is required"),
        },
        {
          type: "input",
          name: "targetPath",
          message: "Enter deployment path on target machine:",
          default: (answers: any) =>
            answers.targetType === "ssh"
              ? `/var/www/${answers.projectName}`
              : path.join(process.cwd(), "dist-deploy"),
          validate: (input) => (input.trim() ? true : "Target path is required"),
        },
        {
          type: "input",
          name: "installCmd",
          message: "Install dependencies command:",
          default: installDefault,
        },
        {
          type: "input",
          name: "buildCmd",
          message: "Build project command:",
          default: buildDefault,
        },
        {
          type: "input",
          name: "restartCmd",
          message: "Restart application command:",
          default: restartDefault,
        },
      ]);

      // Construct config content
      const config: ProjectConfig = {
        project: details.projectName,
        repository: {
          owner: selectedRepo.owner,
          repo: selectedRepo.name,
          branch: selectedBranch,
        },
        target: {
          type: details.targetType,
          host: details.sshHost || undefined,
          port: 22,
          path: details.targetPath,
        },
        deploy: {
          install: details.installCmd || undefined,
          build: details.buildCmd || undefined,
          restart: details.restartCmd || undefined,
        },
        logging: {
          enabled: true,
        },
      };

      // Write yaml file
      const { stringifyProjectConfig } = await import("@deploykit/shared");
      const yamlStr = stringifyProjectConfig(config);
      const configFilePath = path.join(process.cwd(), "deploykit.yml");
      
      fs.writeFileSync(configFilePath, yamlStr, "utf-8");
      console.log(chalk.green(`\nSuccess: Generated ${chalk.bold("deploykit.yml")} at ${configFilePath}\n`));
      console.log(chalk.gray(yamlStr));
      console.log(`Run ${chalk.bold("deploykit sync")} to configure the webhooks and link this project.`);
    } catch (err: any) {
      console.error(chalk.red(`Error during initialization: ${err.message}`));
    }
  });

// 3. PROJECT SYNC
program
  .command("sync")
  .description("Sync deploykit.yml config with database and GitHub webhook")
  .action(async () => {
    try {
      const configPath = path.join(process.cwd(), "deploykit.yml");
      if (!fs.existsSync(configPath)) {
        console.error(chalk.red("Error: deploykit.yml not found. Please run 'deploykit init' to generate it."));
        return;
      }

      const rawYaml = fs.readFileSync(configPath, "utf-8");
      let newConfig: ProjectConfig;
      try {
        newConfig = parseProjectConfig(rawYaml);
      } catch (err: any) {
        console.error(chalk.red("Error: deploykit.yml validation failed."));
        console.error(err.message || err);
        return;
      }

      // Check if project exists to print diff
      const oldProject = getProject(newConfig.project);
      if (oldProject) {
        console.log(chalk.yellow(`\nProject "${newConfig.project}" already exists in the database. Comparing changes:`));
        
        let hasChanges = false;
        const compare = (field: string, oldVal: any, newVal: any) => {
          if (oldVal !== newVal) {
            console.log(`  ${chalk.cyan(field)}: ${chalk.red(oldVal ?? "none")} -> ${chalk.green(newVal ?? "none")}`);
            hasChanges = true;
          }
        };

        compare("Repository Owner", oldProject.owner, newConfig.repository.owner);
        compare("Repository Name", oldProject.repo, newConfig.repository.repo);
        compare("Branch", oldProject.branch, newConfig.repository.branch);
        compare("Target Type", oldProject.target_type, newConfig.target.type);
        compare("Target Host", oldProject.target_host, newConfig.target.host);
        compare("Target Path", oldProject.target_path, newConfig.target.path);
        compare("Install Command", oldProject.install_cmd, newConfig.deploy.install);
        compare("Build Command", oldProject.build_cmd, newConfig.deploy.build);
        compare("Restart Command", oldProject.restart_cmd, newConfig.deploy.restart);

        if (!hasChanges) {
          console.log(chalk.gray("  No configuration changes detected."));
        }

        const confirm = await inquirer.prompt([
          {
            type: "confirm",
            name: "proceed",
            message: "Do you want to apply these changes?",
            default: true,
          },
        ]);

        if (!confirm.proceed) {
          console.log("Sync cancelled.");
          return;
        }
      }

      // We need agent URL to construct webhook endpoint on GitHub
      const auth = readAuthConfig();
      if (!auth.github_token) {
        console.error(chalk.red("Error: Not authenticated. Please run 'deploykit auth github' first."));
        return;
      }

      // Get or prompt for agent public URL
      let agentUrl = (auth as any).agent_url;
      if (!agentUrl) {
        const answers = await inquirer.prompt([
          {
            type: "input",
            name: "url",
            message: "Enter the public base URL of your Server Agent (e.g. http://my-server.com:3000):",
            validate: (input) => {
              try {
                new URL(input);
                return true;
              } catch {
                return "Please enter a valid URL (including protocol http/https)";
              }
            },
          },
        ]);
        agentUrl = answers.url;
        // Save the URL to config.json
        writeAuthConfig({
          ...auth,
          agent_url: agentUrl,
        } as any);
      }

      const webhookUrl = `${agentUrl.replace(/\/$/, "")}/webhook/github`;

      // Generate or reuse webhook secret
      const webhookSecret = oldProject?.webhook_secret || `sec_${nanoid(15)}`;

      const spinner = ora("Registering/Updating GitHub Webhook...").start();
      let webhookInfo;
      try {
        webhookInfo = await setupWebhook(auth.github_token, {
          owner: newConfig.repository.owner,
          repo: newConfig.repository.repo,
          webhookUrl,
          secret: webhookSecret,
        });
        spinner.succeed(`GitHub Webhook configured successfully (ID: ${webhookInfo.id})`);
      } catch (err: any) {
        spinner.fail(`Failed to register GitHub Webhook: ${err.message || err}`);
        console.error(chalk.yellow("Note: If the repository is private or your token doesn't have hooks write scope, this step will fail."));
        
        // Ask if they want to proceed saving locally anyway
        const forceSave = await inquirer.prompt([
          {
            type: "confirm",
            name: "save",
            message: "Save project settings locally anyway without configuring webhook on GitHub?",
            default: false,
          },
        ]);

        if (!forceSave.save) {
          return;
        }
        
        // Mock webhook info
        webhookInfo = { id: null, url: webhookUrl };
      }

      // Add to database
      const projectRecord: Project = {
        id: oldProject?.id || `proj_${nanoid(8)}`,
        name: newConfig.project,
        owner: newConfig.repository.owner,
        repo: newConfig.repository.repo,
        branch: newConfig.repository.branch,
        target_type: newConfig.target.type,
        target_host: newConfig.target.host,
        target_path: newConfig.target.path,
        install_cmd: newConfig.deploy.install,
        build_cmd: newConfig.deploy.build,
        restart_cmd: newConfig.deploy.restart,
        healthcheck_path: newConfig.deploy.healthcheck?.path,
        healthcheck_port: newConfig.deploy.healthcheck?.port,
        healthcheck_retries: newConfig.deploy.healthcheck?.retries,
        healthcheck_interval_ms: newConfig.deploy.healthcheck?.interval_ms,
        healthcheck_timeout_ms: newConfig.deploy.healthcheck?.timeout_ms,
        webhook_secret: webhookSecret,
        created_at: oldProject?.created_at || Date.now(),
        updated_at: Date.now(),
      };

      addProject(projectRecord);

      // Save webhook record
      const webhookRecord: Webhook = {
        id: oldProject ? (getWebhookByProjectId(oldProject.id)?.id || `wh_${nanoid(8)}`) : `wh_${nanoid(8)}`,
        project_id: projectRecord.id,
        github_webhook_id: webhookInfo.id,
        url: webhookInfo.url,
        secret: webhookSecret,
        active: true,
        created_at: Date.now(),
      };

      saveWebhook(webhookRecord);

      console.log(chalk.green(`\nSuccess: Project "${newConfig.project}" synced and stored in local database.`));
      console.log(`Webhook Endpoint URL: ${chalk.bold(webhookInfo.url)}`);
    } catch (err: any) {
      console.error(chalk.red(`Error during sync: ${err.message}`));
    }
  });

// 4. RUNS LIST
program
  .command("runs")
  .description("List past deployment runs")
  .option("--last <n>", "Limit output to the last N runs", "20")
  .action((options) => {
    try {
      const limit = parseInt(options.last);
      const runs = getDeployments(undefined, limit);
      
      if (runs.length === 0) {
        console.log(chalk.yellow("No deployment runs found in the database."));
        return;
      }

      console.log(chalk.bold("\nLast Deployments:"));
      console.log(
        chalk.gray("--------------------------------------------------------------------------------")
      );
      console.log(
        `${chalk.bold("ID").padEnd(14)} ${chalk.bold("Project").padEnd(15)} ${chalk.bold(
          "Branch"
        ).padEnd(10)} ${chalk.bold("Commit").padEnd(8)} ${chalk.bold("Status").padEnd(20)} ${chalk.bold(
          "Duration"
        )}`
      );
      console.log(
        chalk.gray("--------------------------------------------------------------------------------")
      );

      for (const run of runs) {
        const project = getProject(run.project_id);
        const projectName = project ? project.name : run.project_id;
        const commitSha = run.commit_sha ? run.commit_sha.substring(0, 7) : "latest";
        const durationStr = formatDuration(run.total_duration_ms);
        
        console.log(
          `${run.id.padEnd(14)} ${projectName.substring(0, 14).padEnd(15)} ${run.branch.substring(0, 9).padEnd(
            10
          )} ${commitSha.padEnd(8)} ${formatStatus(run.status).padEnd(20)} ${durationStr}`
        );
      }
      console.log();
    } catch (err: any) {
      console.error(chalk.red(`Error loading runs: ${err.message}`));
    }
  });

// 5. RUN LOGS
program
  .command("logs <id>")
  .description("View the output logs of a specific deployment run")
  .option("-f, --follow", "Follow/stream the log output in real-time")
  .action(async (id, options) => {
    try {
      const run = getDeployment(id);
      if (!run) {
        console.error(chalk.red(`Error: Deployment run "${id}" not found.`));
        return;
      }

      const project = getProject(run.project_id);
      const projectName = project ? project.name : run.project_id;
      console.log(chalk.bold(`Logs for Deployment #${id} (${projectName} - ${run.branch}):`));
      console.log(chalk.gray("--------------------------------------------------------------------------------"));

      let lastPrintedLength = 0;

      const printNewLogs = () => {
        const fullLog = getDeploymentLog(id);
        if (fullLog && fullLog.length > lastPrintedLength) {
          const newChunk = fullLog.substring(lastPrintedLength);
          process.stdout.write(newChunk);
          lastPrintedLength = fullLog.length;
        }
      };

      // Print whatever exists right now
      printNewLogs();

      if (options.follow && (run.status === "RUNNING" || run.status === "QUEUED")) {
        const timer = setInterval(() => {
          const currentRun = getDeployment(id);
          if (!currentRun) {
            clearInterval(timer);
            return;
          }

          printNewLogs();

          if (currentRun.status !== "RUNNING" && currentRun.status !== "QUEUED") {
            clearInterval(timer);
            // final print diff
            printNewLogs();
            console.log(chalk.gray("\n--------------------------------------------------------------------------------"));
            console.log(`Deployment finished with status: ${formatStatus(currentRun.status)}`);
            console.log(`Total duration: ${formatDuration(currentRun.total_duration_ms)}`);
          }
        }, 500);

        // Keep process open
        process.on("SIGINT", () => {
          clearInterval(timer);
          console.log(chalk.yellow("\nLog streaming stopped by user."));
          process.exit(0);
        });
      } else {
        console.log(chalk.gray("\n--------------------------------------------------------------------------------"));
        console.log(`Deployment status: ${formatStatus(run.status)}`);
        console.log(`Total duration: ${formatDuration(run.total_duration_ms)}`);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error loading logs: ${err.message}`));
    }
  });

// 6. STATISTICS
program
  .command("stats")
  .description("View project deployment metrics and statistics")
  .option("--project <name>", "Filter stats by a specific project name")
  .action((options) => {
    try {
      let projectId: string | undefined;
      let projectTitle = "All Projects";

      if (options.project) {
        const p = getProject(options.project);
        if (!p) {
          console.error(chalk.red(`Error: Project "${options.project}" not found.`));
          return;
        }
        projectId = p.id;
        projectTitle = `Project: ${p.name}`;
      }

      const stats = getStats(projectId);

      console.log(chalk.bold(`\n=== Deployment Statistics [${projectTitle}] ===\n`));
      console.log(`Total Deployments:        ${chalk.cyan(stats.totalDeployments)}`);
      
      const successColor = stats.successRate > 90 ? chalk.green : stats.successRate > 70 ? chalk.yellow : chalk.red;
      console.log(`Success Rate:             ${successColor(`${stats.successRate}%`)}`);
      
      console.log(`Average Deployment Time:  ${chalk.cyan(formatDuration(stats.avgDeployTimeMs))}`);
      console.log(`Average Build Step Time:  ${chalk.cyan(formatDuration(stats.avgBuildTimeMs))}`);
      console.log(`Fastest Deployment:       ${chalk.green(formatDuration(stats.fastestDeployMs))}`);
      console.log(`Slowest Deployment:       ${chalk.red(formatDuration(stats.slowestDeployMs))}`);
      console.log();
    } catch (err: any) {
      console.error(chalk.red(`Error loading stats: ${err.message}`));
    }
  });

// 7. ROLLBACK
program
  .command("rollback <deployment-id>")
  .description("Rollback project to a previous successful deployment")
  .action(async (id) => {
    try {
      const dep = getDeployment(id);
      if (!dep) {
        console.error(chalk.red(`Error: Deployment run "${id}" not found.`));
        return;
      }

      if (dep.status !== "SUCCESS") {
        console.error(chalk.red(`Error: Cannot rollback to deployment "${id}" because its status is ${dep.status}. Only SUCCESS status is rollback target.`));
        return;
      }

      const project = getProject(dep.project_id);
      if (!project) {
        console.error(chalk.red(`Error: Associated project "${dep.project_id}" not found.`));
        return;
      }

      console.log(chalk.yellow(`\nInitiating rollback of project "${project.name}" to deployment #${id}`));
      console.log(`Target Commit:  ${dep.commit_sha ? dep.commit_sha.substring(0, 7) : "latest"} - "${dep.commit_message || ""}"`);
      console.log(`Target Branch:  ${dep.branch}`);

      const confirm = await inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: "Are you sure you want to trigger this rollback?",
          default: true,
        },
      ]);

      if (!confirm.proceed) {
        console.log("Rollback cancelled.");
        return;
      }

      const spinner = ora("Enqueuing rollback deployment...").start();
      try {
        const rollbackDep = await enqueueDeployment(
          project.id,
          dep.branch,
          dep.commit_sha,
          `Rollback to #${id}`,
          `Rollback (triggered via CLI)`,
          id
        );
        spinner.succeed(`Rollback enqueued successfully!`);
        console.log(`New Deployment ID: ${chalk.bold(rollbackDep.id)}`);
        console.log(`Run ${chalk.bold(`deploykit logs ${rollbackDep.id} -f`)} to watch execution.`);
      } catch (err: any) {
        spinner.fail(`Failed to enqueue rollback: ${err.message || err}`);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error during rollback: ${err.message}`));
    }
  });

// 8. QUEUE & CANCEL
program
  .command("queue")
  .description("List deployments that are currently QUEUED or RUNNING")
  .action(() => {
    try {
      const allDeploys = getDeployments();
      const activeDeploys = allDeploys.filter(d => d.status === "QUEUED" || d.status === "RUNNING");

      if (activeDeploys.length === 0) {
        console.log(chalk.green("No active or queued deployments. The queue is empty."));
        return;
      }

      console.log(chalk.bold("\nActive Queue:"));
      console.log(
        chalk.gray("--------------------------------------------------------------------------------")
      );
      console.log(
        `${chalk.bold("ID").padEnd(14)} ${chalk.bold("Project").padEnd(15)} ${chalk.bold(
          "Branch"
        ).padEnd(10)} ${chalk.bold("Commit").padEnd(8)} ${chalk.bold("Status")}`
      );
      console.log(
        chalk.gray("--------------------------------------------------------------------------------")
      );

      for (const run of activeDeploys) {
        const project = getProject(run.project_id);
        const projectName = project ? project.name : run.project_id;
        const commitSha = run.commit_sha ? run.commit_sha.substring(0, 7) : "latest";
        console.log(
          `${run.id.padEnd(14)} ${projectName.substring(0, 14).padEnd(15)} ${run.branch.substring(0, 9).padEnd(
            10
          )} ${commitSha.padEnd(8)} ${formatStatus(run.status)}`
        );
      }
      console.log();
    } catch (err: any) {
      console.error(chalk.red(`Error reading queue: ${err.message}`));
    }
  });

program
  .command("cancel <id>")
  .description("Cancel a queued or running deployment")
  .action((id) => {
    try {
      const spinner = ora(`Requesting cancellation for deployment ${id}...`).start();
      const res = cancelDeployment(id);
      if (res.success) {
        spinner.succeed(res.message);
      } else {
        spinner.fail(res.message);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error cancelling deployment: ${err.message}`));
    }
  });

// 9. PROJECT COMMANDS
const projectsCmd = program
  .command("projects")
  .description("List all configured projects in the database")
  .action(() => {
    try {
      const projects = getProjects();
      if (projects.length === 0) {
        console.log(chalk.yellow("No projects found in the database. Run 'deploykit init' to create one."));
        return;
      }

      console.log(chalk.bold("\nConfigured Projects:"));
      console.log(
        chalk.gray("--------------------------------------------------------------------------------")
      );
      console.log(
        `${chalk.bold("Name").padEnd(15)} ${chalk.bold("Repository").padEnd(30)} ${chalk.bold(
          "Branch"
        ).padEnd(12)} ${chalk.bold("Target Path")}`
      );
      console.log(
        chalk.gray("--------------------------------------------------------------------------------")
      );

      for (const project of projects) {
        const repoStr = `${project.owner}/${project.repo}`;
        console.log(
          `${project.name.padEnd(15)} ${repoStr.substring(0, 29).padEnd(30)} ${project.branch.padEnd(12)} ${project.target_path}`
        );
      }
      console.log();
    } catch (err: any) {
      console.error(chalk.red(`Error loading projects: ${err.message}`));
    }
  });

// project subcommand container for add/remove/inspect
const projectCmd = program.command("project").description("Manage individual projects");

projectCmd
  .command("add <file>")
  .description("Manually register a project from a deploykit.yml config file")
  .action((file) => {
    try {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`Error: File "${file}" not found.`));
        return;
      }

      const rawYaml = fs.readFileSync(filePath, "utf-8");
      let config: ProjectConfig;
      try {
        config = parseProjectConfig(rawYaml);
      } catch (err: any) {
        console.error(chalk.red("Error: Config validation failed."));
        console.error(err.message || err);
        return;
      }

      const secret = `sec_${nanoid(15)}`;
      const projectRecord: Project = {
        id: `proj_${nanoid(8)}`,
        name: config.project,
        owner: config.repository.owner,
        repo: config.repository.repo,
        branch: config.repository.branch,
        target_type: config.target.type,
        target_host: config.target.host,
        target_path: config.target.path,
        install_cmd: config.deploy.install,
        build_cmd: config.deploy.build,
        restart_cmd: config.deploy.restart,
        healthcheck_path: config.deploy.healthcheck?.path,
        healthcheck_port: config.deploy.healthcheck?.port,
        healthcheck_retries: config.deploy.healthcheck?.retries,
        healthcheck_interval_ms: config.deploy.healthcheck?.interval_ms,
        healthcheck_timeout_ms: config.deploy.healthcheck?.timeout_ms,
        webhook_secret: secret,
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      addProject(projectRecord);
      console.log(chalk.green(`Successfully registered project "${config.project}" manually.`));
      console.log(`Webhook Secret: ${chalk.bold(secret)}`);
    } catch (err: any) {
      console.error(chalk.red(`Error registering project: ${err.message}`));
    }
  });

projectCmd
  .command("remove <name>")
  .description("Remove a project from the database")
  .action(async (name) => {
    try {
      const project = getProject(name);
      if (!project) {
        console.error(chalk.red(`Error: Project "${name}" not found.`));
        return;
      }

      const confirm = await inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: `Are you sure you want to delete project "${name}"? This removes its configuration and deployment history!`,
          default: false,
        },
      ]);

      if (!confirm.proceed) {
        console.log("Cancelled.");
        return;
      }

      removeProject(project.id);
      console.log(chalk.green(`Project "${name}" removed from database.`));
    } catch (err: any) {
      console.error(chalk.red(`Error removing project: ${err.message}`));
    }
  });

projectCmd
  .command("inspect <name>")
  .description("Inspect project configurations and webhook secrets")
  .action((name) => {
    try {
      const project = getProject(name);
      if (!project) {
        console.error(chalk.red(`Error: Project "${name}" not found.`));
        return;
      }

      const webhook = getWebhookByProjectId(project.id);

      console.log(chalk.bold(`\n=== Project: ${project.name} ===`));
      console.log(`Database ID:     ${project.id}`);
      console.log(`Repository:      https://github.com/${project.owner}/${project.repo} (Branch: ${project.branch})`);
      console.log(`Target Type:     ${project.target_type}`);
      if (project.target_type === "ssh") {
        console.log(`Target Host:     ${project.target_host}`);
      }
      console.log(`Target Path:     ${project.target_path}`);
      console.log(`Install Cmd:     ${project.install_cmd || chalk.gray("none")}`);
      console.log(`Build Cmd:       ${project.build_cmd || chalk.gray("none")}`);
      console.log(`Restart Cmd:     ${project.restart_cmd || chalk.gray("none")}`);
      
      console.log(chalk.bold(`\n--- Webhook Settings ---`));
      if (webhook) {
        console.log(`Webhook URL:     ${webhook.url}`);
        console.log(`GitHub Hook ID:  ${webhook.github_webhook_id || chalk.gray("none (registered locally)")}`);
        console.log(`HMAC Secret:     ${webhook.secret}`);
        console.log(`Status:          ${webhook.active ? chalk.green("active") : chalk.red("inactive")}`);
      } else {
        console.log(chalk.yellow("No webhook settings found in database. Run 'deploykit sync' to set it up."));
      }

      const projectRuns = getDeployments(project.id, 5);
      console.log(chalk.bold(`\n--- Recent Runs ---`));
      if (projectRuns.length === 0) {
        console.log(chalk.gray("No runs recorded yet."));
      } else {
        for (const run of projectRuns) {
          const durationStr = formatDuration(run.total_duration_ms);
          console.log(`  #${run.id.substring(0, 10)} - [${formatStatus(run.status)}] - ${run.commit_sha?.substring(0, 7) || "latest"} - ${run.commit_message || "no message"} (${durationStr})`);
        }
      }
      console.log();
    } catch (err: any) {
      console.error(chalk.red(`Error inspecting project: ${err.message}`));
    }
  });

program.parse(process.argv);
