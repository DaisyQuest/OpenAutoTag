import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectPdfLowLevel } from "./inspect-pdf-low-level.js";
import { runPipeline } from "../orchestrator/pipeline-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    inputDir: args.get("--input-dir"),
    outputDir: args.get("--output-dir"),
    limit: args.get("--limit") ? Number(args.get("--limit")) : undefined
  };
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function slugify(value) {
  return String(value || "file")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return entities[character];
  });
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(safeNumber(value));
}

function formatDecimal(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(safeNumber(value));
}

function formatPercent(part, total) {
  if (!total) {
    return "0%";
  }

  return `${formatDecimal((part / total) * 100)}%`;
}

function fileUrl(targetPath) {
  return pathToFileURL(targetPath).href;
}

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(targetPath) {
  if (!(await exists(targetPath))) {
    return null;
  }

  return JSON.parse(await readFile(targetPath, "utf8"));
}

async function listPdfFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const discovered = [];

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...(await listPdfFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && /\.pdf$/i.test(entry.name)) {
      discovered.push(entryPath);
    }
  }

  discovered.sort((left, right) => left.localeCompare(right));
  return discovered;
}

export async function resolveLrbTestsDirectory(inputDir) {
  const candidates = [];

  if (inputDir) {
    candidates.push(path.resolve(inputDir));
  }

  if (process.env.LRB_TEST_DIR) {
    candidates.push(path.resolve(process.env.LRB_TEST_DIR));
  }

  candidates.push(path.resolve("C:/LRBTests"));
  candidates.push(path.resolve("C:/LRBTest"));
  candidates.push(path.resolve("/LRBTests"));
  candidates.push(path.join(repoRoot, "LRBTests"));

  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `LRBTests directory was not found. Checked: ${uniqueCandidates.join(", ")}`
  );
}

function summarizeInspection(inspection) {
  const pages = inspection?.pages || [];

  return {
    pageCount: inspection?.pageCount || 0,
    originalHasStructTree: Boolean(inspection?.catalog?.hasStructTreeRoot),
    originalHasMetadata: Boolean(inspection?.catalog?.hasMetadata),
    originalHasMarkedFlag: Boolean(inspection?.catalog?.marked),
    originalImageObjects: pages.reduce(
      (total, page) => total + safeNumber(page?.resources?.imageXObjectCount),
      0
    ),
    originalTextOperatorPages: pages.filter((page) => page?.operators?.hasTextOperators).length,
    originalMarkedContentPages: pages.filter((page) => page?.operators?.hasMarkedContentOperators).length
  };
}

function summarizeLayout(layout) {
  const pages = layout?.pages || [];
  const ocrSummary = layout?.source?.ocr || {};

  return {
    parserTextBlocks: pages.reduce((total, page) => total + (page?.textBlocks?.length || 0), 0),
    parserEmptyPages: pages.filter((page) => (page?.textBlocks?.length || 0) === 0).length,
    detectedLanguage: layout?.source?.language || "unknown",
    ocrAttemptedPages: safeNumber(ocrSummary.attemptedPages),
    ocrAppliedPages: safeNumber(ocrSummary.appliedPages),
    ocrFailedPages: safeNumber(ocrSummary.failedPages),
    ocrStatus: ocrSummary.status || "unknown"
  };
}

function summarizeWriter(writerReport) {
  return {
    nativeTaggingApplied: Boolean(writerReport?.nativeTaggingApplied),
    metadataApplied: Boolean(writerReport?.metadataApplied),
    writerTagNodes: safeNumber(writerReport?.tagNodeCount),
    writerStructureElements: safeNumber(writerReport?.structureElementCount),
    writerMarkedContent: safeNumber(writerReport?.markedContentCount),
    writerTableAttributes: safeNumber(writerReport?.tableAttributeCount)
  };
}

function summarizeValidation(validationReport) {
  const findings = validationReport?.findings || [];

  return {
    isCompliant: Boolean(validationReport?.isCompliant),
    failedRules: safeNumber(validationReport?.summary?.failedRules),
    failedChecks: safeNumber(validationReport?.summary?.failedChecks),
    metadataMismatchSuspected: Boolean(
      validationReport?.metadataDiagnostics?.suspectedVeraPdfMetadataMismatch
    ),
    findingCodes: findings.map((finding) => finding.code).filter(Boolean),
    topFindings: findings.slice(0, 3).map((finding) => ({
      code: finding.code || "UNKNOWN",
      severity: finding.severity || "error",
      description: finding.description || finding.message || "Validator finding"
    }))
  };
}

function summarizeTagDelta(tagDeltaReport) {
  return {
    structTreeAdded: Boolean(tagDeltaReport?.delta?.structTreeAdded),
    typedNodeDelta: safeNumber(tagDeltaReport?.delta?.totalTypedNodesDelta),
    markedContentDelta: safeNumber(tagDeltaReport?.delta?.markedContentOperatorCountDelta),
    artifactMarkedContentDelta: safeNumber(tagDeltaReport?.delta?.artifactMarkedContentCountDelta),
    tableAttributeDelta: safeNumber(tagDeltaReport?.delta?.tableAttributeNodeCountDelta),
    imageXObjectDelta: safeNumber(tagDeltaReport?.delta?.imageXObjectCountDelta)
  };
}

function buildFileSummary({
  repoRelativeInput,
  pdfPath,
  job,
  layout,
  writerReport,
  validationReport,
  inspection,
  tagDeltaReport
}) {
  const inspectionSummary = summarizeInspection(inspection);
  const layoutSummary = summarizeLayout(layout);
  const writerSummary = summarizeWriter(writerReport);
  const validationSummary = summarizeValidation(validationReport);
  const tagDeltaSummary = summarizeTagDelta(tagDeltaReport);

  return {
    fileName: path.basename(pdfPath),
    relativePath: repoRelativeInput,
    pdfPath,
    outputDir: job?.input?.outputDir || "",
    status: job?.status || "failed",
    failureStage: job?.failureStage?.key || "",
    error: job?.error || "",
    pipelineDurationMs: (job?.stages || []).reduce(
      (total, stage) => total + safeNumber(stage?.durationMs),
      0
    ),
    ...inspectionSummary,
    ...layoutSummary,
    ...writerSummary,
    ...validationSummary,
    ...tagDeltaSummary
  };
}

function incrementCounter(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function topCounts(map, limit = 10) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function aggregateFileSummaries(files) {
  const findingCodeCounts = new Map();
  const failureStageCounts = new Map();

  for (const file of files) {
    for (const code of file.findingCodes || []) {
      incrementCounter(findingCodeCounts, code);
    }

    if (file.failureStage) {
      incrementCounter(failureStageCounts, file.failureStage);
    }
  }

  const completedFiles = files.filter((file) => file.status === "completed");

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      totalFiles: files.length,
      completedFiles: completedFiles.length,
      failedFiles: files.length - completedFiles.length,
      compliantOutputs: completedFiles.filter((file) => file.isCompliant).length,
      nativeTaggedOutputs: completedFiles.filter((file) => file.nativeTaggingApplied).length,
      totalPages: files.reduce((total, file) => total + safeNumber(file.pageCount), 0),
      totalTextBlocks: files.reduce((total, file) => total + safeNumber(file.parserTextBlocks), 0),
      totalFailedRules: files.reduce((total, file) => total + safeNumber(file.failedRules), 0),
      totalFailedChecks: files.reduce((total, file) => total + safeNumber(file.failedChecks), 0),
      totalTypedNodeDelta: files.reduce((total, file) => total + safeNumber(file.typedNodeDelta), 0),
      totalMarkedContentDelta: files.reduce((total, file) => total + safeNumber(file.markedContentDelta), 0),
      totalTableAttributeDelta: files.reduce((total, file) => total + safeNumber(file.tableAttributeDelta), 0),
      filesWithImages: files.filter((file) => safeNumber(file.originalImageObjects) > 0).length,
      filesWithOriginalStructTree: files.filter((file) => file.originalHasStructTree).length,
      filesWithOcrApplied: files.filter((file) => safeNumber(file.ocrAppliedPages) > 0).length,
      metadataMismatchSuspects: files.filter((file) => file.metadataMismatchSuspected).length,
      filesWithTagGrowth: files.filter((file) => safeNumber(file.typedNodeDelta) > 0).length,
      filesWithStructTreeAdded: files.filter((file) => file.structTreeAdded).length
    },
    topFindingCodes: topCounts(findingCodeCounts, 12),
    failureStages: topCounts(failureStageCounts, 8)
  };
}

function buildKpiCards(summary) {
  const { kpis } = summary;
  return [
    {
      label: "Files processed",
      value: formatInteger(kpis.totalFiles),
      detail: `${formatInteger(kpis.completedFiles)} completed / ${formatInteger(kpis.failedFiles)} failed`
    },
    {
      label: "Compliant outputs",
      value: formatInteger(kpis.compliantOutputs),
      detail: formatPercent(kpis.compliantOutputs, Math.max(kpis.completedFiles, 1))
    },
    {
      label: "Native tagged PDFs",
      value: formatInteger(kpis.nativeTaggedOutputs),
      detail: formatPercent(kpis.nativeTaggedOutputs, Math.max(kpis.completedFiles, 1))
    },
    {
      label: "Pages analyzed",
      value: formatInteger(kpis.totalPages),
      detail: `${formatDecimal(kpis.totalPages / Math.max(kpis.totalFiles, 1))} avg per file`
    },
    {
      label: "Text blocks",
      value: formatInteger(kpis.totalTextBlocks),
      detail: `${formatDecimal(kpis.totalTextBlocks / Math.max(kpis.totalFiles, 1))} avg per file`
    },
    {
      label: "Validator rule failures",
      value: formatInteger(kpis.totalFailedRules),
      detail: `${formatInteger(kpis.totalFailedChecks)} failed checks`
    },
    {
      label: "Typed node delta",
      value: formatInteger(kpis.totalTypedNodeDelta),
      detail: `${formatInteger(kpis.filesWithTagGrowth)} files gained structure`
    },
    {
      label: "Marked content delta",
      value: formatInteger(kpis.totalMarkedContentDelta),
      detail: `${formatInteger(kpis.totalTableAttributeDelta)} table attribute delta`
    },
    {
      label: "Image-heavy originals",
      value: formatInteger(kpis.filesWithImages),
      detail: `${formatPercent(kpis.filesWithImages, Math.max(kpis.totalFiles, 1))} of corpus`
    },
    {
      label: "Struct trees added",
      value: formatInteger(kpis.filesWithStructTreeAdded),
      detail: `${formatPercent(kpis.filesWithStructTreeAdded, Math.max(kpis.totalFiles, 1))} of corpus`
    },
    {
      label: "Metadata mismatch suspects",
      value: formatInteger(kpis.metadataMismatchSuspects),
      detail: `${formatPercent(kpis.metadataMismatchSuspects, Math.max(kpis.totalFiles, 1))} of corpus`
    }
  ];
}

function renderTopCounts(items, emptyLabel) {
  if (!items.length) {
    return `<p class="empty-state">${escapeHtml(emptyLabel)}</p>`;
  }

  const maxCount = items[0].count || 1;

  return `
    <div class="bars">
      ${items
        .map(
          (item) => `
            <article class="bar-row">
              <div class="bar-copy">
                <strong>${escapeHtml(item.name)}</strong>
                <span>${formatInteger(item.count)}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" style="width:${Math.max(8, (item.count / maxCount) * 100)}%"></div>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderFindingBadges(findings) {
  if (!findings?.length) {
    return `<span class="badge neutral">No validator findings captured</span>`;
  }

  return findings
    .map(
      (finding) =>
        `<span class="badge ${escapeHtml(finding.severity || "neutral")}">${escapeHtml(finding.code)}</span>`
    )
    .join("");
}

function renderDetailCards(files) {
  if (!files.length) {
    return `<p class="empty-state">No files were processed.</p>`;
  }

  return files
    .map((file) => {
      const statusClass = file.status === "completed" ? "success" : "danger";
      const complianceLabel =
        file.status !== "completed"
          ? "Pipeline failed"
          : file.isCompliant
            ? "Compliant"
            : "Needs remediation";

      const links = [];
      if (file.pdfPath) {
        links.push(
          `<a href="${escapeHtml(fileUrl(file.pdfPath))}" target="_blank" rel="noreferrer">Source PDF</a>`
        );
      }

      if (file.outputDir) {
        const taggedPdf = path.join(file.outputDir, "06-tagged.pdf");
        const validationReport = path.join(file.outputDir, "07-validation-report.json");
        const tagDeltaReport = path.join(file.outputDir, "06b-tag-delta-report.json");
        if (file.nativeTaggingApplied) {
          links.push(
            `<a href="${escapeHtml(fileUrl(taggedPdf))}" target="_blank" rel="noreferrer">Tagged PDF</a>`
          );
        }
        if (file.status === "completed") {
          links.push(
            `<a href="${escapeHtml(fileUrl(validationReport))}" target="_blank" rel="noreferrer">Validation JSON</a>`
          );
          links.push(
            `<a href="${escapeHtml(fileUrl(tagDeltaReport))}" target="_blank" rel="noreferrer">Tag delta JSON</a>`
          );
        }
      }

      return `
        <article class="detail-card">
          <div class="detail-topline">
            <div>
              <p class="eyebrow">${escapeHtml(file.relativePath)}</p>
              <h3>${escapeHtml(file.fileName)}</h3>
            </div>
            <div class="status-cluster">
              <span class="pill ${statusClass}">${escapeHtml(file.status)}</span>
              <span class="pill ${file.isCompliant ? "success" : "warning"}">${escapeHtml(
                complianceLabel
              )}</span>
            </div>
          </div>
          <div class="metric-grid">
            <div><span>Pages</span><strong>${formatInteger(file.pageCount)}</strong></div>
            <div><span>Text blocks</span><strong>${formatInteger(file.parserTextBlocks)}</strong></div>
            <div><span>Images</span><strong>${formatInteger(file.originalImageObjects)}</strong></div>
            <div><span>Failed rules</span><strong>${formatInteger(file.failedRules)}</strong></div>
            <div><span>Failed checks</span><strong>${formatInteger(file.failedChecks)}</strong></div>
            <div><span>OCR applied pages</span><strong>${formatInteger(file.ocrAppliedPages)}</strong></div>
            <div><span>Typed node delta</span><strong>${formatInteger(file.typedNodeDelta)}</strong></div>
            <div><span>Marked content delta</span><strong>${formatInteger(file.markedContentDelta)}</strong></div>
            <div><span>Table attr delta</span><strong>${formatInteger(file.tableAttributeDelta)}</strong></div>
          </div>
          <div class="badge-row">
            ${renderFindingBadges(file.topFindings)}
          </div>
          ${
            file.error
              ? `<p class="error-copy">${escapeHtml(file.error)}</p>`
              : ""
          }
          <div class="link-row">${links.join("")}</div>
        </article>
      `;
    })
    .join("");
}

function renderFileTable(files) {
  if (!files.length) {
    return `<p class="empty-state">No files were processed.</p>`;
  }

  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Status</th>
            <th>Pages</th>
            <th>Blocks</th>
            <th>Native tags</th>
            <th>Compliant</th>
            <th>Failed rules</th>
            <th>Failed checks</th>
            <th>Typed delta</th>
            <th>Marked delta</th>
            <th>Language</th>
            <th>OCR pages</th>
          </tr>
        </thead>
        <tbody>
          ${files
            .map(
              (file) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(file.fileName)}</strong>
                    <span class="subtle">${escapeHtml(file.relativePath)}</span>
                  </td>
                  <td>${escapeHtml(file.status)}</td>
                  <td>${formatInteger(file.pageCount)}</td>
                  <td>${formatInteger(file.parserTextBlocks)}</td>
                  <td>${file.nativeTaggingApplied ? "Yes" : "No"}</td>
                  <td>${file.status === "completed" ? (file.isCompliant ? "Yes" : "No") : "n/a"}</td>
                  <td>${formatInteger(file.failedRules)}</td>
                  <td>${formatInteger(file.failedChecks)}</td>
                  <td>${formatInteger(file.typedNodeDelta)}</td>
                  <td>${formatInteger(file.markedContentDelta)}</td>
                  <td>${escapeHtml(file.detectedLanguage || "unknown")}</td>
                  <td>${formatInteger(file.ocrAppliedPages)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderHtml({ inputDir, summary, files }) {
  const kpiCards = buildKpiCards(summary);
  const sortedFiles = [...files].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "failed" ? -1 : 1;
    }

    if (left.isCompliant !== right.isCompliant) {
      return left.isCompliant ? 1 : -1;
    }

    return right.failedRules - left.failedRules || left.fileName.localeCompare(right.fileName);
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LRB PDF Intake Report</title>
    <style>
      :root {
        --bg: #f4efe6;
        --ink: #172033;
        --muted: #51607b;
        --card: rgba(255, 252, 247, 0.88);
        --line: rgba(23, 32, 51, 0.1);
        --accent: #c46a2d;
        --accent-soft: #f2c29e;
        --navy: #1c2f4d;
        --success: #247254;
        --warning: #bf6a20;
        --danger: #a43c2c;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        color: var(--ink);
        font-family: Georgia, "Times New Roman", serif;
        background:
          radial-gradient(circle at top left, rgba(196, 106, 45, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(28, 47, 77, 0.16), transparent 24%),
          linear-gradient(180deg, #f7f1e8 0%, var(--bg) 100%);
      }

      .page {
        max-width: 1380px;
        margin: 0 auto;
        padding: 32px 24px 56px;
      }

      .hero {
        position: relative;
        overflow: hidden;
        border-radius: 28px;
        padding: 32px;
        color: #fff8ee;
        background:
          linear-gradient(135deg, rgba(10, 24, 48, 0.96) 0%, rgba(28, 47, 77, 0.94) 58%, rgba(196, 106, 45, 0.9) 100%);
        box-shadow: 0 22px 48px rgba(19, 29, 46, 0.18);
      }

      .hero::after {
        content: "";
        position: absolute;
        inset: auto -40px -70px auto;
        width: 280px;
        height: 280px;
        border-radius: 50%;
        background: rgba(255, 233, 200, 0.16);
      }

      .eyebrow {
        margin: 0 0 8px;
        color: #ffd3a8;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: 44px;
        line-height: 1;
      }

      .lede {
        max-width: 780px;
        margin: 14px 0 0;
        color: #f4dfc5;
        font-size: 17px;
        line-height: 1.6;
      }

      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 18px;
      }

      .hero-chip {
        border: 1px solid rgba(255, 241, 223, 0.18);
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.08);
        font-size: 13px;
      }

      .section {
        margin-top: 28px;
      }

      .section-header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
      }

      .section-header h2 {
        margin: 0;
        font-size: 28px;
      }

      .section-header p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 15px;
      }

      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 16px;
      }

      .kpi-card,
      .panel,
      .detail-card {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: var(--card);
        box-shadow: 0 16px 36px rgba(23, 32, 51, 0.08);
        backdrop-filter: blur(12px);
      }

      .kpi-card {
        padding: 18px;
      }

      .kpi-card span {
        display: block;
        color: var(--muted);
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .kpi-card strong {
        display: block;
        margin-top: 12px;
        font-size: 34px;
        line-height: 1;
      }

      .kpi-card small {
        display: block;
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.4;
      }

      .two-up {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 18px;
      }

      .panel {
        padding: 20px;
      }

      .panel h3 {
        margin: 0;
        font-size: 20px;
      }

      .panel p {
        color: var(--muted);
      }

      .bars {
        display: grid;
        gap: 14px;
      }

      .bar-row {
        display: grid;
        gap: 8px;
      }

      .bar-copy {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-size: 14px;
      }

      .bar-track {
        height: 10px;
        border-radius: 999px;
        background: rgba(81, 96, 123, 0.12);
        overflow: hidden;
      }

      .bar-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--accent) 0%, var(--accent-soft) 100%);
      }

      .table-shell {
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 22px;
        background: rgba(255, 252, 247, 0.9);
        box-shadow: 0 16px 36px rgba(23, 32, 51, 0.08);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 980px;
      }

      thead {
        background: rgba(28, 47, 77, 0.94);
        color: #fff6e8;
      }

      th,
      td {
        padding: 14px 16px;
        border-bottom: 1px solid rgba(23, 32, 51, 0.08);
        text-align: left;
        vertical-align: top;
        font-size: 14px;
      }

      tbody tr:nth-child(even) {
        background: rgba(23, 32, 51, 0.025);
      }

      .subtle {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 18px;
      }

      .detail-card {
        padding: 20px;
      }

      .detail-topline {
        display: flex;
        justify-content: space-between;
        gap: 16px;
      }

      .detail-topline h3 {
        margin: 0;
        font-size: 21px;
      }

      .status-cluster {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }

      .pill,
      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 700;
      }

      .pill.success,
      .badge.success {
        background: rgba(36, 114, 84, 0.12);
        color: var(--success);
      }

      .pill.warning,
      .badge.warning {
        background: rgba(191, 106, 32, 0.14);
        color: var(--warning);
      }

      .pill.danger,
      .badge.error {
        background: rgba(164, 60, 44, 0.12);
        color: var(--danger);
      }

      .badge.neutral {
        background: rgba(81, 96, 123, 0.12);
        color: var(--muted);
      }

      .metric-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 18px;
      }

      .metric-grid div {
        border: 1px solid rgba(23, 32, 51, 0.08);
        border-radius: 16px;
        padding: 12px;
        background: rgba(255, 255, 255, 0.55);
      }

      .metric-grid span {
        display: block;
        color: var(--muted);
        font-size: 12px;
      }

      .metric-grid strong {
        display: block;
        margin-top: 8px;
        font-size: 18px;
      }

      .badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 16px;
      }

      .link-row {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        margin-top: 16px;
      }

      a {
        color: var(--navy);
        text-decoration: none;
        font-weight: 700;
      }

      a:hover {
        text-decoration: underline;
      }

      .error-copy {
        margin-top: 14px;
        color: var(--danger);
        line-height: 1.5;
      }

      .empty-state {
        color: var(--muted);
        font-style: italic;
      }

      @media (max-width: 760px) {
        .page {
          padding: 18px 14px 36px;
        }

        .hero {
          padding: 24px;
        }

        h1 {
          font-size: 34px;
        }

        .metric-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="hero">
        <p class="eyebrow">LRB Corpus Intake</p>
        <h1>LRB PDF Processing Report</h1>
        <p class="lede">
          High-level KPIs, compliance rollups, and file-by-file execution detail for every PDF discovered in the local LRB intake directory.
        </p>
        <div class="hero-meta">
          <span class="hero-chip">Source: ${escapeHtml(inputDir)}</span>
          <span class="hero-chip">Generated: ${escapeHtml(summary.generatedAt)}</span>
          <span class="hero-chip">Files: ${formatInteger(summary.kpis.totalFiles)}</span>
        </div>
      </header>

      <section class="section">
        <div class="section-header">
          <div>
            <h2>KPI Snapshot</h2>
            <p>Processing throughput, accessibility output quality, and corpus composition in one pass.</p>
          </div>
        </div>
        <div class="kpi-grid">
          ${kpiCards
            .map(
              (card) => `
                <article class="kpi-card">
                  <span>${escapeHtml(card.label)}</span>
                  <strong>${escapeHtml(card.value)}</strong>
                  <small>${escapeHtml(card.detail)}</small>
                </article>
              `
            )
            .join("")}
        </div>
      </section>

      <section class="section two-up">
        <article class="panel">
          <h3>Top Compliance Signals</h3>
          <p>The most common validator findings across the processed corpus.</p>
          ${renderTopCounts(summary.topFindingCodes, "No validator findings were captured.")}
        </article>
        <article class="panel">
          <h3>Pipeline Failure Stages</h3>
          <p>Where unsuccessful files dropped out of the pipeline.</p>
          ${renderTopCounts(summary.failureStages, "No pipeline failures were recorded.")}
        </article>
      </section>

      <section class="section">
        <div class="section-header">
          <div>
            <h2>File-by-File Matrix</h2>
            <p>A sortable-at-a-glance operational view of every processed PDF.</p>
          </div>
        </div>
        ${renderFileTable(sortedFiles)}
      </section>

      <section class="section">
        <div class="section-header">
          <div>
            <h2>File Detail Cards</h2>
            <p>Fast triage cards for failures, weak outputs, and compliance hotspots.</p>
          </div>
        </div>
        <div class="detail-grid">
          ${renderDetailCards(sortedFiles)}
        </div>
      </section>
    </div>
  </body>
</html>`;
}

export async function generateLrbReport({ inputDir, outputDir, limit } = {}) {
  const resolvedInputDir = await resolveLrbTestsDirectory(inputDir);
  const resolvedOutputDir = path.resolve(outputDir || path.join(repoRoot, "output", "lrb-report"));
  await mkdir(resolvedOutputDir, { recursive: true });
  await mkdir(path.join(resolvedOutputDir, "jobs"), { recursive: true });

  const discovered = await listPdfFiles(resolvedInputDir);
  const pdfFiles =
    Number.isFinite(limit) && limit > 0 ? discovered.slice(0, limit) : discovered;

  if (pdfFiles.length === 0) {
    throw new Error(`No PDF files were found in ${resolvedInputDir}.`);
  }

  const files = [];

  for (const [index, pdfPath] of pdfFiles.entries()) {
    const relativePath = path.relative(resolvedInputDir, pdfPath) || path.basename(pdfPath);
    const jobSlug = `${String(index + 1).padStart(3, "0")}-${slugify(relativePath)}`;
    const jobOutputDir = path.join(resolvedOutputDir, "jobs", jobSlug);

    const inspection = await inspectPdfLowLevel({ pdfPath });
    const job = await runPipeline({
      filePath: pdfPath,
      outputDir: jobOutputDir,
      jobId: `lrb-${jobSlug}`
    });

    const layout = await readJsonIfExists(job.artifacts.layout);
    const writerReport = await readJsonIfExists(job.artifacts.writerReport);
    const validationReport = await readJsonIfExists(job.artifacts.validationReport);
    const tagDeltaReport = await readJsonIfExists(job.artifacts.tagDeltaReport);

    files.push(
      buildFileSummary({
        repoRelativeInput: relativePath,
        pdfPath,
        job,
        layout,
        writerReport,
        validationReport,
        inspection,
        tagDeltaReport
      })
    );
  }

  const summary = aggregateFileSummaries(files);
  const report = {
    inputDir: resolvedInputDir,
    outputDir: resolvedOutputDir,
    ...summary,
    files
  };

  const summaryPath = path.join(resolvedOutputDir, "report-summary.json");
  const reportPath = path.join(resolvedOutputDir, "report.html");

  await writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, renderHtml({ inputDir: resolvedInputDir, summary, files }));

  return {
    inputDir: resolvedInputDir,
    outputDir: resolvedOutputDir,
    processedCount: files.length,
    summaryPath,
    reportPath
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await generateLrbReport(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
