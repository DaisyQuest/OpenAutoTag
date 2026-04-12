#!/usr/bin/env bash
set -euo pipefail

codex --full-auto <<'EOF'
Read SPEC.txt and AGENTS.md.

Implement the reading-order module in /modules/reading-order.

Compute ordered semantic nodes.
Handle multi-column layouts.

Output semantic.schema.json with orderedNodeIds and readingOrder.

Include tests.

DO NOT modify other modules.
EOF

