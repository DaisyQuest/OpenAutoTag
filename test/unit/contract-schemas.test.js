import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

function createValidator(schema) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    strictSchema: false,
    strictTypes: false,
    allowUnionTypes: true
  });

  return ajv.compile(schema);
}

test("tag containment schema preserves the tagging vocabulary and accepts a valid tree", async () => {
  const taggingSchema = await loadJson("contracts/tagging.schema.json");
  const containmentSchema = await loadJson("contracts/tag-containment.schema.json");

  const containmentVocabulary = [
    "Document",
    "Sect",
    "Title",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "L",
    "LI",
    "Lbl",
    "LBody",
    "Figure",
    "Caption",
    "Aside",
    "BlockQuote",
    "Form",
    "Table",
    "THead",
    "TBody",
    "TFoot",
    "TR",
    "TH",
    "TD",
    "Span"
  ];

  assert.equal(containmentSchema.properties.root.$ref, "#/$defs/documentNode");
  assert.deepEqual(containmentVocabulary.sort(), taggingSchema.$defs.tagNode.properties.type.enum.slice().sort());
});

test("tag containment schema validates a structurally valid tree", async () => {
  const schema = await loadJson("contracts/tag-containment.schema.json");
  const validate = createValidator(schema);

  const tree = {
    schemaVersion: "1.0.0",
    documentId: "tag-tree:sample",
    root: {
      id: "tag:document",
      type: "Document",
      children: [
        {
          id: "tag:sect-1",
          type: "Sect",
          children: [
            {
              id: "tag:title-1",
              type: "Title",
              children: [
                {
                  id: "tag:title-span-1",
                  type: "Span",
                  children: []
                }
              ]
            },
            {
              id: "tag:heading-1",
              type: "H1",
              children: [
                {
                  id: "tag:heading-span-1",
                  type: "Span",
                  children: []
                }
              ]
            },
            {
              id: "tag:p-1",
              type: "P",
              children: [
                {
                  id: "tag:p-span-1",
                  type: "Span",
                  children: []
                }
              ]
            },
            {
              id: "tag:list-1",
              type: "L",
              children: [
                {
                  id: "tag:li-1",
                  type: "LI",
                  children: [
                    {
                      id: "tag:li-lbl-1",
                      type: "Lbl",
                      children: []
                    },
                    {
                      id: "tag:li-lbody-1",
                      type: "LBody",
                      children: []
                    }
                  ]
                }
              ]
            },
            {
              id: "tag:table-1",
              type: "Table",
              children: [
                {
                  id: "tag:table-1-head",
                  type: "THead",
                  children: [
                    {
                      id: "tag:table-1-row-1",
                      type: "TR",
                      children: [
                        {
                          id: "tag:table-1-th-1",
                          type: "TH",
                          children: [
                            {
                              id: "tag:table-1-th-1-span",
                              type: "Span",
                              children: []
                            }
                          ]
                        }
                      ]
                    }
                  ]
                },
                {
                  id: "tag:table-1-body",
                  type: "TBody",
                  children: [
                    {
                      id: "tag:table-1-row-2",
                      type: "TR",
                      children: [
                        {
                          id: "tag:table-1-td-1",
                          type: "TD",
                          children: [
                            {
                              id: "tag:table-1-td-1-span",
                              type: "Span",
                              children: []
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  };

  assert.equal(validate(tree), true, JSON.stringify(validate.errors, null, 2));
});

test("tag containment schema rejects an invalid parent-child relationship", async () => {
  const schema = await loadJson("contracts/tag-containment.schema.json");
  const validate = createValidator(schema);

  const invalidTree = {
    schemaVersion: "1.0.0",
    documentId: "tag-tree:invalid",
    root: {
      id: "tag:document",
      type: "Document",
      children: [
        {
          id: "tag:p-1",
          type: "P",
          children: [
            {
              id: "tag:bad-table",
              type: "Table",
              children: []
            }
          ]
        }
      ]
    }
  };

  assert.equal(validate(invalidTree), false);
  assert.ok(validate.errors?.length > 0, "validator should explain the invalid containment");
});

test("validation report schema accepts the current validator artifact shape", async () => {
  const schema = await loadJson("contracts/validation-report.schema.json");
  const validate = createValidator(schema);

  const currentReport = {
    status: "completed",
    isCompliant: true,
    overall: {
      status: "pass"
    },
    statement: "Validation completed successfully.",
    rawStatement: "Validation completed successfully.",
    profileName: "PDF/UA-1 validation profile",
    findings: [],
    errors: [],
    compliance: {
      pdfUA: true,
      wcagAA: true
    },
    summary: {
      passedRules: 12,
      failedRules: 0,
      passedChecks: 101,
      failedChecks: 0
    },
    metadataDiagnostics: {
      metadataPresent: true,
      infoMatchesXmp: true
    },
    fonts: [],
    fontAudit: {
      status: "ok",
      errorCount: 0,
      warningCount: 0,
      blockingPreVeraPdf: false
    },
    engine: {
      name: "veraPDF",
      version: "1.28.2"
    }
  };

  assert.equal(validate(currentReport), true, JSON.stringify(validate.errors, null, 2));
});

test("normalized compliance schema accepts corpus runner payloads", async () => {
  const schema = await loadJson("contracts/normalized-compliance.schema.json");
  const validate = createValidator(schema);

  const normalizedReport = {
    errors: [
      {
        code: "VERA-001",
        message: "Missing alt text",
        source: "validator",
        page: 2
      }
    ],
    compliance: {
      pdfUA: false,
      wcagAA: false
    },
    summary: {
      passedRules: 12,
      failedRules: 1,
      passedChecks: 101,
      failedChecks: 1
    },
    engine: {
      name: "veraPDF",
      version: "1.28.2"
    }
  };

  assert.equal(validate(normalizedReport), true, JSON.stringify(validate.errors, null, 2));
});

test("validation report schema rejects malformed compliance payloads", async () => {
  const schema = await loadJson("contracts/validation-report.schema.json");
  const validate = createValidator(schema);

  const invalidReport = {
    status: "completed",
    isCompliant: false,
    statement: "Validation finished with findings.",
    profileName: "PDF/UA-1 validation profile",
    findings: [],
    summary: {},
    compliance: {
      pdfUA: "no",
      wcagAA: false
    }
  };

  assert.equal(validate(invalidReport), false);
  assert.ok(validate.errors?.some((error) => error.instancePath.includes("/compliance/pdfUA")));
});
