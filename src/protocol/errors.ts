/**
 * Capability errors are plain data, never `Error` instances: they cross
 * `postMessage` and reach page code as the rejection value.
 */

/** Lifecycle codes every capability shares (produced by the runtime/shell). */
export const LIFECYCLE_CODES = [
  "not_granted",
  "capability_disabled",
  "capability_removed",
  "transform_error",
  "queue_overflow",
] as const;

/** Codes the spine itself can produce. Slices extend this per capability. */
export const COMMON_CODES = [
  ...LIFECYCLE_CODES,
  "conflict",
  "not_writer",
  "not_declared",
  "too_large",
  "invalid_content",
  "read_only_path",
  "rate_limited",
  "consent_required",
  "unavailable",
  "upstream_error",
] as const;

export type CommonErrorCode = (typeof COMMON_CODES)[number];

export interface CapError {
  code: string;
  message: string;
  [extra: string]: unknown;
}

/** Build a wire error object. Extra fields (e.g. `live`) are carried verbatim. */
export function capError(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): CapError {
  return { ...(extra ?? {}), code, message };
}

export function isCapError(v: unknown): v is CapError {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { code?: unknown }).code === "string" &&
    typeof (v as { message?: unknown }).message === "string"
  );
}

/** Normalise anything thrown on the shell side into a wire error. */
export function toCapError(err: unknown, fallbackCode = "upstream_error"): CapError {
  if (isCapError(err)) return err;
  if (err instanceof Error) return capError(fallbackCode, err.message);
  return capError(fallbackCode, String(err));
}

export const CAPABILITY_DISABLED = (what: string): CapError =>
  capError("capability_disabled", `${what} is not available in this view`);
