/**
 * What a capability module may import from the frame runtime. The modules are
 * built as separate ESM bundles (`dist/runtime/<name>.js`) and loaded by the
 * preamble with a dynamic import, so this is a compile-time surface only —
 * nothing here is shared at runtime between the preamble and a module.
 */
export { browserRpcHost, createRpc } from "./rpc.ts";
export type { CallOptions, RpcClient, RpcEvent, RpcHost, RpcOptions } from "./rpc.ts";
export type { CapPipe, CapabilityModule, FrameContext } from "./types.ts";
