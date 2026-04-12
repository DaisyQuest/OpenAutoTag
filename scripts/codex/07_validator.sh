#!/usr/bin/env bash
set -euo pipefail

codex --full-auto <<'EOF'
Read SPEC.txt and AGENTS.md.

Implement the validator module in /modules/validator.

Validate tagged artifacts and return a JSON report.

Include tests.

DO NOT modify other modules.
EOF

