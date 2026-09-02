/**
 * `src/server/config.ts`: the boot warnings a configuration earns when it
 * puts the operator's shared credentials in reach of every visitor.
 */
import { describe, expect, it } from "vitest";
import { exposureWarnings, loadConfig } from "../../src/server/config.ts";

describe("the boot warning", () => {
  const config = (bindHost: string, defaultLevel: "view" | "interact" | "admin") =>
    loadConfig({ bindHost, defaultLevel });

  it("stays quiet on loopback, with no credentials, and when viewers only view", () => {
    const connector = { MCP_SERVERS: '[{"name":"W","url":"https://w.example/mcp"}]' };
    expect(exposureWarnings(config("127.0.0.1", "interact"), connector)).toEqual([]);
    expect(exposureWarnings(config("localhost", "interact"), connector)).toEqual([]);
    expect(exposureWarnings(config("::1", "interact"), connector)).toEqual([]);
    expect(exposureWarnings(config("0.0.0.0", "interact"), {})).toEqual([]);
    expect(exposureWarnings(config("0.0.0.0", "interact"), { MCP_BACKEND: "fake" })).toEqual([]);
    expect(exposureWarnings(config("0.0.0.0", "view"), connector)).toEqual([]);
  });

  it("names the credentials a bound-out server hands to every visitor", () => {
    const lines = exposureWarnings(config("0.0.0.0", "interact"), {
      MCP_SERVERS_FILE: "./mcp-servers.json",
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("ANTHROPIC_API_KEY and MCP_SERVERS");
    expect(lines.join("\n")).toContain("ARTIFACT_DEFAULT_LEVEL=view");
    const admin = exposureWarnings(config("192.168.1.4", "admin"), {
      MCP_SERVERS: '[{"name":"W","url":"https://w.example/mcp"}]',
    });
    expect(admin.join("\n")).toContain("gets admin");
    expect(admin.join("\n")).not.toContain("ANTHROPIC_API_KEY");
  });
});
