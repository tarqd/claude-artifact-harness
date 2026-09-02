/**
 * The fixed roster of capability slices. Each name owns
 * `src/capabilities/<name>/`, `test/<name>/` and `fixtures/<name>*.html`.
 */
export const CAPABILITIES = [
  "artifact",
  "db",
  "sample",
  "user",
  "permissions",
  "downloads",
  "room",
  "assets",
  "network",
  "mcp",
] as const;

export type CapabilityName = (typeof CAPABILITIES)[number];

/** Legacy spellings that resolve to another slice's module and namespace. */
export const CAPABILITY_ALIASES: Readonly<Record<string, CapabilityName>> = Object.freeze({
  self: "artifact",
});

/** Every name `claude.use()` may be handed, aliases included. */
export const USABLE_NAMES: readonly string[] = Object.freeze([
  ...CAPABILITIES,
  ...Object.keys(CAPABILITY_ALIASES),
]);

export function isCapabilityName(v: unknown): v is CapabilityName {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}

/** Resolve an alias to the slice that implements it. */
export function resolveCapability(name: string): CapabilityName | null {
  if (isCapabilityName(name)) return name;
  return CAPABILITY_ALIASES[name] ?? null;
}

/**
 * Per-capability RPC id prefixes (surface-area.md §4). A `__frame_cap_r`
 * carries only the id, so every client's ids must be unmistakable for
 * another's: the table is spine-owned and a slice never picks its own.
 */
export const CAP_ID_PREFIXES: Readonly<Record<CapabilityName, string>> = Object.freeze({
  artifact: "s",
  db: "b",
  sample: "a",
  user: "u",
  permissions: "p",
  downloads: "d",
  room: "r",
  assets: "e",
  network: "w",
  mcp: "c",
});

/** The id prefix for a capability name, aliases included. */
export function capIdPrefix(name: string): string {
  const slice = resolveCapability(name);
  return slice ? CAP_ID_PREFIXES[slice] : "x";
}

/**
 * `__FRAME_PREAMBLE.capabilities`: the module file the frame imports from
 * `/_runtime/<file>` for each name it may serve. Aliases share a file, and the
 * preamble de-duplicates imports by URL so `install()` runs once.
 */
export function runtimeModuleMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of USABLE_NAMES) {
    const slice = resolveCapability(name);
    if (slice) map[name] = `${slice}.js`;
  }
  return map;
}
