#!/usr/bin/env bash
set -euo pipefail

codex --full-auto <<'EOF'
Read SPEC.txt and AGENTS.md.

Implement the orchestrator in /orchestrator.

Requirements:
- pipeline-runner.js invokes module CLIs in process order
- job-queue.js provides async in-memory job execution
- server.js exposes:
  POST /process-pdf
  GET /jobs/:id
- include integration tests

DO NOT modify module implementations.
EOF

