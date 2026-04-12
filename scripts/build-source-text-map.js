import Ajv2020 from "ajv/dist/2020.js";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import layoutSchema from "../contracts/layout.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateLayout = ajv.compile(layoutSchema);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const buildDir = path.join(scriptDir, ".build");
const javaSourcePath = path.join(scriptDir, "java", "SourceTextRunExtractorCli.java");
const javaClassPath = path.join(buildDir, "SourceTextRunExtractorCli.class");
const pdfboxJarPath = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    pdfPath: args.get("--pdf"),
    layoutPath: args.get("--layout"),
    outputPath: args.get("--output")
  };
}

function execCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function needsCompilation() {
  try {
    const [sourceStats, classStats] = await Promise.all([stat(javaSourcePath), stat(javaClassPath)]);
    return sourceStats.mtimeMs > classStats.mtimeMs;
  } catch {
    return true;
  }
}

async function ensureJavaHelperCompiled() {
  await mkdir(buildDir, { recursive: true });

  if (!(await needsCompilation())) {
    return;
  }

  await execCommand("javac", [
    "-encoding",
    "UTF-8",
    "-cp",
    pdfboxJarPath,
    "-d",
    buildDir,
    javaSourcePath
  ]);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCompactText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function bboxArea([, , width = 0, height = 0]) {
  return Math.max(0, width) * Math.max(0, height);
}

function unionBbox(boxes) {
  if (boxes.length === 0) {
    return [0, 0, 0, 0];
  }

  const left = Math.min(...boxes.map((bbox) => bbox[0]));
  const top = Math.min(...boxes.map((bbox) => bbox[1]));
  const right = Math.max(...boxes.map((bbox) => bbox[0] + bbox[2]));
  const bottom = Math.max(...boxes.map((bbox) => bbox[1] + bbox[3]));
  return [left, top, right - left, bottom - top];
}

function bboxOverlapRatio(left, right) {
  const overlapLeft = Math.max(left[0], right[0]);
  const overlapTop = Math.max(left[1], right[1]);
  const overlapRight = Math.min(left[0] + left[2], right[0] + right[2]);
  const overlapBottom = Math.min(left[1] + left[3], right[1] + right[3]);
  const overlapWidth = Math.max(0, overlapRight - overlapLeft);
  const overlapHeight = Math.max(0, overlapBottom - overlapTop);
  const overlapArea = overlapWidth * overlapHeight;

  if (overlapArea === 0) {
    return 0;
  }

  return overlapArea / Math.max(1, Math.min(bboxArea(left), bboxArea(right)));
}

function centerDistanceScore(left, right) {
  const leftCenterX = left[0] + left[2] / 2;
  const leftCenterY = left[1] + left[3] / 2;
  const rightCenterX = right[0] + right[2] / 2;
  const rightCenterY = right[1] + right[3] / 2;
  const distance = Math.hypot(leftCenterX - rightCenterX, leftCenterY - rightCenterY);
  return 1 / (1 + distance / 24);
}

function textSimilarity(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  const compactLeft = normalizeCompactText(left);
  const compactRight = normalizeCompactText(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  if (compactLeft === compactRight) {
    return 0.97;
  }

  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return 0.93;
  }

  const leftTokens = new Set(normalizedLeft.toLowerCase().split(" "));
  const rightTokens = new Set(normalizedRight.toLowerCase().split(" "));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  return shared / union;
}

function joinRunTexts(runs) {
  const spaced = normalizeText(runs.map((run) => run.text).join(" "));
  const compact = normalizeText(runs.map((run) => run.text).join(""));
  return { spaced, compact };
}

function buildSequenceCandidates(block, runs, maxSequenceLength = 4) {
  const candidates = [];

  for (let start = 0; start < runs.length; start += 1) {
    for (let length = 1; length <= maxSequenceLength && start + length <= runs.length; length += 1) {
      const sequence = runs.slice(start, start + length);
      const union = unionBbox(sequence.map((run) => run.bbox));
      const { spaced, compact } = joinRunTexts(sequence);
      const similarity = Math.max(textSimilarity(block.text, spaced), textSimilarity(block.text, compact));
      const overlap = bboxOverlapRatio(block.bbox, union);
      const geometry = Math.max(overlap, centerDistanceScore(block.bbox, union) * 0.6);
      const score = similarity * 0.7 + geometry * 0.3;

      if (score < 0.55) {
        continue;
      }

      candidates.push({
        score,
        textScore: similarity,
        geometryScore: geometry,
        overlap,
        start,
        length,
        runs: sequence,
        unionBbox: union,
        combinedText: spaced
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.length - right.length || left.start - right.start);
  return candidates;
}

function sortBlocksForMatching(blocks) {
  return [...blocks].sort((left, right) => left.pageNumber - right.pageNumber || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
}

function buildBlockMappings(layoutDocument, sourceRuns) {
  const runsByPage = new Map();
  for (const run of sourceRuns) {
    const pageRuns = runsByPage.get(run.pageNumber) || [];
    pageRuns.push(run);
    runsByPage.set(run.pageNumber, pageRuns);
  }

  const usedRunIds = new Set();
  const blocks = layoutDocument.pages.flatMap((page) =>
    page.textBlocks.map((block) => ({
      pageNumber: page.pageNumber,
      ...block
    }))
  );

  const mappings = [];
  for (const block of sortBlocksForMatching(blocks)) {
    const candidateRuns = (runsByPage.get(block.pageNumber) || []).filter((run) => !usedRunIds.has(run.id));
    const candidates = buildSequenceCandidates(block, candidateRuns);
    const best = candidates[0];

    if (!best || best.score < 0.7) {
      mappings.push({
        blockId: block.id,
        pageNumber: block.pageNumber,
        blockText: block.text,
        bbox: block.bbox,
        status: "unmatched",
        confidence: 0
      });
      continue;
    }

    for (const run of best.runs) {
      usedRunIds.add(run.id);
    }

    mappings.push({
      blockId: block.id,
      pageNumber: block.pageNumber,
      blockText: block.text,
      bbox: block.bbox,
      status: "matched",
      confidence: Number(best.score.toFixed(3)),
      textScore: Number(best.textScore.toFixed(3)),
      geometryScore: Number(best.geometryScore.toFixed(3)),
      overlapRatio: Number(best.overlap.toFixed(3)),
      runCount: best.runs.length,
      matchedRunIds: best.runs.map((run) => run.id),
      matchedRunText: best.combinedText,
      matchedRunBbox: best.unionBbox
    });
  }

  const matchedRuns = sourceRuns.filter((run) => usedRunIds.has(run.id));
  const unmatchedRuns = sourceRuns.filter((run) => !usedRunIds.has(run.id));
  const matchedBlocks = mappings.filter((mapping) => mapping.status === "matched");

  return {
    mappings,
    summary: {
      totalBlocks: mappings.length,
      matchedBlocks: matchedBlocks.length,
      unmatchedBlocks: mappings.length - matchedBlocks.length,
      totalRuns: sourceRuns.length,
      matchedRuns: matchedRuns.length,
      unmatchedRuns: unmatchedRuns.length,
      exactTextMatches: matchedBlocks.filter((mapping) => normalizeText(mapping.blockText) === normalizeText(mapping.matchedRunText)).length,
      multiRunMatches: matchedBlocks.filter((mapping) => mapping.runCount > 1).length,
      averageConfidence:
        matchedBlocks.length === 0
          ? 0
          : Number(
              (
                matchedBlocks.reduce((total, mapping) => total + mapping.confidence, 0) /
                matchedBlocks.length
              ).toFixed(3)
            )
    },
    unmatchedRuns
  };
}

async function extractSourceRuns(pdfPath) {
  await ensureJavaHelperCompiled();
  const stdout = await execCommand("java", [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "SourceTextRunExtractorCli",
    "--pdf",
    path.resolve(pdfPath)
  ]);
  return JSON.parse(stdout);
}

export async function buildSourceTextMap({ pdfPath, layoutPath, outputPath }) {
  if (!pdfPath || !layoutPath) {
    throw new Error("Usage: node scripts/build-source-text-map.js --pdf <input.pdf> --layout <layout.json> [--output <map.json>]");
  }

  const layoutDocument = JSON.parse(await readFile(layoutPath, "utf8"));
  if (!validateLayout(layoutDocument)) {
    throw new Error(`Source text map input failed schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  const extracted = await extractSourceRuns(pdfPath);
  const mapped = buildBlockMappings(layoutDocument, extracted.runs || []);
  const result = {
    status: "completed",
    pdfPath: path.resolve(pdfPath),
    layoutPath: path.resolve(layoutPath),
    pageCount: layoutDocument.pages.length,
    sourceRunCount: extracted.runs?.length || 0,
    sourceRuns: extracted.runs || [],
    blockMappings: mapped.mappings,
    summary: mapped.summary,
    unmatchedRuns: mapped.unmatchedRuns
  };

  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildSourceTextMap(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
