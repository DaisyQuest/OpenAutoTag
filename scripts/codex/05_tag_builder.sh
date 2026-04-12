#!/usr/bin/env bash
set -euo pipefail

codex --full-auto <<'EOF'
Read SPEC.txt and AGENTS.md.

Implement the tag-builder module in /modules/tag-builder.

Construct a hierarchical tag tree.

Output tagging.schema.json.

Include tests.

DO NOT modify other modules.
EOF

