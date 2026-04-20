import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildJavaExecEnv, ensureJavaBuildArtifact, resolveJavaTool } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";

const execFileP = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");
const buildDir = getRuntimeBuildDir("modules-pdf-writer", { repoRoot });
const pdfboxJar = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");
const bundledJavaHome = path.join(repoRoot, "modules", "validator", "vendor", "java");
const externalPdfDir = path.join(repoRoot, "test", "fixtures", "external");
const fixturesRoot = path.join(moduleDir, "fixtures", "external");

const POSITION_TOLERANCE = 5;

function normalizeMatcherText(s) {
  return String(s || "")
    .replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Arabic + Hebrew code-point ranges — mirrors containsRtl in the matcher.
function containsRtl(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x0590 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F)) return true;
  }
  return false;
}

function collectTagInfo(tagNode, semById, out) {
  const semNodes = [];
  for (const srcId of tagNode.sourceNodeIds || []) {
    const sn = semById.get(srcId);
    if (sn) semNodes.push(sn);
  }
  if (semNodes.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pages = new Set();
    let text = "";
    for (const sn of semNodes) {
      const [x, y, w, h] = sn.bbox || [0, 0, 0, 0];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
      pages.add(sn.pageNumber);
      text += (text ? " " : "") + sn.text;
    }
    out.set(tagNode.id, { minX, minY, maxX, maxY, pages, text: normalizeMatcherText(text) });
  }
  for (const child of tagNode.children || []) collectTagInfo(child, semById, out);
  return out;
}

// Mirror of NativeTagMatcher.unrotateOpToPortrait. Op coords from
// the parser are in post-rotation display space; semantic bboxes
// stay in the unrotated portrait frame, so the audit applies the
// same inverse rotation as the matcher before the containment
// check — otherwise rotated pages show spurious "bogus" results.
function unrotateOpToPortrait(op, pageMeta) {
  const { rotation, pageWidth, pageHeight } = pageMeta;
  const r = ((rotation % 360) + 360) % 360;
  if (r === 90) return { x: op.y, y: pageHeight - op.x };
  if (r === 180) return { x: pageWidth - op.x, y: pageHeight - op.y };
  if (r === 270) return { x: pageWidth - op.y, y: op.x };
  return { x: op.x, y: op.y };
}

function positionInside(op, tag) {
  return op.x >= tag.minX - POSITION_TOLERANCE && op.x <= tag.maxX + POSITION_TOLERANCE &&
         op.y >= tag.minY - POSITION_TOLERANCE && op.y <= tag.maxY + POSITION_TOLERANCE;
}

async function compileNative() {
  const sources = [
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamParser.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeTagMatcher.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "NativeContentStreamRewriter.java"),
    path.join(repoRoot, "modules", "pdf-writer", "java", "PassthroughMetadataCli.java")
  ];
  await ensureJavaBuildArtifact({
    buildDir,
    isCurrent: async () => false,
    compile: async () => {
      const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
      await execFileP(javac, ["-encoding", "UTF-8", "-cp", pdfboxJar, "-d", buildDir, ...sources], {
        env: await buildJavaExecEnv({ bundledJavaHome })
      });
    }
  });
  await mkdir(buildDir, { recursive: true });
}

/**
 * External-corpus regression test. Exercises seven publicly-sourced PDFs
 * (SCOTUS opinion, arXiv CS paper, IRS W-9 AcroForm + p1040 tax tables,
 * NIST Special Publication, GPO Federal Register notice, UN ECOSOC
 * document) that cover coverage gaps beyond the LRBTest corpus:
 *
 *   - Distinct producers (pdfTeX, Adobe Distiller, GPO XyVision, an older
 *     PDF-1.2 producer)
 *   - Multi-column academic layout (arXiv)
 *   - AcroForm fillable fields (IRS W-9)
 *   - Dense tabular data (IRS p1040)
 *   - Older/multilingual PDF (UN document)
 *
 * Current baseline (measured 2026-04-18 after the pdfTeX spaceless-
 * containment fallback and C0-control-char normalization):
 *   - All seven PDFs match at ≥99% rate
 *   - Zero bogus assignments across the corpus
 *   - IRS p1040 has low uniqueness (~77%) because repeated tax-table
 *     cells produce many ambiguous candidates; the matcher's first-
 *     in-reading-order tiebreak is acceptable for that doc's use case
 */
const EXTERNAL_FLOORS = {
  // Per-doc match rate floor. Most external PDFs hit 100%; arxiv sits at
  // ~99% because the semantic engine dedupes a few running-header
  // repeats, same pattern as the LRBTest "FILED:" headers.
  "arxiv-2501.18462":         { matchRate: 0.98, uniqueRate: 0.95 },
  "gpo-fr-notice":            { matchRate: 0.99, uniqueRate: 0.95 },
  "irs-p1040-tax-tables":     { matchRate: 0.99, uniqueRate: 0.70 }, // repetitive cells → low uniqueness
  "irs-w9":                   { matchRate: 0.99, uniqueRate: 0.95 },
  "nist-sp-1271":             { matchRate: 0.99, uniqueRate: 0.90 },
  "scotus-24-656":            { matchRate: 0.99, uniqueRate: 0.95 },
  "un-ecosoc-multilingual":   { matchRate: 0.99, uniqueRate: 0.95 },
  // CJK coverage — Chinese-language UN General Assembly doc, 100%
  // match rate under current matcher. Uniqueness high because
  // repeated boilerplate is minimal in a short-form resolution.
  "un-ga-chinese":            { matchRate: 0.99, uniqueRate: 0.95 },
  // RTL coverage — Arabic-language UN Security Council doc.
  // Matcher's containsRtl/reverse-containment fallback lifts this
  // from 95% (pre-bidi-fix) to 97%+. Remaining unmatched ops are
  // whitespace-only operators (matcher skips these by design) and
  // a few multi-word Arabic runs whose word order was reflowed by
  // the layout extractor — simple string reversal can't recover
  // those, and their length makes bigram-Jaccard unsafe.
  "un-sc-arabic":             { matchRate: 0.96, uniqueRate: 0.88 },
  // Rotated-page coverage — USGS Open-File Report with 24 landscape
  // pages using /Rotate 90. Pins the matcher's unrotateOpToPortrait
  // transform. Without the rotation fix, rotated pages match at
  // 10-30% (60-70% overall); with fix, the whole document matches
  // at ≥99%. Lower unique-rate floor (0.85) reflects that chemical
  // table cells with repetitive tokens (same ppt units, same
  // regulatory agency names) produce many ambiguous candidates.
  "usgs-of2024-1001":         { matchRate: 0.99, uniqueRate: 0.85 },
  // UN General Assembly English resolution (filename comes from the
  // UN document series ID — actual content is English, not Hebrew).
  // Kept as coverage for the Microsoft Word for Microsoft 365
  // producer on short structured UN resolutions. Hebrew-specific
  // RTL verification is by code-range only — the matcher's
  // `containsRtl` check covers 0x0590-0x05FF (Hebrew) and
  // 0x0600-0x06FF (Arabic) via the same predicate, and un-sc-arabic
  // verifies the reverse-containment path empirically.
  "un-ga-hebrew":             { matchRate: 0.99, uniqueRate: 0.95 },
  // Mac Quartz / PDF 1.3 coverage — Thai Constitution (English
  // translation). Validates an Apple-platform producer rare in
  // standard corpora and an older PDF vintage (1.3). Thai script
  // specifically exercises complex character shaping.
  "thai-constitution-en":     { matchRate: 0.99, uniqueRate: 0.95 }
};

test("external corpus regression: trusted-source PDFs preserve matcher invariants", async (t) => {
  if (!existsSync(externalPdfDir)) {
    t.skip(`external PDF dir missing at ${externalPdfDir}`);
    return;
  }
  if (!existsSync(fixturesRoot)) {
    t.skip(`external fixture dir missing at ${fixturesRoot}`);
    return;
  }

  await compileNative();
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const env = await buildJavaExecEnv({ bundledJavaHome });

  const fixtureDirs = (await readdir(fixturesRoot)).sort();
  assert.ok(fixtureDirs.length >= 12, `expected ≥12 external fixtures, found ${fixtureDirs.length}`);

  let totalOps = 0, totalMatched = 0, totalAssigned = 0, totalBogus = 0, totalUnique = 0;

  for (const fixName of fixtureDirs) {
    await t.test(fixName, async (subt) => {
      const semanticPath = path.join(fixturesRoot, fixName, "semantic-ordered.json");
      const tagsPath = path.join(fixturesRoot, fixName, "tagging.json");
      const pdfPath = path.join(externalPdfDir, `${fixName}.pdf`);
      if (!existsSync(pdfPath) || !existsSync(semanticPath) || !existsSync(tagsPath)) {
        subt.skip(`missing artifacts for ${fixName}`);
        return;
      }

      const opsPath = path.join(buildDir, `external-${fixName}-operators.json`);
      const planPath = path.join(buildDir, `external-${fixName}-plan.json`);

      await execFileP(
        java,
        ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeContentStreamParser",
         "--pdf", pdfPath, "--output", opsPath],
        { env, maxBuffer: 200 * 1024 * 1024 }
      );
      await execFileP(
        java,
        ["-cp", `${buildDir}${path.delimiter}${pdfboxJar}`, "NativeTagMatcher",
         "--operators", opsPath, "--semantic", semanticPath, "--tags", tagsPath,
         "--output", planPath],
        { env, maxBuffer: 200 * 1024 * 1024 }
      );

      const plan = JSON.parse(await readFile(planPath, "utf8"));
      const semantic = JSON.parse(await readFile(semanticPath, "utf8"));
      const tagging = JSON.parse(await readFile(tagsPath, "utf8"));
      const operators = JSON.parse(await readFile(opsPath, "utf8"));
      const pageMetaByNum = new Map();
      for (const pg of operators.pages || []) {
        pageMetaByNum.set(pg.pageNumber, {
          rotation: pg.rotation || 0,
          pageWidth: pg.pageWidth || 612,
          pageHeight: pg.pageHeight || 792
        });
      }

      const overall = plan.overall || {};
      const ops = Number(overall.operatorCount || 0);
      const matched = Number(overall.matchedOperators || 0);
      const rate = Number(overall.matchRate ?? (ops ? matched / ops : 1));

      totalOps += ops;
      totalMatched += matched;

      const semById = new Map();
      for (const n of semantic.nodes || []) semById.set(n.id, n);
      const tagInfoById = collectTagInfo(tagging.root, semById, new Map());

      let assigned = 0, unique = 0, bogus = 0;
      const bogusSamples = [];
      for (const page of plan.pages || []) {
        const pageTags = [];
        for (const [id, info] of tagInfoById.entries()) {
          if (info.pages.has(page.pageNumber)) pageTags.push({ id, ...info });
        }
        const pageMeta = pageMetaByNum.get(page.pageNumber) || { rotation: 0, pageWidth: 612, pageHeight: 792 };
        for (const asgn of page.assignments || []) {
          for (const op of asgn.operators || []) {
            assigned++;
            const opNorm = normalizeMatcherText(op.text);
            const opNoSpace = opNorm.replace(/\s+/g, "");
            const opPortrait = pageMeta.rotation !== 0 ? unrotateOpToPortrait(op, pageMeta) : op;
            const opReversedNoSpace = opNoSpace.length >= 5 && containsRtl(opNoSpace)
              ? Array.from(opNoSpace).reverse().join("")
              : null;
            const finalists = pageTags.filter(t => {
              if (!positionInside(opPortrait, t)) return false;
              if (opNorm.length === 0) return true;
              if (t.text.includes(opNorm) || opNorm.includes(t.text)) return true;
              if (opNoSpace.length >= 5) {
                const tNoSpace = t.text.replace(/\s+/g, "");
                if (tNoSpace.includes(opNoSpace) || opNoSpace.includes(tNoSpace)) return true;
                // Mirror the matcher's RTL reverse-containment fallback.
                // PDFBox emits RTL glyphs in visual (reversed) order
                // while the layout extractor uses Unicode logical order.
                if (opReversedNoSpace && tNoSpace.includes(opReversedNoSpace)) return true;
              }
              return false;
            });
            const hit = finalists.some(f => f.id === asgn.tagNodeId);
            if (!hit) {
              bogus++;
              if (bogusSamples.length < 3) {
                bogusSamples.push({
                  page: page.pageNumber,
                  tag: asgn.tagNodeId,
                  opSeq: op.seq,
                  opText: op.text.slice(0, 60)
                });
              }
            } else if (finalists.length === 1) {
              unique++;
            }
          }
        }
      }

      totalAssigned += assigned;
      totalBogus += bogus;
      totalUnique += unique;

      const floors = EXTERNAL_FLOORS[fixName];
      assert.ok(floors, `${fixName}: no baseline floor registered — add one to EXTERNAL_FLOORS`);

      assert.ok(rate >= floors.matchRate,
        `${fixName}: match rate ${rate.toFixed(3)} below floor ${floors.matchRate} (${matched}/${ops})`);
      assert.equal(bogus, 0,
        `${fixName}: ${bogus} bogus assignments. First: ${JSON.stringify(bogusSamples[0])}`);
      const uniqueRate = assigned > 0 ? unique / assigned : 1;
      assert.ok(uniqueRate >= floors.uniqueRate,
        `${fixName}: unique rate ${uniqueRate.toFixed(3)} below floor ${floors.uniqueRate}`);
    });
  }

  await t.test("external corpus aggregate: no bogus, match rate >=98%", () => {
    assert.equal(totalBogus, 0, `${totalBogus} bogus assignments across external corpus`);
    const rate = totalMatched / totalOps;
    // 0.98 floor (was 0.99 before CJK/RTL fixtures). The Arabic RTL
    // fixture drops aggregate ~1pp because bidi-reshaped glyph runs
    // hit the matcher's 5-char spaceless fallback floor. Per-doc
    // floors still pin 0.93–0.99, which is where the enforcement is.
    assert.ok(rate >= 0.98, `aggregate match rate ${rate.toFixed(4)} below 0.98 floor`);
    assert.ok(totalOps > 40000, `expected >40k text ops across external corpus, got ${totalOps}`);
  });
});
