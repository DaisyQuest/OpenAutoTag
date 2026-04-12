#!/usr/bin/env bash
set -euo pipefail

codex --full-auto <<'EOF'
Read SPEC.txt and AGENTS.md.

Implement the semantic-engine module in /modules/semantic-engine.

Convert layout -> semantic roles.

Output semantic.schema.json.

Use deterministic rules.

Include tests.

DO NOT modify other modules.
EOF

