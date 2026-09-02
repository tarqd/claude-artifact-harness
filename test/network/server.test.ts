/**
 * The enforcement half of `network`: the validator, and the CSP header two
 * real Hono apps actually serve over a socket (ephemeral ports, a temporary
 * DATA_DIR — never the defaults).
 */
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_ORIGINS,
  connectSrcOrigins,
  normalizeOrigin,
  validateOrigins,
} from "../../src/capabilities/network/server.ts";
import { startServer, type RunningServer } from "../../src/server/index.ts";
import { frameCsp } from "../../src/server/serve.ts";
import type { FrameEnv } from "../../src/server/types.ts";

const SHELL = "http://shell.test:8787";
const DECLARED = "https://declared.example";
const BLOB_HEADERS = { "content-security-policy": "default-src 'none'; sandbox" };

// A neutral shell origin and frame suffix, unrelated to any declared test
// origin, for the pure-function tests below.
const TEST_SHELL = "https://shell.example";
const TEST_FRAME_SUFFIX = "artifacts.example";

describe("normalizeOrigin", () => {
  it("keeps absolute https origins, normalised", () => {
    expect(normalizeOrigin("https://api.example.com")).toBe("https://api.example.com");
    expect(normalizeOrigin("https://api.example.com/")).toBe("https://api.example.com");
    expect(normalizeOrigin("  https://API.Example.com  ")).toBe("https://api.example.com");
    expect(normalizeOrigin("https://api.example.com:8443")).toBe("https://api.example.com:8443");
    // The default port is not part of the origin.
    expect(normalizeOrigin("https://api.example.com:443")).toBe("https://api.example.com");
  });

  it("refuses everything that is not one absolute https origin", () => {
    for (const bad of [
      "http://api.example.com", // cleartext
      "wss://api.example.com", // websockets are blocked (§10.1)
      "data:", // not an origin
      "//api.example.com", // scheme-relative
      "api.example.com", // bare host
      "https://", // no host
      "https://api.example.com/v1", // a path is not an origin
      "https://api.example.com/?q=1",
      "https://api.example.com/#f",
      "https://user:pw@api.example.com", // credentials
      "https://*.example.com", // wildcard host
      "https://[::1]", // IPv6 literal (documented gap)
      "*",
      "'self'",
      "",
      "   ",
      42,
      null,
      undefined,
      ["https://api.example.com"],
      { origin: "https://api.example.com" },
    ]) {
      expect(normalizeOrigin(bad as unknown), String(bad)).toBeNull();
    }
  });

  it("refuses a candidate that would inject another CSP directive", () => {
    expect(normalizeOrigin("https://a.example; script-src *")).toBeNull();
    expect(normalizeOrigin("https://a.example, https://b.example")).toBeNull();
    expect(normalizeOrigin("https://a.example https://b.example")).toBeNull();
    expect(normalizeOrigin("https://a.example\n; script-src *")).toBeNull();
  });
});

describe("validateOrigins", () => {
  it("drops the invalid entries and keeps the rest in order", () => {
    expect(
      validateOrigins(
        [
          "https://a.example",
          "http://b.example",
          "https://c.example/path",
          "nonsense",
          "https://d.example",
        ],
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual(["https://a.example", "https://d.example"]);
  });

  it("de-duplicates after normalisation", () => {
    expect(
      validateOrigins(
        ["https://a.example", "https://A.example/", "https://a.example:443"],
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual(["https://a.example"]);
  });

  it("answers [] for anything that is not an array", () => {
    for (const bad of [undefined, null, "https://a.example", 7, {}]) {
      expect(validateOrigins(bad as unknown, TEST_SHELL, TEST_FRAME_SUFFIX)).toEqual([]);
    }
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_ORIGINS + 10 }, (_, i) => `https://h${i}.example`);
    expect(validateOrigins(many, TEST_SHELL, TEST_FRAME_SUFFIX)).toHaveLength(MAX_ORIGINS);
  });

  it("drops the shell's own origin and sibling frame origins", () => {
    // The shell host itself, case-insensitively...
    expect(
      validateOrigins(["https://SHELL.example", "https://ok.example"], TEST_SHELL, TEST_FRAME_SUFFIX),
    ).toEqual(["https://ok.example"]);
    // ...a same-host, different-port origin (cookies are not port-scoped)...
    expect(
      validateOrigins(["https://shell.example:8443", "https://ok.example"], TEST_SHELL, TEST_FRAME_SUFFIX),
    ).toEqual(["https://ok.example"]);
    // ...and any sibling artifact's frame origin under the frame host suffix.
    expect(
      validateOrigins(
        ["https://abc123.artifacts.example", "https://ok.example"],
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual(["https://ok.example"]);
    // ...and the bare frame host suffix itself, case-insensitively — an
    // artifact can be served at that host directly, not only at a subdomain.
    expect(
      validateOrigins(
        ["https://ARTIFACTS.example", "https://ok.example"],
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual(["https://ok.example"]);
    // An unrelated https origin is kept.
    expect(validateOrigins(["https://unrelated.example"], TEST_SHELL, TEST_FRAME_SUFFIX)).toEqual([
      "https://unrelated.example",
    ]);
  });
});

describe("connectSrcOrigins", () => {
  it("reads the declaration", () => {
    expect(
      connectSrcOrigins(
        { network: { config: { origins: ["https://a.example"] } } },
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual(["https://a.example"]);
  });

  it("answers [] when network was not declared or is malformed", () => {
    expect(connectSrcOrigins(undefined, TEST_SHELL, TEST_FRAME_SUFFIX)).toEqual([]);
    expect(connectSrcOrigins({}, TEST_SHELL, TEST_FRAME_SUFFIX)).toEqual([]);
    expect(connectSrcOrigins({ network: {} }, TEST_SHELL, TEST_FRAME_SUFFIX)).toEqual([]);
    expect(connectSrcOrigins({ network: { config: null } }, TEST_SHELL, TEST_FRAME_SUFFIX)).toEqual(
      [],
    );
    expect(
      connectSrcOrigins(
        { network: { config: { origins: "https://a.example" } } },
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual([]);
  });

  it("opens nothing for an optional declaration", () => {
    // The spine drops optional declarations before `__frame_init` and there
    // is no later grant path, so the page never gets the namespace; the
    // policy must not hand it a reach the view was not granted.
    expect(
      connectSrcOrigins(
        { network: { config: { optional: true, origins: ["https://a.example"] } } },
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual([]);
  });

  it("drops an origin that would be the shell or a sibling frame", () => {
    expect(
      connectSrcOrigins(
        { network: { config: { origins: [TEST_SHELL, "https://a.example"] } } },
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual(["https://a.example"]);
    expect(
      connectSrcOrigins(
        {
          network: {
            config: { origins: [`https://x.${TEST_FRAME_SUFFIX}`, "https://a.example"] },
          },
        },
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual(["https://a.example"]);
    // The bare frame host suffix itself, not only a subdomain of it.
    expect(
      connectSrcOrigins(
        {
          network: {
            config: { origins: [`https://${TEST_FRAME_SUFFIX}`, "https://a.example"] },
          },
        },
        TEST_SHELL,
        TEST_FRAME_SUFFIX,
      ),
    ).toEqual(["https://a.example"]);
  });
});

describe("the CSP the frame origin serves", () => {
  let server: RunningServer;
  let dataDir: string;
  let version: string;

  const HTML = "<p>network</p>";

  async function create(capabilities: Record<string, unknown>): Promise<string> {
    const response = await fetch(`${server.shellOrigin}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: HTML, capabilities }),
    });
    expect(response.status).toBe(200);
    const created = (await response.json()) as { id: string; version: string };
    version = created.version;
    return created.id;
  }

  /**
   * The served document, over a real socket, through the `/_a/<id>/` form so
   * no wildcard DNS is needed. This is the response the iframe gets, and the
   * only one whose CSP the browser enforces on the page.
   */
  async function policyFor(id: string): Promise<string> {
    const response = await fetch(
      `http://127.0.0.1:${server.framePort}/_a/${id}/_f/${version}/index.html`,
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    return response.headers.get("content-security-policy") ?? "";
  }

  function connectSrc(policy: string): string {
    return (
      policy
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("connect-src")) ?? ""
    );
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "network-server-"));
    server = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      openAdminApi: true,
      allowPrefixHosts: true,
    });
  });

  afterAll(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("includes the declared https origins in connect-src", async () => {
    const id = await create({
      network: { origins: ["https://api.example.com", "https://cdn.example.com:8443"] },
    });
    const policy = await policyFor(id);
    expect(connectSrc(policy)).toBe(
      "connect-src 'self' https://api.example.com https://cdn.example.com:8443",
    );
    // The rest of the documented allowlist is untouched (§10.1).
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com");
    expect(policy).toContain(`frame-ancestors ${server.shellOrigin}`);
  });

  it("allows nothing but 'self' when network was not declared", async () => {
    const id = await create({ db: {} });
    expect(connectSrc(await policyFor(id))).toBe("connect-src 'self'");
  });

  it("allows nothing but 'self' when the declaration is malformed", async () => {
    const id = await create({ network: { origins: "https://a.example" } });
    expect(connectSrc(await policyFor(id))).toBe("connect-src 'self'");
  });

  it("drops the entries that are not absolute https origins", async () => {
    const id = await create({
      network: {
        origins: [
          "https://good.example",
          "http://insecure.example",
          "https://good.example/path",
          "not a url",
          "https://evil.example; script-src *",
        ],
      },
    });
    const policy = await policyFor(id);
    expect(connectSrc(policy)).toBe("connect-src 'self' https://good.example");
    expect(policy).not.toContain("insecure.example");
    expect(policy).not.toContain("evil.example");
    // The injected directive did not become a directive.
    expect(policy.split(";").filter((d) => d.trim().startsWith("script-src"))).toHaveLength(1);
  });

  it("drops a declared origin that is the shell itself or a sibling frame", async () => {
    // This deployment's shell host and frame host suffix are both
    // "localhost" (the dev default), so both same-site cases show up as one
    // host: the shell's own origin, and a sibling artifact's frame origin.
    const id = await create({
      network: {
        origins: ["https://localhost", "https://abc123.localhost", "https://unrelated.example"],
      },
    });
    const policy = await policyFor(id);
    expect(connectSrc(policy)).toBe("connect-src 'self' https://unrelated.example");
  });

  it("serves the validated subset, not the declaration", async () => {
    // The served header and the helper agree — the gap the slice used to
    // document (the spine's own string filter) is closed for the response
    // the browser enforces.
    const declared = ["https://good.example", "http://insecure.example"];
    const id = await create({ network: { origins: declared } });
    expect(connectSrc(await policyFor(id))).toBe("connect-src 'self' https://good.example");
    expect(
      connectSrcOrigins(
        { network: { config: { origins: declared } } },
        server.shellOrigin,
        server.config.frameHostSuffix,
      ),
    ).toEqual(["https://good.example"]);
  });

  it("cannot be made to inject a directive that shadows a real one", async () => {
    // A repeated directive is read from its first occurrence, so an injected
    // `frame-ancestors *` ahead of the genuine one would lift the artifact
    // out of its frame restriction.
    const id = await create({
      network: {
        origins: ["https://a.example; script-src * 'unsafe-inline'; frame-ancestors *"],
      },
    });
    const policy = await policyFor(id);
    expect(connectSrc(policy)).toBe("connect-src 'self'");
    expect(policy).not.toContain("frame-ancestors *");
    const directives = policy.split(";").map((d) => d.trim().split(" ")[0]);
    expect(directives).toEqual([...new Set(directives)]);
    expect(policy.endsWith(`frame-ancestors ${server.shellOrigin}`)).toBe(true);
  });

  it("caps the header rather than serving an unbounded one", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `https://h${i}.example`);
    const id = await create({ network: { origins: many } });
    const connect = connectSrc(await policyFor(id));
    expect(connect.split(" ")).toHaveLength(MAX_ORIGINS + 2); // "connect-src" + 'self'
    expect(connect).not.toContain("https://h199.example");
  });

  it("opens nothing for an optional declaration, which the page never gets", async () => {
    const id = await create({ network: { optional: true, origins: ["https://opt.example"] } });
    expect(connectSrc(await policyFor(id))).toBe("connect-src 'self'");
  });

  it("leaves a route that builds its own response alone", async () => {
    // The policy is stamped by the frame middleware with `c.header`, and Hono
    // drops those headers when a handler returns a `Response` it built itself
    // — which is how the `assets` slice serves blobs under their own
    // `default-src 'none'; sandbox`. Pinned here because the CSP this slice
    // validates must not leak onto a sandboxed subresource.
    const app = new Hono<FrameEnv>();
    app.use("*", async (c, next) => {
      c.header("content-security-policy", frameCsp(SHELL, [DECLARED]));
      await next();
    });
    app.get("/doc", (c) => c.html("<p>doc</p>"));
    app.get("/blob", () => new Response("bytes", { headers: BLOB_HEADERS }));

    const policy = async (path: string): Promise<string | null> =>
      (await app.request(path)).headers.get("content-security-policy");
    expect(connectSrc((await policy("/doc")) ?? "")).toBe(`connect-src 'self' ${DECLARED}`);
    expect(await policy("/blob")).toBe(BLOB_HEADERS["content-security-policy"]);
  });

  it("leaves every other directive exactly as the spine built it", async () => {
    const plain = await policyFor(await create({ db: {} }));
    const withNetwork = await policyFor(
      await create({ network: { origins: ["https://api.example.com"] } }),
    );
    expect(withNetwork.replace(" https://api.example.com", "")).toBe(plain);
  });
});
