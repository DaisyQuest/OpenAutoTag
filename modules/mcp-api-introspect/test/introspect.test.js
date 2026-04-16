// Prevent MCP server from binding to stdio during tests
process.env.MCP_INTROSPECT_NO_CONNECT = "1";

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(moduleDir, "data");
const repoRoot = path.resolve(moduleDir, "..", "..");
const contractsDir = path.join(repoRoot, "contracts");

// ─── Data file tests ───

describe("pipeline-stages.json", () => {
  let stages;
  before(async () => {
    stages = JSON.parse(await readFile(path.join(dataDir, "pipeline-stages.json"), "utf8"));
  });

  it("is an array of 7 stages", () => {
    assert.ok(Array.isArray(stages));
    assert.equal(stages.length, 7);
  });

  it("stages are in order 1-7", () => {
    const orders = stages.map((s) => s.order);
    assert.deepStrictEqual(orders, [1, 2, 3, 4, 5, 6, 7]);
  });

  it("each stage has required fields", () => {
    for (const stage of stages) {
      assert.ok(stage.name, `stage missing name`);
      assert.ok(stage.module, `stage ${stage.name} missing module`);
      assert.ok(stage.cli, `stage ${stage.name} missing cli`);
      assert.ok(stage.description, `stage ${stage.name} missing description`);
      assert.equal(typeof stage.order, "number");
    }
  });

  it("stage names match SPEC pipeline order", () => {
    const names = stages.map((s) => s.name);
    assert.deepStrictEqual(names, [
      "parser",
      "layout-analyzer",
      "semantic-engine",
      "reading-order",
      "tag-builder",
      "pdf-writer",
      "validator",
    ]);
  });
});

describe("env-knobs.json", () => {
  let data;
  before(async () => {
    data = JSON.parse(await readFile(path.join(dataDir, "env-knobs.json"), "utf8"));
  });

  it("has groups array", () => {
    assert.ok(Array.isArray(data.groups));
    assert.ok(data.groups.length > 0);
  });

  it("each group has module and vars", () => {
    for (const group of data.groups) {
      assert.ok(group.module, "group missing module");
      assert.ok(Array.isArray(group.vars), `group ${group.module} missing vars array`);
      assert.ok(group.vars.length > 0, `group ${group.module} has no vars`);
    }
  });

  it("each var has name and description", () => {
    for (const group of data.groups) {
      for (const v of group.vars) {
        assert.ok(v.name, `var in ${group.module} missing name`);
        assert.ok(v.description, `var ${v.name} missing description`);
      }
    }
  });

  it("contains all expected env vars from SPEC", () => {
    const allVarNames = data.groups.flatMap((g) => g.vars.map((v) => v.name));
    const expected = [
      "PARSER_OCR_MODE",
      "PARSER_OCR_LANGS",
      "PARSER_OCR_MAX_ATTEMPTS",
      "PARSER_OCR_TEMP_ROOT",
      "VERAPDF_FLAVOUR",
      "VALIDATOR_JAVA_HOME",
      "VALIDATOR_JAVA_PATH",
      "VALIDATOR_JAVAC_PATH",
      "VERAPDF_PATH",
      "PIPELINE_DATA_ROOT",
      "APP_RUNTIME_ROOT",
      "AGENT_MASTER_ENDPOINT",
      "AGENT_POLL_INTERVAL_MS",
      "AGENT_HEARTBEAT_INTERVAL_MS",
      "AGENT_CHECKIN_INTERVAL_MS",
      "PIPELINE_JAVAC_PATH",
      "OVERLAY_FONT_PATH",
    ];
    for (const name of expected) {
      assert.ok(allVarNames.includes(name), `Missing env var: ${name}`);
    }
  });
});

describe("finding-codes.json", () => {
  let data;
  before(async () => {
    data = JSON.parse(await readFile(path.join(dataDir, "finding-codes.json"), "utf8"));
  });

  it("has findingCodes array", () => {
    assert.ok(Array.isArray(data.findingCodes));
    assert.ok(data.findingCodes.length > 0);
  });

  it("each finding has code, severity, source, description, remediation", () => {
    for (const f of data.findingCodes) {
      assert.ok(f.code, "finding missing code");
      assert.ok(f.severity, `finding ${f.code} missing severity`);
      assert.ok(f.source, `finding ${f.code} missing source`);
      assert.ok(f.description, `finding ${f.code} missing description`);
      assert.ok(f.remediation, `finding ${f.code} missing remediation`);
    }
  });

  it("includes manifest-check findings", () => {
    const manifestCodes = data.findingCodes.filter((f) => f.source === "manifest-check");
    assert.ok(manifestCodes.length >= 3, "Expected at least 3 manifest-check findings");
  });

  it("includes verapdf findings", () => {
    const veraCodes = data.findingCodes.filter((f) => f.source === "verapdf");
    assert.ok(veraCodes.length >= 3, "Expected at least 3 verapdf findings");
  });
});

// ─── Contract file accessibility tests ───

describe("contracts directory", () => {
  const expectedContracts = [
    "layout",
    "semantic",
    "tagging",
    "pipeline-job",
    "profile",
    "redaction-plan",
    "redaction-report",
    "table-structure",
  ];

  for (const name of expectedContracts) {
    it(`${name}.schema.json is readable and valid JSON`, async () => {
      const filePath = path.join(contractsDir, `${name}.schema.json`);
      const raw = await readFile(filePath, "utf8");
      const schema = JSON.parse(raw);
      assert.ok(schema.title || schema.$id, `Contract ${name} has no title or $id`);
    });
  }
});

// ─── native-tagging.json ───

describe("native-tagging.json", () => {
  let data;
  before(async () => {
    data = JSON.parse(await readFile(path.join(dataDir, "native-tagging.json"), "utf8"));
  });

  it("has expected top-level fields", () => {
    assert.ok(data.status, "missing status");
    assert.ok(data.components, "missing components");
    assert.ok(Array.isArray(data.writerModes), "writerModes should be array");
    assert.ok(data.profileField, "missing profileField");
    assert.ok(Array.isArray(data.advantages), "advantages should be array");
    assert.ok(Array.isArray(data.limitations), "limitations should be array");
    assert.ok(Array.isArray(data.proofMetrics), "proofMetrics should be array");
  });

  it("writerModes contains native, raster, auto", () => {
    assert.deepStrictEqual(data.writerModes.sort(), ["auto", "native", "raster"]);
  });

  it("components have status and file/module fields", () => {
    for (const [key, comp] of Object.entries(data.components)) {
      assert.ok(comp.status, `component ${key} missing status`);
      assert.ok(comp.file || comp.module, `component ${key} missing file or module`);
    }
  });

  it("profileField points to pdfWriter.mode", () => {
    assert.equal(data.profileField, "pdfWriter.mode");
  });
});

// ─── MCP server tool handler tests (unit-style, no transport) ───

describe("MCP tool handlers", () => {
  let loadStages, loadEnvKnobs, loadFindingCodes, loadNativeTagging;

  before(async () => {
    // Import the loader functions directly rather than starting the server
    // (the server connects to stdio on import, so we test the data loaders)
    const mod = await import("../index.js");
    loadStages = mod.loadStages;
    loadEnvKnobs = mod.loadEnvKnobs;
    loadFindingCodes = mod.loadFindingCodes;
    loadNativeTagging = mod.loadNativeTagging;
  });

  it("loadStages returns 7 pipeline stages", async () => {
    const stages = await loadStages();
    assert.equal(stages.length, 7);
    assert.equal(stages[0].name, "parser");
    assert.equal(stages[6].name, "validator");
  });

  it("loadEnvKnobs returns grouped env vars", async () => {
    const data = await loadEnvKnobs();
    assert.ok(data.groups.length >= 4);
    const parserGroup = data.groups.find((g) => g.module === "parser");
    assert.ok(parserGroup, "Expected parser group");
    assert.ok(parserGroup.vars.length >= 3);
  });

  it("loadFindingCodes returns finding code catalog", async () => {
    const data = await loadFindingCodes();
    assert.ok(data.findingCodes.length >= 5);
    const missing = data.findingCodes.find((f) => f.code === "MISSING_DOCUMENT_ROOT");
    assert.ok(missing, "Expected MISSING_DOCUMENT_ROOT finding");
    assert.equal(missing.severity, "error");
  });

  it("loadNativeTagging returns expected shape", async () => {
    const data = await loadNativeTagging();
    assert.equal(data.status, "phase-1-proof-of-concept");
    assert.ok(data.components.operatorParser, "missing operatorParser component");
    assert.equal(data.components.operatorParser.status, "implemented");
    assert.equal(data.components.operatorParser.file, "NativeContentStreamParser.java");
    assert.ok(data.components.tagMatcher, "missing tagMatcher component");
    assert.ok(data.components.streamRewriter, "missing streamRewriter component");
    assert.ok(data.components.verification, "missing verification component");
    assert.deepStrictEqual(data.writerModes.sort(), ["auto", "native", "raster"]);
    assert.equal(data.profileField, "pdfWriter.mode");
    assert.ok(data.advantages.length >= 3, "expected at least 3 advantages");
    assert.ok(data.limitations.length >= 2, "expected at least 2 limitations");
    assert.ok(data.proofMetrics.length >= 3, "expected at least 3 proof metrics");
    assert.ok(data.proofMetrics.includes("operatorMatchRate"), "expected operatorMatchRate metric");
  });
});

// ─── .mcp.json config test ───

describe(".mcp.json", () => {
  it("exists at repo root with correct server config", async () => {
    const mcpConfig = JSON.parse(await readFile(path.join(repoRoot, ".mcp.json"), "utf8"));
    assert.ok(mcpConfig.mcpServers, "Missing mcpServers key");
    assert.ok(mcpConfig.mcpServers["pipeline-introspect"], "Missing pipeline-introspect server");
    assert.equal(mcpConfig.mcpServers["pipeline-introspect"].command, "node");
    assert.deepStrictEqual(mcpConfig.mcpServers["pipeline-introspect"].args, [
      "modules/mcp-api-introspect/index.js",
    ]);
  });
});
