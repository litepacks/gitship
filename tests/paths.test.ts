import fs from "fs";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  ensureDirsExist,
  readAuthConfig,
  writeAuthConfig,
  CONFIG_PATH,
  GITSHIP_DIR,
  BUILDS_DIR,
} from "../packages/core/src/paths.js";

describe("Paths and Storage Utility", () => {
  beforeAll(() => {
    // Ensure clean state before tests
    if (fs.existsSync(GITSHIP_DIR)) {
      fs.rmSync(GITSHIP_DIR, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(GITSHIP_DIR)) {
      fs.rmSync(GITSHIP_DIR, { recursive: true, force: true });
    }
  });

  it("should create configuration directories", () => {
    ensureDirsExist();
    expect(fs.existsSync(GITSHIP_DIR)).toBe(true);
    expect(fs.existsSync(BUILDS_DIR)).toBe(true);
  });

  it("should read empty config when no file exists", () => {
    const config = readAuthConfig();
    expect(config).toEqual({});
  });

  it("should write and read authentication configurations", () => {
    const authData = {
      github_token: "test_pat_token_123",
      github_username: "testuser",
    };
    writeAuthConfig(authData);
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);

    const readData = readAuthConfig();
    expect(readData).toEqual(authData);
  });

  it("should handle corrupt config file gracefully", () => {
    fs.writeFileSync(CONFIG_PATH, "{ corrupt json ...", "utf-8");
    const readData = readAuthConfig();
    expect(readData).toEqual({});
  });
});
