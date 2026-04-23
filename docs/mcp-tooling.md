# MCP Tooling for Claude Agents

This repo ships MCP (Model Context Protocol) tooling that gives Claude agents structured access to the pipeline's API surface and evaluation harness. Local stdio servers are registered in `.mcp.json` at the repo root, and the primary web server also hosts a read-only MCP gateway at `/mcp`.

## Primary Read-Only HTTP Gateway

**Endpoint**: `/mcp`

The primary server exposes a Streamable-HTTP-compatible JSON-RPC MCP gateway for read-only tools. It is mounted in `orchestrator/server.js`, uses the same API authentication policy as other protected primary APIs, and never enqueues jobs, uploads PDFs, writes labels, mutates profiles, or changes artifacts.

The gateway combines:

- `pipeline-introspect`: read-only pipeline, contract, profile, environment, and finding-code inspection.
- `corpus-eval-readonly`: deterministic corpus sampling plus artifact scoring and run diffing from existing files only.
- `primary-readonly`: workload, job, and job-artifact inspection from the primary server.

Examples:

```powershell
# Human-readable manifest
curl http://localhost:3001/mcp

# MCP tools/list
curl http://localhost:3001/mcp `
  -H "Content-Type: application/json" `
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"

# MCP tools/call
curl http://localhost:3001/mcp `
  -H "Content-Type: application/json" `
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"describe_pipeline\",\"arguments\":{}}}"
```

In private mode, include `X-API-KEY` or `X-ADMIN-KEY`.

## Pipeline Introspection Server

**Server name**: `pipeline-introspect`

Provides read-only tools for understanding the pipeline without reading source code.

### Tools

#### `describe_pipeline`
Returns the ordered list of pipeline stages with module paths, CLI commands, input/output contracts, and environment variables.

```
No arguments.
Returns: [{ stage, module, cliCommand, inputContract, outputContract, envVars }]
```

#### `describe_profile_schema`
Returns the full profile schema or a stage-specific slice. Each field includes name, type, default, description, and valid range.

```
Optional: { stage: "parser" }
Returns: { fields: [{ name, type, default, description, range }] }
```

#### `describe_contract`
Summarizes a named contract schema (layout, semantic, tagging, profile, font-inventory, pipeline-job). Returns required fields, types, and nested structures — not raw JSON.

```
Required: { name: "semantic" }
Returns: { title, required, fields: [...], defs: [...] }
```

#### `list_env_knobs`
Returns every environment variable the pipeline respects, grouped by module.

```
No arguments.
Returns: { modules: { parser: [{ name, default, effect }], ... } }
```

#### `list_profiles`
Returns all available profile presets from the registry.

```
No arguments.
Returns: [{ profileId, label, description, tags, extends }]
```

#### `describe_finding_codes`
Returns the complete catalog of validator and font-audit finding codes with severity, clause references, and remediation hints.

```
No arguments.
Returns: [{ code, severity, source, clause, description, remediation }]
```

## Corpus Evaluation Server

**Server name**: `corpus-eval`

Provides tools for the profile-tuning feedback loop: sample a corpus, run profiles against it, score results, and compare runs.

Only the read-only subset is hosted at `/mcp`. Mutating or write-producing tools such as `run_profile` remain stdio-only and are intentionally excluded from the primary read-only gateway.

### Tools

#### `sample_corpus`
Selects representative PDFs from a directory without loading full file contents.

```
Required: { directory: "C:\\LRBTest", n: 5 }
Optional: { criteria: { minPages: 2, namePattern: "2026_*" } }
Returns: [{ pdfPath, fileName, sizeBytes, pageCount }]
```

#### `run_profile`
Runs the full pipeline on a set of PDFs using a specific profile. Returns per-PDF job summaries.

```
Required: { profileId: "legal", pdfPaths: ["path1.pdf", "path2.pdf"] }
Optional: { profileOverrides: { parser: { ocrMode: "force" } }, outputDir: "/tmp/run" }
Returns: { runId, jobs: [{ pdfPath, status, stageSummary, outputDir }] }
```

#### `score_job`
Computes quality metrics from a completed job's artifacts.

```
Required: { jobDir: "/path/to/job" }
Returns: {
  veraPdfFindingCount, fontEmbedCoverage, readingOrderInversions,
  ocrConfidence, aggregateScore, groundTruth: null
}
```

#### `diff_runs`
Compares two evaluation runs and reports per-PDF deltas.

```
Required: { runADir: "/tmp/run-default", runBDir: "/tmp/run-legal" }
Returns: {
  perPdf: [{ fileName, scoreA, scoreB, delta, improved }],
  aggregate: { meanDelta, improvedCount, regressedCount, unchangedCount }
}
```

## Example Agent Session

A Claude agent tuning the legal profile might:

1. **Understand the surface**: `describe_profile_schema({ stage: "parser" })` to see what OCR knobs exist
2. **Sample the corpus**: `sample_corpus({ directory: "C:\\LRBTest", n: 10 })` to pick representative docs
3. **Establish baseline**: `run_profile({ profileId: "default", pdfPaths: [...] })` → `score_job` each result
4. **Try a variant**: `run_profile({ profileId: "legal", pdfPaths: [...] })`
5. **Compare**: `diff_runs({ runADir: "...", runBDir: "..." })` to see which PDFs improved
6. **Iterate**: adjust `profileOverrides`, re-run, re-diff

## Configuration

The servers are registered in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "pipeline-introspect": {
      "command": "node",
      "args": ["modules/mcp-api-introspect/index.js"]
    },
    "corpus-eval": {
      "command": "node",
      "args": ["modules/mcp-corpus-eval/index.js"]
    }
  }
}
```

Claude Code reads this file automatically when the project is opened. No manual server startup is needed.
