#!/usr/bin/env bash
set -euo pipefail

codex --full-auto <<'EOF'
Read SPEC.txt and AGENTS.md.

Implement the parser module in /modules/parser.

Requirements:
- Extract text blocks with bounding boxes
- Output layout.schema.json compliant JSON
- Provide CLI:
  node index.js input.pdf > output.json
- Include unit tests
- Use clean architecture

DO NOT modify other modules.
EOF

