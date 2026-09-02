/**
 * `sample` broker: the shell side of "ask Claude".
 *
 * It owns everything the frame deliberately does not (docs/analysis/
 * sample-room.md §1.6): first-call consent per artifact per viewer, the
 * five-minute reply cache, per-viewer concurrency, and the translation of
 * the backend's server-sent events into `__frame_cap_p` progress and one
 * `__frame_cap_r`. No credential ever crosses back into the frame: the shell
 * calls its own backend same-origin with the viewer cookie.
 */
import { capError, CAPABILITY_DISABLED, isCapError, type CapError } from "../../protocol/errors.ts";
import type { BrokerCall, BrokerContext } from "../../shell/types.ts";
import {
  MAX_PROMPT_BYTES,
  inputText,
  isModelTier,
  parseLooseJson,
  utf8Bytes,
  type ModelTier,
  type SampleEvent,
  type SampleInput,
  type SampleTurn,
  type WireImage,
  type WireTool,
  type WireToolCall,
  type WireToolResult,
} from "./protocol.ts";

/** Calls a viewer may have in flight at once; the rest wait their turn. */
const MAX_CONCURRENT = 3;
/** Calls that may wait. Beyond this the page is flooding: `rate_limited`. */
const MAX_WAITING = 5;
/** Default replay window for a cached answer (sample.d.ts `gcTime`). */
const DEFAULT_GC_TIME_MS = 300_000;
const MAX_GC_TIME_MS = 86_400_000;
const MAX_IMAGES_TOTAL_BYTES = 5_000_000;
/** Answers held at once; the oldest is dropped past this (never swept else). */
const MAX_CACHE_ENTRIES = 64;
const API_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface SampleResult {
  text: string;
  truncated: boolean;
  modelTierApplied: ModelTier;
}

interface CacheEntry {
  expiresAt: number;
  result: SampleResult;
}

interface InFlight {
  /** The id the backend knows this call by; tool results are posted to it. */
  streamId: string;
  controller: AbortController;
}

interface ViewState {
  inflight: Map<string, InFlight>;
}

/* --------------------------- module-level state -------------------------- */

/** Cached answers, keyed by artifact, viewer and the call's own shape. */
const cache = new Map<string, CacheEntry>();
/** Concurrency slots, per viewer (a second open copy shares the viewer's). */
const slots = new Map<string, { running: number; waiting: number }>();
/** One consent dialog per artifact, however many calls are waiting on it. */
const consentInFlight = new Map<string, Promise<boolean>>();
const views = new WeakMap<BrokerContext, ViewState>();

/** Test seam: unit tests share a module registry, so they reset it. */
export function resetSampleBrokerState(): void {
  cache.clear();
  slots.clear();
  consentInFlight.clear();
}

function viewState(ctx: BrokerContext): ViewState {
  let state = views.get(ctx);
  if (!state) {
    state = { inflight: new Map() };
    views.set(ctx, state);
  }
  return state;
}

/* --------------------------------- helpers ------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invalid = (message: string): CapError => capError("invalid_request", message);

/** The shell re-validates: a frame is not trusted just because ours is honest. */
function readInput(raw: unknown): SampleInput {
  if (typeof raw === "string") {
    if (raw.trim() === "") throw invalid("the prompt must be a non-empty string");
    if (utf8Bytes(raw) > MAX_PROMPT_BYTES) {
      throw capError("prompt_too_large", "the prompt exceeds the 64 KiB limit");
    }
    return raw;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid("input must be a prompt string or a list of {role, content} turns");
  }
  const turns: SampleTurn[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) throw invalid("each turn must be {role, content}");
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || content.trim() === "") {
      throw invalid("each turn must be {role, content}");
    }
    turns.push({ role, content });
  }
  if (turns[0]?.role !== "user" || turns[turns.length - 1]?.role !== "user") {
    throw invalid("the turn list must start and end with a user turn");
  }
  if (utf8Bytes(inputText(turns)) > MAX_PROMPT_BYTES) {
    throw capError("prompt_too_large", "the turns exceed the 64 KiB limit");
  }
  return turns;
}

function readTools(raw: unknown): WireTool[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid("tools must be an array");
  const out: WireTool[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.description !== "string") {
      throw invalid("each tool is {name, description, inputSchema?}");
    }
    const tool: WireTool = { name: entry.name, description: entry.description };
    if (isRecord(entry.inputSchema)) tool.inputSchema = entry.inputSchema;
    out.push(tool);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function readImages(raw: unknown): Promise<WireImage[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw capError("image_rejected", "images must be a list of Blobs");
  const out: WireImage[] = [];
  let total = 0;
  for (const entry of raw) {
    if (typeof Blob === "undefined" || !(entry instanceof Blob)) {
      throw capError("image_rejected", "images must be a list of Blobs");
    }
    const mediaType = (entry.type || "image/jpeg").split(";")[0]?.trim() ?? "image/jpeg";
    if (!API_MEDIA_TYPES.has(mediaType)) {
      throw capError("image_rejected", `${mediaType} is not an image type Claude reads`);
    }
    total += entry.size;
    if (total > MAX_IMAGES_TOTAL_BYTES) {
      throw capError("image_rejected", "images total over 5 MB after resizing");
    }
    out.push({ mediaType, data: toBase64(new Uint8Array(await entry.arrayBuffer())) });
  }
  return out;
}

/* --------------------------------- consent ------------------------------- */

export function consentKey(artifactId: string): string {
  return `consent:${artifactId}:sample`;
}

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* private mode, or no storage at all: the viewer is asked again */
  }
}

const NOT_GRANTED = (): CapError =>
  capError("not_granted", "the viewer has not allowed this artifact to use Claude");

async function ensureConsent(ctx: BrokerContext, callId: string): Promise<void> {
  const key = consentKey(ctx.boot.artifactId);
  const stored = readStored(key);
  if (stored === "granted") return;
  if (stored === "denied") throw NOT_GRANTED();

  // The frame's budget is extended while a viewer decides, and every call
  // that arrives meanwhile waits on the one dialog.
  ctx.ack(callId);
  let dialog = consentInFlight.get(key);
  if (!dialog) {
    dialog = ctx
      .consent({
        title: `Let this artifact ask Claude?`,
        body: "This page wants to send text you give it to Claude on your account, and show the answer. It can do this whenever you use the page.",
        confirmLabel: "Allow",
        cancelLabel: "Not now",
      })
      .then((granted) => {
        writeStored(key, granted ? "granted" : "denied");
        return granted;
      })
      .finally(() => consentInFlight.delete(key));
    consentInFlight.set(key, dialog);
  }
  if (!(await dialog)) throw NOT_GRANTED();
}

/* ---------------------------------- cache -------------------------------- */

/** A small non-cryptographic digest — a cache key, never a security boundary. */
function digest(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16_777_619) >>> 0;
    h2 = Math.imul(h2 + c, 2_246_822_519) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

export function cacheKey(input: {
  artifactId: string;
  viewerId: string;
  verb: "sample" | "json";
  input: SampleInput;
  modelTier: ModelTier;
  images: WireImage[];
}): string {
  const canonical = JSON.stringify([
    input.verb,
    input.modelTier,
    typeof input.input === "string" ? input.input : input.input.map((t) => [t.role, t.content]),
    input.images.map((image) => `${image.mediaType}:${digest(image.data)}`),
  ]);
  return `${input.artifactId}|${input.viewerId}|${digest(canonical)}|${canonical.length}`;
}

interface CachePolicy {
  read: boolean;
  write: boolean;
  gcTime: number;
}

export function cachePolicy(raw: unknown, hasTools: boolean): CachePolicy {
  // "calls with tools are never cached" — the tools may have had effects.
  if (hasTools) return { read: false, write: false, gcTime: 0 };
  if (raw === false) return { read: false, write: false, gcTime: 0 };
  if (raw === undefined || raw === null || raw === true) {
    return { read: true, write: true, gcTime: DEFAULT_GC_TIME_MS };
  }
  if (!isRecord(raw)) return { read: true, write: true, gcTime: DEFAULT_GC_TIME_MS };
  const gcTime =
    typeof raw.gcTime === "number" && Number.isFinite(raw.gcTime) && raw.gcTime > 0
      ? Math.min(raw.gcTime, MAX_GC_TIME_MS)
      : DEFAULT_GC_TIME_MS;
  return { read: raw.refresh !== true, write: true, gcTime };
}

function cacheGet(key: string): SampleResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

/**
 * Nothing else prunes this map, so every write sweeps what has expired and,
 * if the page still asks more distinct questions than the window can hold,
 * drops the oldest entries (a `Map` iterates in insertion order).
 */
function cacheSet(key: string, entry: CacheEntry): void {
  const now = Date.now();
  for (const [k, held] of cache) {
    if (held.expiresAt <= now) cache.delete(k);
  }
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/* ------------------------------- concurrency ----------------------------- */

const CANCELLED = (): CapError => capError("cancelled", "the call was cancelled");

/** Cancellation is checked at every point a call can be parked or resumed. */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw CANCELLED();
}

/** A slot record nobody is using is dropped, so `slots` cannot grow forever. */
function releaseSlots(viewerId: string, state: { running: number; waiting: number }): void {
  if (state.running <= 0 && state.waiting <= 0 && slots.get(viewerId) === state) {
    slots.delete(viewerId);
  }
}

/** Wait `ms`, or until the call is cancelled — whichever comes first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

async function withSlot<T>(
  viewerId: string,
  callId: string,
  ctx: BrokerContext,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const state = slots.get(viewerId) ?? { running: 0, waiting: 0 };
  slots.set(viewerId, state);
  try {
    throwIfCancelled(signal);
    if (state.running >= MAX_CONCURRENT) {
      if (state.waiting >= MAX_WAITING) {
        throw capError("rate_limited", "too many calls at once - let the viewer try again");
      }
      state.waiting++;
      ctx.ack(callId);
      try {
        while (state.running >= MAX_CONCURRENT) {
          // Stop must stop a queued call too: nothing is spent on one the
          // viewer already abandoned.
          throwIfCancelled(signal);
          await sleep(25, signal);
        }
        throwIfCancelled(signal);
      } finally {
        state.waiting--;
      }
    }
    state.running++;
    try {
      return await run();
    } finally {
      state.running--;
    }
  } finally {
    releaseSlots(viewerId, state);
  }
}

/* --------------------------------- the call ------------------------------ */

function readEvent(line: string): SampleEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed) && typeof parsed.type === "string") return parsed as unknown as SampleEvent;
  } catch {
    /* a partial or non-JSON frame */
  }
  return null;
}

/** Split an SSE body into the JSON payload of each `data:` line. */
export function sseFrames(chunk: string, carry: string): { frames: string[]; carry: string } {
  const buffer = carry + chunk;
  const parts = buffer.split(/\n\n/);
  const rest = parts.pop() ?? "";
  const frames: string[] = [];
  for (const part of parts) {
    const data = part
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) frames.push(data);
  }
  return { frames, carry: rest };
}

async function streamCall(
  call: BrokerCall,
  ctx: BrokerContext,
  body: Record<string, unknown>,
  controller: AbortController,
): Promise<SampleResult> {
  throwIfCancelled(controller.signal);
  let text = "";
  let truncated = false;
  let tier: ModelTier = (body.modelTier as ModelTier) ?? "default";
  let failure: CapError | null = null;
  let done = false;

  try {
    const response = await fetch("/api/frame/sample/call", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const detail: unknown = await response.json().catch(() => null);
      if (isCapError(detail)) throw detail;
      throw capError("upstream_error", `the sampling backend answered ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      const split = sseFrames(decoder.decode(value, { stream: true }), carry);
      carry = split.carry;
      for (const frame of split.frames) {
        const event = readEvent(frame);
        if (!event) continue;
        if (event.type === "start") {
          if (isModelTier(event.modelTierApplied)) tier = event.modelTierApplied;
        } else if (event.type === "text") {
          if (typeof event.text === "string" && event.text !== "") {
            text += event.text;
            ctx.progress(call.id, { type: "text", text: event.text });
          }
        } else if (event.type === "tool_use") {
          const calls = Array.isArray(event.calls) ? (event.calls as WireToolCall[]) : [];
          if (calls.length > 0) ctx.progress(call.id, { type: "tool_use", calls });
        } else if (event.type === "done") {
          truncated = event.truncated === true;
          done = true;
        } else if (event.type === "error") {
          failure = capError(
            typeof event.code === "string" ? event.code : "upstream_error",
            typeof event.message === "string" ? event.message : "the sampling backend failed",
          );
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) throw CANCELLED();
    if (isCapError(err)) throw err;
    throw capError("upstream_error", err instanceof Error ? err.message : String(err));
  }

  if (failure) throw failure;
  if (!done) throw capError("upstream_error", "the answer ended before it was finished");
  if (text.trim() === "") throw capError("empty_completion", "Claude produced no text");
  return { text, truncated, modelTierApplied: tier };
}

async function handleSample(call: BrokerCall, ctx: BrokerContext): Promise<SampleResult> {
  // The call is cancellable from its first instant: `cancelCall` finds it here
  // while it is still held for consent or waiting for a slot, long before any
  // request is made (docs/analysis/sample-room.md §3.2).
  const state = viewState(ctx);
  const controller = new AbortController();
  const streamId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  state.inflight.set(call.id, { streamId, controller });
  try {
    const input = readInput(call.args[0]);
    const rawTier = call.args[1];
    if (rawTier !== undefined && rawTier !== null && !isModelTier(rawTier)) {
      throw invalid("modelTier must be default, complex, or quick");
    }
    const modelTier: ModelTier = isModelTier(rawTier) ? rawTier : "default";
    const options = isRecord(call.args[2]) ? call.args[2] : {};
    const verb = options.format === "json" ? "json" : "sample";
    const tools = readTools(options.tools);
    const images = await readImages(options.images);

    await ensureConsent(ctx, call.id);
    // A viewer who pressed Stop while the dialog was up gets no call at all.
    throwIfCancelled(controller.signal);

    const policy = cachePolicy(options.cache, tools.length > 0);
    const key = cacheKey({
      artifactId: ctx.boot.artifactId,
      viewerId: ctx.viewer.id,
      verb,
      input,
      modelTier,
      images,
    });
    if (policy.read) {
      const hit = cacheGet(key);
      if (hit) {
        // Replayed answers still stream, so `onText` renders as it would have.
        ctx.progress(call.id, { type: "text", text: hit.text });
        return hit;
      }
    }

    const result = await withSlot(ctx.viewer.id, call.id, ctx, controller.signal, () =>
      streamCall(
        call,
        ctx,
        {
          callId: streamId,
          artifactId: ctx.boot.artifactId,
          input,
          modelTier,
          format: verb === "json" ? "json" : null,
          tools,
          images,
        },
        controller,
      ),
    );

    throwIfCancelled(controller.signal);
    // A json() answer that holds no JSON — or one cut short before the JSON
    // was complete — is never cached: "Try again" must really ask again
    // (sample.d.ts, `json`).
    const cacheable =
      policy.write && (verb !== "json" || (!result.truncated && parseLooseJson(result.text).ok));
    if (cacheable) cacheSet(key, { expiresAt: Date.now() + policy.gcTime, result });
    return result;
  } finally {
    state.inflight.delete(call.id);
  }
}

async function handleToolResults(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  const [callId, results] = call.args;
  if (typeof callId !== "string" || !Array.isArray(results)) {
    throw invalid("toolResults takes (callId, results)");
  }
  const flight = viewState(ctx).inflight.get(callId);
  // The frame ignores this reply; an unknown id means the call already ended.
  if (!flight) return { ok: false };
  const clean: WireToolResult[] = [];
  for (const entry of results) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.content !== "string") {
      continue;
    }
    clean.push({
      id: entry.id,
      content: entry.content,
      ...(entry.isError === true ? { isError: true } : {}),
    });
  }
  await ctx.api("/api/frame/sample/tool_results", {
    method: "POST",
    body: JSON.stringify({ callId: flight.streamId, results: clean }),
  });
  return { ok: true };
}

function handleCancel(call: BrokerCall, ctx: BrokerContext): unknown {
  const callId = call.args[0];
  if (typeof callId !== "string") throw invalid("cancelCall takes a call id");
  const flight = viewState(ctx).inflight.get(callId);
  flight?.controller.abort();
  return { ok: true };
}

export async function handle(call: BrokerCall, ctx: BrokerContext): Promise<unknown> {
  switch (call.method) {
    case "sample":
      return handleSample(call, ctx);
    case "toolResults":
      return handleToolResults(call, ctx);
    case "cancelCall":
      return handleCancel(call, ctx);
    default:
      throw CAPABILITY_DISABLED(`sample.${call.method}`);
  }
}

/** A remounted view loses its window: every call it held is over. */
export function dispose(ctx: BrokerContext): void {
  const state = views.get(ctx);
  if (!state) return;
  for (const flight of state.inflight.values()) flight.controller.abort();
  state.inflight.clear();
}
