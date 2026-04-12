#!/usr/bin/env bash
set -euo pipefail

codex --full-auto <<'EOF'
Read SPEC.txt and AGENTS.md.

Implement the layout-analyzer module in /modules/layout-analyzer.

Input: layout.schema.json
Output: enriched layout.schema.json

Detect:
- paragraphs
- headings
- lists

Include tests.

DO NOT modify other modules.
EOF

