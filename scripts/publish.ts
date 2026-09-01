/**
 * `npm run publish -- <file.html> [--capabilities '{"db":{}}'] [--id <artifactId>]`
 *
 * Creates an artifact from a local HTML file, or publishes a new version of
 * an existing one, through the admin API on the shell origin.
 */
import { readFile } from "node:fs/promises";

interface Args {
  file: string | null;
  capabilities: string | null;
  id: string | null;
  title: string | null;
  server: string;
  token: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: null,
    capabilities: null,
    id: null,
    title: null,
    server: process.env.SHELL_URL ?? `http://localhost:${process.env.SHELL_PORT ?? 8787}`,
    token: process.env.ARTIFACT_OWNER_TOKEN ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`${arg} needs a value`);
        process.exit(2);
      }
      return value;
    };
    if (arg === "--capabilities") args.capabilities = next();
    else if (arg === "--id") args.id = next();
    else if (arg === "--title") args.title = next();
    else if (arg === "--server") args.server = next();
    else if (arg === "--token") args.token = next();
    else if (!arg.startsWith("-")) args.file = arg;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error(
    "usage: npm run publish -- <file.html> [--capabilities '{\"db\":{}}'] [--id <artifactId>] [--title T] [--server http://localhost:8787]",
  );
  process.exit(2);
}

const html = await readFile(args.file, "utf8");
const headers: Record<string, string> = { "content-type": "application/json" };
if (args.token) headers.authorization = `Bearer ${args.token}`;

const url = args.id
  ? `${args.server}/api/artifacts/${args.id}/publish`
  : `${args.server}/api/artifacts`;
const body = args.id
  ? { html }
  : {
      html,
      title: args.title ?? undefined,
      capabilities: args.capabilities ? (JSON.parse(args.capabilities) as unknown) : {},
    };

const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
const text = await response.text();
if (!response.ok) {
  console.error(`${response.status} ${text}`);
  if (response.status === 403) {
    console.error(
      "the admin API needs --token (or ARTIFACT_OWNER_TOKEN), or ARTIFACT_OPEN_ADMIN=1 on the server",
    );
  }
  process.exit(1);
}
const result = JSON.parse(text) as { id?: string; version?: string; url?: string };
const id = args.id ?? result.id;
console.log(JSON.stringify({ ...result, id, url: result.url ?? `${args.server}/a/${id}` }, null, 2));
