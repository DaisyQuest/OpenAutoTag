import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { inspectPdfLowLevel } from "./inspect-pdf-low-level.js";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    sourcePdf: args.get("--source-pdf"),
    taggedPdf: args.get("--tagged-pdf"),
    outputPath: args.get("--output")
  };
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function aggregateInspection(inspection) {
  const pages = inspection?.pages || [];

  return {
    pageCount: safeNumber(inspection?.pageCount),
    hasStructTreeRoot: Boolean(inspection?.catalog?.hasStructTreeRoot),
    hasMetadata: Boolean(inspection?.catalog?.hasMetadata),
    hasMarkInfo: Boolean(inspection?.catalog?.hasMarkInfo),
    marked: Boolean(inspection?.catalog?.marked),
    totalTypedNodes: safeNumber(inspection?.structureTree?.totalTypedNodes),
    tableAttributeNodeCount: safeNumber(inspection?.structureTree?.tableAttributeNodeCount),
    imageXObjectCount: pages.reduce(
      (total, page) => total + safeNumber(page?.resources?.imageXObjectCount),
      0
    ),
    textOperatorCount: pages.reduce(
      (total, page) => total + safeNumber(page?.operators?.textOperatorCount),
      0
    ),
    markedContentOperatorCount: pages.reduce(
      (total, page) => total + safeNumber(page?.operators?.markedContentOperatorCount),
      0
    ),
    artifactMarkedContentCount: pages.reduce(
      (total, page) => total + safeNumber(page?.operators?.artifactMarkedContentCount),
      0
    ),
    textOperatorPages: pages.filter((page) => page?.operators?.hasTextOperators).length,
    markedContentPages: pages.filter((page) => page?.operators?.hasMarkedContentOperators).length
  };
}

function buildPerPageDelta(sourceInspection, taggedInspection) {
  const sourcePages = sourceInspection?.pages || [];
  const taggedPages = taggedInspection?.pages || [];
  const maxPageCount = Math.max(sourcePages.length, taggedPages.length);
  const results = [];

  for (let index = 0; index < maxPageCount; index += 1) {
    const sourcePage = sourcePages[index] || {};
    const taggedPage = taggedPages[index] || {};
    const sourceMetrics = {
      imageXObjectCount: safeNumber(sourcePage?.resources?.imageXObjectCount),
      textOperatorCount: safeNumber(sourcePage?.operators?.textOperatorCount),
      markedContentOperatorCount: safeNumber(sourcePage?.operators?.markedContentOperatorCount),
      artifactMarkedContentCount: safeNumber(sourcePage?.operators?.artifactMarkedContentCount)
    };
    const taggedMetrics = {
      imageXObjectCount: safeNumber(taggedPage?.resources?.imageXObjectCount),
      textOperatorCount: safeNumber(taggedPage?.operators?.textOperatorCount),
      markedContentOperatorCount: safeNumber(taggedPage?.operators?.markedContentOperatorCount),
      artifactMarkedContentCount: safeNumber(taggedPage?.operators?.artifactMarkedContentCount)
    };

    results.push({
      pageNumber: index + 1,
      source: sourceMetrics,
      tagged: taggedMetrics,
      delta: {
        imageXObjectCount: taggedMetrics.imageXObjectCount - sourceMetrics.imageXObjectCount,
        textOperatorCount: taggedMetrics.textOperatorCount - sourceMetrics.textOperatorCount,
        markedContentOperatorCount:
          taggedMetrics.markedContentOperatorCount - sourceMetrics.markedContentOperatorCount,
        artifactMarkedContentCount:
          taggedMetrics.artifactMarkedContentCount - sourceMetrics.artifactMarkedContentCount
      }
    });
  }

  return results;
}

function buildDelta(sourceSummary, taggedSummary) {
  return {
    structTreeAdded: !sourceSummary.hasStructTreeRoot && taggedSummary.hasStructTreeRoot,
    metadataAdded: !sourceSummary.hasMetadata && taggedSummary.hasMetadata,
    markInfoAdded: !sourceSummary.hasMarkInfo && taggedSummary.hasMarkInfo,
    markedFlagEnabled: !sourceSummary.marked && taggedSummary.marked,
    totalTypedNodesDelta: taggedSummary.totalTypedNodes - sourceSummary.totalTypedNodes,
    tableAttributeNodeCountDelta:
      taggedSummary.tableAttributeNodeCount - sourceSummary.tableAttributeNodeCount,
    imageXObjectCountDelta: taggedSummary.imageXObjectCount - sourceSummary.imageXObjectCount,
    textOperatorCountDelta: taggedSummary.textOperatorCount - sourceSummary.textOperatorCount,
    markedContentOperatorCountDelta:
      taggedSummary.markedContentOperatorCount - sourceSummary.markedContentOperatorCount,
    artifactMarkedContentCountDelta:
      taggedSummary.artifactMarkedContentCount - sourceSummary.artifactMarkedContentCount,
    textOperatorPagesDelta: taggedSummary.textOperatorPages - sourceSummary.textOperatorPages,
    markedContentPagesDelta: taggedSummary.markedContentPages - sourceSummary.markedContentPages
  };
}

export async function buildTagDeltaReport({ sourcePdf, taggedPdf, outputPath } = {}) {
  if (!sourcePdf || !taggedPdf) {
    throw new Error(
      "Usage: node scripts/build-tag-delta-report.js --source-pdf <input.pdf> --tagged-pdf <tagged.pdf> --output <report.json>"
    );
  }

  const [sourceInspection, taggedInspection] = await Promise.all([
    inspectPdfLowLevel({ pdfPath: sourcePdf }),
    inspectPdfLowLevel({ pdfPath: taggedPdf })
  ]);

  const sourceSummary = aggregateInspection(sourceInspection);
  const taggedSummary = aggregateInspection(taggedInspection);
  const report = {
    status: "completed",
    sourcePdf: path.resolve(sourcePdf),
    taggedPdf: path.resolve(taggedPdf),
    source: sourceSummary,
    tagged: taggedSummary,
    delta: buildDelta(sourceSummary, taggedSummary),
    perPage: buildPerPageDelta(sourceInspection, taggedInspection)
  };

  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildTagDeltaReport(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
