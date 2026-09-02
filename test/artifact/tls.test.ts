/**
 * The TLS posture of the spine (security review, finding 9): the public
 * origins carry the configured scheme, the cookies are `Secure` and
 * `__Host-` prefixed when they do, the owner token is posted rather than
 * put in a URL, the owner cookie dies with the token it was minted under,
 * and both doors onto that token — the login form and the admin API's bearer
 * header — are throttled per address.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { mintPeerId } from "../../src/capabilities/room/protocol.ts";
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

/**
 * A form post with no `Content-Length`, which node frames as chunked — the
 * shape a TLS terminator hands us when it does not buffer the request.
 */
function chunkedPost(port: number, body: string): Promise<{ status: number; text: string }> {
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
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
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

/**
 * Only a *wrong* token spends login budget, so the many successful logins in
 * this file share one server safely. A test that guesses in a loop still
 * wants its own server: 20 wrong answers a minute is the whole budget.
 */
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

  it("takes the browser's own form post: same origin, same site", async () => {
    // The path a person actually walks. Every other login in the suite is a
    // bare client that sends neither header, so this is the case that would
    // otherwise be unexercised — a wrong `shellOrigin` locks the operator out
    // while the rest of the suite stays green.
    const submitted = await fetch(`${server.shellOrigin}/login`, {
      ...form({ token: OWNER_TOKEN }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: server.shellOrigin,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(submitted.status).toBe(200);
    expect(setCookieFor(submitted, "ao")).toBeDefined();

    // A typed-in URL: no `Origin`, and `Sec-Fetch-Site: none`.
    const typed = await fetch(`${server.shellOrigin}/login`, {
      ...form({ token: OWNER_TOKEN }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "none",
      },
    });
    expect(typed.status).toBe(200);
    expect(setCookieFor(typed, "ao")).toBeDefined();
  });

  it("takes the browser's form post against an https public origin too", async () => {
    // The guard compares against `PUBLIC_SHELL_URL`'s origin, not the address
    // we listen on, so it is proven on the deployment shape this PR is for.
    const tls = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: OWNER_TOKEN,
      publicScheme: "https",
      publicShellPort: 443,
    });
    try {
      expect(tls.shellOrigin).toBe("https://localhost");
      const submitted = await fetch(`http://127.0.0.1:${tls.shellPort}/login`, {
        ...form({ token: OWNER_TOKEN }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: tls.shellOrigin,
          "sec-fetch-site": "same-origin",
        },
      });
      expect(submitted.status).toBe(200);
      expect(setCookieFor(submitted, "__Host-ao")).toBeDefined();
    } finally {
      await tls.close();
    }
  });

  it("logs in on a chunked body, and cuts an oversized one off", async () => {
    // A terminator that does not buffer the request forwards it chunked, so a
    // body with no declared length is metered rather than refused.
    const chunked = await chunkedPost(server.shellPort, `token=${OWNER_TOKEN}`);
    expect(chunked.status).toBe(200);
    expect(chunked.text).toContain("logged in as the owner");

    const flood = await chunkedPost(server.shellPort, `token=${"x".repeat(64_000)}`);
    expect(flood.status).toBe(413);
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

  it("redirects after login only within this origin", async () => {
    const post = (next: string) =>
      fetch(`${server.shellOrigin}/login`, form({ token: OWNER_TOKEN, next }));

    const inside = await post("/a/x?v=1");
    expect(inside.status).toBe(303);
    expect(inside.headers.get("location")).toBe("/a/x?v=1");

    // Every one of these starts with `/`, which is why the prefix alone was
    // never a test: a browser reads them as another host. The tab one leans
    // on URL parsing dropping the tab, and the last two are protocol-relative
    // only *after* resolution collapses their dot segments - so the check has
    // to run on the string that is handed back, not on the one that came in.
    for (const away of [
      "//evil.example/x",
      "/\\evil.example",
      "/\t/evil.example",
      "https://evil.example/x",
      "/..//evil.example/x",
      "/%2e%2e//evil.example",
    ]) {
      const response = await post(away);
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("never carries an off-origin next into the form", async () => {
    const away = await fetch(`${server.shellOrigin}/login?next=%2F%2Fevil.example%2Fx`);
    expect(await away.text()).not.toContain("evil.example");
    // The hidden field is where a link's `next` reaches the operator, so the
    // normalising form has to be refused here too and not just at the bounce.
    const dots = await fetch(`${server.shellOrigin}/login?next=%2F..%2F%2Fevil.example%2Fx`);
    expect(await dots.text()).not.toContain("evil.example");
    const inside = await fetch(`${server.shellOrigin}/login?next=%2Fa%2Fx`);
    expect(await inside.text()).toContain('name="next" value="/a/x"');
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

  it("throttles guessing from one address, and never the right token", async () => {
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

      // Only wrong answers spend the budget. A flood is a brake on guessing,
      // never a lockout of the operator who holds the token — which is all it
      // could be behind a terminator, where every request shares one address.
      const right = await fetch(`${throttled.shellOrigin}/login`, form({ token: OWNER_TOKEN }));
      expect(right.status).toBe(200);
      expect(setCookieFor(right, "ao")).toBeDefined();

      // And guessing is still shut immediately after that success.
      const again = await fetch(`${throttled.shellOrigin}/login`, form({ token: "guess" }));
      expect(again.status).toBe(429);
    } finally {
      await throttled.close();
    }
  });
});

describe("the admin API's bearer guard", () => {
  /** `POST /api/artifacts` with whatever credential headers are given. */
  const create = (origin: string, headers: Record<string, string>) =>
    fetch(`${origin}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ html: fixture, capabilities: {} }),
    });

  it("throttles guessing from one address, and never the right credential", async () => {
    const throttled = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: OWNER_TOKEN,
    });
    try {
      // The bearer header is the door a script would knock on, so it must not
      // be a free yes/no oracle for the owner token the login form throttles.
      let sawLimit = false;
      for (let i = 0; i < 25; i++) {
        const response = await create(throttled.shellOrigin, {
          authorization: `Bearer guess-${i}`,
        });
        if (response.status === 429) {
          sawLimit = true;
          break;
        }
        expect(response.status).toBe(403);
      }
      expect(sawLimit).toBe(true);

      // Only wrong answers spend the budget: the publish script and CI share
      // the terminator's address with every guesser, so a right token that
      // could be throttled would be a remote lockout of the operator.
      const right = await create(throttled.shellOrigin, {
        authorization: `Bearer ${OWNER_TOKEN}`,
      });
      expect(right.status).toBe(200);

      // The owner cookie is the other legitimate credential, and is untouched.
      const login = await fetch(`${throttled.shellOrigin}/login`, form({ token: OWNER_TOKEN }));
      expect(login.status).toBe(200);
      const cookie = cookieHeader(login);
      expect(await create(throttled.shellOrigin, { cookie }).then((r) => r.status)).toBe(200);

      // And guessing is still shut immediately after both of those.
      const again = await create(throttled.shellOrigin, { authorization: "Bearer guess-again" });
      expect(again.status).toBe(429);
    } finally {
      await throttled.close();
    }
  });

  it("spends nothing on a caller that presents no credential", async () => {
    const quiet = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: OWNER_TOKEN,
    });
    try {
      // An anonymous request is not a guess at anything, so it is refused
      // 403 for as long as it likes and never eats the operator's budget.
      for (let i = 0; i < 25; i++) {
        expect(await create(quiet.shellOrigin, {}).then((r) => r.status)).toBe(403);
      }
      const right = await create(quiet.shellOrigin, { authorization: `Bearer ${OWNER_TOKEN}` });
      expect(right.status).toBe(200);
    } finally {
      await quiet.close();
    }
  });

  it("still serves an explicitly opened admin API, wrong header and all", async () => {
    const open = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: OWNER_TOKEN,
      openAdminApi: true,
    });
    try {
      for (let i = 0; i < 25; i++) {
        const response = await create(open.shellOrigin, { authorization: `Bearer junk-${i}` });
        expect(response.status).toBe(200);
      }
    } finally {
      await open.close();
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

describe("HSTS", () => {
  const HSTS = "max-age=31536000; includeSubDomains";

  it("is sent on both origins under https, and never on http", async () => {
    // On http the header would strand the deployment on a scheme it does not
    // serve, so it is exactly as absent as the scheme is.
    const plain = await fetch(`${server.shellOrigin}/login`);
    expect(plain.headers.get("strict-transport-security")).toBeNull();
    const plainRoot = await fetch(`${server.shellOrigin}/`);
    expect(plainRoot.headers.get("strict-transport-security")).toBeNull();

    const tls = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: OWNER_TOKEN,
      publicScheme: "https",
      publicShellPort: 443,
      publicFramePort: 443,
    });
    try {
      const login = await fetch(`http://127.0.0.1:${tls.shellPort}/login`);
      expect(login.headers.get("strict-transport-security")).toBe(HSTS);

      // `/` is the bare-host URL an operator hands out, so it is the first
      // plain-http request HSTS exists to stop an on-path attacker holding.
      const root = await fetch(`http://127.0.0.1:${tls.shellPort}/`);
      expect(root.status).toBe(200);
      expect(root.headers.get("strict-transport-security")).toBe(HSTS);
      const bundle = await fetch(`http://127.0.0.1:${tls.shellPort}/_shell/shell.js`);
      expect(bundle.headers.get("strict-transport-security")).toBe(HSTS);

      const created = await fetch(`http://127.0.0.1:${tls.shellPort}/api/artifacts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${OWNER_TOKEN}`,
        },
        body: JSON.stringify({ html: fixture, capabilities: {} }),
      });
      expect(created.headers.get("strict-transport-security")).toBe(HSTS);
      const { id } = (await created.json()) as { id: string };
      const shell = await fetch(`http://127.0.0.1:${tls.shellPort}/a/${id}`);
      expect(shell.headers.get("strict-transport-security")).toBe(HSTS);

      // The frame origin is a wildcard sibling, so it says it for itself.
      const framed = await fetch(`http://127.0.0.1:${tls.framePort}/_runtime/nope.js`);
      expect(framed.headers.get("strict-transport-security")).toBe(HSTS);
    } finally {
      await tls.close();
    }
  });
});

/** Wait for the first message a lane socket pushes. */
function firstMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(String(raw))));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("the lane was refused")));
  });
}

describe("the websocket lanes on https", () => {
  /**
   * The lanes read the cookies by name off a raw upgrade request, so an
   * https deployment is where a hardcoded `av`/`ao` would silently stop
   * identifying anyone. Both lanes are opened with the `__Host-` prefixed
   * pair a real login handed back, under rules only the owner satisfies.
   */
  it("identify the viewer and the owner from the __Host- cookies", async () => {
    const tls = await startServer({
      shellPort: 0,
      framePort: 0,
      dataDir,
      ownerToken: OWNER_TOKEN,
      publicScheme: "https",
      publicShellPort: 443,
    });
    const base = `http://127.0.0.1:${tls.shellPort}`;
    const sockets: WebSocket[] = [];
    try {
      const login = await fetch(`${base}/login`, form({ token: OWNER_TOKEN }));
      expect(login.status).toBe(200);
      const cookie = cookieHeader(login);
      expect(cookie).toContain("__Host-av=");
      expect(cookie).toContain("__Host-ao=");

      const created = await fetch(`${base}/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          html: fixture,
          // Reading takes `admin`, and no topic is declared, so both lanes
          // answer only a viewer the owner cookie actually named.
          capabilities: {
            db: { config: { rules: [{ path: "", read: "admin", write: "admin" }] } },
            room: {},
          },
        }),
      });
      expect(created.status).toBe(200);
      const { id } = (await created.json()) as { id: string };

      await fetch(`${base}/api/frame/db/${id}/call`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ verb: "set", path: "tasks/t1", body: { title: "one" } }),
      });
      const granted = await fetch(`${base}/api/frame/db/${id}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subId: "s1", spec: { collection: "tasks" } }),
      });
      expect(granted.status).toBe(200);
      const { grant } = (await granted.json()) as { grant: string };

      const dbLane = new WebSocket(`ws://127.0.0.1:${tls.shellPort}/api/frame/db/ws?artifact=${id}`, {
        headers: { cookie, origin: tls.shellOrigin },
      });
      sockets.push(dbLane);
      await new Promise<void>((resolve, reject) => {
        dbLane.once("open", () => resolve());
        dbLane.once("error", reject);
      });
      dbLane.send(JSON.stringify({ kind: "sub", subId: "s1", grant }));
      // Rows, not `error`: the grant names the viewer the lane read out of
      // `__Host-av`, and `admin` reads take the owner `__Host-ao` names.
      const rows = await firstMessage(dbLane);
      expect(rows.kind).toBe("rows");
      expect(rows.docs.map((d: { id: string }) => d.id)).toEqual(["t1"]);

      const peer = mintPeerId();
      const roomLane = new WebSocket(
        `ws://127.0.0.1:${tls.shellPort}/api/frame/room/ws?artifact=${id}&peer=${peer}`,
        { headers: { cookie, origin: tls.shellOrigin } },
      );
      sockets.push(roomLane);
      expect(await firstMessage(roomLane)).toEqual({ kind: "welcome", peer });
      // An undeclared topic is admin-only, so this echo is the owner cookie.
      roomLane.send(JSON.stringify({ kind: "emit", topic: "clear", d: { board: true } }));
      const echoed = await firstMessage(roomLane);
      expect(echoed.kind).toBe("event");
      expect(echoed.topic).toBe("clear");
    } finally {
      for (const socket of sockets) socket.close();
      await tls.close();
    }
  });
});
