#!/usr/bin/env bash
set -euo pipefail

codex --full-auto <<'EOF'
Read SPEC.txt and AGENTS.md.

Implement the pdf-writer module in /modules/pdf-writer.

CLI:
node index.js --pdf input.pdf --tags tagging.json --output tagged.pdf > writer-report.json

Bootstrap goal:
- keep the interface stable
- emit deterministic output artifacts
- include tests

Production replacement goal:
- swap internals with Apache PDFBox native tagging later without changing the CLI

DO NOT modify other modules.
EOF

