import { describe, it, expect } from "vitest";
import { parseProjectConfig, stringifyProjectConfig } from "../packages/shared/src/config.schema.js";

describe("Project Config Validation", () => {
  it("should validate a correct deploykit.yml format", () => {
    const yamlContent = `
project: test-project
repository:
  owner: test-owner
  repo: test-repo
  branch: dev
target:
  type: ssh
  host: server.host:2222
  port: 22
  path: /opt/test
deploy:
  install: npm ci
  build: npm run build
  restart: pm2 restart all
logging:
  enabled: true
`;
    const config = parseProjectConfig(yamlContent);
    expect(config.project).toBe("test-project");
    expect(config.repository.owner).toBe("test-owner");
    expect(config.repository.branch).toBe("dev");
    expect(config.target.type).toBe("ssh");
    expect(config.target.host).toBe("server.host:2222");
    expect(config.target.port).toBe(22); // default
    expect(config.deploy.install).toBe("npm ci");
    
    // Stringify check
    const generatedYaml = stringifyProjectConfig(config);
    const reParsed = parseProjectConfig(generatedYaml);
    expect(reParsed.project).toBe("test-project");
  });

  it("should throw error on missing required field", () => {
    const yamlContent = `
project: test-project
repository:
  owner: test-owner
`;
    expect(() => parseProjectConfig(yamlContent)).toThrow();
  });

  it("should throw error on invalid project name characters", () => {
    const yamlContent = `
project: Invalid Project Name
repository:
  owner: test-owner
  repo: test-repo
  branch: main
target:
  type: local
  path: /tmp
`;
    expect(() => parseProjectConfig(yamlContent)).toThrow();
  });
});
