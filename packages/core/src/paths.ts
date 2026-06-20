import path from "path";
import os from "os";
import fs from "fs";

export const DEPLOYKIT_DIR = process.env.DEPLOYKIT_DIR || path.join(os.homedir(), ".deploykit");
export const CONFIG_PATH = path.join(DEPLOYKIT_DIR, "config.json");
export const DB_PATH = path.join(DEPLOYKIT_DIR, "deploykit.json");
export const BUILDS_DIR = path.join(DEPLOYKIT_DIR, "builds");

export function ensureDirsExist() {
  if (!fs.existsSync(DEPLOYKIT_DIR)) {
    fs.mkdirSync(DEPLOYKIT_DIR, { recursive: true });
  }
  if (!fs.existsSync(BUILDS_DIR)) {
    fs.mkdirSync(BUILDS_DIR, { recursive: true });
  }
}

export function readAuthConfig(): { github_token?: string; github_username?: string } {
  ensureDirsExist();
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function writeAuthConfig(config: { github_token: string; github_username?: string }) {
  ensureDirsExist();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
