/**
 * Conformance mode: `npm run e2e:conformance` runs the same specs with the
 * platform's own runtime modules served from `RUNTIME_DIR` instead of ours
 * (see docs/design.md, "Conformance"). A few assertions describe guarantees
 * only our runtime makes — beyond the published contract — and are gated on
 * this flag so the run measures the wire protocol, not our extras.
 */
export const FOREIGN_RUNTIME = Boolean(process.env.RUNTIME_DIR);
