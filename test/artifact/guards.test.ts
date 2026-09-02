/**
 * The two spine guards (`src/server/guards.ts`): which `Host` each app
 * answers to, and which non-GET requests the shell origin accepts.
 *
 * Both halves are exercised over real sockets, because the header that
 * matters — `Host` — cannot be set through `fetch`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.ts";
import { hostnameOf, isKnownHost } from "../../src/server/guards.ts";
import { startServer, type RunningServer } from "../../src/server/index.ts";

const ID = "a".repeat(32);

describe("hostnameOf", () => {
  it("takes the name out of a Host header", () => {
    expect(hostnameOf("localhost:8787")).toBe("localhost");
    expect(hostnameOf("Shell.Example")).toBe("shell.example");
    expect(hostnameOf("  shell.example:443  ")).toBe("shell.example");
    expect(hostnameOf("[::1]:8788")).toBe("::1");
    expect(hostnameOf("[::1]")).toBe("::1");
  });

  it("answers null when there is no usable host", () => {
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf("")).toBeNull();
    expect(hostnameOf("   ")).toBeNull();
    expect(hostnameOf(":8787")).toBeNull();
    expect(hostnameOf("[")).toBeNull();
  });
});

describe("isKnownHost", () => {
  const config = loadConfig({
    shellHost: "shell.example",
    frameHostSuffix: "frames.example",
    allowedHosts: ["proxy.internal"],
  });

  it("accepts the shell host on the shell origin and nothing else", () => {
    expect(isKnownHost(config, "shell", "shell.example:8787")).toBe(true);
    expect(isKnownHost(config, "shell", "SHELL.example")).toBe(true);
    expect(isKnownHost(config, "shell", "evil.example")).toBe(false);
    // The frame origin's hosts are a different app's.
    expect(isKnownHost(config, "shell", `${ID}.frames.example`)).toBe(false);
  });

  it("accepts an artifact host and the bare suffix on the frame origin", () => {
    expect(isKnownHost(config, "frame", `${ID}.frames.example:8788`)).toBe(true);
    expect(isKnownHost(config, "frame", "frames.example")).toBe(true);
    // The label must be an artifact id, and the suffix must match on labels.
    expect(isKnownHost(config, "frame", "www.frames.example")).toBe(false);
    expect(isKnownHost(config, "frame", "notframes.example")).toBe(false);
    expect(isKnownHost(config, "frame", `${ID}.frames.example.evil.test`)).toBe(false);
    expect(isKnownHost(config, "frame", "shell.example")).toBe(false);
  });

  it("accepts loopback literals and ARTIFACT_ALLOWED_HOSTS on both", () => {
    for (const kind of ["shell", "frame"] as const) {
      expect(isKnownHost(config, kind, "127.0.0.1:8787")).toBe(true);
      expect(isKnownHost(config, kind, "[::1]:8787")).toBe(true);
      expect(isKnownHost(config, kind, "proxy.internal")).toBe(true);
    }
  });

  it("refuses a request with no Host at all", () => {
    expect(isKnownHost(config, "shell", undefined)).toBe(false);
    expect(isKnownHost(config, "frame", "")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* over a socket                                                       */
/* ------------------------------------------------------------------ */

interface RawResponse {
  status: number;
  body: string;
}

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (chunk) => (out += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("the guards over a socket", () => {
  let server: RunningServer;
  let dataDir: string;
  let html: string;
  let artifact: { id: string; version: string };
  let shellHost: string;

  const json = (extra: Record<string, string> = {}): Record<string, string> => ({
    host: shellHost,
    "content-type": "application/json",
    ...extra,
  });

  const createBody = (): string => JSON.stringify({ html, capabilities: { artifact: {} } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "guards-"));
    html = await readFile("fixtures/artifact.html", "utf8");
    // The documented open dev box: the admin API takes no credential, so a
    // rebound page would be creating artifacts if the host went unchecked.
    server = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      defaultLevel: "admin",
      openAdminApi: true,
      allowPrefixHosts: true,
    });
    shellHost = `localhost:${server.shellPort}`;
    const created = await raw(server.shellPort, "POST", "/api/artifacts", json(), createBody());
    expect(created.status).toBe(200);
    artifact = JSON.parse(created.body) as { id: string; version: string };
  });

  afterAll(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("the host guard", () => {
    it("refuses a rebound name on the shell origin", async () => {
      // The finding's repro: `Host: evil.com` plus a content type nobody
      // preflights used to create an artifact — with `sample` declared, on
      // the operator's API key.
      const rebound = await raw(
        server.shellPort,
        "POST",
        "/api/artifacts",
        { host: "evil.com", "content-type": "text/plain" },
        JSON.stringify({ html, capabilities: { sample: {} } }),
      );
      expect(rebound.status).toBe(403);
      expect(rebound.body).toBe("unknown host");

      // Not the content type doing the work: a well-formed request from the
      // same rebound name is refused too, and so is a plain page load.
      expect(
        (await raw(
          server.shellPort,
          "POST",
          "/api/artifacts",
          { host: "evil.com", "content-type": "application/json" },
          createBody(),
        )).status,
      ).toBe(403);
      expect(
        (await raw(server.shellPort, "GET", `/a/${artifact.id}`, { host: "evil.com" })).status,
      ).toBe(403);
    });

    it("refuses a rebound name on the frame origin", async () => {
      const path = `/_a/${artifact.id}/_f/${artifact.version}/index.html`;
      expect((await raw(server.framePort, "GET", path, { host: "evil.com" })).status).toBe(403);
      expect(
        (await raw(server.framePort, "GET", "/_f/v1/index.html", {
          host: `${artifact.id}.evil.com`,
        })).status,
      ).toBe(403);
    });

    it("still serves the hosts this deployment answers to", async () => {
      expect(
        (await raw(server.shellPort, "GET", `/a/${artifact.id}`, { host: shellHost })).status,
      ).toBe(200);
      // The artifact's own origin, and the tooling prefix form on loopback.
      expect(
        (await raw(server.framePort, "GET", `/_f/${artifact.version}/index.html`, {
          host: `${artifact.id}.localhost:${server.framePort}`,
        })).status,
      ).toBe(200);
      expect(
        (await raw(
          server.framePort,
          "GET",
          `/_a/${artifact.id}/_f/${artifact.version}/index.html`,
          { host: `127.0.0.1:${server.framePort}` },
        )).status,
      ).toBe(200);
    });

    it("answers a host named by ARTIFACT_ALLOWED_HOSTS", async () => {
      const named = await startServer({
        shellPort: 0,
        framePort: 0,
        dataDir,
        openAdminApi: true,
        allowedHosts: ["shell.internal"],
      });
      try {
        expect(
          (await raw(named.shellPort, "GET", "/", { host: "shell.internal" })).status,
        ).toBe(200);
        expect((await raw(named.shellPort, "GET", "/", { host: "other.internal" })).status).toBe(
          403,
        );
      } finally {
        await named.close();
      }
    });
  });

  describe("the origin guard", () => {
    it("refuses a write from an artifact frame (same-site CSRF)", async () => {
      // The attack the finding describes: shell and frames under one
      // registrable domain, so the `SameSite=Lax` cookie rides along.
      const frameOrigin = `http://${artifact.id}.localhost:${server.framePort}`;
      const forged = await raw(
        server.shellPort,
        "POST",
        "/api/artifacts",
        json({ origin: frameOrigin, "sec-fetch-site": "same-site" }),
        createBody(),
      );
      expect(forged.status).toBe(403);
      expect(JSON.parse(forged.body)).toMatchObject({ code: "not_granted" });

      // Slice routes are behind the same guard, not only the admin API.
      const renamed = await raw(
        server.shellPort,
        "POST",
        "/api/frame/user/profile",
        json({ origin: frameOrigin, "sec-fetch-site": "same-site" }),
        JSON.stringify({ name: "owned" }),
      );
      expect(renamed.status).toBe(403);
    });

    it("refuses a cross-site write, by either header on its own", async () => {
      expect(
        (await raw(
          server.shellPort,
          "POST",
          "/api/artifacts",
          json({ "sec-fetch-site": "cross-site" }),
          createBody(),
        )).status,
      ).toBe(403);
      expect(
        (await raw(
          server.shellPort,
          "POST",
          "/api/artifacts",
          json({ origin: "https://evil.example" }),
          createBody(),
        )).status,
      ).toBe(403);
      // `Origin: null` — a sandboxed frame, or a cross-origin redirect.
      expect(
        (await raw(server.shellPort, "POST", "/api/artifacts", json({ origin: "null" }), createBody()))
          .status,
      ).toBe(403);
    });

    it("refuses a body a forged cross-site form could have sent", async () => {
      const refused = await raw(
        server.shellPort,
        "POST",
        "/api/artifacts",
        { host: shellHost, "content-type": "text/plain" },
        createBody(),
      );
      expect(refused.status).toBe(415);
      expect(JSON.parse(refused.body)).toMatchObject({ code: "invalid_content" });
      for (const type of ["application/x-www-form-urlencoded", "multipart/form-data"]) {
        expect(
          (await raw(
            server.shellPort,
            "POST",
            "/api/artifacts",
            { host: shellHost, "content-type": type },
            createBody(),
          )).status,
        ).toBe(415);
      }
    });

    it("lets the shell page and bare tooling through", async () => {
      // What the shell's own `fetch` sends.
      expect(
        (await raw(
          server.shellPort,
          "POST",
          "/api/artifacts",
          json({ origin: server.shellOrigin, "sec-fetch-site": "same-origin" }),
          createBody(),
        )).status,
      ).toBe(200);
      // A user-initiated navigation, and `npm run publish` (no fetch metadata
      // at all, but a content type no browser could have sent by accident).
      expect(
        (await raw(
          server.shellPort,
          "POST",
          "/api/artifacts",
          json({ "sec-fetch-site": "none" }),
          createBody(),
        )).status,
      ).toBe(200);
      expect(
        (await raw(server.shellPort, "POST", "/api/artifacts", json(), createBody())).status,
      ).toBe(200);
      // Reads are never gated on the fetch metadata: the version poll drives
      // live reload from every open view.
      expect(
        (await raw(server.shellPort, "GET", `/api/artifacts/${artifact.id}/version`, {
          host: shellHost,
          origin: "https://evil.example",
        })).status,
      ).toBe(200);
    });
  });
});
