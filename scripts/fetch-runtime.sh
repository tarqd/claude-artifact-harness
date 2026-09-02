#!/usr/bin/env bash
# Fetch the claude.ai artifact frame runtime and shell bundles for analysis.
# They are served publicly but are Anthropic's code, so they are gitignored
# under reference/runtime and reference/shell rather than committed.
#
# Usage: scripts/fetch-runtime.sh <artifact-uuid> [served-artifact.html]
# The uuid is any artifact you own (claude.ai/code/artifact/<uuid>); the
# runtime modules are the same for every artifact, only the host differs.
# The optional second argument is that artifact's served HTML (what the
# Artifact tool's `read` action saves): its <!-- frame-runtime --> block is
# extracted into reference/runtime/preamble.js and preamble-config.json, which
# `npm run e2e:conformance` (RUNTIME_DIR=reference/runtime) serves in place
# of our own preamble so the platform's modules run against our shell.
set -euo pipefail
UUID="${1:?artifact uuid required}"
HOST="https://${UUID}.frame.claudeusercontent.com"
ASSETS="https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/reference"
mkdir -p "$OUT/runtime" "$OUT/shell"

# 1. The shell page: it embeds the preamble that names the current runtime files.
curl -sSL "https://claude.ai/code/artifact/${UUID}" -o "$OUT/shell/served.html"

# 2. Runtime module names come from window.__FRAME_PREAMBLE in the artifact's
#    own served HTML, which needs an authenticated read (Artifact tool, action:
#    read). Fall back to the list captured on 2026-09-01 when none is supplied.
LIST="${RUNTIME_FILES:-_comments.C6E0cR5g.js _transforms.DSB5x63f.js _translate.5HCW4BJh.js artifact.EF7sW8YL.js assets.8Gk803W0.js comments.vw5vQdGA.js db.h-3sndFg.js downloads.C3GSvEDP.js embed.CxGAyc-v.js mcp.Bvma3qD7.js network.B5UA9Su4.js notifications.ssU4jy7G.js permissions.BNySkLV5.js room.VSdFwTE9.js sample.BW2Uysoh.js user.BpKav-Rf.js handlerError.kGkFgEUi.js}"
SHELL_EXTRA="frame-shell-broker-Bvj5PsoN.js frame-shell-replica-DJM6AQlN.js c26621f4a-CeTsb9NB.js"
for f in $LIST; do
  curl -sSL "$HOST/_runtime/$f" -o "$OUT/runtime/$f"
  echo "runtime/$f $(wc -c < "$OUT/runtime/$f")"
done

# 3. Shell bundles referenced by served.html.
grep -o "$ASSETS/[A-Za-z0-9._-]*\.js" "$OUT/shell/served.html" | sort -u | while read -r url; do
  f="$(basename "$url")"
  curl -sSL "$url" -o "$OUT/shell/$f"
  echo "shell/$f $(wc -c < "$OUT/shell/$f")"
done

# 3b. Lazily loaded shell chunks not referenced from served.html (names captured 2026-09-01).
for f in $SHELL_EXTRA; do
  curl -sSL "$ASSETS/$f" -o "$OUT/shell/$f" && echo "shell/$f $(wc -c < "$OUT/shell/$f")"
done

# 3c. The platform preamble, from a served artifact page.
if [ -n "${2:-}" ]; then
  python3 - "$2" "$OUT/runtime" <<'PY'
import re, sys
html = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"<!-- frame-runtime --><script>(window\.__FRAME_PREAMBLE=.*?)</script><script>(.*?)</script><!-- /frame-runtime -->", html, re.S)
if not m:
    sys.exit("no frame-runtime block found in " + sys.argv[1])
open(sys.argv[2] + "/preamble.js", "w", encoding="utf-8").write(m.group(2))
open(sys.argv[2] + "/preamble-config.json", "w", encoding="utf-8").write(m.group(1).split("=", 1)[1])
print("runtime/preamble.js and preamble-config.json extracted")
PY
fi

# 4. Pretty-print for reading.
if command -v npx >/dev/null; then
  for f in "$OUT"/runtime/*.js "$OUT"/shell/*.js; do
    npx --yes js-beautify -s 2 "$f" > "$f.pretty" 2>/dev/null || true
  done
fi
