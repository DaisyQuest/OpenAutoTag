import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { scoreJob, diffRuns } from "../modules/mcp-corpus-eval/lib/tools.js";
import { getArtifactLabel } from "./public/report-renderers.js";
import { listProfiles } from "./profile-registry.js";
import { listWorkloads } from "./workloads/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = path.join(repoRoot, "contracts");
const introspectDataDir = path.join(repoRoot, "modules", "mcp-api-introspect", "data");
const DEFAULT_SAMPLE_LIMIT = 10;
const MAX_SAMPLE_LIMIT = 100;
const MAX_JOB_LIMIT = 100;
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

const CONTRACT_ALIASES = Object.freeze({
  "font-inventory": "font-inventory.schema.json",
  layout: "layout.schema.json",
  "normalized-compliance": "normalized-compliance.schema.json",
  "pipeline-job": "pipeline-job.schema.json",
  profile: "profile.schema.json",
  "redaction-plan": "redaction-plan.schema.json",
  "redaction-report": "redaction-report.schema.json",
  semantic: "semantic.schema.json",
  "table-structure": "table-structure.schema.json",
  "tag-containment": "tag-containment.schema.json",
  tagging: "tagging.schema.json",
  "validation-report": "validation-report.schema.json"
});

const STAGE_SCHEMA_KEYS = Object.freeze({
  parser: "parserConfig",
  "layout-analyzer": "layoutAnalyzerConfig",
  layoutAnalyzer: "layoutAnalyzerConfig",
  "semantic-engine": "semanticEngineConfig",
  semanticEngine: "semanticEngineConfig",
  "reading-order": "readingOrderConfig",
  readingOrder: "readingOrderConfig",
  "tag-builder": "tagBuilderConfig",
  tagBuilder: "tagBuilderConfig",
  "font-embedder": "fontEmbedderConfig",
  fontEmbedder: "fontEmbedderConfig",
  "pdf-writer": "pdfWriterConfig",
  pdfWriter: "pdfWriterConfig",
  validator: "validatorConfig",
  redactor: "redactorConfig",
  orchestrator: "orchestratorConfig",
  evaluation: "evaluationConfig",
  "paragraph-merger": "paragraphMergerConfig",
  paragraphMerger: "paragraphMergerConfig",
  "corruption-repairer": "corruptionRepairerConfig",
  corruptionRepairer: "corruptionRepairerConfig"
});

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true
});

function objectSchema(properties = {}, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {})
  };
}

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "list_mcp_servers",
    server: "primary-readonly",
    description: "Describe the read-only MCP servers and tool groups hosted by the primary OpenAutoTag server.",
    inputSchema: objectSchema()
  },
  {
    name: "describe_pipeline",
    server: "pipeline-introspect",
    description: "Return the ordered OpenAutoTag pipeline stages with module paths, CLI commands, and contracts.",
    inputSchema: objectSchema()
  },
  {
    name: "describe_profile_schema",
    server: "pipeline-introspect",
    description: "Return profile.schema.json tunables. Optionally filter by one stage.",
    inputSchema: objectSchema({
      stage: { type: "string", description: "Optional stage name such as parser, validator, or pdf-writer." }
    })
  },
  {
    name: "describe_contract",
    server: "pipeline-introspect",
    description: "Return a named contract schema from contracts/ using a fixed allowlist.",
    inputSchema: objectSchema({
      name: { type: "string", description: "Contract name, for example layout, semantic, tagging, profile, or pipeline-job." }
    }, ["name"])
  },
  {
    name: "list_env_knobs",
    server: "pipeline-introspect",
    description: "Return environment variables grouped by module. Optionally filter by module.",
    inputSchema: objectSchema({
      module: { type: "string", description: "Optional module name such as parser or validator." }
    })
  },
  {
    name: "list_profiles",
    server: "pipeline-introspect",
    description: "Return available profile presets from the orchestrator profile registry.",
    inputSchema: objectSchema()
  },
  {
    name: "describe_finding_codes",
    server: "pipeline-introspect",
    description: "Return validator/font finding codes. Optionally filter by code.",
    inputSchema: objectSchema({
      code: { type: "string", description: "Optional finding code such as MISSING_DOCUMENT_ROOT." }
    })
  },
  {
    name: "describe_native_tagging",
    server: "pipeline-introspect",
    description: "Return native PDF tagging component status, modes, advantages, limitations, and proof metrics.",
    inputSchema: objectSchema()
  },
  {
    name: "list_workloads",
    server: "primary-readonly",
    description: "Return public workload definitions exposed by the primary server.",
    inputSchema: objectSchema()
  },
  {
    name: "list_jobs",
    server: "primary-readonly",
    description: "Return a compact read-only list of known primary-server jobs.",
    inputSchema: objectSchema({
      status: { type: "string", description: "Optional status filter such as queued, running, completed, or failed." },
      limit: { type: "integer", minimum: 1, maximum: MAX_JOB_LIMIT, description: "Maximum jobs to return. Default 25, max 100." }
    })
  },
  {
    name: "get_job",
    server: "primary-readonly",
    description: "Return one primary-server job snapshot by jobId.",
    inputSchema: objectSchema({
      jobId: { type: "string", description: "Job id from list_jobs or the dashboard." }
    }, ["jobId"])
  },
  {
    name: "list_job_artifacts",
    server: "primary-readonly",
    description: "Return artifact names, labels, paths, sizes, and download URLs for one job.",
    inputSchema: objectSchema({
      jobId: { type: "string", description: "Job id from list_jobs or the dashboard." }
    }, ["jobId"])
  },
  {
    name: "sample_corpus",
    server: "corpus-eval-readonly",
    description: "Deterministically sample PDF file metadata from a directory without running the pipeline.",
    inputSchema: objectSchema({
      directory: { type: "string", description: "Directory containing PDFs." },
      n: { type: "integer", minimum: 1, maximum: MAX_SAMPLE_LIMIT, description: "Number of samples. Default 10, max 100." },
      criteria: {
        type: "object",
        additionalProperties: false,
        properties: {
          namePattern: { type: "string", description: "Case-insensitive regular expression matched against relative paths." },
          minBytes: { type: "integer", minimum: 0, description: "Minimum file size in bytes." },
          maxBytes: { type: "integer", minimum: 0, description: "Maximum file size in bytes." }
        }
      }
    }, ["directory"])
  },
  {
    name: "score_job",
    server: "corpus-eval-readonly",
    description: "Score a completed job by reading existing artifacts only.",
    inputSchema: objectSchema({
      jobDir: { type: "string", description: "Path to a completed job output directory." }
    }, ["jobDir"])
  },
  {
    name: "diff_runs",
    server: "corpus-eval-readonly",
    description: "Compare two existing evaluation run directories by reading existing artifacts only.",
    inputSchema: objectSchema({
      runADir: { type: "string", description: "Baseline run directory." },
      runBDir: { type: "string", description: "Comparison run directory." }
    }, ["runADir", "runBDir"])
  }
].map((tool) => Object.freeze({
  ...tool,
  annotations: READ_ONLY_ANNOTATIONS
})));

const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

const SERVER_GROUPS = Object.freeze([
  {
    id: "pipeline-introspect",
    hostedAt: "/mcp",
    source: "modules/mcp-api-introspect",
    mode: "mirrored-read-only",
    readOnly: true,
    tools: TOOL_DEFINITIONS.filter((tool) => tool.server === "pipeline-introspect").map((tool) => tool.name)
  },
  {
    id: "corpus-eval-readonly",
    hostedAt: "/mcp",
    source: "modules/mcp-corpus-eval",
    mode: "read-only-subset",
    readOnly: true,
    excludedTools: ["run_profile", "detect_profile", "sweep_corpus", "parse_metadata"],
    tools: TOOL_DEFINITIONS.filter((tool) => tool.server === "corpus-eval-readonly").map((tool) => tool.name)
  },
  {
    id: "primary-readonly",
    hostedAt: "/mcp",
    source: "orchestrator/server.js",
    mode: "primary-server-read-only",
    readOnly: true,
    tools: TOOL_DEFINITIONS.filter((tool) => tool.server === "primary-readonly").map((tool) => tool.name)
  }
]);

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readIntrospectData(fileName) {
  return readJsonFile(path.join(introspectDataDir, fileName));
}

async function readContract(name) {
  const normalized = String(name || "").replace(/\.schema\.json$/i, "").trim();
  const fileName = CONTRACT_ALIASES[normalized];
  if (!fileName) {
    throw new Error(`Unknown contract '${name}'. Available: ${Object.keys(CONTRACT_ALIASES).join(", ")}`);
  }
  return readJsonFile(path.join(contractsDir, fileName));
}

function jsonTextResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function compactJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    workload: job.workload
      ? {
          id: job.workload.id,
          label: job.workload.label
        }
      : null,
    fileName: path.basename(job.input?.filePath || job.input?.sourceFileName || "document.pdf"),
    sourceUrl: job.input?.sourceUrl || null,
    outputDir: job.input?.outputDir || null,
    artifactNames: Object.keys(job.artifacts || {}),
    stageSummary: job.stageSummary || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error || null
  };
}

function clampInteger(value, { fallback, min = 1, max }) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

async function listPdfFiles(directory) {
  const root = path.resolve(directory);
  const files = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".pdf")) {
        continue;
      }
      const details = await stat(fullPath);
      files.push({
        pdfPath: fullPath,
        fileName: entry.name,
        relativePath: path.relative(root, fullPath).replace(/\\/g, "/"),
        sizeBytes: details.size,
        modifiedAt: details.mtime.toISOString()
      });
    }
  }

  await walk(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function deterministicSlice(items, count) {
  if (items.length <= count) {
    return items;
  }
  if (count === 1) {
    return [items[0]];
  }

  const selected = [];
  const lastIndex = items.length - 1;
  for (let index = 0; index < count; index += 1) {
    const sourceIndex = Math.round((index * lastIndex) / (count - 1));
    selected.push(items[sourceIndex]);
  }
  return selected;
}

async function sampleCorpusReadOnly({ directory, n, criteria } = {}) {
  if (!directory) {
    throw new Error("directory is required.");
  }

  const limit = clampInteger(n, { fallback: DEFAULT_SAMPLE_LIMIT, min: 1, max: MAX_SAMPLE_LIMIT });
  const root = path.resolve(directory);
  let pdfs = await listPdfFiles(root);

  if (criteria?.namePattern) {
    const matcher = new RegExp(String(criteria.namePattern), "i");
    pdfs = pdfs.filter((pdf) => matcher.test(pdf.relativePath));
  }
  if (criteria?.minBytes != null) {
    pdfs = pdfs.filter((pdf) => pdf.sizeBytes >= Number(criteria.minBytes));
  }
  if (criteria?.maxBytes != null) {
    pdfs = pdfs.filter((pdf) => pdf.sizeBytes <= Number(criteria.maxBytes));
  }

  return {
    directory: root,
    totalPdfCount: pdfs.length,
    sampleCount: Math.min(limit, pdfs.length),
    strategy: "deterministic-even-slice",
    samples: deterministicSlice(pdfs, limit)
  };
}

function buildMcpServerManifest() {
  return {
    endpoint: "/mcp",
    protocol: "MCP Streamable HTTP compatible JSON-RPC",
    protocolVersion: LATEST_PROTOCOL_VERSION,
    readOnly: true,
    instructions:
      "This endpoint exposes only read-only OpenAutoTag tools. It will not enqueue jobs, mutate profiles, write labels, upload PDFs, or alter artifacts.",
    servers: SERVER_GROUPS,
    tools: TOOL_DEFINITIONS.map(({ server, name, description, inputSchema, annotations }) => ({
      server,
      name,
      description,
      inputSchema,
      annotations
    })),
    mutatingToolsExcluded: ["run_profile", "process-pdf", "process-pdf-upload", "process-pdf-url", "ml review labeling"]
  };
}

async function callTool(name, args, context) {
  switch (name) {
    case "list_mcp_servers":
      return buildMcpServerManifest();

    case "describe_pipeline":
      return { stages: await readIntrospectData("pipeline-stages.json") };

    case "describe_profile_schema": {
      const schema = await readContract("profile");
      const stage = args?.stage ? String(args.stage) : "";
      if (!stage) {
        return { stages: schema.$defs || {} };
      }
      const stageKey = STAGE_SCHEMA_KEYS[stage];
      if (!stageKey || !schema.$defs?.[stageKey]) {
        throw new Error(`Unknown stage '${stage}'. Available: ${Object.keys(STAGE_SCHEMA_KEYS).join(", ")}`);
      }
      return { stage, schema: schema.$defs[stageKey] };
    }

    case "describe_contract": {
      const schema = await readContract(args?.name);
      return {
        title: schema.title || args.name,
        description: schema.description || "",
        id: schema.$id || null,
        requiredFields: schema.required || [],
        topLevelProperties: Object.keys(schema.properties || {}),
        schema
      };
    }

    case "list_env_knobs": {
      const data = await readIntrospectData("env-knobs.json");
      const moduleName = args?.module ? String(args.module) : "";
      const groups = moduleName ? data.groups.filter((group) => group.module === moduleName) : data.groups;
      if (moduleName && groups.length === 0) {
        throw new Error(`No env knobs for module '${moduleName}'. Available: ${data.groups.map((group) => group.module).join(", ")}`);
      }
      return { groups };
    }

    case "list_profiles":
      return { profiles: await listProfiles() };

    case "describe_finding_codes": {
      const data = await readIntrospectData("finding-codes.json");
      const code = args?.code ? String(args.code) : "";
      const findingCodes = code ? data.findingCodes.filter((finding) => finding.code === code) : data.findingCodes;
      if (code && findingCodes.length === 0) {
        throw new Error(`Unknown finding code '${code}'.`);
      }
      return { findingCodes };
    }

    case "describe_native_tagging":
      return readIntrospectData("native-tagging.json");

    case "list_workloads":
      return { workloads: listWorkloads() };

    case "list_jobs": {
      const status = args?.status ? String(args.status) : "";
      const limit = clampInteger(args?.limit, { fallback: 25, min: 1, max: MAX_JOB_LIMIT });
      const jobs = context.queue
        .list()
        .filter((job) => !status || job.status === status)
        .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
        .slice(0, limit)
        .map(compactJob);
      return { jobs, totalReturned: jobs.length, status: status || null, limit };
    }

    case "get_job": {
      const jobId = String(args?.jobId || "").trim();
      if (!jobId) {
        throw new Error("jobId is required.");
      }
      const job = context.queue.get(jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }
      return { job };
    }

    case "list_job_artifacts": {
      const jobId = String(args?.jobId || "").trim();
      if (!jobId) {
        throw new Error("jobId is required.");
      }
      const job = context.queue.get(jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      const artifacts = await Promise.all(
        Object.entries(job.artifacts || {}).map(async ([artifactName, artifactPath]) => {
          const resolvedPath = path.resolve(artifactPath);
          const details = await stat(resolvedPath).catch(() => null);
          return {
            name: artifactName,
            label: getArtifactLabel(artifactName),
            path: resolvedPath,
            exists: Boolean(details),
            sizeBytes: details?.size ?? null,
            modifiedAt: details?.mtime?.toISOString() || null,
            downloadUrl: `/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactName)}`
          };
        })
      );
      return { jobId, artifacts };
    }

    case "sample_corpus":
      return sampleCorpusReadOnly(args);

    case "score_job":
      return scoreJob(args || {});

    case "diff_runs":
      return diffRuns(args || {});

    default:
      throw new Error(`Unknown read-only MCP tool: ${name}`);
  }
}

function jsonRpcResponse(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function isNotification(message) {
  return !Object.prototype.hasOwnProperty.call(message, "id");
}

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

async function handleJsonRpcMessage(message, context) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(message?.id, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC 2.0 request.");
  }

  if (isNotification(message)) {
    return null;
  }

  try {
    switch (message.method) {
      case "initialize":
        return jsonRpcResponse(message.id, {
          protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "openautotag-primary-readonly",
            version: "0.1.0"
          },
          instructions: buildMcpServerManifest().instructions
        });

      case "ping":
        return jsonRpcResponse(message.id, {});

      case "tools/list":
        return jsonRpcResponse(message.id, {
          tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            annotations
          }))
        });

      case "tools/call": {
        const toolName = String(message.params?.name || "");
        if (!TOOL_BY_NAME.has(toolName)) {
          return jsonRpcError(message.id, JSON_RPC_INVALID_PARAMS, `Unknown read-only MCP tool: ${toolName}`);
        }
        const result = await callTool(toolName, message.params?.arguments || {}, context);
        return jsonRpcResponse(message.id, jsonTextResult(result));
      }

      case "resources/list":
        return jsonRpcResponse(message.id, { resources: [] });

      case "prompts/list":
        return jsonRpcResponse(message.id, { prompts: [] });

      default:
        return jsonRpcError(message.id, JSON_RPC_METHOD_NOT_FOUND, `Unsupported MCP method: ${message.method}`);
    }
  } catch (error) {
    return jsonRpcError(message.id, JSON_RPC_INTERNAL_ERROR, error.message);
  }
}

export function createReadOnlyMcpGateway(context) {
  return {
    manifest: buildMcpServerManifest,
    async handleJsonRpc(body) {
      if (Array.isArray(body)) {
        if (body.length === 0) {
          return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "JSON-RPC batch cannot be empty.");
        }
        const responses = (await Promise.all(body.map((message) => handleJsonRpcMessage(message, context)))).filter(Boolean);
        return responses.length ? responses : null;
      }

      if (body == null) {
        return jsonRpcError(null, JSON_RPC_PARSE_ERROR, "Missing JSON-RPC request body.");
      }

      return handleJsonRpcMessage(body, context);
    }
  };
}
