/**
 * The TLS posture of the spine (security review, finding 9): the public
 * origins carry the configured scheme, the cookies are `Secure` and
 * `__Host-` prefixed when they do, the owner token is posted rather than
 * put in a URL, the owner cookie dies with the token it was minted under,
 * and login is throttled per address.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../../src/server/auth.ts";
import {
  frameOrigin,
  isLoopbackHost,
  loadConfig,
  shellOrigin,
  usesTls,
} from "../../src/server/config.ts";
import { startServer, type RunningServer } from "../../src/server/index.ts";

const OWNER_TOKEN = "owner-token-under-test";
const ARTIFACT_ID = "0123456789abcdef0123456789abcdef";

let server: RunningServer;
let dataDir: string;
let fixture: string;

/** The `Set-Cookie` for one cookie name, or `undefined`. */
function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

/** Every `Set-Cookie` folded into a `Cookie` header value. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

/** A form post with no `Content-Length`, which node frames as chunked. */
function chunkedPost(port: number, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/login",
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "artifact-tls-"));
  fixture = await readFile("fixtures/artifact.html", "utf8");
  server = await startServer({
    shellPort: 0,
    framePort: 0,
    dataDir,
    ownerToken: OWNER_TOKEN,
    secret: "test-secret",
  });
});

afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("public origins", () => {
  it("keeps the plain-http localhost defaults", () => {
    const config = loadConfig({ shellPort: 8787, framePort: 8788 });
    expect(usesTls(config)).toBe(false);
    expect(shellOrigin(config)).toBe("http://localhost:8787");
    expect(frameOrigin(config, ARTIFACT_ID)).toBe(`http://${ARTIFACT_ID}.localhost:8788`);
  });

  it("builds https origins from PUBLIC_SHELL_URL, without the default port", () => {
    process.env.PUBLIC_SHELL_URL = "https://artifacts.example.com";
    process.env.FRAME_HOST_SUFFIX = "artifacts.example.com";
    try {
      const config = loadConfig();
      expect(usesTls(config)).toBe(true);
      expect(shellOrigin(config)).toBe("https://artifacts.example.com");
      expect(frameOrigin(config, ARTIFACT_ID)).toBe(
        `https://${ARTIFACT_ID}.artifacts.example.com`,
      );
    } finally {
      delete process.env.PUBLIC_SHELL_URL;
      delete process.env.FRAME_HOST_SUFFIX;
    }
  });

  it("keeps a non-default public port, and takes the frame's own", () => {
    process.env.PUBLIC_SHELL_URL = "https://artifacts.example.com:8443";
    process.env.PUBLIC_FRAME_PORT = "9443";
    try {
      const config = loadConfig();
      expect(shellOrigin(config)).toBe("https://artifacts.example.com:8443");
      expect(frameOrigin(config, ARTIFACT_ID)).toBe(
        `https://${ARTIFACT_ID}.localhost:9443`,
      );
    } finally {
      delete process.env.PUBLIC_SHELL_URL;
      delete process.env.PUBLIC_FRAME_PORT;
    }
  });

  it("takes PUBLIC_SCHEME on its own", () => {
    process.env.PUBLIC_SCHEME = "https";
    try {
      expect(usesTls(loadConfig())).toBe(true);
    } finally {
      delete process.env.PUBLIC_SCHEME;
    }
  });

  it("refuses a public URL that is not a bare origin", () => {
    for (const bad of ["ftp://example.com", "https://example.com/shell", "not a url"]) {
      process.env.PUBLIC_SHELL_URL = bad;
      try {
        expect(() => loadConfig()).toThrow();
      } finally {
        delete process.env.PUBLIC_SHELL_URL;
      }
    }
    process.env.PUBLIC_SCHEME = "gopher";
    try {
      expect(() => loadConfig()).toThrow();
    } finally {
      delete process.env.PUBLIC_SCHEME;
    }
  });

  it("knows which bind addresses are loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.4")).toBe(false);
  });

  it("pins frame-ancestors to the https shell origin", async () => {
    const tls = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      publicScheme: "https",
      publicShellPort: 443,
      publicFramePort: 443,
    });
    try {
      expect(tls.shellOrigin).toBe("https://localhost");
      const response = await fetch(`http://127.0.0.1:${tls.framePort}/_runtime/nope.js`);
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors https://localhost",
      );
    } finally {
      await tls.close();
    }
  });
});

describe("cookies", () => {
  it("are plain on http and Secure + __Host- on https", async () => {
    const plain = await fetch(`${server.shellOrigin}/login`, form({ token: OWNER_TOKEN }));
    expect(plain.status).toBe(200);
    expect(setCookieFor(plain, "av")).toContain("HttpOnly");
    expect(setCookieFor(plain, "av")).not.toContain("Secure");
    expect(setCookieFor(plain, "ao")).toBeDefined();

    const tls = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: OWNER_TOKEN,
      publicScheme: "https",
      publicShellPort: 443,
    });
    try {
      const secure = await fetch(
        `http://127.0.0.1:${tls.shellPort}/login`,
        form({ token: OWNER_TOKEN }),
      );
      expect(secure.status).toBe(200);
      const viewer = setCookieFor(secure, "__Host-av");
      const owner = setCookieFor(secure, "__Host-ao");
      expect(viewer).toContain("Secure");
      expect(viewer).toContain("Path=/");
      expect(viewer).not.toContain("Domain=");
      expect(owner).toContain("Secure");
      // The unprefixed names are gone: a `__Host-` cookie is the only one a
      // sibling host under a shared domain cannot toss at us.
      expect(setCookieFor(secure, "av")).toBeUndefined();
    } finally {
      await tls.close();
    }
  });
});

describe("login", () => {
  it("refuses a token in the query string and sets no cookie", async () => {
    const response = await fetch(`${server.shellOrigin}/login?token=${OWNER_TOKEN}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(setCookieFor(response, "ao")).toBeUndefined();
    const body = await response.text();
    expect(body).toContain("must not travel in a URL");
    // The form must not hand the token back out in the markup either.
    expect(body).not.toContain(OWNER_TOKEN);
  });

  it("serves a token-free form on GET", async () => {
    const response = await fetch(`${server.shellOrigin}/login`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain('<form method="post" action="/login">');
  });

  it("logs in on a posted form and reaches the admin API", async () => {
    const response = await fetch(`${server.shellOrigin}/login`, form({ token: OWNER_TOKEN }));
    expect(response.status).toBe(200);
    const cookie = cookieHeader(response);
    const created = await fetch(`${server.shellOrigin}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ html: fixture, capabilities: {} }),
    });
    expect(created.status).toBe(200);
  });

  it("logs in on posted JSON too, and honours next", async () => {
    const response = await fetch(`${server.shellOrigin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: OWNER_TOKEN, next: "/a/x" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/a/x");
  });

  it("refuses the wrong token, a bad body and a foreign origin", async () => {
    const wrong = await fetch(`${server.shellOrigin}/login`, form({ token: "nope" }));
    expect(wrong.status).toBe(403);
    expect(setCookieFor(wrong, "ao")).toBeUndefined();

    const plainText = await fetch(`${server.shellOrigin}/login`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: `token=${OWNER_TOKEN}`,
    });
    expect(plainText.status).toBe(415);

    // A chunked body declares no length to bound it by, so it is refused
    // before a byte of it is read.
    const chunked = await chunkedPost(server.shellPort, `token=${OWNER_TOKEN}`);
    expect(chunked).toBe(411);

    const tooLarge = await fetch(`${server.shellOrigin}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "x".repeat(5000) }).toString(),
    });
    expect(tooLarge.status).toBe(413);

    const crossSite = await fetch(`${server.shellOrigin}/login`, {
      ...form({ token: OWNER_TOKEN }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
    });
    expect(crossSite.status).toBe(403);
    expect(setCookieFor(crossSite, "ao")).toBeUndefined();

    const crossFetchSite = await fetch(`${server.shellOrigin}/login`, {
      ...form({ token: OWNER_TOKEN }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(crossFetchSite.status).toBe(403);
  });

  it("throttles guessing from one address", async () => {
    const throttled = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: OWNER_TOKEN,
    });
    try {
      let sawLimit = false;
      for (let i = 0; i < 25; i++) {
        const response = await fetch(`${throttled.shellOrigin}/login`, form({ token: "guess" }));
        if (response.status === 429) {
          sawLimit = true;
          break;
        }
        expect(response.status).toBe(403);
      }
      expect(sawLimit).toBe(true);
      // The budget is per address and covers the right token too, so a
      // guessing flood cannot be walked past by finally getting it right.
      const right = await fetch(`${throttled.shellOrigin}/login`, form({ token: OWNER_TOKEN }));
      expect(right.status).toBe(429);
    } finally {
      await throttled.close();
    }
  });
});

describe("owner cookie", () => {
  it("stops being the owner once the token rotates", async () => {
    const response = await fetch(`${server.shellOrigin}/login`, form({ token: OWNER_TOKEN }));
    const cookie = cookieHeader(response);
    const rotated = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: "a-freshly-rotated-token",
      secret: server.config.secret,
    });
    try {
      const created = await fetch(`${rotated.shellOrigin}/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ html: fixture, capabilities: {} }),
      });
      expect(created.status).toBe(403);
    } finally {
      await rotated.close();
    }
  });

  it("holds under the same token, and never for another viewer", async () => {
    const response = await fetch(`${server.shellOrigin}/login`, form({ token: OWNER_TOKEN }));
    const auth = createAuth(server.config);
    const sealedViewer = setCookieFor(response, "av")!.slice("av=".length).split(";")[0]!;
    const sealedOwner = setCookieFor(response, "ao")!.slice("ao=".length).split(";")[0]!;
    const viewerId = auth.unseal(sealedViewer)!;

    expect(auth.isOwnerCookie(sealedOwner, viewerId)).toBe(true);
    expect(auth.isOwnerCookie(sealedOwner, "u_AAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    // A cookie in the shape used before the binding — `seal(viewerId)` alone —
    // is not evidence of the current token, so it is not the owner.
    expect(auth.isOwnerCookie(auth.seal(viewerId), viewerId)).toBe(false);
    // No token configured at all: nobody is the owner by cookie.
    const closed = createAuth({ ...server.config, ownerToken: null });
    expect(closed.isOwnerCookie(sealedOwner, viewerId)).toBe(false);
  });
});
