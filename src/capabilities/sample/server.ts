/**
 * `sample` backend: `POST /api/frame/sample/call` on the shell origin,
 * streaming the answer to the shell as server-sent events, plus the
 * `POST /api/frame/sample/tool_results` lane a page tool's answer comes back
 * on while that stream is still open.
 *
 * Two backends: the real Messages API (streaming, tool rounds, images), and
 * a deterministic fake enabled with `SAMPLE_BACKEND=fake` so the tests run
 * with no key and no network.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { capError, isCapError, type CapError } from "../../protocol/errors.ts";
import { isArtifactId } from "../../protocol/paths.ts";
import { maxBodySize } from "../../server/body-limit.ts";
import type { ServerApps, ServerContext } from "../../server/types.ts";
import {
  MAX_PROMPT_BYTES,
  TIER_MODELS,
  inputText,
  isModelTier,
  utf8Bytes,
  type ModelTier,
  type SampleEvent,
  type SampleInput,
  type WireImage,
  type WireTool,
  type WireToolCall,
  type WireToolResult,
} from "./protocol.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 4096;
/** Tool rounds one call may take before the answer is forced to conclude. */
const MAX_TOOL_ROUNDS = 8;
/** How long the backend waits for the page's tool results. */
const TOOL_RESULTS_TIMEOUT_MS = 160_000;

/* ------------------------------ request limits ---------------------------- */

/**
 * Every limit below the page API also lives here. The shell page enforces
 * them for an honest frame; this route is the boundary a direct HTTP caller
 * meets, and it trusts nothing but the artifact's own declared config.
 */
/** Largest request body, generous enough for 5 MB of base64 images. */
const MAX_BODY_BYTES = 8_000_000;
/** The image types the Messages API reads. */
const API_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_TOOL_DEFINITIONS_BYTES = 32_768;
/** Streams one viewer may hold open at once, across every tab they have. */
const MAX_STREAMS_PER_VIEWER = 8;
/** Calls parked on a page's tool results at once, server-wide. */
const MAX_PARKED_TOOL_CALLS = 64;

/* --------------------------------- backend -------------------------------- */

export interface BackendRequest {
  input: SampleInput;
  modelTier: ModelTier;
  format: "json" | null;
  tools: WireTool[];
  images: WireImage[];
  signal: AbortSignal;
  emit(event: SampleEvent): void;
  /**
   * Ask the page to run tools: emits `tool_use` and resolves when the page's
   * results come back on the tool-results lane.
   */
  requestTools(calls: WireToolCall[]): Promise<WireToolResult[]>;
}

export interface SampleBackend {
  run(request: BackendRequest): Promise<void>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length > 0 ? out : [text];
}

let fakeCalls = 0;

/** Test hook: how many answers the fake backend has produced. */
export function fakeBackendCallCount(): number {
  return fakeCalls;
}

/**
 * The deterministic backend. It echoes the prompt in chunks and, when tools
 * are offered, calls the first one once before answering. Three markers in
 * the prompt steer it for tests: `!error:<code>`, `!truncate`, `!slow`.
 */
export function fakeBackend(): SampleBackend {
  return {
    async run(request) {
      const prompt = inputText(request.input);
      request.emit({ type: "start", modelTierApplied: request.modelTier });

      const failure = /!error:([a-z_]+)/.exec(prompt);
      if (failure) {
        request.emit({
          type: "error",
          code: failure[1] ?? "upstream_error",
          message: `the fake backend was asked for ${failure[1] ?? "upstream_error"}`,
        });
        return;
      }

      const n = ++fakeCalls;
      let toolNote = "";
      const first = request.tools[0];
      if (first) {
        const results = await request.requestTools([
          { id: `toolu_fake_${n}`, name: first.name, input: {} },
        ]);
        toolNote = ` [${first.name} -> ${results.map((r) => r.content).join(" | ")}]`;
      }
      if (request.signal.aborted) return;

      const imageNote =
        request.images.length > 0
          ? ` [images: ${request.images.length} ${request.images[0]?.mediaType ?? "?"}]`
          : "";
      const body =
        request.format === "json"
          ? JSON.stringify({
              call: n,
              tier: request.modelTier,
              echo: prompt.slice(0, 200),
              tools: request.tools.map((t) => t.name),
              images: request.images.length,
              toolNote,
            })
          : `echo #${n} (${request.modelTier}): ${prompt}${toolNote}${imageNote}`;

      const slow = prompt.includes("!slow");
      for (const piece of chunk(body, 24)) {
        if (request.signal.aborted) return;
        request.emit({ type: "text", text: piece });
        await delay(slow ? 400 : 5, request.signal);
      }
      if (request.signal.aborted) return;
      request.emit({ type: "done", truncated: prompt.includes("!truncate") });
    },
  };
}

/* ---------------------------- the Messages API ---------------------------- */

interface ApiBlock {
  type: string;
  [key: string]: unknown;
}
interface ApiMessage {
  role: "user" | "assistant";
  content: ApiBlock[];
}

function systemPrompt(format: "json" | null, hasTools: boolean): string {
  const lines = [
    "You are answering inside a published Claude Artifact: a web page the viewer is using right now.",
    "The page sends you exactly what you see — instructions, its own data, and the viewer's words — and shows your reply.",
    "You have no memory of earlier calls and no tools other than any the page offers.",
    "Answer the request directly, with no preamble and no offer to help further.",
  ];
  if (hasTools) {
    lines.push(
      "The page's tools run in the viewer's browser. Call one when it gets you data or an effect you need; otherwise just answer.",
    );
  }
  if (format === "json") {
    lines.push(
      "Your reply is machine-parsed: the final message must be one JSON value and nothing else — no prose, no code fence.",
    );
  }
  return lines.join("\n");
}

function toMessages(input: SampleInput, images: WireImage[]): ApiMessage[] {
  const messages: ApiMessage[] =
    typeof input === "string"
      ? [{ role: "user", content: [{ type: "text", text: input }] }]
      : input.map((turn) => ({
          role: turn.role,
          content: [{ type: "text", text: turn.content }],
        }));
  if (images.length > 0) {
    const last = messages[messages.length - 1];
    if (last) {
      last.content = [
        ...images.map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        })),
        ...last.content,
      ];
    }
  }
  return messages;
}

function apiError(status: number, body: unknown): CapError {
  const type =
    typeof body === "object" && body !== null
      ? ((body as { error?: { type?: unknown; message?: unknown } }).error?.type ?? "")
      : "";
  const message =
    typeof body === "object" && body !== null
      ? String((body as { error?: { message?: unknown } }).error?.message ?? `HTTP ${status}`)
      : `HTTP ${status}`;
  if (status === 429 || type === "rate_limit_error") return capError("rate_limited", message);
  if (status === 401 || type === "authentication_error") {
    return capError("sampling_disabled", message);
  }
  if (status === 403 || type === "permission_error") return capError("not_granted", message);
  if (status === 400 || type === "invalid_request_error") {
    return capError("invalid_request", message);
  }
  return capError("upstream_error", message);
}

interface RoundOutcome {
  text: string;
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string | null;
  blocks: ApiBlock[];
}

/** The real backend: `fetch` against the Messages API, no SDK required. */
export function anthropicBackend(apiKey: string, baseUrl: string): SampleBackend {
  return {
    async run(request) {
      const model = TIER_MODELS[request.modelTier];
      request.emit({ type: "start", modelTierApplied: request.modelTier });
      const messages = toMessages(request.input, request.images);
      const tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      }));

      let truncated = false;
      let wroteText = false;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const body: Record<string, unknown> = {
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          system: systemPrompt(request.format, tools.length > 0),
          messages,
        };
        if (tools.length > 0) body.tools = tools;

        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });
        if (!response.ok || !response.body) {
          throw apiError(response.status, await response.json().catch(() => null));
        }

        const outcome = await readMessageStream(response.body, (text) => {
          if (wroteText || text !== "") {
            request.emit({ type: "text", text });
            wroteText = true;
          }
        });
        if (outcome.stopReason === "max_tokens") truncated = true;
        if (outcome.stopReason === "refusal") {
          request.emit({ type: "error", code: "refused", message: "Claude declined this input" });
          return;
        }
        if (outcome.stopReason !== "tool_use" || outcome.toolUses.length === 0) break;

        // `requestTools` is what puts `tool_use` on the wire; the backend only
        // says which tools it wants run.
        const results = await request.requestTools(outcome.toolUses);
        if (request.signal.aborted) return;
        messages.push({ role: "assistant", content: outcome.blocks });
        messages.push({
          role: "user",
          content: results.map((result) => ({
            type: "tool_result",
            tool_use_id: result.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          })),
        });
        // Rounds are separated by a blank line in the text the page sees.
        request.emit({ type: "text", text: "\n\n" });
      }
      request.emit({ type: "done", truncated });
    },
  };
}

/** Read one Messages API stream, forwarding text deltas as they arrive. */
async function readMessageStream(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<RoundOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let text = "";
  let stopReason: string | null = null;
  const blocks: ApiBlock[] = [];
  const partials = new Map<number, string>();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const parts = carry.split("\n\n");
    carry = parts.pop() ?? "";
    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = event.type;
      if (type === "content_block_start") {
        const index = Number(event.index ?? 0);
        const block = event.content_block as ApiBlock | undefined;
        if (block) {
          blocks[index] = { ...block };
          if (block.type === "tool_use") partials.set(index, "");
        }
      } else if (type === "content_block_delta") {
        const index = Number(event.index ?? 0);
        const delta = event.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          onText(delta.text);
          const target = blocks[index];
          if (target) target.text = String(target.text ?? "") + delta.text;
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          partials.set(index, (partials.get(index) ?? "") + delta.partial_json);
        }
      } else if (type === "message_delta") {
        const delta = event.delta as { stop_reason?: unknown } | undefined;
        if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
      } else if (type === "error") {
        const error = event.error as { message?: unknown; type?: unknown } | undefined;
        throw capError("upstream_error", String(error?.message ?? "the model stream failed"));
      }
    }
  }

  const toolUses: RoundOutcome["toolUses"] = [];
  blocks.forEach((block, index) => {
    if (!block || block.type !== "tool_use") return;
    const raw = partials.get(index) ?? "";
    let input: Record<string, unknown> = {};
    if (raw.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) input = parsed as Record<string, unknown>;
      } catch {
        input = {};
      }
    }
    block.input = input;
    toolUses.push({ id: String(block.id ?? ""), name: String(block.name ?? ""), input });
  });
  return { text, toolUses, stopReason, blocks: blocks.filter(Boolean) };
}

export function selectBackend(): SampleBackend | CapError {
  if ((process.env.SAMPLE_BACKEND ?? "").toLowerCase() === "fake") return fakeBackend();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return capError(
      "sampling_disabled",
      "this server has no ANTHROPIC_API_KEY (set SAMPLE_BACKEND=fake for a deterministic stand-in)",
    );
  }
  return anthropicBackend(key, process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com");
}

/* ------------------------------- tool rounds ------------------------------ */

interface ToolWaiter {
  viewerId: string;
  resolve(results: WireToolResult[]): void;
}

/** Calls whose stream is parked on the page's tool results. */
const waiters = new Map<string, ToolWaiter>();
/** Open streams per viewer, so one caller cannot hold the server open. */
const streamsPerViewer = new Map<string, number>();

function takeStream(viewerId: string): boolean {
  const open = streamsPerViewer.get(viewerId) ?? 0;
  if (open >= MAX_STREAMS_PER_VIEWER) return false;
  streamsPerViewer.set(viewerId, open + 1);
  return true;
}

function releaseStream(viewerId: string): void {
  const open = (streamsPerViewer.get(viewerId) ?? 1) - 1;
  if (open <= 0) streamsPerViewer.delete(viewerId);
  else streamsPerViewer.set(viewerId, open);
}

/* --------------------------------- routes --------------------------------- */

interface CallBody {
  callId?: unknown;
  artifactId?: unknown;
  input?: unknown;
  modelTier?: unknown;
  format?: unknown;
  tools?: unknown;
  images?: unknown;
}

function readInput(raw: unknown): SampleInput | null {
  if (typeof raw === "string") return raw.trim() === "" ? null : raw;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const turns: SampleInput = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    turns.push({ role, content });
  }
  return turns;
}

/* ------------------------- the artifact's own config ----------------------- */

type FailStatus = 400 | 403 | 404 | 409 | 413 | 429 | 503;

/** A refusal carrying the status and the `{code, message}` body to answer. */
class Refusal extends Error {
  constructor(
    readonly status: FailStatus,
    readonly error: CapError,
  ) {
    super(error.message);
  }
}

function refuse(status: FailStatus, code: string, message: string): never {
  throw new Refusal(status, capError(code, message));
}

interface ImageLimits {
  maxCount: number;
  maxBytes: number;
  maxTotalBytes: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `capabilities.sample.config.images`, with the same clamps the frame uses. */
function readImageLimits(raw: unknown): ImageLimits | null {
  const cfg = asRecord(raw);
  if (!cfg) return null;
  return {
    maxCount: clampInt(cfg.maxCount, 4, 1, 20),
    maxBytes: clampInt(cfg.maxBytes, 2_000_000, 100_000, 10_000_000),
    maxTotalBytes: clampInt(cfg.maxTotalBytes, 5_000_000, 100_000, 40_000_000),
  };
}

/** `capabilities.sample.config.tools`. */
function readToolLimits(raw: unknown): { maxCount: number } | null {
  const cfg = asRecord(raw);
  if (!cfg) return null;
  return { maxCount: clampInt(cfg.maxCount, 16, 1, 128) };
}

/** Decoded size of a base64 payload, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function readTools(raw: unknown, limits: { maxCount: number } | null): WireTool[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) refuse(400, "invalid_request", "tools must be an array");
  if (raw.length === 0) return [];
  if (!limits) {
    refuse(400, "tools_unavailable", "this artifact does not declare page tools");
  }
  if (raw.length > limits.maxCount) {
    refuse(400, "invalid_request", `at most ${limits.maxCount} tools per call`);
  }
  const out: WireTool[] = [];
  for (const entry of raw) {
    const tool = asRecord(entry);
    if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string") {
      refuse(400, "invalid_request", "each tool is {name, description, inputSchema?}");
    }
    const inputSchema = asRecord(tool.inputSchema);
    out.push({
      name: tool.name,
      description: tool.description,
      ...(inputSchema ? { inputSchema } : {}),
    });
  }
  if (utf8Bytes(JSON.stringify(out)) > MAX_TOOL_DEFINITIONS_BYTES) {
    refuse(400, "invalid_request", "the tool definitions together are at most 32 KB");
  }
  return out;
}

function readImages(raw: unknown, limits: ImageLimits | null): WireImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) refuse(400, "image_rejected", "images must be an array");
  if (raw.length === 0) return [];
  if (!limits) {
    refuse(400, "images_unavailable", "this artifact does not declare image input");
  }
  if (raw.length > limits.maxCount) {
    refuse(400, "image_rejected", `at most ${limits.maxCount} images per call`);
  }
  const out: WireImage[] = [];
  let total = 0;
  for (const entry of raw) {
    const image = asRecord(entry);
    if (!image || typeof image.mediaType !== "string" || typeof image.data !== "string") {
      refuse(400, "image_rejected", "each image is {mediaType, data}");
    }
    if (!API_MEDIA_TYPES.has(image.mediaType)) {
      refuse(400, "image_rejected", `${image.mediaType} is not an image type Claude reads`);
    }
    const bytes = base64Bytes(image.data);
    if (bytes > limits.maxBytes) {
      refuse(400, "image_rejected", "an image is over the size this artifact allows");
    }
    total += bytes;
    if (total > limits.maxTotalBytes) {
      refuse(400, "image_rejected", "the images together are over the size this artifact allows");
    }
    out.push({ mediaType: image.mediaType, data: image.data });
  }
  return out;
}

/**
 * Read the body, refusing one too big to hold before it is parsed. The
 * `maxBodySize` middleware mounted on this route already meters the stream
 * itself — including a chunked body, which declares no `content-length` to
 * pre-check — so this is a backstop: a multi-byte character makes `raw` (in
 * UTF-16 units) shorter than its own UTF-8 byte length, so the check must
 * measure bytes, not string length, or it can pass a body the middleware
 * would have refused.
 */
async function readBody(c: Context): Promise<CallBody> {
  const raw = await c.req.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    refuse(413, "too_large", "the request body is too large");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    refuse(400, "invalid_request", "bad request body");
  }
  const body = asRecord(parsed);
  if (!body) refuse(400, "invalid_request", "bad request body");
  return body as CallBody;
}

export function routes(apps: ServerApps, ctx: ServerContext): void {
  // Meters the stream itself, so a chunked body (no `content-length` to
  // pre-check) is caught exactly like one that declares its length honestly.
  apps.shell.use("/api/frame/sample/*", maxBodySize(MAX_BODY_BYTES));

  apps.shell.post("/api/frame/sample/call", async (c) => {
    // Everything the page API promises is re-checked here: this route, not
    // the shell page, is what a direct HTTP caller meets.
    let plan: {
      viewerId: string;
      callId: string;
      input: SampleInput;
      modelTier: ModelTier;
      format: "json" | null;
      tools: WireTool[];
      images: WireImage[];
      backend: SampleBackend;
    };
    try {
      const body = await readBody(c);
      if (typeof body.callId !== "string" || !isArtifactId(String(body.artifactId))) {
        refuse(400, "invalid_request", "bad request body");
      }
      const artifactId = String(body.artifactId);
      const meta = await ctx.store.readMeta(artifactId);
      if (!meta) refuse(404, "not_declared", "no such artifact");
      const declared = meta.capabilities.sample;
      if (!declared) {
        refuse(400, "not_declared", "this artifact no longer declares sample");
      }
      const viewer = ctx.auth.viewer(c);
      const level = ctx.auth.levelFor(viewer, meta);
      if (level === "view") {
        refuse(403, "not_granted", "this viewer may not use Claude here");
      }

      const input = readInput(body.input);
      if (!input) refuse(400, "invalid_request", "input is required");
      if (utf8Bytes(inputText(input)) > MAX_PROMPT_BYTES) {
        refuse(400, "prompt_too_large", "the prompt exceeds the 64 KiB limit");
      }
      if (waiters.has(body.callId)) {
        refuse(409, "invalid_request", "duplicate call id");
      }

      // Images and tools are the artifact's to offer: a caller cannot send
      // either to a view that never declared it.
      const config = asRecord(declared.config) ?? {};
      const tools = readTools(body.tools, readToolLimits(config.tools));
      const images = readImages(body.images, readImageLimits(config.images));

      const backend = selectBackend();
      if (isCapError(backend)) throw new Refusal(503, backend);

      if (!takeStream(viewer.id)) {
        refuse(429, "rate_limited", "too many calls at once - let the viewer try again");
      }
      plan = {
        viewerId: viewer.id,
        callId: body.callId,
        input,
        modelTier: isModelTier(body.modelTier) ? body.modelTier : "default",
        format: body.format === "json" ? "json" : null,
        tools,
        images,
        backend,
      };
    } catch (err) {
      if (err instanceof Refusal) return c.json(err.error, err.status);
      throw err;
    }

    const { viewerId, callId, input, modelTier, format, tools, images, backend } = plan;
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });

      // One write at a time: `emit` is synchronous for the backend's sake.
      let chain: Promise<void> = Promise.resolve();
      const emit = (event: SampleEvent): void => {
        chain = chain
          .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
          .catch(() => undefined);
      };

      const requestTools = (calls: WireToolCall[]): Promise<WireToolResult[]> =>
        new Promise<WireToolResult[]>((resolve, reject) => {
          // A parked stream costs a socket and a timer for as long as the
          // page takes to answer, so only so many may be parked at once.
          if (waiters.size >= MAX_PARKED_TOOL_CALLS) {
            reject(capError("rate_limited", "too many calls are waiting on page tools"));
            return;
          }
          emit({ type: "tool_use", calls });
          const timer = setTimeout(() => {
            waiters.delete(callId);
            reject(capError("upstream_error", "the page never returned its tool results"));
          }, TOOL_RESULTS_TIMEOUT_MS);
          const finish = (results: WireToolResult[]): void => {
            clearTimeout(timer);
            waiters.delete(callId);
            resolve(results);
          };
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              waiters.delete(callId);
              resolve(calls.map((call) => ({ id: call.id, content: "Error: the call ended", isError: true })));
            },
            { once: true },
          );
          waiters.set(callId, { viewerId, resolve: finish });
        });

      try {
        await backend.run({
          input,
          modelTier,
          format,
          tools,
          images,
          signal: controller.signal,
          emit,
          requestTools,
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          const error = isCapError(err)
            ? err
            : capError("upstream_error", err instanceof Error ? err.message : String(err));
          emit({ type: "error", code: error.code, message: error.message });
        }
      } finally {
        waiters.delete(callId);
        releaseStream(viewerId);
      }
      await chain;
    });
  });

  apps.shell.post("/api/frame/sample/tool_results", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      callId?: unknown;
      results?: unknown;
    } | null;
    if (!body || typeof body.callId !== "string" || !Array.isArray(body.results)) {
      return c.json({ code: "invalid_request", message: "callId and results are required" }, 400);
    }
    const waiter = waiters.get(body.callId);
    // A call nobody is waiting on is over: say so rather than holding bytes.
    if (!waiter) return c.json({ code: "invalid_request", message: "no such call" }, 404);
    const viewer = ctx.auth.viewer(c);
    // Only the viewer whose call this is may answer its tools.
    if (waiter.viewerId !== viewer.id) {
      return c.json({ code: "not_granted", message: "not your call" }, 403);
    }
    const results: WireToolResult[] = [];
    for (const entry of body.results) {
      if (typeof entry !== "object" || entry === null) continue;
      const result = entry as { id?: unknown; content?: unknown; isError?: unknown };
      if (typeof result.id !== "string" || typeof result.content !== "string") continue;
      results.push({
        id: result.id,
        content: result.content,
        ...(result.isError === true ? { isError: true } : {}),
      });
    }
    waiter.resolve(results);
    return c.json({ ok: true });
  });
}
