/**
 * `sample` — the page-facing namespace from
 * `reference/contract/0.2.32/sample.d.ts`: a callable namespace with
 * `sample`, `json` and `limits`.
 *
 * Everything the platform's own module does before the wire is done here
 * (docs/analysis/sample-room.md §1): input and option validation with the
 * documented messages, image sniffing/decoding/downscaling, tool-definition
 * validation, the `__frame_cap` call lifecycle with its ack extension and
 * `cancelCall`, in-frame tool rounds, `onText` delivery of whole text plus
 * delta, and the tolerant JSON read for `json()`. Caching, consent,
 * concurrency and tier substitution are shell-side and never decided here.
 */
import { capIdPrefix } from "../../protocol/capabilities.ts";
import { capError, isCapError, type CapError } from "../../protocol/errors.ts";
import {
  isFrameCapAck,
  isFrameCapProgress,
  isFrameCapReply,
} from "../../protocol/messages.ts";
import { browserRpcHost, type RpcHost } from "../../frame/rpc.ts";
import type { FrameContext } from "../../frame/types.ts";
import {
  MAX_PROMPT_BYTES,
  isModelTier,
  parseLooseJson,
  utf8Bytes,
  type ModelTier,
  type SampleInput,
  type SampleTurn,
  type WireTool,
  type WireToolCall,
  type WireToolResult,
} from "./protocol.ts";

const CAP = "sample";

/* ------------------------------- constants ------------------------------- */

const MAX_TURNS = 1000;
/** Largest input file accepted before downsizing (`limits().images`). */
const MAX_IMAGE_INPUT_BYTES = 20_000_000;
const MAX_IMAGE_SIDE = 10_000;
const MAX_IMAGE_AREA = 64_000_000;
const HEADER_SNIFF_BYTES = 1_048_576;
const QUALITY_LADDER = [0.85, 0.7] as const;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SCHEMA_PROP_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_TOOL_DESCRIPTION_BYTES = 1024;
const MAX_TOOL_SCHEMA_BYTES = 4096;
const MAX_TOOL_SCHEMA_DEPTH = 8;
const MAX_TOOL_DEFINITIONS_BYTES = 32_768;
const MAX_TOOL_RESULT_BYTES = 32_768;
const MAX_TOOL_ERROR_BYTES = 2048;
/** A single `execute` gets this long before the round answers without it. */
const TOOL_TIMEOUT_MS = 150_000;
const DEFAULT_MAX_TOOLS = 16;
const FALLBACK_REPLY_TIMEOUT_MS = 130_000;
const REPLY_BUDGET_EXTRA_MS = 2000;
const REPLY_BUDGET_CAP_MS = 600_000;
/** An `__frame_cap_ack` (consent dialog, queue) extends the call to this. */
const ACK_TIMEOUT_MS = 900_000;
const MAX_GC_TIME_MS = 86_400_000;

/** What `limits().images.mediaTypes` reports: the INPUT types, always. */
const INPUT_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
/** What the canvas may re-encode to. */
const ENCODINGS = ["image/jpeg", "image/webp", "image/png"] as const;
const DEFAULT_ENCODINGS = ["image/jpeg", "image/png"];
const KNOWN_OPTION_KEYS = ["onText", "signal", "tools", "images", "modelTier", "cache"];

/* --------------------------------- config -------------------------------- */

export interface ImageConfig {
  maxCount: number;
  maxBytes: number;
  maxTotalBytes: number;
  maxEdgePx: number;
  patchPx: number;
  maxPatches: number;
  mediaTypes: string[];
}

export interface ToolConfig {
  maxCount: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `config.images`; a missing or unusable value makes images unavailable. */
export function parseImageConfig(raw: unknown): ImageConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const cfg = raw as Record<string, unknown>;
  const requested = Array.isArray(cfg.mediaTypes)
    ? cfg.mediaTypes.filter(
        (t): t is string => typeof t === "string" && (ENCODINGS as readonly string[]).includes(t),
      )
    : DEFAULT_ENCODINGS;
  if (requested.length === 0) return null;
  return {
    maxCount: clampInt(cfg.maxCount, 4, 1, 20),
    maxBytes: clampInt(cfg.maxBytes, 2_000_000, 100_000, 10_000_000),
    maxTotalBytes: clampInt(cfg.maxTotalBytes, 5_000_000, 100_000, 40_000_000),
    maxEdgePx: clampInt(cfg.maxEdgePx, 1568, 64, 8000),
    patchPx: clampInt(cfg.patchPx, 28, 8, 256),
    maxPatches: clampInt(cfg.maxPatches, 1568, 16, 65_536),
    mediaTypes: [...requested],
  };
}

/** `config.tools`; a missing or unusable value makes page tools unavailable. */
export function parseToolConfig(raw: unknown): ToolConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const cfg = raw as Record<string, unknown>;
  return { maxCount: clampInt(cfg.maxCount, DEFAULT_MAX_TOOLS, 1, 128) };
}

export interface SampleLimits {
  maxPromptBytes: number;
  images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] };
  tools?: { maxCount: number };
}

/**
 * A fresh snapshot every call. `limits()` hands the page a value it may keep,
 * and the platform module builds a new object each time (docs/analysis/
 * sample-room.md §1.1), so one caller's mutation must not reach the next.
 * Left mutable, as `SampleLimits.mediaTypes` is a plain `string[]` the page is
 * free to sort or filter in place.
 */
export function buildLimits(images: ImageConfig | null, tools: ToolConfig | null): SampleLimits {
  const limits: SampleLimits = { maxPromptBytes: MAX_PROMPT_BYTES };
  if (images) {
    limits.images = {
      maxCount: images.maxCount,
      maxInputBytes: MAX_IMAGE_INPUT_BYTES,
      mediaTypes: [...INPUT_MEDIA_TYPES],
    };
  }
  if (tools) limits.tools = { maxCount: tools.maxCount };
  return limits;
}

/* -------------------------------- errors --------------------------------- */

const invalid = (message: string): CapError => capError("invalid_request", message);
const rejectImage = (message: string): CapError => capError("image_rejected", message);

/* ---------------------------- input validation --------------------------- */

export function validateInput(input: unknown): SampleInput {
  if (typeof input === "string") {
    if (input.trim() === "") throw invalid("the prompt must be a non-empty string");
    if (utf8Bytes(input) > MAX_PROMPT_BYTES) {
      throw capError("prompt_too_large", "the prompt exceeds the 64 KiB limit");
    }
    return input;
  }
  if (Array.isArray(input)) return validateTurns(input);
  if (typeof input === "object" && input !== null) {
    throw invalid("pass the prompt as the first argument: sample(prompt, options)");
  }
  throw invalid("input must be a prompt string or a list of {role, content} turns");
}

function validateTurns(turns: unknown[]): SampleTurn[] {
  if (turns.length === 0) throw invalid("the turn list is empty");
  if (turns.length > MAX_TURNS) throw invalid(`at most ${MAX_TURNS} turns per call`);
  const out: SampleTurn[] = [];
  let bytes = 0;
  for (const turn of turns) {
    if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
      throw invalid("each turn must be {role, content}");
    }
    const { role, content } = turn as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      throw invalid('turn role must be "user" or "assistant"');
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw invalid("each turn needs non-blank text content");
    }
    bytes += utf8Bytes(content);
    // Turns are copied: extra keys are dropped and the page's array is never
    // read again (`SampleInput`: "The array is copied when you call").
    out.push({ role, content });
  }
  if (out[0]?.role !== "user" || out[out.length - 1]?.role !== "user") {
    throw invalid("the turn list must start and end with a user turn");
  }
  if (bytes > MAX_PROMPT_BYTES) {
    throw capError("prompt_too_large", "the turns exceed the 64 KiB limit");
  }
  return out;
}

/* --------------------------- option validation --------------------------- */

export interface ValidTool extends WireTool {
  execute(input: Record<string, unknown>, context: { signal: AbortSignal }): unknown;
}

export interface CallSpec {
  input: SampleInput;
  modelTier?: ModelTier;
  format: "json" | null;
  onText?: (update: { text: string; delta: string }) => unknown;
  signal?: AbortSignal;
  images: Blob[];
  tools: ValidTool[];
  cache?: boolean | { gcTime?: number; refresh?: boolean };
}

/** The hint the platform appends when `options` is not a plain object. */
function optionsHint(options: unknown): string {
  if (typeof options === "function") return "for streaming pass {onText: fn}";
  if (typeof options === "string") {
    return "for a model tier pass {modelTier}; the prompt is the first argument";
  }
  if (typeof AbortController !== "undefined" && options instanceof AbortController) {
    return "to cancel pass {signal: ctl.signal}";
  }
  if (typeof AbortSignal !== "undefined" && options instanceof AbortSignal) {
    return "to cancel pass {signal}";
  }
  return "for images pass {images}";
}

const warnedOptionKeys = new Set<string>();

function warnUnknownOption(key: string): void {
  if (warnedOptionKeys.has(key)) return;
  warnedOptionKeys.add(key);
  try {
    console.warn(`claude.sample: unknown option "${key}" ignored`);
  } catch {
    /* a page that replaced console must not break the call */
  }
}

function validateCache(raw: unknown): CallSpec["cache"] {
  if (raw === undefined) return undefined;
  if (raw === true || raw === false) return raw;
  if (!isPlainObject(raw)) throw invalid("cache must be true, false, or {gcTime?, refresh?}");
  const out: { gcTime?: number; refresh?: boolean } = {};
  if (raw.gcTime !== undefined && raw.gcTime !== null) {
    const gcTime = raw.gcTime;
    if (typeof gcTime !== "number" || !Number.isFinite(gcTime) || gcTime <= 0) {
      throw invalid(
        "cache.gcTime must be a number of milliseconds above zero (cache: false disables caching)",
      );
    }
    out.gcTime = Math.min(gcTime, MAX_GC_TIME_MS);
  }
  if (raw.refresh !== undefined && raw.refresh !== null) {
    if (typeof raw.refresh !== "boolean") throw invalid("cache.refresh must be true or false");
    out.refresh = raw.refresh;
  }
  return out;
}

function validateImages(raw: unknown, config: ImageConfig | null): Blob[] {
  if (raw === undefined || raw === null) return [];
  let list: unknown[];
  if (typeof Blob !== "undefined" && raw instanceof Blob) list = [raw];
  else if (typeof raw === "object" && Symbol.iterator in (raw as object)) {
    list = Array.from(raw as Iterable<unknown>);
  } else throw invalid("images must be a Blob or File, or a list of them");
  for (const item of list) {
    if (typeof Blob === "undefined" || !(item instanceof Blob)) {
      throw invalid("images must be a Blob or File, or a list of them");
    }
  }
  const blobs = list as Blob[];
  if (blobs.length === 0) return [];
  if (!config) throw capError("images_unavailable", "image input is not available in this view");
  if (blobs.length > config.maxCount) {
    throw rejectImage(`at most ${config.maxCount} images per call`);
  }
  return blobs;
}

/* ---------------------------- tool validation ---------------------------- */

const SCHEMA_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["input_schema", "inputSchema"],
  ["parameters", "inputSchema"],
  ["run", "execute"],
  ["handler", "execute"],
];

function schemaDepth(value: unknown, depth = 1): number {
  if (!isPlainObject(value) && !Array.isArray(value)) return depth - 1;
  let deepest = depth;
  const entries: unknown[] = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    if (isPlainObject(entry)) deepest = Math.max(deepest, schemaDepth(entry, depth + 1));
    else if (Array.isArray(entry)) deepest = Math.max(deepest, schemaDepth(entry, depth));
  }
  return deepest;
}

function assertPlainThroughout(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertPlainThroughout(entry, label);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (!isPlainObject(value)) {
    const name = (value as object).constructor?.name ?? "value";
    throw invalid(`${label}inputSchema must be plain JSON data (it contains a ${name})`);
  }
  for (const entry of Object.values(value)) assertPlainThroughout(entry, label);
}

export function validateInputSchema(raw: unknown, label: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return { type: "object", properties: {} };
  if (!isPlainObject(raw)) {
    throw invalid(`${label}inputSchema must be plain JSON data (it contains a value)`);
  }
  assertPlainThroughout(raw, label);
  if (raw.type !== "object") throw invalid(`${label}inputSchema needs type: "object" at its root`);
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    if (combinator in raw) {
      throw invalid(
        `${label}inputSchema cannot use ${combinator} at its root - put it on a property`,
      );
    }
  }
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.some((r) => typeof r !== "string")) {
      throw invalid(`${label}inputSchema required must be an array of property names`);
    }
  }
  if (raw.properties !== undefined) {
    if (!isPlainObject(raw.properties)) {
      throw invalid(`${label}inputSchema properties must be a plain object`);
    }
    for (const key of Object.keys(raw.properties)) {
      if (!SCHEMA_PROP_RE.test(key)) {
        throw invalid(`${label}property "${key}" - names are 1-64 of A-Z a-z 0-9 _ . -`);
      }
    }
  }
  if (schemaDepth(raw) > MAX_TOOL_SCHEMA_DEPTH) {
    throw invalid(`${label}inputSchema nests deeper than ${MAX_TOOL_SCHEMA_DEPTH}`);
  }
  if (utf8Bytes(JSON.stringify(raw)) > MAX_TOOL_SCHEMA_BYTES) {
    throw invalid(`${label}inputSchema is at most 4 KB`);
  }
  return raw;
}

export function validateTools(raw: unknown, config: ToolConfig | null): ValidTool[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw invalid(
      "tools must be an array of {name, description, inputSchema?, execute} - not an object keyed by name",
    );
  }
  if (raw.length === 0) return [];
  if (!config) {
    throw capError(
      "tools_unavailable",
      "this view cannot run page tools - check (await sample.limits()).tools",
    );
  }
  if (raw.length > config.maxCount) {
    throw invalid(`at most ${config.maxCount} tools per call (got ${raw.length})`);
  }

  const out: ValidTool[] = [];
  const names = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const named =
      isPlainObject(entry) && typeof entry.name === "string" ? entry.name : String(i);
    const label = `tools[${i}] (${named}): `;
    if (!isPlainObject(entry)) {
      throw invalid(`${label}each tool is a plain object {name, description, inputSchema?, execute}`);
    }
    for (const [alias, real] of SCHEMA_ALIASES) {
      if (alias in entry && !(real in entry)) {
        throw invalid(`${label}"${alias}" - did you mean "${real}"?`);
      }
    }
    if (typeof entry.name !== "string" || !TOOL_NAME_RE.test(entry.name)) {
      throw invalid(`${label}name is 1-128 of A-Z a-z 0-9 _ -`);
    }
    if (names.has(entry.name)) throw invalid(`${label}duplicate name`);
    names.add(entry.name);
    if (typeof entry.description !== "string" || entry.description.trim() === "") {
      throw invalid(`${label}description is required - say what the tool does and returns`);
    }
    if (utf8Bytes(entry.description) > MAX_TOOL_DESCRIPTION_BYTES) {
      throw invalid(`${label}description is at most 1 KB`);
    }
    const inputSchema = validateInputSchema(entry.inputSchema, label);
    if (typeof entry.execute !== "function") throw invalid(`${label}execute must be a function`);
    out.push({
      name: entry.name,
      description: entry.description,
      inputSchema,
      execute: entry.execute as ValidTool["execute"],
    });
  }

  const definitions = out.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  if (utf8Bytes(JSON.stringify(definitions)) > MAX_TOOL_DEFINITIONS_BYTES) {
    throw invalid("the tool definitions together are at most 32 KB");
  }
  return out;
}

/* ----------------------------- whole call spec --------------------------- */

export function validateCall(
  input: unknown,
  options: unknown,
  format: "json" | null,
  images: ImageConfig | null,
  tools: ToolConfig | null,
): CallSpec {
  try {
    const spec: CallSpec = {
      input: validateInput(input),
      format,
      images: [],
      tools: [],
    };
    if (options === undefined || options === null) return spec;
    const proto: unknown =
      typeof options === "object" ? Object.getPrototypeOf(options as object) : undefined;
    if (typeof options !== "object" || (proto !== Object.prototype && proto !== null)) {
      throw invalid(`options must be a plain object - ${optionsHint(options)}`);
    }
    const opts = options as Record<string, unknown>;
    for (const key of Object.keys(opts)) {
      if (!KNOWN_OPTION_KEYS.includes(key)) warnUnknownOption(key);
    }

    spec.tools = validateTools(opts.tools, tools);
    if (spec.tools.length > 0 && opts.cache !== undefined && opts.cache !== null && opts.cache !== false) {
      throw invalid("calls with tools are never cached - remove cache");
    }
    if (opts.onText !== undefined && opts.onText !== null) {
      if (typeof opts.onText !== "function") throw invalid("onText must be a function");
      spec.onText = opts.onText as CallSpec["onText"];
    }
    if (opts.signal !== undefined && opts.signal !== null) {
      if (typeof AbortSignal === "undefined" || !(opts.signal instanceof AbortSignal)) {
        throw invalid(
          typeof AbortController !== "undefined" && opts.signal instanceof AbortController
            ? "signal: pass ctl.signal, not the controller"
            : "signal must be an AbortSignal",
        );
      }
      spec.signal = opts.signal;
    }
    if (opts.modelTier !== undefined && opts.modelTier !== null) {
      if (!isModelTier(opts.modelTier)) {
        throw invalid("modelTier must be default, complex, or quick");
      }
      spec.modelTier = opts.modelTier;
    }
    const cache = validateCache(opts.cache);
    if (cache !== undefined) spec.cache = cache;
    spec.images = validateImages(opts.images, images);
    return spec;
  } catch (err) {
    if (isCapError(err)) throw err;
    throw invalid("input and options must be plain data");
  }
}

/* ------------------------------- image work ------------------------------ */

export interface SniffedImage {
  type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

function be16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}
function le16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}
function be32(b: Uint8Array, at: number): number {
  return (
    ((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)
  );
}
function ascii(b: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(b[at + i] ?? 0);
  return out;
}

/**
 * Read type and dimensions out of the first bytes of a file, exactly as the
 * platform does: the browser's own decoder is never asked what a file is.
 * `null` means "not one of the four types"; `"unreadable"` a truncated or
 * nonsensical header.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | "unreadable" | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => bytes[i] === byte)) {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return "unreadable";
    const width = be32(bytes, 16);
    const height = be32(bytes, 20);
    return width > 0 && height > 0 ? { type: "image/png", width, height } : "unreadable";
  }
  const head6 = ascii(bytes, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") {
    if (bytes.length < 10) return "unreadable";
    const width = le16(bytes, 6);
    const height = le16(bytes, 8);
    return width > 0 && height > 0 ? { type: "image/gif", width, height } : "unreadable";
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8 ") {
      if (bytes.length < 30) return "unreadable";
      const width = le16(bytes, 26) & 0x3fff;
      const height = le16(bytes, 28) & 0x3fff;
      return width > 0 && height > 0 ? { type: "image/webp", width, height } : "unreadable";
    }
    if (chunk === "VP8L") {
      if (bytes.length < 25) return "unreadable";
      const packed =
        (bytes[21] ?? 0) |
        ((bytes[22] ?? 0) << 8) |
        ((bytes[23] ?? 0) << 16) |
        ((bytes[24] ?? 0) << 24);
      const width = (packed & 0x3fff) + 1;
      const height = ((packed >>> 14) & 0x3fff) + 1;
      return { type: "image/webp", width, height };
    }
    if (chunk === "VP8X") {
      if (bytes.length < 30) return "unreadable";
      const width = ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16)) + 1;
      const height = ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16)) + 1;
      return { type: "image/webp", width, height };
    }
    return "unreadable";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at] !== 0xff) return "unreadable";
      const marker = bytes[at + 1] ?? 0;
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2;
        continue;
      }
      const length = be16(bytes, at + 2);
      if (length < 2) return "unreadable";
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (at + 9 > bytes.length) return "unreadable";
        const height = be16(bytes, at + 5);
        const width = be16(bytes, at + 7);
        return width > 0 && height > 0 ? { type: "image/jpeg", width, height } : "unreadable";
      }
      at += 2 + length;
    }
    return "unreadable";
  }
  return null;
}

/**
 * The downscale target: at most `maxEdgePx` on a side and `maxPatches`
 * patches of `patchPx` — with the defaults, roughly 1.2 megapixels.
 */
export function targetSize(
  width: number,
  height: number,
  cfg: Pick<ImageConfig, "maxEdgePx" | "patchPx" | "maxPatches">,
): { width: number; height: number } {
  const patchArea = cfg.patchPx * cfg.patchPx;
  const scale = Math.min(
    1,
    cfg.maxEdgePx / Math.max(width, height),
    Math.sqrt((cfg.maxPatches * patchArea) / (width * height)),
  );
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  for (let i = 0; i < 400; i++) {
    const patches = Math.ceil(w / cfg.patchPx) * Math.ceil(h / cfg.patchPx);
    if (Math.max(w, h) <= cfg.maxEdgePx && patches <= cfg.maxPatches) break;
    w = Math.max(1, Math.floor(w * 0.99));
    h = Math.max(1, Math.floor(h * 0.99));
  }
  return { width: w, height: h };
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/** Try each encoding in order, accepting the first blob under `budget`. */
async function encodeUnder(
  canvas: HTMLCanvasElement,
  types: string[],
  budget: number,
): Promise<Blob | null> {
  for (const type of types) {
    const qualities = type === "image/png" ? [undefined] : QUALITY_LADDER;
    for (const quality of qualities) {
      const blob = await canvasBlob(canvas, type, quality);
      if (blob && blob.type === type && blob.size <= budget) return blob;
    }
  }
  return null;
}

async function prepareImage(
  blob: Blob,
  index: number,
  budget: number,
  cfg: ImageConfig,
): Promise<Blob> {
  const at = (message: string): CapError => rejectImage(`image ${index}: ${message}`);
  let size: number;
  try {
    size = blob.size;
  } catch {
    throw invalid("images must be plain Blobs");
  }
  if (size === 0) throw at("the file is empty");
  if (size > MAX_IMAGE_INPUT_BYTES) throw at("the file is over 20 MB - choose a smaller one");

  let header: Uint8Array;
  try {
    header = new Uint8Array(await blob.slice(0, HEADER_SNIFF_BYTES).arrayBuffer());
  } catch {
    throw at("the file could not be read");
  }
  const sniffed = sniffImage(header);
  if (sniffed === null) throw at("not a JPEG, PNG, WebP, or GIF file");
  if (sniffed === "unreadable") {
    throw at("the file's header could not be read - re-save it as JPEG or PNG");
  }
  if (
    sniffed.width > MAX_IMAGE_SIDE ||
    sniffed.height > MAX_IMAGE_SIDE ||
    sniffed.width * sniffed.height > MAX_IMAGE_AREA
  ) {
    throw at(
      "larger than 10,000 pixels on a side or 64 megapixels - choose a smaller version",
    );
  }

  let bitmap: ImageBitmap;
  const wanted = targetSize(sniffed.width, sniffed.height, cfg);
  try {
    const options: ImageBitmapOptions = { imageOrientation: "from-image" };
    if (sniffed.type === "image/png" || sniffed.type === "image/gif") {
      options.resizeWidth = wanted.width;
      options.resizeHeight = wanted.height;
      options.resizeQuality = "high";
    }
    try {
      bitmap = await createImageBitmap(blob, options);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      bitmap = await createImageBitmap(blob);
    }
  } catch {
    throw at("the file could not be decoded - try a different file");
  }

  const canvas = document.createElement("canvas");
  try {
    const final = targetSize(bitmap.width, bitmap.height, cfg);
    canvas.width = final.width;
    canvas.height = final.height;
    const context = canvas.getContext("2d");
    if (!context) throw at("this browser cannot process images");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, final.width, final.height);

    const alphaTypes = ["image/png", "image/webp"].filter((t) => cfg.mediaTypes.includes(t));
    if (sniffed.type !== "image/jpeg" && alphaTypes.length > 0 && hasAlpha(context, canvas)) {
      const kept = await encodeUnder(canvas, alphaTypes, budget);
      if (kept) return kept;
    }
    // Flatten onto white: JPEG has no alpha, and a transparent PNG that did
    // not fit is better sent opaque than rejected.
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, final.width, final.height);
    context.globalCompositeOperation = "source-over";
    const order = ENCODINGS.filter((t) => cfg.mediaTypes.includes(t));
    const encoded = await encodeUnder(canvas, order, budget);
    if (!encoded) {
      throw at(`could not be compressed under ${(budget / 1_000_000).toFixed(1)} MB`);
    }
    return encoded;
  } catch (err) {
    if (isCapError(err)) throw err;
    throw at("the file could not be processed");
  } finally {
    try {
      bitmap.close();
    } catch {
      /* older browsers */
    }
    canvas.width = 0;
    canvas.height = 0;
  }
}

function hasAlpha(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): boolean {
  try {
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
    return false;
  } catch {
    return false;
  }
}

export async function prepareImages(blobs: Blob[], cfg: ImageConfig): Promise<Blob[]> {
  const budget = Math.min(cfg.maxBytes, Math.floor(cfg.maxTotalBytes / blobs.length));
  const out: Blob[] = [];
  let total = 0;
  for (let i = 0; i < blobs.length; i++) {
    const prepared = await prepareImage(blobs[i] as Blob, i + 1, budget, cfg);
    total += prepared.size;
    if (total > cfg.maxTotalBytes) {
      throw rejectImage(
        `images total over ${(cfg.maxTotalBytes / 1_000_000).toFixed(0)} MB after resizing`,
      );
    }
    out.push(prepared);
  }
  return out;
}

/* ------------------------------ tool running ----------------------------- */

function truncateBytes(value: string, limit: number): string {
  if (utf8Bytes(value) <= limit) return value;
  let out = value;
  while (out.length > 0 && utf8Bytes(out) > limit) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

function constructorName(value: object): string {
  try {
    return (value as { constructor?: { name?: string } }).constructor?.name ?? "value";
  } catch {
    return "value";
  }
}

/** Find a class instance or DOM node with no `toJSON` — it has no JSON form. */
function findNonPlain(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNonPlain(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return constructorName(value);
  for (const entry of Object.values(value)) {
    const found = findNonPlain(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

export function toolResultContent(value: unknown): { content: string; isError?: boolean } {
  if (value === undefined) return { content: "(no return value)" };
  if (typeof value === "string") {
    const bytes = utf8Bytes(value);
    if (bytes > MAX_TOOL_RESULT_BYTES) {
      return {
        content: `Error: result too large (${bytes} bytes > ${MAX_TOOL_RESULT_BYTES}); return less`,
        isError: true,
      };
    }
    return { content: value };
  }
  const nonPlain = findNonPlain(value);
  if (nonPlain) {
    return {
      content: `Error: the result contains a ${nonPlain}, which has no JSON form - return plain data (picked fields, .textContent, Array.from(...))`,
      isError: true,
    };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    const reason = truncateBytes(err instanceof Error ? err.message : String(err), 200);
    return { content: `Error: the result cannot be sent as JSON (${reason})`, isError: true };
  }
  if (json === undefined) return { content: "(no return value)" };
  const bytes = utf8Bytes(json);
  if (bytes > MAX_TOOL_RESULT_BYTES) {
    return {
      content: `Error: result too large (${bytes} bytes > ${MAX_TOOL_RESULT_BYTES}); return less`,
      isError: true,
    };
  }
  return { content: json };
}

function toolThrewContent(err: unknown): { content: string; isError: true } {
  let detail: string;
  if (err instanceof Error && typeof err.message === "string") detail = err.message;
  else if (typeof err === "string") detail = err;
  else {
    try {
      detail = JSON.stringify(err) ?? String(err);
    } catch {
      detail = String(err);
    }
  }
  return { content: truncateBytes(`Error: ${detail}`, MAX_TOOL_ERROR_BYTES), isError: true };
}

/* -------------------------------- the client ----------------------------- */

interface Pending {
  id: string;
  spec: CallSpec;
  accumulated: string;
  delivered: string;
  timer: unknown;
  timeoutMessage: string;
  acked: boolean;
  toolsRunning: boolean;
  toolCtl: AbortController | null;
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: CapError): void;
}

function report(err: unknown): void {
  try {
    if (typeof reportError === "function") reportError(err);
    else
      setTimeout(() => {
        throw err;
      }, 0);
  } catch {
    /* nothing more we can do */
  }
}

export type SampleFn = (input: unknown, options?: unknown) => Promise<unknown>;
export interface SampleNamespace extends SampleFn {
  sample: SampleFn;
  json: SampleFn;
  limits: () => Promise<SampleLimits>;
}

export interface SampleClientOptions {
  /** Test seam: a fake `RpcHost` stands in for `parent.postMessage`. */
  host?: RpcHost;
}

/**
 * Build the namespace. Split out of `install` so unit tests can drive the
 * whole lifecycle over a fake `RpcHost` with no browser.
 */
export function createSample(ctx: FrameContext, options: SampleClientOptions = {}): SampleNamespace {
  const config = (ctx.capabilities[CAP]?.config ?? {}) as Record<string, unknown>;
  const imageConfig = parseImageConfig(config.images);
  const toolConfig = parseToolConfig(config.tools);
  const host = options.host ?? browserRpcHost(ctx.shellOrigin);
  const prefix = capIdPrefix(CAP);
  const budget = ctx.capBudgets?.sample?.sample;
  const replyTimeout =
    typeof budget === "number" && Number.isFinite(budget) && budget > 0
      ? Math.min(budget, REPLY_BUDGET_CAP_MS) + REPLY_BUDGET_EXTRA_MS
      : FALLBACK_REPLY_TIMEOUT_MS;

  const pending = new Map<string, Pending>();
  let counter = 0;
  let installing = true;
  const nextId = (): string => `${prefix}${++counter}`;

  const post = (message: unknown): void => host.post(message, ctx.shellOrigin);

  const sendCancel = (callId: string): void => {
    try {
      post({ __frame_cap: true, cap: CAP, id: nextId(), method: "cancelCall", args: [callId] });
    } catch {
      /* the shell went away; the call is over either way */
    }
  };

  const finish = (entry: Pending): void => {
    entry.settled = true;
    pending.delete(entry.id);
    if (entry.timer !== null) host.clearTimer(entry.timer);
    entry.timer = null;
    // Running `execute`s see their `context.signal` abort as the call settles.
    entry.toolCtl?.abort();
  };

  /** Deliver `onText`: whole text plus delta, never a blank first call. */
  const deliver = (entry: Pending, text: string): void => {
    const onText = entry.spec.onText;
    if (!onText) {
      entry.delivered = text;
      return;
    }
    if (text.length <= entry.delivered.length) return;
    if (entry.delivered === "" && text.trim() === "") return;
    const delta = text.slice(entry.delivered.length);
    entry.delivered = text;
    try {
      const returned = onText({ text, delta });
      if (returned && typeof (returned as Promise<unknown>).catch === "function") {
        void (returned as Promise<unknown>).catch(report);
      }
    } catch (err) {
      report(err);
    }
  };

  const settleError = (entry: Pending, error: CapError): void => {
    if (entry.settled) return;
    finish(entry);
    // The shell's error travels verbatim; the frame only adds the partial
    // text, and `refused` withdraws it.
    const out: CapError = { ...error };
    if (out.text === undefined && out.code !== "refused" && entry.accumulated.trim() !== "") {
      out.text = entry.accumulated;
    }
    entry.reject(out);
  };

  const settleResult = (entry: Pending, result: unknown): void => {
    if (entry.settled) return;
    if (typeof result !== "object" || result === null) {
      settleError(
        entry,
        capError(
          "upstream_error",
          "the viewer app's reply is not one this page runtime reads - reload the view",
        ),
      );
      return;
    }
    const reply = result as { text?: unknown; truncated?: unknown; value?: unknown };
    if (typeof reply.text !== "string") {
      settleError(
        entry,
        capError(
          "upstream_error",
          "the viewer app's reply is not one this page runtime reads - reload the view",
        ),
      );
      return;
    }
    if (!reply.text.startsWith(entry.accumulated)) {
      settleError(entry, capError("upstream_error", "the reply disagrees with the text sent"));
      return;
    }
    entry.accumulated = reply.text;
    deliver(entry, reply.text);
    if (entry.spec.signal?.aborted) {
      settleError(entry, capError("cancelled", "the call was cancelled"));
      return;
    }
    finish(entry);
    if (entry.spec.format !== "json") {
      entry.resolve(result);
      return;
    }
    if ("value" in reply) {
      entry.resolve(reply.value);
      return;
    }
    if (reply.truncated === true) {
      entry.reject(
        capError("invalid_json", "the reply was cut short before the JSON was complete", {
          text: reply.text,
        }),
      );
      return;
    }
    const parsed = parseLooseJson(reply.text);
    if (parsed.ok) entry.resolve(parsed.value);
    else {
      entry.reject(
        capError("invalid_json", "the reply held no JSON value", { text: reply.text }),
      );
    }
  };

  const expire = (entry: Pending): void => {
    if (entry.settled) return;
    const message = entry.timeoutMessage;
    sendCancel(entry.id);
    settleError(entry, capError("upstream_error", message));
  };

  const arm = (entry: Pending, ms: number, message: string): void => {
    if (entry.timer !== null) host.clearTimer(entry.timer);
    entry.timeoutMessage = message;
    entry.timer = host.setTimer(() => expire(entry), ms);
  };

  /* ------------------------------ tool rounds ---------------------------- */

  const runOneTool = async (
    tool: ValidTool,
    call: WireToolCall,
    outer: AbortSignal,
  ): Promise<WireToolResult> => {
    if (outer.aborted) {
      return { id: call.id, content: "Error: the call ended before the tool started", isError: true };
    }
    const inner = new AbortController();
    let timer: unknown = null;
    const onOuterAbort = (): void => inner.abort((outer as { reason?: unknown }).reason);
    outer.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const guard = new Promise<WireToolResult>((resolve) => {
        timer = host.setTimer(() => {
          inner.abort(new DOMException("the tool ran too long", "TimeoutError"));
          resolve({
            id: call.id,
            content: "Error: the tool did not finish within 150 s",
            isError: true,
          });
        }, TOOL_TIMEOUT_MS);
        outer.addEventListener(
          "abort",
          () =>
            resolve({
              id: call.id,
              content: "Error: the call ended before the tool finished",
              isError: true,
            }),
          { once: true },
        );
      });
      // Never synchronously: a tool that throws on entry still yields a result.
      const run = Promise.resolve()
        .then(() => tool.execute.call(tool, call.input, { signal: inner.signal }))
        .then(
          (value) => {
            try {
              return { id: call.id, ...toolResultContent(value) };
            } catch {
              return {
                id: call.id,
                content: "Error: the result could not be read - return plain data",
                isError: true,
              };
            }
          },
          (err: unknown) => {
            try {
              console.warn(`claude.sample: tool ${tool.name} threw:`, err);
            } catch {
              /* ignore */
            }
            return { id: call.id, ...toolThrewContent(err) };
          },
        );
      return await Promise.race([run, guard]);
    } finally {
      if (timer !== null) host.clearTimer(timer);
      outer.removeEventListener("abort", onOuterAbort);
    }
  };

  const runToolRound = async (entry: Pending, calls: WireToolCall[]): Promise<void> => {
    const tools = new Map(entry.spec.tools.map((t) => [t.name, t]));
    const signal = (entry.toolCtl ??= new AbortController()).signal;
    const names = [...tools.keys()].join(", ");
    const results = await Promise.all(
      calls.map(async (call): Promise<WireToolResult> => {
        const tool = tools.get(call.name);
        if (!tool) {
          return {
            id: call.id,
            content: truncateBytes(
              `Error: no tool named "${call.name}"; available: ${names}`,
              MAX_TOOL_ERROR_BYTES,
            ),
            isError: true,
          };
        }
        return runOneTool(tool, call, signal);
      }),
    );
    if (entry.settled || signal.aborted) return;
    try {
      post({
        __frame_cap: true,
        cap: CAP,
        id: nextId(),
        method: "toolResults",
        args: [entry.id, results],
      });
    } catch {
      settleError(entry, capError("upstream_error", "the tool results could not be sent"));
      return;
    }
    entry.toolsRunning = false;
    arm(entry, replyTimeout, "no reply from shell after the tools ran");
  };

  function readToolCalls(value: unknown): WireToolCall[] | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const calls: WireToolCall[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) return null;
      const call = entry as { id?: unknown; name?: unknown; input?: unknown };
      if (typeof call.id !== "string" || typeof call.name !== "string") return null;
      if (!isPlainObject(call.input)) return null;
      calls.push({ id: call.id, name: call.name, input: call.input });
    }
    return calls;
  }

  /* ------------------------------- listening ----------------------------- */

  host.listen((ev) => {
    if (!host.accepts(ev)) return;
    const data = ev.data;
    if (isFrameCapReply(data)) {
      const entry = pending.get(data.id);
      if (!entry) return;
      if (data.error !== undefined && data.error !== null) {
        settleError(entry, data.error as CapError);
      } else settleResult(entry, data.result);
      return;
    }
    if (isFrameCapAck(data)) {
      const entry = pending.get(data.id);
      if (!entry || entry.acked) return;
      entry.acked = true;
      arm(entry, ACK_TIMEOUT_MS, "the call was held (consent or its turn) and no outcome came");
      return;
    }
    if (isFrameCapProgress(data)) {
      const entry = pending.get(data.id);
      if (!entry) return;
      const p = data.p;
      if (typeof p !== "object" || p === null) return;
      const progress = p as { type?: unknown; text?: unknown; calls?: unknown };
      if (progress.type === "text") {
        if (typeof progress.text !== "string" || progress.text === "") return;
        entry.accumulated += progress.text;
        deliver(entry, entry.accumulated);
        return;
      }
      if (progress.type === "tool_use") {
        if (entry.spec.tools.length === 0 || entry.toolsRunning) return;
        const calls = readToolCalls(progress.calls);
        if (!calls) return;
        entry.toolsRunning = true;
        if (entry.timer !== null) host.clearTimer(entry.timer);
        entry.timer = null;
        void runToolRound(entry, calls);
      }
    }
  });

  if (typeof addEventListener === "function") {
    addEventListener("pagehide", (ev: Event) => {
      if ((ev as PageTransitionEvent).persisted) return;
      for (const entry of [...pending.values()]) {
        sendCancel(entry.id);
        settleError(
          entry,
          capError("upstream_error", "the page was hidden before the answer finished"),
        );
      }
    });
  }

  /* --------------------------------- call -------------------------------- */

  function call(input: unknown, options: unknown, format: "json" | null): Promise<unknown> {
    const spec = validateCall(input, options, format, imageConfig, toolConfig);
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = {
        id: nextId(),
        spec,
        accumulated: "",
        delivered: "",
        timer: null,
        timeoutMessage: "no reply from shell",
        acked: false,
        toolsRunning: false,
        toolCtl: spec.tools.length > 0 ? new AbortController() : null,
        settled: false,
        resolve,
        reject,
      };

      if (spec.signal?.aborted) {
        if (!installing) {
          try {
            console.warn(
              "claude.sample: the signal was already aborted when sample() was called - use a new AbortController per call",
            );
          } catch {
            /* ignore */
          }
        }
        entry.settled = true;
        reject(capError("cancelled", "the call was cancelled"));
        return;
      }

      let sent = false;
      spec.signal?.addEventListener(
        "abort",
        () => {
          if (entry.settled) return;
          if (sent) sendCancel(entry.id);
          settleError(entry, capError("cancelled", "the call was cancelled"));
        },
        { once: true },
      );

      queueMicrotask(() => {
        void (async () => {
          if (entry.settled) return;
          let images: Blob[] = [];
          if (spec.images.length > 0 && imageConfig) {
            try {
              images = await prepareImages(spec.images, imageConfig);
            } catch (err) {
              // Nothing was posted, so no `cancelCall` is owed.
              if (entry.settled) return;
              entry.settled = true;
              reject(isCapError(err) ? err : rejectImage("the file could not be processed"));
              return;
            }
          }
          if (entry.settled) return;

          const extra: Record<string, unknown> = {};
          if (images.length > 0) extra.images = images;
          if (spec.cache !== undefined) extra.cache = spec.cache;
          if (spec.format === "json") extra.format = "json";
          if (spec.tools.length > 0) {
            extra.tools = spec.tools.map(
              (t): WireTool => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              }),
            );
          }
          const args =
            Object.keys(extra).length > 0
              ? [spec.input, spec.modelTier, extra]
              : [spec.input, spec.modelTier];

          pending.set(entry.id, entry);
          arm(entry, replyTimeout, "no reply from shell");
          try {
            post({ __frame_cap: true, cap: CAP, id: entry.id, method: "sample", args });
            sent = true;
          } catch {
            if (entry.timer !== null) host.clearTimer(entry.timer);
            entry.timer = null;
            pending.delete(entry.id);
            entry.settled = true;
            reject(invalid("arguments must be cloneable"));
          }
        })();
      });
    });
  }

  const pipe = ctx.pipe(CAP);
  const sample = pipe.wrap("sample", (input: unknown, options?: unknown) =>
    call(input, options, null),
  ) as SampleFn;
  const json = pipe.wrap("json", (input: unknown, options?: unknown) =>
    call(input, options, "json"),
  ) as SampleFn;
  const limitsFn = pipe.wrap("limits", () =>
    Promise.resolve(buildLimits(imageConfig, toolConfig)),
  ) as () => Promise<SampleLimits>;

  installing = false;
  return Object.assign(sample, { sample, json, limits: limitsFn }) as SampleNamespace;
}

export function install(ctx: FrameContext, options: SampleClientOptions = {}): void {
  ctx.mount(CAP, createSample(ctx, options));
}
