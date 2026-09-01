# claude-artifact-harness

A compatibility layer for self-hosting Artifacts created by Claude Code and
claude.ai: serve the same HTML on your own infrastructure and provide the
`window.claude` runtime the pages expect.

Status: research phase. The surface area is mapped; no runtime code yet.

- `docs/surface-area.md`: what an artifact page can see and call, the
  frame/shell protocol, the page envelope, and what a self-host must provide.
- `docs/analysis/`: detailed reverse-engineering notes per runtime module
  and for the host shell.
- `reference/contract/0.2.32/`: the platform-served `window.claude` type
  definitions the pages are written against.
- `scripts/fetch-runtime.sh`: downloads the proprietary runtime and shell
  bundles into gitignored `reference/runtime` and `reference/shell` for
  local analysis.
