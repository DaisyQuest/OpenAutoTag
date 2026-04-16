import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(moduleDir, "data");
const repoRoot = path.resolve(moduleDir, "..", "..");
const contractsDir = path.join(repoRoot, "contracts");

// --- lazy-loaded data caches ---

let _stages = null;
export async function loadStages() {
  if (!_stages) {
    _stages = JSON.parse(await readFile(path.join(dataDir, "pipeline-stages.json"), "utf8"));
  }
  return _stages;
}

let _envKnobs = null;
export async function loadEnvKnobs() {
  if (!_envKnobs) {
    _envKnobs = JSON.parse(await readFile(path.join(dataDir, "env-knobs.json"), "utf8"));
  }
  return _envKnobs;
}

let _findingCodes = null;
export async function loadFindingCodes() {
  if (!_findingCodes) {
    _findingCodes = JSON.parse(await readFile(path.join(dataDir, "finding-codes.json"), "utf8"));
  }
  return _findingCodes;
}

let _nativeTagging = null;
export async function loadNativeTagging() {
  if (!_nativeTagging) {
    _nativeTagging = JSON.parse(await readFile(path.join(dataDir, "native-tagging.json"), "utf8"));
  }
  return _nativeTagging;
}

// --- helpers ---

async function readContract(name) {
  const fileName = name.endsWith(".schema.json") ? name : `${name}.schema.json`;
  const filePath = path.join(contractsDir, fileName);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadProfileSchema() {
  return readContract("profile");
}

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// --- server setup ---

const server = new McpServer({
  name: "pipeline-introspect",
  version: "1.0.0",
});

// 1. describe_pipeline
server.tool(
  "describe_pipeline",
  "Returns the ordered pipeline stages with module path, CLI invocation, and input/output contracts.",
  {},
  async () => {
    const stages = await loadStages();
    return textResult({ stages });
  }
);

// 2. describe_profile_schema
server.tool(
  "describe_profile_schema",
  "Returns profile tunables from profile.schema.json. Optionally filter by a single stage name.",
  { stage: z.string().optional().describe("Stage name to filter (e.g. 'parser', 'validator'). Omit for all stages.") },
  async ({ stage }) => {
    const schema = await loadProfileSchema();
    const defs = schema.$defs || {};

    if (stage) {
      // map stage names to $defs keys
      const stageKeyMap = {
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
      };

      const defKey = stageKeyMap[stage];
      if (!defKey || !defs[defKey]) {
        return textResult({ error: `Unknown stage '${stage}'. Available: ${Object.keys(stageKeyMap).join(", ")}` });
      }
      return textResult({ stage, schema: defs[defKey] });
    }

    // return all stage configs
    const result = {};
    for (const [key, def] of Object.entries(defs)) {
      result[key] = def;
    }
    return textResult({ stages: result });
  }
);

// 3. describe_contract
server.tool(
  "describe_contract",
  "Loads and summarizes a named contract schema from contracts/.",
  { name: z.string().describe("Contract name, e.g. 'layout', 'semantic', 'tagging', 'pipeline-job', 'profile'.") },
  async ({ name }) => {
    try {
      const schema = await readContract(name);
      return textResult({
        title: schema.title || name,
        description: schema.description || "",
        id: schema.$id || null,
        requiredFields: schema.required || [],
        topLevelProperties: Object.keys(schema.properties || {}),
        schema,
      });
    } catch (err) {
      return textResult({ error: `Could not load contract '${name}': ${err.message}` });
    }
  }
);

// 4. list_env_knobs
server.tool(
  "list_env_knobs",
  "Returns all environment variables grouped by module, with types, defaults, and descriptions.",
  { module: z.string().optional().describe("Filter by module name (e.g. 'parser', 'validator'). Omit for all.") },
  async ({ module: moduleName }) => {
    const data = await loadEnvKnobs();
    let groups = data.groups;
    if (moduleName) {
      groups = groups.filter((g) => g.module === moduleName);
      if (groups.length === 0) {
        return textResult({
          error: `No env knobs for module '${moduleName}'. Available modules: ${data.groups.map((g) => g.module).join(", ")}`,
        });
      }
    }
    return textResult({ groups });
  }
);

// 5. list_profiles
server.tool(
  "list_profiles",
  "Returns available profile presets from the orchestrator/profiles/ directory.",
  {},
  async () => {
    try {
      // Try dynamic import of profile-registry
      const registryPath = path.join(repoRoot, "orchestrator", "profile-registry.js");
      const registry = await import(pathToFileUrl(registryPath));
      const profiles = await registry.listProfiles();
      return textResult({ profiles });
    } catch {
      // Fallback: read profile files directly
      const { readdir } = await import("node:fs/promises");
      const profilesDir = path.join(repoRoot, "orchestrator", "profiles");
      try {
        const files = (await readdir(profilesDir)).filter((f) => f.endsWith(".json"));
        const profiles = [];
        for (const file of files) {
          try {
            const raw = JSON.parse(await readFile(path.join(profilesDir, file), "utf8"));
            profiles.push({
              profileId: raw.profileId,
              label: raw.label,
              description: raw.description || "",
              tags: raw.tags || [],
              extends: raw.extends || null,
            });
          } catch {
            profiles.push({ file, error: "Could not parse profile" });
          }
        }
        return textResult({ profiles, source: "direct-read" });
      } catch (dirErr) {
        return textResult({ error: `Could not read profiles: ${dirErr.message}` });
      }
    }
  }
);

// 6. describe_finding_codes
server.tool(
  "describe_finding_codes",
  "Returns the catalog of validator finding codes with severity, source, and remediation hints.",
  { code: z.string().optional().describe("Filter by a specific finding code (e.g. 'MISSING_DOCUMENT_ROOT'). Omit for all.") },
  async ({ code }) => {
    const data = await loadFindingCodes();
    let codes = data.findingCodes;
    if (code) {
      codes = codes.filter((c) => c.code === code);
      if (codes.length === 0) {
        return textResult({
          error: `Unknown finding code '${code}'. Available: ${data.findingCodes.map((c) => c.code).join(", ")}`,
        });
      }
    }
    return textResult({ findingCodes: codes });
  }
);

// 7. describe_native_tagging
server.tool(
  "describe_native_tagging",
  "Returns a structured description of the native PDF tagging capability, including component status, writer modes, advantages, limitations, and proof metrics.",
  {},
  async () => {
    const data = await loadNativeTagging();
    return textResult(data);
  }
);

// 8. compare_writer_modes
server.tool(
  "compare_writer_modes",
  "Quick estimation comparing native vs raster writer modes for a given PDF. Runs NativeContentStreamParser to count operators and estimates output sizes.",
  { pdfPath: z.string().describe("Absolute path to the source PDF file.") },
  async ({ pdfPath }) => {
    // Get original file size
    let originalFileSize;
    try {
      const s = await stat(pdfPath);
      originalFileSize = s.size;
    } catch (err) {
      return textResult({ error: `Cannot read PDF: ${err.message}` });
    }

    // Run NativeContentStreamParser via Java subprocess
    const javaHome = process.env.VALIDATOR_JAVA_HOME || process.env.JAVA_HOME || "";
    const javaCmd = javaHome ? path.join(javaHome, "bin", "java") : "java";
    const parserClass = "NativeContentStreamParser";
    const classPath = path.join(repoRoot, "modules", "native-verify", "build");

    let operatorCount = 0;
    try {
      const { stdout } = await execFileAsync(javaCmd, ["-cp", classPath, parserClass, pdfPath], {
        timeout: 30000,
      });
      // Parser outputs JSON with operatorCount field, or one operator per line
      try {
        const parsed = JSON.parse(stdout);
        operatorCount = parsed.operatorCount ?? (Array.isArray(parsed.operators) ? parsed.operators.length : 0);
      } catch {
        // Fallback: count non-empty lines
        operatorCount = stdout.split("\n").filter((l) => l.trim().length > 0).length;
      }
    } catch (err) {
      // If Java is unavailable, return a partial result
      return textResult({
        pdfPath,
        originalFileSize,
        estimatedNativeSize: null,
        estimatedRasterSize: null,
        operatorCount: null,
        nativeViable: null,
        recommendation: "unknown",
        error: `Could not run operator parser: ${err.message}`,
      });
    }

    // Estimation heuristics
    // Native mode: ~overhead per operator for tag insertion (~20 bytes each) on top of original
    const estimatedNativeSize = Math.round(originalFileSize * 1.05 + operatorCount * 20);
    // Raster mode: ~150 DPI full-page images, roughly 5-50x the original
    const estimatedRasterSize = Math.round(originalFileSize * 8.5);

    const nativeViable = operatorCount > 0;
    const recommendation = nativeViable ? "native" : "raster";

    return textResult({
      pdfPath,
      originalFileSize,
      estimatedNativeSize,
      estimatedRasterSize,
      operatorCount,
      nativeViable,
      recommendation,
    });
  }
);

// --- helpers ---
function pathToFileUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, "/")}`).href;
}

// --- exports for testing ---
export { server };

// --- start transport when run directly ---
const isDirectRun = process.env.MCP_INTROSPECT_NO_CONNECT !== "1";
if (isDirectRun) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
