#!/usr/bin/env bash
# Vendors the guard core from the public ixia-guardrails repo into src/lib/guard.
# Usage: scripts/sync-guard.sh [/path/to/ixia-guardrails]
set -euo pipefail
SRC="${1:-/data/projects/ixia-guardrails}/packages/guard/src"
DST="$(cd "$(dirname "$0")/.." && pwd)/src/lib/guard"
rm -rf "$DST" && mkdir -p "$DST" && cp -r "$SRC"/. "$DST"/
echo "// Vendored from github.com/ctmakc/ixia-guardrails ($(git -C "$SRC/../../.." rev-parse --short HEAD 2>/dev/null || echo local)). Edit there, then run scripts/sync-guard.sh." > "$DST/VENDORED.md"
echo "synced $(ls "$DST" | wc -l) entries → $DST"
