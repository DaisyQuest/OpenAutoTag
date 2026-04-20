import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeTaggedArtifacts } from "../index.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");

const fixturePdf = path.join(repoRoot, "Autonics-TK-manual.pdf");
// We reuse the LRBTest fixture's tagging + semantic documents here only
// because this test's concern is the dispatch/passthrough wiring, not the
// matcher output. The probe runs before we'd ever try to match against the
// Autonics tagging, and the probe alone decides we're in passthrough land.
const sharedTaggingPath = path.join(moduleDir, "fixtures", "2026_31163", "tagging.json");
const sharedSemanticPath = path.join(moduleDir, "fixtures", "2026_31163", "semantic-ordered.json");

test("auto + passthrough policy: already-tagged Autonics PDF gets copied + metadata refresh", async (t) => {
  if (!existsSync(fixturePdf)) {
    t.skip(`source PDF missing at ${fixturePdf}`);
    return;
  }
  if (!existsSync(sharedTaggingPath) || !existsSync(sharedSemanticPath)) {
    t.skip("shared tagging/semantic fixtures missing");
    return;
  }

  const outDir = path.join(repoRoot, "tmp", "passthrough-smoke");
  await mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, "autonics-passthrough.pdf");

  const result = await writeTaggedArtifacts({
    pdfPath: fixturePdf,
    tagsPath: sharedTaggingPath,
    semanticPath: sharedSemanticPath,
    outputPath,
    mode: "auto",
    alreadyTaggedPolicy: "passthrough"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.writerMode, "passthrough", "passthrough policy should produce writerMode=passthrough");
  assert.ok(existsSync(outputPath), "output PDF written");

  // Content-stream fidelity check. Passthrough does an incremental save,
  // which appends a delta section — the source's content-stream, font, and
  // structure-tree bytes should appear verbatim at the head of the output.
  const sourceBytes = await readFile(fixturePdf);
  const outputBytes = await readFile(outputPath);
  assert.ok(
    outputBytes.byteLength >= sourceBytes.byteLength,
    `output (${outputBytes.byteLength}) must include all source bytes (${sourceBytes.byteLength}); ` +
    "incremental save appends rather than truncating"
  );
  // The first N bytes should match byte-for-byte — this is the signature of
  // a true passthrough. A full save-reopen-save cycle would rewrite these.
  const compareLen = Math.min(sourceBytes.byteLength, outputBytes.byteLength);
  let divergedAt = -1;
  for (let i = 0; i < compareLen; i++) {
    if (sourceBytes[i] !== outputBytes[i]) {
      divergedAt = i;
      break;
    }
  }
  assert.equal(
    divergedAt,
    -1,
    `expected source prefix byte-identical in passthrough output; diverged at offset ${divergedAt}`
  );

  // Manifest surfaces the new fields.
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.writerMode, "passthrough");
  assert.equal(manifest.summary.alreadyTaggedPolicy, "passthrough");
  assert.ok(manifest.summary.probeMarkedFraction >= 0.5, "autoNomics is detected as already-tagged");
  assert.equal(manifest.summary.sourceBytes, sourceBytes.byteLength);
  assert.ok(manifest.summary.outputBytes >= sourceBytes.byteLength);
});

test("auto + explicit bailout-to-raster policy: already-tagged PDF falls back to raster", async (t) => {
  // Before 2026-04-18 this was the default path. It's now opt-in —
  // the default switched to passthrough because rasterizing a
  // well-tagged source strips its fonts and leaves Adobe's tag panel
  // showing invisible-overlay gibberish. Still valid for callers
  // that deliberately want the raster behavior (e.g. flows that
  // also redact content visually).
  if (!existsSync(fixturePdf)) {
    t.skip(`source PDF missing at ${fixturePdf}`);
    return;
  }
  if (!existsSync(sharedTaggingPath) || !existsSync(sharedSemanticPath)) {
    t.skip("shared tagging/semantic fixtures missing");
    return;
  }

  const outDir = path.join(repoRoot, "tmp", "passthrough-smoke");
  await mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, "autonics-bailout.pdf");

  const result = await writeTaggedArtifacts({
    pdfPath: fixturePdf,
    tagsPath: sharedTaggingPath,
    semanticPath: sharedSemanticPath,
    outputPath,
    mode: "auto",
    alreadyTaggedPolicy: "bailout-to-raster"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.writerMode, "raster", "explicit bailout-to-raster should raster an already-tagged source");
  assert.ok(result.autoFallbackReason, "manifest records why native was bypassed");
  // The reason string shifts with the probe's signal set — accept either
  // phrasing (legacy marked-content-only, or the newer structurally-tagged
  // check that also verifies /StructTreeRoot and /MarkInfo.Marked).
  assert.match(
    result.autoFallbackReason,
    /already (marked-content tagged|structurally tagged)/,
    `unexpected fallback reason: ${result.autoFallbackReason}`
  );
});
