import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSamplePdf } from "../fixtures/create-sample-pdf.js";
import { createSpanishSamplePdf } from "../fixtures/create-spanish-sample-pdf.js";
import { createScannedSamplePdf } from "../fixtures/create-scanned-sample-pdf.js";
import { createRuledTableSamplePdf } from "../fixtures/create-ruled-table-sample-pdf.js";
import { createTableSamplePdf } from "../fixtures/create-table-sample-pdf.js";
import { createHellishPdf } from "../fixtures/create-hellish-pdf.js";
import { createAcademicHellPdf } from "../fixtures/create-academic-hell-pdf.js";
import { runPipeline } from "../../orchestrator/pipeline-runner.js";
import { parsePdf } from "../../modules/parser/index.js";

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function roundBbox(bbox) {
  return (bbox || []).map((value) => round(value));
}

function normalizeOcrCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  return {
    candidateName: candidate.candidateName,
    profileName: candidate.profileName,
    variantName: candidate.variantName,
    averageConfidence: round(candidate.averageConfidence),
    score: round(candidate.score),
    consensusScore: round(candidate.consensusScore),
    finalScore: round(candidate.finalScore)
  };
}

function normalizeOcrPage(ocr) {
  if (!ocr) {
    return null;
  }

  return {
    status: ocr.status,
    mergeStrategy: ocr.mergeStrategy || "",
    trigger: ocr.trigger
      ? {
          blockCount: ocr.trigger.blockCount,
          characterCount: ocr.trigger.characterCount,
          coverageRatio: round(ocr.trigger.coverageRatio)
        }
      : null,
    selectedCandidate: normalizeOcrCandidate(ocr.selectedCandidate),
    errorMessages: (ocr.errors || []).map((error) => error.message)
  };
}

function normalizeLayout(layout) {
  return {
    source: {
      pageCount: layout.source.pageCount,
      language: layout.source.language || "und",
      languageConfidence: round(layout.source.languageConfidence),
      ocr: layout.source.ocr
        ? {
            mode: layout.source.ocr.mode,
            status: layout.source.ocr.status,
            languages: [...(layout.source.ocr.languages || [])],
            languageStrategy: layout.source.ocr.languageStrategy || "",
            languageHint: layout.source.ocr.languageHint || "und",
            attemptedPages: layout.source.ocr.attemptedPages,
            appliedPages: layout.source.ocr.appliedPages,
            failedPages: layout.source.ocr.failedPages,
            partialPages: layout.source.ocr.partialPages || 0,
            skippedPages: layout.source.ocr.skippedPages
          }
        : null
    },
    pages: layout.pages.map((page) => ({
      pageNumber: page.pageNumber,
      language: page.language || "und",
      languageConfidence: round(page.languageConfidence),
      textBlocks: page.textBlocks.map((block) => ({
        text: block.text,
        bbox: roundBbox(block.bbox),
        fontSize: round(block.fontSize),
        fontName: block.fontName || "",
        blockType: block.blockType || "",
        columnHint: block.columnHint ?? null,
        textSource: block.textSource || "native"
      })),
      ocr: normalizeOcrPage(page.ocr)
    }))
  };
}

function normalizeLayoutEnriched(layout) {
  return {
    pages: layout.pages.map((page) => ({
      pageNumber: page.pageNumber,
      columns: page.columns ?? null,
      structureSignals: {
        tableCount: page.structureSignals?.tableCount ?? 0,
        vectorTableCount: page.structureSignals?.vectorTableCount ?? 0,
        textGridTableCount: page.structureSignals?.textGridTableCount ?? 0,
        tableMergeSignalCount: page.structureSignals?.tableMergeSignalCount ?? 0
      },
      textBlocks: page.textBlocks.map((block) => ({
        text: block.text,
        blockType: block.blockType || "",
        headingLevel: block.headingLevel ?? null,
        columnHint: block.columnHint ?? null,
        listId: block.listId || "",
        tableId: block.tableId || "",
        tableRole: block.tableRole || "",
        tableSection: block.tableSection || "",
        tableSource: block.tableSource || "",
        tableRow: block.tableRowIndex ?? block.tableRow ?? null,
        tableColumn: block.tableColumnIndex ?? block.tableColumn ?? null,
        tableRowSpan: block.tableRowSpan ?? null,
        tableColumnSpan: block.tableColumnSpan ?? null
      }))
    }))
  };
}

function normalizeSemantic(document) {
  return {
    source: {
      language: document.source?.language || "und",
      languageConfidence: round(document.source?.languageConfidence)
    },
    nodes: document.nodes.map((node) => ({
      id: node.id,
      role: node.role,
      text: node.text,
      pageNumber: node.pageNumber,
      bbox: roundBbox(node.bbox),
      readingOrder: node.readingOrder ?? null,
      columnHint: node.columnHint ?? null,
      listId: node.listId || "",
      tableId: node.tableId || "",
      tableRole: node.tableRole || "",
      tableSection: node.tableSection || "",
      tableSource: node.tableSource || "",
      tableRow: node.tableRowIndex ?? node.tableRow ?? null,
      tableColumn: node.tableColumnIndex ?? node.tableColumn ?? null,
      tableRowSpan: node.tableRowSpan ?? null,
      tableColumnSpan: node.tableColumnSpan ?? null
    }))
  };
}

function normalizeTagNode(node) {
  return {
    type: node.type,
    label: node.label || "",
    sourceNodeIds: [...(node.sourceNodeIds || [])],
    rowSpan: node.rowSpan ?? null,
    columnSpan: node.columnSpan ?? null,
    tableSection: node.tableSection || "",
    tableSource: node.tableSource || "",
    children: (node.children || []).map((child) => normalizeTagNode(child))
  };
}

function normalizeSourceTextMap(report) {
  return {
    summary: {
      totalRuns: report.summary.totalRuns,
      matchedBlocks: report.summary.matchedBlocks,
      unmatchedBlocks: report.summary.unmatchedBlocks,
      averageConfidence: round(report.summary.averageConfidence)
    },
    matches: (report.blockMappings || []).map((match) => ({
      blockId: match.blockId,
      blockText: match.blockText,
      runIds: match.matchedRunIds || [],
      confidence: round(match.confidence)
    }))
  };
}

function normalizeValidation(report) {
  return {
    status: report.status,
    isCompliant: report.isCompliant,
    profileName: report.profileName,
    engine: report.engine,
    findingCodes: [...report.findings.map((finding) => finding.code)].sort(),
    metadataDiagnostics: report.metadataDiagnostics
      ? {
          infoMatchesXmp: Boolean(report.metadataDiagnostics.infoMatchesXmp),
          dcTitleDetected: Boolean(report.metadataDiagnostics.dcTitleDetected),
          pdfUaIdentificationDetected: Boolean(report.metadataDiagnostics.pdfUaIdentificationDetected),
          suspectedVeraPdfMetadataMismatch: Boolean(report.metadataDiagnostics.suspectedVeraPdfMetadataMismatch)
        }
      : null
  };
}

function normalizeTagDelta(report) {
  return {
    status: report.status,
    source: {
      hasStructTreeRoot: Boolean(report.source?.hasStructTreeRoot),
      totalTypedNodes: report.source?.totalTypedNodes ?? 0,
      markedContentOperatorCount: report.source?.markedContentOperatorCount ?? 0,
      artifactMarkedContentCount: report.source?.artifactMarkedContentCount ?? 0,
      tableAttributeNodeCount: report.source?.tableAttributeNodeCount ?? 0
    },
    tagged: {
      hasStructTreeRoot: Boolean(report.tagged?.hasStructTreeRoot),
      totalTypedNodes: report.tagged?.totalTypedNodes ?? 0,
      markedContentOperatorCount: report.tagged?.markedContentOperatorCount ?? 0,
      artifactMarkedContentCount: report.tagged?.artifactMarkedContentCount ?? 0,
      tableAttributeNodeCount: report.tagged?.tableAttributeNodeCount ?? 0
    },
    delta: {
      structTreeAdded: Boolean(report.delta?.structTreeAdded),
      metadataAdded: Boolean(report.delta?.metadataAdded),
      markInfoAdded: Boolean(report.delta?.markInfoAdded),
      markedFlagEnabled: Boolean(report.delta?.markedFlagEnabled),
      totalTypedNodesDelta: report.delta?.totalTypedNodesDelta ?? 0,
      markedContentOperatorCountDelta: report.delta?.markedContentOperatorCountDelta ?? 0,
      artifactMarkedContentCountDelta: report.delta?.artifactMarkedContentCountDelta ?? 0,
      tableAttributeNodeCountDelta: report.delta?.tableAttributeNodeCountDelta ?? 0,
      imageXObjectCountDelta: report.delta?.imageXObjectCountDelta ?? 0
    }
  };
}

function normalizeWriterReport(report) {
  return {
    status: report.status,
    nativeTaggingApplied: Boolean(report.nativeTaggingApplied),
    structureElementCount: report.structureElementCount ?? 0,
    markedContentCount: report.markedContentCount ?? 0,
    tableAttributeCount: report.tableAttributeCount ?? 0,
    metadataApplied: Boolean(report.metadataApplied),
    language: report.language || "en-US",
    title: report.title || ""
  };
}

function normalizeTableStructureMap(report) {
  return {
    summary: report.summary,
    pages: (report.pages || []).map((page) => ({
      pageNumber: page.pageNumber,
      vectorSummary: page.vectorSummary,
      tables: (page.tables || []).map((table) => ({
        id: table.id,
        bbox: roundBbox(table.bbox),
        rowCount: table.rowCount,
        columnCount: table.columnCount,
        confidence: round(table.confidence),
        mergeSignals: (table.mergeSignals || []).map((signal) => ({
          kind: signal.kind,
          rowIndex: signal.rowIndex,
          columnIndex: signal.columnIndex
        })),
        cells: (table.cells || []).map((cell) => ({
          rowIndex: cell.rowIndex,
          columnIndex: cell.columnIndex,
          rowSpan: cell.rowSpan,
          columnSpan: cell.columnSpan,
          bbox: roundBbox(cell.bbox),
          assignedBlockIds: [...(cell.assignedBlockIds || [])]
        })),
        assignedBlockIds: [...(table.assignedBlockIds || [])]
      }))
    }))
  };
}

function normalizeJob(job) {
  return {
    status: job.status,
    stageSummary: job.stageSummary,
    stages: job.stages.map((stage) => ({
      key: stage.key,
      status: stage.status,
      attempts: stage.attempts.length,
      fallbackUsed: Boolean(stage.fallbackUsed),
      diagnosticUnavailable: Boolean(stage.diagnosticUnavailable)
    }))
  };
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function buildPipelineGoldmaster({ pdfPath, outputDir, jobId }) {
  const job = await runPipeline({
    filePath: pdfPath,
    outputDir,
    jobId
  });

  const [layout, layoutEnriched, semanticOrdered, tagging, sourceTextMap, tableStructureMap, validationReport, tagDeltaReport, writerReport] = await Promise.all([
    loadJson(job.artifacts.layout),
    loadJson(job.artifacts.layoutEnriched),
    loadJson(job.artifacts.semanticOrdered),
    loadJson(job.artifacts.tagging),
    loadJson(job.artifacts.sourceTextMap),
    loadJson(job.artifacts.tableStructureMap),
    loadJson(job.artifacts.validationReport),
    loadJson(job.artifacts.tagDeltaReport),
    loadJson(job.artifacts.writerReport)
  ]);

  return {
    job: normalizeJob(job),
    layout: normalizeLayout(layout),
    layoutEnriched: normalizeLayoutEnriched(layoutEnriched),
    semanticOrdered: normalizeSemantic(semanticOrdered),
    tagging: normalizeTagNode(tagging.root),
    sourceTextMap: normalizeSourceTextMap(sourceTextMap),
    tableStructureMap: normalizeTableStructureMap(tableStructureMap),
    writer: normalizeWriterReport(writerReport),
    tagDelta: normalizeTagDelta(tagDeltaReport),
    validation: normalizeValidation(validationReport)
  };
}

export async function buildNativeSampleGoldmaster() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "goldmaster-native-"));
  const pdfPath = path.join(tempDir, "sample.pdf");
  const outputDir = path.join(tempDir, "output");

  try {
    await createSamplePdf(pdfPath);
    return await buildPipelineGoldmaster({
      pdfPath,
      outputDir,
      jobId: "goldmaster-native"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildSpanishSampleGoldmaster() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "goldmaster-spanish-"));
  const pdfPath = path.join(tempDir, "spanish-sample.pdf");
  const outputDir = path.join(tempDir, "output");

  try {
    await createSpanishSamplePdf(pdfPath);
    return await buildPipelineGoldmaster({
      pdfPath,
      outputDir,
      jobId: "goldmaster-spanish"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildScannedSampleOcrGoldmaster() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "goldmaster-scanned-"));
  const pdfPath = path.join(tempDir, "scanned.pdf");

  try {
    await createScannedSamplePdf(pdfPath);
    const layout = await parsePdf(pdfPath, {
      ocr: {
        mode: "required"
      }
    });

    return normalizeLayout(layout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildTableSampleGoldmaster() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "goldmaster-table-"));
  const pdfPath = path.join(tempDir, "table-sample.pdf");
  const outputDir = path.join(tempDir, "output");

  try {
    await createTableSamplePdf(pdfPath);
    return await buildPipelineGoldmaster({
      pdfPath,
      outputDir,
      jobId: "goldmaster-table"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildRuledTableSampleGoldmaster() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "goldmaster-ruled-table-"));
  const pdfPath = path.join(tempDir, "ruled-table-sample.pdf");
  const outputDir = path.join(tempDir, "output");

  try {
    await createRuledTableSamplePdf(pdfPath);
    return await buildPipelineGoldmaster({
      pdfPath,
      outputDir,
      jobId: "goldmaster-ruled-table"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildHellishSampleGoldmaster() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "goldmaster-hellish-"));
  const pdfPath = path.join(tempDir, "hellish-sample.pdf");
  const outputDir = path.join(tempDir, "output");

  try {
    await createHellishPdf(pdfPath);
    return await buildPipelineGoldmaster({
      pdfPath,
      outputDir,
      jobId: "goldmaster-hellish"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildAcademicHellSampleGoldmaster() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "goldmaster-academic-hell-"));
  const pdfPath = path.join(tempDir, "academic-hell-sample.pdf");
  const outputDir = path.join(tempDir, "output");

  try {
    await createAcademicHellPdf(pdfPath);
    return await buildPipelineGoldmaster({
      pdfPath,
      outputDir,
      jobId: "goldmaster-academic-hell"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
