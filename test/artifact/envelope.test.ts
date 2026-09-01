import { describe, expect, it } from "vitest";
import { buildEnvelope, frameCsp, inlineJson, RESET_CSS } from "../../src/server/serve.ts";
import { extractTitle } from "../../src/server/store.ts";
import type { FramePreambleConfig } from "../../src/protocol/messages.ts";

const preambleConfig: FramePreambleConfig = {
  v: 1,
  capabilities: { artifact: "artifact.js", self: "artifact.js", db: "db.js" },
  origins: ["http://localhost:8787"],
};
const options = { preambleConfig, preambleSource: "/*preamble*/void 0;" };

describe("page envelope", () => {
  it("wraps author body content in a full document", () => {
    const html = buildEnvelope("<h1>hi</h1>", options);
    expect(html.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(html).toContain("window.__FRAME_PREAMBLE=");
    expect(html).toContain("/*preamble*/void 0;");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain(RESET_CSS);
    expect(html).toContain("</head><body><h1>hi</h1></body></html>");
    // the preamble comes before the page's own head content
    expect(html.indexOf("__FRAME_PREAMBLE")).toBeLessThan(html.indexOf("<meta charset"));
  });

  it("injects into an existing head as its first child", () => {
    const page =
      '<!doctype html><html><head><title>T</title></head><body><p>x</p></body></html>';
    const html = buildEnvelope(page, options);
    expect(html.indexOf("__FRAME_PREAMBLE")).toBeLessThan(html.indexOf("<title>T</title>"));
    expect(html).toContain("<title>T</title>");
    // an author's complete document keeps its own head: no second reset
    expect(html).not.toContain(RESET_CSS);
    expect(html.match(/<head>/g)).toHaveLength(1);
  });

  it("adds a head when a complete document has none", () => {
    const html = buildEnvelope("<!doctype html><html><body>x</body></html>", options);
    expect(html).toContain("<head><script>window.__FRAME_PREAMBLE=");
    expect(html).toContain("</head><body>x</body>");
  });

  it("does not mistake a <header> element for the document head", () => {
    const page =
      '<!doctype html><html><body><header id="h">hi</header><p>body</p></body></html>';
    const html = buildEnvelope(page, options);
    expect(html.indexOf("__FRAME_PREAMBLE")).toBeLessThan(html.indexOf("<header"));
    expect(html).toContain("<head><script>window.__FRAME_PREAMBLE=");
    expect(html).toContain('<header id="h">hi</header>');
  });

  it("never lets the preamble config close the script element", () => {
    const json = inlineJson({ nasty: "</script><img onerror=1>" });
    expect(json).not.toContain("</script>");
    expect(json).toContain("\\u003c");
  });

  it("escapes a script end tag inside the bundle", () => {
    const html = buildEnvelope("<p>x</p>", {
      preambleConfig,
      preambleSource: 'var s = "</script>";',
    });
    expect(html).toContain('var s = "<\\/script>";');
  });

  it("reads the title from the first 8 KB only", () => {
    expect(extractTitle("<title> Spaced  title </title>")).toBe("Spaced title");
    expect(extractTitle(`${"x".repeat(9000)}<title>late</title>`)).toBeNull();
    expect(extractTitle("<p>no title</p>")).toBeNull();
  });
});

describe("frame CSP", () => {
  it("names the shell origin as the only frame ancestor", () => {
    const csp = frameCsp("http://localhost:8787", ["https://api.example.com"]);
    expect(csp).toContain("frame-ancestors http://localhost:8787");
    expect(csp).toContain("connect-src 'self' https://api.example.com");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com");
    expect(csp).toContain("font-src https://fonts.gstatic.com data:");
  });
});
