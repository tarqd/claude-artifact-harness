/**
 * Shapes shared by the three sides of the `sample` slice.
 *
 * `frame.ts` runs in the artifact iframe, `broker.ts` in the shell page and
 * `server.ts` in Node; only plain data and pure functions live here so the
 * bundler can pull this file into either side.
 */

/** The tiers the page may ask for (sample.d.ts `ModelTier`). */
export const MODEL_TIERS = ["default", "complex", "quick"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** design.md "Sample proxy": the model each tier resolves to. */
export const TIER_MODELS: Readonly<Record<ModelTier, string>> = Object.freeze({
  quick: "claude-haiku-4-5-20251001",
  default: "claude-sonnet-5",
  complex: "claude-opus-5",
});

/** Largest `input`, in UTF-8 bytes (sample.d.ts `SampleLimits.maxPromptBytes`). */
export const MAX_PROMPT_BYTES = 65_536;

export interface SampleTurn {
  role: "user" | "assistant";
  content: string;
}

export type SampleInput = string | SampleTurn[];

/** A tool as it travels the wire: the page's `execute` never leaves the frame. */
export interface WireTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface WireToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface WireToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/** One image, base64-encoded, as the shell hands it to the backend. */
export interface WireImage {
  mediaType: string;
  data: string;
}

/* ------------------------------------------------------------------ */
/* the server-sent event stream (surface-area.md §7, design.md)         */
/* ------------------------------------------------------------------ */

export interface StartEvent {
  type: "start";
  modelTierApplied: ModelTier;
}
export interface TextEvent {
  type: "text";
  /** A delta, never the whole answer. */
  text: string;
}
export interface ToolUseEvent {
  type: "tool_use";
  calls: WireToolCall[];
}
export interface DoneEvent {
  type: "done";
  truncated: boolean;
}
export interface ErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export type SampleEvent = StartEvent | TextEvent | ToolUseEvent | DoneEvent | ErrorEvent;

export function isModelTier(v: unknown): v is ModelTier {
  return typeof v === "string" && (MODEL_TIERS as readonly string[]).includes(v);
}

const encoder = new TextEncoder();

/** UTF-8 byte length — every size limit in this slice is counted in bytes. */
export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** The text of an input, for byte counting and prompt building. */
export function inputText(input: SampleInput): string {
  return typeof input === "string" ? input : input.map((t) => t.content).join("\n");
}

/**
 * The tolerant read `json()` documents: the whole reply, else the body of
 * exactly one Markdown fence, else the first `{`/`[` to the last `}`/`]`.
 * Two values, or JSON buried in a sentence, are deliberately not accepted.
 */
export function parseLooseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const attempt = (source: string): { ok: true; value: unknown } | null => {
    const trimmed = source.trim();
    if (trimmed === "") return null;
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch {
      return null;
    }
  };

  const whole = attempt(text);
  if (whole) return whole;

  const fences = [...text.matchAll(/```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g)];
  if (fences.length === 1) {
    const body = fences[0]?.[1];
    const fenced = body === undefined ? null : attempt(body);
    if (fenced) return fenced;
  }

  const first = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  const last = [text.lastIndexOf("}"), text.lastIndexOf("]")].filter((i) => i >= 0);
  if (first.length && last.length) {
    const start = Math.min(...first);
    const end = Math.max(...last);
    if (end > start) {
      const sliced = attempt(text.slice(start, end + 1));
      if (sliced) return sliced;
    }
  }
  return { ok: false };
}
