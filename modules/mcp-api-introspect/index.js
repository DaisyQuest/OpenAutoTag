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
        "paragraph-merger": "paragraphMergerConfig",
        paragraphMerger: "paragraphMergerConfig",
        "corruption-repairer": "corruptionRepairerConfig",
        corruptionRepairer: "corruptionRepairerConfig",
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

// 9. guide_create_profile
server.tool(
  "guide_create_profile",
  "Step-by-step guide for creating a custom pipeline profile. Returns the profile schema, available presets to extend, every tunable field with its type/default/effect, and a concrete example JSON ready to save.",
  {
    documentType: z.string().optional().describe("Document type hint: 'legal', 'scientific', 'scanned', 'forms', 'cjk', or describe your docs."),
    baseProfile: z.string().optional().describe("Profile to extend. Default: 'default'. Options: default, legal, scientific, scanned-low-quality, forms-heavy, cjk.")
  },
  async ({ documentType, baseProfile }) => {
    const schema = await loadProfileSchema();
    const base = baseProfile || "default";
    const defs = schema.$defs || {};

    const stageGuide = Object.entries(defs).map(([key, def]) => {
      const fields = def.properties ? Object.entries(def.properties).map(([name, prop]) => ({
        name,
        type: prop.type || (prop.enum ? `enum: ${prop.enum.join("|")}` : "object"),
        default: prop.default ?? null,
        description: prop.description || ""
      })) : [];
      return { stage: key.replace("Config", ""), fieldCount: fields.length, fields };
    });

    const docHints = {
      legal: { extends: "legal", overrides: { parser: { ocrMaxAttempts: 3 }, readingOrder: { lineGroupEpsilon: 4 }, paragraphMerger: { strategy: "text-structure" } } },
      scientific: { extends: "scientific", overrides: { layoutAnalyzer: { columnGapThresholdPercent: 0.10 }, tagBuilder: { headingLevelClampMax: 4 } } },
      scanned: { extends: "scanned-low-quality", overrides: { parser: { ocrMode: "force", ocrMaxAttempts: 4 } } },
      forms: { extends: "forms-heavy", overrides: { fontEmbedder: { fallbackStrategy: "substitute-always" } } },
      cjk: { extends: "cjk", overrides: { parser: { ocrLanguages: "jpn+chi_sim+kor+eng" } } }
    };

    const hint = docHints[documentType?.toLowerCase()] || null;
    const exampleProfile = {
      schemaVersion: "1.0.0",
      profileId: `custom-${documentType || "general"}`,
      label: `Custom ${documentType || "General"} Profile`,
      description: `Profile tuned for ${documentType || "your document type"}. Extend and override as needed.`,
      extends: hint?.extends || base,
      tags: [documentType || "custom"],
      ...(hint?.overrides || {})
    };

    return textResult({
      guide: {
        title: "Creating a Custom Profile",
        steps: [
          "1. Choose a base profile to extend (default, legal, scientific, scanned-low-quality, forms-heavy, cjk)",
          "2. Create a JSON file in orchestrator/profiles/<your-id>.json",
          "3. Set schemaVersion: '1.0.0', profileId (lowercase-kebab), label (human-readable), and extends",
          "4. Override only the fields you want to change — everything else inherits from the base",
          "5. Validate: node -e \"import('./orchestrator/profile-registry.js').then(m=>m.resolveProfile('your-id').then(console.log))\"",
          "6. Restart the server — your profile appears in the dashboard dropdown and GET /profiles API",
          "7. Test: submit a PDF with profileId='your-id' and check the results"
        ],
        availableBaseProfiles: ["default", "legal", "scientific", "scanned-low-quality", "forms-heavy", "cjk"],
        profileFilePath: "orchestrator/profiles/<your-id>.json"
      },
      stageGuide,
      totalTunableFields: stageGuide.reduce((s, g) => s + g.fieldCount, 0),
      exampleProfile,
      documentTypeHint: hint ? `Recommended base for '${documentType}': extend '${hint.extends}'` : null
    });
  }
);

// 10. guide_verification_pipeline
server.tool(
  "guide_verification_pipeline",
  "Comprehensive guide for running verification pipelines: accessibility validation, font health analysis, native tagging verification, corruption repair, and paragraph merge quality. Returns concrete CLI commands, expected outputs, and how to interpret results.",
  {
    scope: z.enum(["full", "accessibility", "fonts", "native", "corruption", "paragraphs"]).optional().describe("Which verification to explain. Default: 'full' (all).")
  },
  async ({ scope }) => {
    const s = scope || "full";
    const guides = {};

    if (s === "full" || s === "accessibility") {
      guides.accessibility = {
        title: "Accessibility Tagging Verification",
        description: "Run the full pipeline and validate PDF/UA compliance via veraPDF.",
        commands: [
          "# Run full pipeline on a single PDF:",
          "node orchestrator/pipeline-runner.js --pdf input.pdf --output-dir tmp/run --profile-id legal",
          "",
          "# Or via the API:",
          "curl -X POST http://localhost:3000/process-pdf -H 'Content-Type: application/json' -d '{\"filePath\":\"input.pdf\",\"outputDir\":\"tmp/out\",\"workloadId\":\"accessibility-tagging\",\"profileId\":\"legal\"}'",
          "",
          "# Check validation report:",
          "cat tmp/run/07-validation-report.json | node -e \"const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('Status:', r.overall.status, 'Findings:', r.findings.length)\"",
          "",
          "# Run veraPDF directly:",
          "npm run install:verapdf",
          "node modules/validator/index.js --pdf tmp/run/06-tagged.pdf --manifest tmp/run/06-tagged.pdf.tags.json"
        ],
        artifacts: ["01-layout.json", "02-layout-enriched.json", "03-semantic.json", "03b-semantic-merged.json", "04-semantic-ordered.json", "05-tagging.json", "06-tagged.pdf", "07-validation-report.json"],
        keyMetrics: ["overall.status (pass/fail)", "findings[].code (specific rule violations)", "summary.failedRules", "summary.failedChecks"],
        commonFailures: [
          "VERAPDF_5_1: Missing PDF/UA identification in XMP metadata",
          "VERAPDF_7_1_9: Missing dc:title in document metadata",
          "VERAPDF_7_21_4_2_2: CIDSet incomplete on subsetted fonts (fixed by our CIDSet cleanup)",
          "FONT_NOT_EMBEDDED: Standard 14 font used without embedding",
          "TO_UNICODE_MISSING: Font lacks ToUnicode CMap"
        ]
      };
    }

    if (s === "full" || s === "fonts") {
      guides.fonts = {
        title: "Font Health Verification",
        description: "24-check font analysis covering embedding, encoding, metrics, structure, and accessibility.",
        commands: [
          "# Run font health analysis as part of corruption repair workload:",
          "curl -X POST http://localhost:3000/process-pdf-upload -F 'file=@input.pdf' -F 'workloadId=corruption-repair'",
          "",
          "# Or run the font repair CLI directly:",
          "java -cp modules/corruption-repairer/java:modules/pdf-writer/vendor/pdfbox-app-3.0.7.jar FontRepairCli --pdf input.pdf",
          "",
          "# View the font health report in browser:",
          "open http://localhost:3000/font-report.html?jobId=<jobId>"
        ],
        checks: {
          embedding: ["FONT_NOT_EMBEDDED", "FONT_PROGRAM_CORRUPT", "FONT_PROGRAM_TRUNCATED", "STANDARD_14_RELIANCE", "MISSING_FONT_DESCRIPTOR"],
          encoding: ["TOUNICODE_MISSING", "TOUNICODE_CORRUPT", "IDENTITY_H_NO_TOUNICODE", "SYMBOLIC_NO_DIFFERENCES", "ENCODING_MISMATCH", "PUA_WITHOUT_TOUNICODE"],
          metrics: ["WIDTH_TABLE_MISMATCH", "MISSING_REQUIRED_GLYPHS", "FONTBBOX_INVALID", "METRICS_INVALID"],
          structure: ["CID_SYSTEM_INFO_MISSING", "DESCENDANT_FONTS_INVALID", "CID_TO_GID_MAP_BROKEN", "SUBSET_PREFIX_MISMATCH", "CIDSET_INCOMPLETE"],
          accessibility: ["DA_FONT_NOT_IN_DR", "FONT_NOT_IN_RESOURCES", "TYPE3_FONT_FOUND", "FONT_LANGUAGE_MISMATCH"]
        },
        grading: "A (≥0.9), B (≥0.75), C (≥0.6), D (≥0.4), F (<0.4) per font and overall"
      };
    }

    if (s === "full" || s === "native") {
      guides.native = {
        title: "Native Tagging Verification",
        description: "Verify that the PDF writer preserves original vector text instead of rasterizing. Compare native vs raster output.",
        commands: [
          "# Run with native mode:",
          "node modules/pdf-writer/index.js --pdf input.pdf --tags tags.json --semantic semantic.json --output tagged.pdf --mode native",
          "",
          "# Or set profile to use native mode:",
          "curl -X POST http://localhost:3000/process-pdf -H 'Content-Type: application/json' -d '{\"filePath\":\"input.pdf\",\"outputDir\":\"tmp/out\",\"profileOverrides\":{\"pdfWriter\":{\"mode\":\"native\"}}}'",
          "",
          "# Run the native verification pipeline:",
          "npm run native:verify -- --pdf tmp/out/06-tagged.pdf",
          "",
          "# View nativity report in browser:",
          "open http://localhost:3000/nativity-report.html?jobId=<jobId>",
          "",
          "# Run the operator-level parser to inspect content streams:",
          "java -cp build:modules/pdf-writer/vendor/pdfbox-app-3.0.7.jar NativeContentStreamParser --pdf input.pdf --page 0"
        ],
        keyMetrics: [
          "contentPreservationScore: fraction of text as native vectors (1.0 = fully native)",
          "operatorMatchRate: fraction of PDF operators matched to structure tree (target ≥0.8)",
          "fileSizeRatio: native/original (should be ~1.05, not 10x like raster)",
          "writerMode: 'native', 'raster', or 'auto'"
        ],
        nativeBadge: "When writerMode=native, the dashboard shows a green animated 'NATIVE PDF RETAINED' badge with fidelity percentage"
      };
    }

    if (s === "full" || s === "corruption") {
      guides.corruption = {
        title: "Corruption Repair Verification",
        description: "8 structural checks + 24 font checks. Scan a PDF for damage and apply surgical repairs.",
        commands: [
          "# Run via dashboard:",
          "Select 'PDF Corruption Repair' workload, upload PDF",
          "",
          "# Run via CLI:",
          "npm run repair:pdf -- --pdf input.pdf --output repaired.pdf",
          "",
          "# View repair report:",
          "open http://localhost:3000/repair-report.html?jobId=<jobId>",
          "",
          "# Run font-specific repair:",
          "java -cp build:modules/pdf-writer/vendor/pdfbox-app-3.0.7.jar FontRepairCli --pdf input.pdf --output repaired.pdf"
        ],
        structuralChecks: ["XREF_TABLE_BROKEN", "STREAM_LENGTH_MISMATCH", "FLATE_STREAM_CORRUPT", "FONT_DAMAGED", "DANGLING_REFERENCE", "HEADER_DAMAGED", "INCREMENTAL_GARBAGE", "FILE_TRUNCATED"],
        healthScoring: "0-1 score; riskLevel: clean/low/medium/high/critical"
      };
    }

    if (s === "full" || s === "paragraphs") {
      guides.paragraphs = {
        title: "Paragraph Merge Quality Verification",
        description: "Text-structure merge achieves 82% line reduction. Tournament system compares 9 strategies across your corpus.",
        commands: [
          "# Run the evaluator across a corpus:",
          "npm run paragraph:evaluate -- C:/path/to/jobs/root tmp/paragraph-eval",
          "",
          "# Generate HTML comparison report:",
          "npm run paragraph:report -- --input tmp/paragraph-eval/corpus-summary.json --output tmp/paragraph-eval/index.html",
          "",
          "# Run a single document through the merger:",
          "node modules/paragraph-merger/index.js semantic.json --strategy text-structure --report merge-report.json",
          "",
          "# View paragraph merge report:",
          "open http://localhost:3000/paragraph-report.html?jobId=<jobId>"
        ],
        strategies: ["text-structure (default, 82% reduction)", "pairwise (confidence-based)", "disabled (passthrough)"],
        scoring: ["nodeReduction (0.15 weight)", "paragraphCoherence (0.25)", "overMergeRate (0.35 penalty)", "underMergeRate (0.15)", "skipExplainability (0.10)"],
        profileField: "paragraphMerger.strategy = 'text-structure' | 'pairwise' | 'disabled'"
      };
    }

    return textResult({
      title: `Verification Pipeline Guide${s !== "full" ? `: ${s}` : ""}`,
      guides,
      quickStart: {
        fullVerification: [
          "1. Start the server: npm start",
          "2. Upload a PDF via dashboard or API",
          "3. Select 'Accessibility Tagging' workload with 'legal' profile",
          "4. Check results: validation report, font audit, native badge, paragraph merge report",
          "5. For corruption: switch to 'PDF Corruption Repair' workload",
          "6. For corpus-wide evaluation: npm run paragraph:evaluate <corpus-dir>"
        ],
        recommendedOrder: "corruption-repair → accessibility-tagging → (review font/native/paragraph reports)"
      }
    });
  }
);

// 11. guide_workload_comparison
server.tool(
  "guide_workload_comparison",
  "Explains all available workloads, what each produces, when to use which, and how they relate to each other.",
  {},
  async () => {
    return textResult({
      workloads: [
        {
          id: "accessibility-tagging",
          label: "Accessibility Tagging",
          purpose: "Produce PDF/UA compliant tagged output with structure tree, reading order, and embedded fonts.",
          when: "You need to make a PDF accessible for screen readers and assistive technology.",
          stages: ["parser", "layout-analyzer", "semantic-engine", "paragraph-merger", "reading-order", "tag-builder", "font-embedder", "pdf-writer", "validator"],
          outputs: ["06-tagged.pdf (tagged output)", "07-validation-report.json", "06-writer-report.json", "03c-paragraph-merge-report.json"],
          profiles: "Use 'legal' for court filings, 'scientific' for papers, 'scanned-low-quality' for photocopies",
          nativeMode: "Set pdfWriter.mode='native' or 'auto' to preserve original vector text"
        },
        {
          id: "ssn-redaction",
          label: "SSN Redaction",
          purpose: "Detect and redact social security numbers from PDF content.",
          when: "You need to remove PII before sharing documents.",
          stages: ["parser", "layout-analyzer", "redactor"],
          outputs: ["redacted.pdf", "redaction-report.json"]
        },
        {
          id: "tag-and-ssn-redact",
          label: "Tag + SSN Redact",
          purpose: "Accessibility tag AND redact SSNs in one pass.",
          when: "You need both accessibility and PII protection.",
          stages: ["All accessibility stages + SSN redaction before writing"]
        },
        {
          id: "corruption-repair",
          label: "PDF Corruption Repair",
          purpose: "Scan for 8 structural + 24 font corruptions and apply surgical repairs.",
          when: "PDFs fail to open, render incorrectly, have garbled text, or fail accessibility validation due to structural damage.",
          stages: ["structural-repair", "font-health-check"],
          outputs: ["repaired.pdf", "repair-report.json", "font-report.json"],
          recommendation: "Run BEFORE accessibility tagging — repair the source, then tag the clean version."
        }
      ],
      recommendedWorkflow: [
        "1. Run 'corruption-repair' first to fix any structural/font issues",
        "2. Run 'accessibility-tagging' with appropriate profile on the repaired PDF",
        "3. Review the validation report + font health + native badge",
        "4. If SSN redaction needed, use 'tag-and-ssn-redact' instead of step 2"
      ]
    });
  }
);

// 12. explain_pdf_standards
let _pdfStandards = null;
async function loadPdfStandards() {
  if (!_pdfStandards) {
    _pdfStandards = JSON.parse(await readFile(path.join(dataDir, "pdf-standards-ecosystem.json"), "utf8"));
  }
  return _pdfStandards;
}
export { loadPdfStandards };

server.tool(
  "explain_pdf_standards",
  "Comprehensive reference for all PDF-related ISO standards: PDF 1.7/2.0, PDF/UA-1/UA-2, PDF/A-1/2/3/4, PDF/X, and their relationships. Returns version history, key requirements, our compliance status, and migration guidance.",
  {
    standard: z.string().optional().describe("Specific standard: 'pdf17', 'pdf20', 'pdfua1', 'pdfua2', 'pdfa1', 'pdfa2', 'pdfa3', 'pdfa4', 'pdfx', 'all', 'timeline', 'conflicts', 'dual-conformance'. Omit for overview.")
  },
  async ({ standard }) => {
    const data = await loadPdfStandards();
    const s = (standard || "").toLowerCase().replace(/[-_/\s]/g, "");

    if (!s || s === "all" || s === "overview") {
      return textResult({
        title: data.title,
        coreVersions: Object.keys(data.coreSpecification.versions).map(k => ({
          key: k,
          label: data.coreSpecification.versions[k].label,
          year: data.coreSpecification.versions[k].year,
          iso: data.coreSpecification.versions[k].iso
        })),
        accessibilityStandards: ["PDF/UA-1 (ISO 14289-1:2014, for PDF 1.7)", "PDF/UA-2 (ISO 14289-2:2024, for PDF 2.0)"],
        archivalStandards: ["PDF/A-1 (ISO 19005-1:2005)", "PDF/A-2 (ISO 19005-2:2011)", "PDF/A-3 (ISO 19005-3:2012)", "PDF/A-4 (ISO 19005-4:2020)"],
        printStandards: ["PDF/X-1a", "PDF/X-3", "PDF/X-4", "PDF/X-6"],
        versionAlignment: data.standardRelationships.versionAlignment,
        ourTarget: "PDF 1.7 + PDF/UA-1. PDF 2.0 + PDF/UA-2 migration path documented.",
        queryHint: "Pass standard='pdfua1', 'pdfua2', 'pdfa2', 'pdf20', 'timeline', 'conflicts', or 'dual-conformance' for details."
      });
    }

    if (s === "timeline") return textResult(data.versionHistory);
    if (s === "conflicts") return textResult({ conflicts: data.standardRelationships.conflicts, dualConformance: data.standardRelationships.dualConformance });
    if (s === "dualconformance") return textResult(data.standardRelationships.dualConformance);
    if (s === "relationships") return textResult(data.standardRelationships);

    const map = {
      pdf14: data.coreSpecification.versions.pdf14,
      pdf15: data.coreSpecification.versions.pdf15,
      pdf16: data.coreSpecification.versions.pdf16,
      pdf17: data.coreSpecification.versions.pdf17,
      pdf20: data.coreSpecification.versions.pdf20,
      pdfua1: data.accessibilityStandards.pdfUA1,
      pdfua2: data.accessibilityStandards.pdfUA2,
      pdfa1: data.archivalStandards.pdfA1,
      pdfa2: data.archivalStandards.pdfA2,
      pdfa3: data.archivalStandards.pdfA3,
      pdfa4: data.archivalStandards.pdfA4,
      pdfx: data.printStandards,
      pdfe: data.otherStandards.pdfE,
      pdfvt: data.otherStandards.pdfVT
    };

    const match = map[s];
    if (match) return textResult({ standard: s, ...match });

    return textResult({
      error: `Unknown standard '${standard}'.`,
      available: Object.keys(map)
    });
  }
);

// 13. explain_pdf_concept
let _pdfSpec = null;
async function loadPdfSpec() {
  if (!_pdfSpec) {
    _pdfSpec = JSON.parse(await readFile(path.join(dataDir, "pdf-specification.json"), "utf8"));
  }
  return _pdfSpec;
}
export { loadPdfSpec };

server.tool(
  "explain_pdf_concept",
  "Explains a PDF specification concept in plain language with examples. Covers file structure, content streams, operators, fonts, tagged PDF, PDF/UA accessibility, and coordinate systems. Use this when you need to understand how PDFs work internally.",
  {
    concept: z.string().describe("What to explain. Examples: 'content streams', 'Tj operator', 'ToUnicode', 'font types', 'tagged PDF', 'structure tree', 'MCID', 'xref table', 'coordinate system', 'PDF/UA requirements', 'Type0 font', 'BDC operator', 'artifacts', 'table structure', 'font embedding', 'CIDSet'.")
  },
  async ({ concept }) => {
    const spec = await loadPdfSpec();
    const lower = concept.toLowerCase();
    const results = [];

    const searchSections = [
      { key: "fileStructure", data: spec.fileStructure },
      { key: "documentStructure", data: spec.documentStructure },
      { key: "contentStreams", data: spec.contentStreams },
      { key: "fontSystem", data: spec.fontSystem },
      { key: "taggedPdf", data: spec.taggedPdf },
      { key: "pdfUA", data: spec.pdfUA },
      { key: "coordinateSystems", data: spec.coordinateSystems }
    ];

    for (const section of searchSections) {
      const json = JSON.stringify(section.data).toLowerCase();
      if (json.includes(lower)) {
        results.push({ section: section.key, title: section.data.title, content: section.data });
      }
    }

    if (spec.glossary[concept] || spec.glossary[concept.toUpperCase()]) {
      results.push({
        section: "glossary",
        title: "Glossary",
        definition: spec.glossary[concept] || spec.glossary[concept.toUpperCase()]
      });
    }

    for (const [term, def] of Object.entries(spec.glossary)) {
      if (term.toLowerCase().includes(lower) || def.toLowerCase().includes(lower)) {
        results.push({ section: "glossary", term, definition: def });
      }
    }

    const operators = spec.contentStreams?.textOperators || {};
    const markedOps = spec.contentStreams?.markedContentOperators || {};
    for (const [op, info] of [...Object.entries(operators), ...Object.entries(markedOps)]) {
      if (op.toLowerCase() === lower || (typeof info === "object" && info.description?.toLowerCase().includes(lower))) {
        results.push({ section: "operator", operator: op, ...info });
      }
    }

    if (results.length === 0) {
      return textResult({
        concept,
        found: false,
        suggestion: "Try one of: 'content streams', 'Tj', 'ToUnicode', 'font types', 'tagged PDF', 'structure tree', 'MCID', 'xref', 'coordinate system', 'PDF/UA', 'artifacts', 'table', 'font embedding', 'CIDSet', 'BDC'.",
        availableSections: searchSections.map(s => s.key),
        glossaryTerms: Object.keys(spec.glossary)
      });
    }

    const unique = [];
    const seen = new Set();
    for (const r of results) {
      const key = r.section + (r.term || r.operator || "");
      if (!seen.has(key)) { seen.add(key); unique.push(r); }
    }

    return textResult({ concept, found: true, results: unique.slice(0, 8) });
  }
);

// 13. explain_pdf_operator
server.tool(
  "explain_pdf_operator",
  "Detailed explanation of a specific PDF content stream operator. Returns operands, description, usage context, and how our pipeline handles it.",
  { operator: z.string().describe("The operator name: Tj, TJ, Tf, Td, Tm, BT, ET, BDC, BMC, EMC, q, Q, cm, re, m, l, S, f, etc.") },
  async ({ operator }) => {
    const spec = await loadPdfSpec();
    const allOps = {
      ...spec.contentStreams.textOperators,
      ...spec.contentStreams.graphicsStateOperators,
      ...spec.contentStreams.pathOperators,
      ...spec.contentStreams.markedContentOperators
    };

    const info = allOps[operator];
    if (!info) {
      return textResult({
        operator,
        found: false,
        available: Object.keys(allOps),
        hint: "Operator names are case-sensitive. Common text operators: BT, ET, Tf, Td, Tm, Tj, TJ. Marked content: BDC, BMC, EMC."
      });
    }

    const category =
      spec.contentStreams.textOperators[operator] ? "text" :
      spec.contentStreams.graphicsStateOperators[operator] ? "graphicsState" :
      spec.contentStreams.pathOperators[operator] ? "path" :
      "markedContent";

    const pipelineUsage =
      category === "text" ? "NativeContentStreamParser intercepts this operator to extract text content and position. NativeTagMatcher uses its position to link to semantic nodes." :
      category === "markedContent" ? "NativeContentStreamRewriter injects these operators around text content to create the structure tree linkage. BDC carries the MCID that connects to a structure element." :
      category === "graphicsState" ? "Preserved verbatim during native tagging. Not modified by the pipeline." :
      "Used by the table-structure-map extractor to detect ruled table gridlines.";

    return textResult({
      operator,
      found: true,
      category,
      ...(typeof info === "string" ? { description: info } : info),
      pipelineUsage,
      relatedOperators: category === "text" ? ["BT", "ET", "Tf", "Td", "Tm", "Tj", "TJ", "T*"] :
        category === "markedContent" ? ["BDC", "BMC", "EMC"] :
        category === "graphicsState" ? ["q", "Q", "cm", "gs"] :
        ["m", "l", "c", "re", "S", "f", "n"]
    });
  }
);

// 14. explain_font_architecture
server.tool(
  "explain_font_architecture",
  "Deep dive into PDF font architecture: types, encoding, embedding, ToUnicode, subsetting, and how our pipeline handles each font scenario.",
  { topic: z.string().optional().describe("Specific topic: 'types', 'encoding', 'embedding', 'toUnicode', 'subsetting', 'standard14', 'cidFonts', 'type3'. Omit for full overview.") },
  async ({ topic }) => {
    const spec = await loadPdfSpec();
    const font = spec.fontSystem;

    if (topic) {
      const topicMap = {
        types: { title: "Font Types", content: font.fontTypes },
        encoding: { title: "Font Encoding", content: { overview: "PDF fonts use encodings to map byte values to glyphs. Each font type has its own encoding model.", type1: "WinAnsiEncoding or Differences array. Each byte → glyph name → outline.", trueType: "Platform-specific cmap table inside the TTF. Byte → glyph ID → outline.", type0: "CMap (usually Identity-H) maps 2-byte codes to CIDs. CIDToGIDMap then maps CIDs to glyph IDs in the embedded TrueType.", toUnicode: font.toUnicode } },
        embedding: { title: "Font Embedding", content: { descriptor: font.fontDescriptor, requirement: "PDF/UA requires ALL fonts to be embedded. No exceptions.", ourApproach: "font-embedder module analyzes every font, plans remediation (embed, substitute, inject-toUnicode), pdf-writer executes the plan." } },
        toUnicode: { title: "ToUnicode CMap", content: font.toUnicode },
        tounicode: { title: "ToUnicode CMap", content: font.toUnicode },
        subsetting: { title: "Font Subsetting", content: font.subsetting },
        standard14: { title: "Standard 14 Fonts", content: font.fontTypes.Type1 },
        cidFonts: { title: "CID Fonts (Type0)", content: font.fontTypes.Type0 },
        cidfonts: { title: "CID Fonts (Type0)", content: font.fontTypes.Type0 },
        type3: { title: "Type3 Fonts", content: font.fontTypes.Type3 }
      };

      const match = topicMap[topic.toLowerCase()];
      if (match) return textResult(match);
      return textResult({ error: `Unknown topic '${topic}'. Available: ${Object.keys(topicMap).join(", ")}` });
    }

    return textResult({
      title: font.title,
      overview: font.overview,
      fontTypes: Object.keys(font.fontTypes),
      toUnicode: font.toUnicode,
      subsetting: font.subsetting,
      descriptor: font.fontDescriptor,
      ourPipeline: {
        fontEmbedder: "Analyzes all fonts, reconstructs missing ToUnicode, plans remediation actions",
        fontAudit: "24-check pre-veraPDF audit with actionable findings",
        fontRepair: "Corruption repairer scans for damaged font programs, missing descriptors, broken CIDToGIDMap",
        cidSetFix: "Removes /CIDSet from subsetted Type0 fonts (clause 7.21.4.2)",
        fallbackFonts: "Noto Sans/Serif/Mono/Symbols vendored as SIL-OFL replacements for Standard 14"
      }
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
