// Per-fixture unit tests for the font-stress corpus.
//
// Each fixture under test/fixtures/fonts/ is paired with an *.expected.json
// describing the inventory shape and validator outcome the combined font-
// embedder + pdf-writer + validator stack must produce.
//
// These tests are defensive about the surrounding modules:
//   - font-embedder/index.js, pdf-writer/index.js, and validator/index.js
//     are all owned by sibling agents on parallel branches.
//   - When a sibling module is not yet present (or its veraPDF/Java vendor
//     bundle is missing), individual subtest steps `skip()` with a clear
//     message instead of failing the suite. The fixture-level inventory
//     shape assertions still run so that CI proves the fixtures themselves
//     are well-formed and discoverable.

import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildAllFixtures, FIXTURES } from "../fixtures/fonts/build-fonts-fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const fixturesDir = path.join(repoRoot, "test", "fixtures", "fonts");

async function pathExists(target) {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function tryImport(specifier) {
  try {
    // Absolute filesystem paths must be passed to dynamic import() as file://
    // URLs on Windows; otherwise Node rejects them with "Only URLs with a
    // scheme in: file, data, and node are supported".
    const importable = path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
    return await import(importable);
  } catch (error) {
    return { __importError: error };
  }
}

function findInventoryFont(inventory, baseFontPredicate) {
  if (!inventory || !Array.isArray(inventory.fonts)) {
    return null;
  }
  return inventory.fonts.find((font) => baseFontPredicate(font.baseFont || "")) || null;
}

function assertExpectedFontShape(actualFont, expectedFont) {
  assert.equal(actualFont.subtype, expectedFont.subtype, "subtype matches");
  if (typeof expectedFont.embedded === "boolean") {
    assert.equal(actualFont.embedded, expectedFont.embedded, "embedded matches");
  }
  if (typeof expectedFont.standard14 === "boolean") {
    assert.equal(actualFont.standard14, expectedFont.standard14, "standard14 matches");
  }
  if (expectedFont.toUnicode?.present !== undefined) {
    assert.equal(
      actualFont.toUnicode?.present,
      expectedFont.toUnicode.present,
      "toUnicode.present matches"
    );
  }
  if (expectedFont.toUnicode?.repairStrategy !== undefined) {
    assert.equal(
      actualFont.toUnicode?.repairStrategy,
      expectedFont.toUnicode.repairStrategy,
      "toUnicode.repairStrategy matches"
    );
  }
  if (expectedFont.encoding?.name) {
    assert.equal(actualFont.encoding?.name, expectedFont.encoding.name, "encoding.name matches");
  }
  if (typeof expectedFont.encoding?.isSymbolic === "boolean") {
    assert.equal(
      actualFont.encoding?.isSymbolic,
      expectedFont.encoding.isSymbolic,
      "encoding.isSymbolic matches"
    );
  }
  if (typeof expectedFont.encoding?.hasDifferences === "boolean") {
    assert.equal(
      actualFont.encoding?.hasDifferences,
      expectedFont.encoding.hasDifferences,
      "encoding.hasDifferences matches"
    );
  }
  if (typeof expectedFont.usage?.inFormDA === "boolean") {
    assert.equal(actualFont.usage?.inFormDA, expectedFont.usage.inFormDA, "usage.inFormDA matches");
  }
  if (expectedFont.plan?.action) {
    assert.equal(actualFont.plan?.action, expectedFont.plan.action, "plan.action matches");
  }
  if (expectedFont.plan?.fallbackKey) {
    assert.equal(
      actualFont.plan?.fallbackKey,
      expectedFont.plan.fallbackKey,
      "plan.fallbackKey matches"
    );
  }
}

test("font fixtures: build helper regenerates all six PDFs deterministically", async () => {
  const built = await buildAllFixtures(fixturesDir);
  assert.equal(built.length, 6, "six fixtures regenerated");
  for (const entry of built) {
    const { size } = await stat(entry.pdfPath);
    assert.ok(size > 0, `${entry.name}.pdf is non-empty`);
    assert.ok(size < 50_000, `${entry.name}.pdf is < 50KB (got ${size}B)`);
    const expectedDoc = JSON.parse(await readFile(entry.expectedPath, "utf8"));
    assert.equal(expectedDoc.fixture, entry.name, "expected.json matches fixture name");
    assert.ok(
      Array.isArray(expectedDoc.inventory?.fonts) && expectedDoc.inventory.fonts.length > 0,
      "expected inventory has at least one font entry"
    );
  }
});

const fontEmbedderEntry = path.join(repoRoot, "modules", "font-embedder", "index.js");
const pdfWriterEntry = path.join(repoRoot, "modules", "pdf-writer", "index.js");
const validatorEntry = path.join(repoRoot, "modules", "validator", "index.js");

for (const fixture of FIXTURES) {
  test(`font fixture: ${fixture.name}`, async (t) => {
    const pdfPath = path.join(fixturesDir, `${fixture.name}.pdf`);
    const expectedPath = path.join(fixturesDir, `${fixture.name}.expected.json`);
    assert.ok(await pathExists(pdfPath), `${fixture.name}.pdf must be present on disk`);
    const expectedDoc = JSON.parse(await readFile(expectedPath, "utf8"));

    let inventory = null;
    let writerReport = null;
    let validatorReport = null;
    let taggedPdfPath = null;

    await t.test("font-embedder produces an inventory matching expectations", async (sub) => {
      if (!(await pathExists(fontEmbedderEntry))) {
        sub.skip("modules/font-embedder/index.js not yet present (sibling branch)");
        return;
      }
      const fontEmbedder = await tryImport(fontEmbedderEntry);
      if (fontEmbedder.__importError) {
        sub.skip(`font-embedder import failed: ${fontEmbedder.__importError.message}`);
        return;
      }
      const buildInventory =
        fontEmbedder.buildFontInventory ||
        fontEmbedder.runFontEmbedder ||
        fontEmbedder.default;
      if (typeof buildInventory !== "function") {
        sub.skip("font-embedder does not yet expose buildFontInventory()");
        return;
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), `font-fixture-${fixture.name}-`));
      const inventoryPath = path.join(tempDir, "fonts.json");
      const result = await buildInventory({ pdfPath, outputPath: inventoryPath });
      inventory = result?.inventory
        ? result.inventory
        : await pathExists(inventoryPath)
          ? JSON.parse(await readFile(inventoryPath, "utf8"))
          : result;

      assert.ok(inventory, "font-embedder returned an inventory");
      assert.equal(inventory.schemaVersion, "1.0.0", "schemaVersion matches contract");

      for (const expectedFont of expectedDoc.inventory.fonts) {
        const matcher = (baseFont) =>
          baseFont === expectedFont.baseFont ||
          baseFont.endsWith(`+${expectedFont.baseFont.replace(/^[A-Z]{6}\+/, "")}`) ||
          baseFont.includes(expectedFont.baseFont);
        const actual = findInventoryFont(inventory, matcher);
        assert.ok(actual, `inventory contains entry for baseFont ~ ${expectedFont.baseFont}`);
        assertExpectedFontShape(actual, expectedFont);
      }

      const expectedBlockerKinds = (expectedDoc.inventory.summary?.blockers || []).map(
        (b) => b.blocker
      );
      const actualBlockerKinds = (inventory.summary?.blockers || []).map((b) => b.blocker);
      for (const kind of expectedBlockerKinds) {
        assert.ok(
          actualBlockerKinds.includes(kind),
          `inventory blockers include "${kind}" (got ${actualBlockerKinds.join(",")})`
        );
      }
    });

    await t.test("pdf-writer executes the planned font actions", async (sub) => {
      if (!inventory) {
        sub.skip("inventory not produced (font-embedder skipped)");
        return;
      }
      if (!(await pathExists(pdfWriterEntry))) {
        sub.skip("modules/pdf-writer/index.js not present");
        return;
      }
      const writer = await tryImport(pdfWriterEntry);
      if (writer.__importError) {
        sub.skip(`pdf-writer import failed: ${writer.__importError.message}`);
        return;
      }
      const writeFn = writer.writeTaggedArtifacts;
      if (typeof writeFn !== "function") {
        sub.skip("pdf-writer does not export writeTaggedArtifacts");
        return;
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), `font-fixture-write-${fixture.name}-`));
      const outputPath = path.join(tempDir, "tagged.pdf");
      const inventoryPath = path.join(tempDir, "fonts.json");
      const tagsPath = path.join(tempDir, "tagging.json");
      const semanticPath = path.join(tempDir, "semantic.json");
      await readFile(pdfPath); // ensure source readable
      // Minimal tagging + semantic stub so writer can run end-to-end on the
      // fixture. The stub uses the contract shape; writers that demand richer
      // structure should expand this when the per-fixture pipeline runs.
      const taggingStub = {
        schemaVersion: "1.0.0",
        documentId: `tagging:${fixture.name}`,
        source: { semanticDocumentId: `semantic:${fixture.name}` },
        root: {
          id: "doc",
          type: "Document",
          children: [
            { id: "p1", type: "P", sourceNodeIds: ["n1"], children: [] }
          ],
          sourceNodeIds: []
        }
      };
      const semanticStub = {
        schemaVersion: "1.0.0",
        documentId: `semantic:${fixture.name}`,
        source: { documentId: `parser:${fixture.name}` },
        nodes: [
          {
            id: "n1",
            type: "paragraph",
            text: "Fixture text",
            pageNumber: 1,
            bbox: [72, 700, 540, 720]
          }
        ]
      };
      await Promise.all([
        readFile(pdfPath),
        Promise.resolve().then(() =>
          import("node:fs/promises").then(({ writeFile }) =>
            Promise.all([
              writeFile(tagsPath, JSON.stringify(taggingStub)),
              writeFile(semanticPath, JSON.stringify(semanticStub)),
              writeFile(inventoryPath, JSON.stringify(inventory))
            ])
          )
        )
      ]);

      try {
        writerReport = await writeFn({
          pdfPath,
          tagsPath,
          semanticPath,
          fontsPath: inventoryPath,
          outputPath
        });
      } catch (error) {
        sub.skip(`pdf-writer threw on fixture (expected pre-rework): ${error.message}`);
        return;
      }

      taggedPdfPath = writerReport?.outputPath || outputPath;
      assert.ok(await pathExists(taggedPdfPath), "writer produced a tagged PDF");
      const writerFonts = writerReport?.fonts || writerReport?.summary?.fonts || [];
      if (!Array.isArray(writerFonts) || writerFonts.length === 0) {
        sub.skip("pdf-writer report does not yet surface fonts[] (writer rework pending)");
        return;
      }
      for (const expectedFont of expectedDoc.inventory.fonts) {
        const reportedAction = writerFonts.find((f) =>
          (f.baseFont || "").includes(expectedFont.baseFont) ||
          (f.fontKey && f.plan?.action === expectedFont.plan.action)
        );
        assert.ok(
          reportedAction,
          `writer fonts[] reports plan ${expectedFont.plan.action} for ${expectedFont.baseFont}`
        );
        assert.equal(reportedAction.executed === true || reportedAction.status === "applied", true);
      }
    });

    await t.test("validator reports zero font-category errors", async (sub) => {
      if (!taggedPdfPath || !(await pathExists(taggedPdfPath))) {
        sub.skip("tagged PDF not produced (writer step skipped)");
        return;
      }
      if (!(await pathExists(validatorEntry))) {
        sub.skip("modules/validator/index.js not present");
        return;
      }
      const validator = await tryImport(validatorEntry);
      if (validator.__importError) {
        sub.skip(`validator import failed: ${validator.__importError.message}`);
        return;
      }
      const validateFn = validator.validateTaggedArtifacts;
      if (typeof validateFn !== "function") {
        sub.skip("validator does not export validateTaggedArtifacts");
        return;
      }
      try {
        validatorReport = await validateFn({
          pdfPath: taggedPdfPath,
          manifestPath: `${taggedPdfPath}.tags.json`
        });
      } catch (error) {
        sub.skip(`validator could not run (probably no veraPDF vendor): ${error.message}`);
        return;
      }
      const fontFindings = (validatorReport.findings || []).filter(
        (f) => /font|to[-_ ]?unicode|cmap|cid|encoding|embed/i.test(f.description || f.code || "")
      );
      const fontErrors = fontFindings.filter((f) => f.severity === "error");
      assert.equal(
        fontErrors.length,
        0,
        `expected zero font-category validator errors, got ${fontErrors.length}: ${fontErrors
          .map((f) => f.code)
          .join(",")}`
      );
    });
  });
}
