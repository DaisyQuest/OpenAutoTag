import {
  fetchJson,
  fetchWithAuth,
  formatBytes,
  formatTimestamp,
  getSessionAccess,
  loadAuthConfig
} from "./auth-client.js";

const CAPABILITIES = [
  ["parser", "Parser", "Glyph extraction, bounds, rotation, language, and source text signals."],
  ["layout", "Layout Analyzer", "Blocks, reading order, headers, lists, sparse tables, and ruled table bands."],
  ["semantic", "Semantic Engine", "Role assignment, paragraph continuity, table cells, and heading structure."],
  ["native", "Native Writer", "Marked-content assignment, MCID coverage, artifact wrapping, and tag tree output."],
  ["validation", "Validator", "PDF/UA checks, tagged-content failures, tab order, contrast, and metadata."],
  ["tables", "Table Mapper", "Grid anchors, row and column spans, header scopes, and data-cell coverage."],
  ["fonts", "Font Health", "Embedding, ToUnicode, glyph coverage, subtype inventory, and repair readiness."],
  ["repair", "Repairer", "Structural repair findings, before and after health, and corruption risk."],
  ["redaction", "Redaction", "Sensitive text detection, visual removal, accessibility text cleanup, and audit output."],
  ["diff", "Diff Engine", "Before and after structure, native quality, reading order, and report deltas."]
];

const SECTIONS = [
  ["overview", "Overview"],
  ["pipeline", "Pipeline"],
  ["tags", "Tags"],
  ["tables", "Tables"],
  ["typography", "Typography"],
  ["compliance", "Compliance"],
  ["share", "Share"]
];

const state = {
  file: null,
  activeSection: "overview",
  report: null,
  pollHandle: null,
  artifactPayloads: {}
};

const els = {
  accessState: document.querySelector("#access-state"),
  analysisForm: document.querySelector("#analysis-form"),
  capabilityStack: document.querySelector("#capability-stack"),
  copyJson: document.querySelector("#copy-json"),
  downloadHtml: document.querySelector("#download-html"),
  fileInput: document.querySelector("#pdf-input"),
  fileMeta: document.querySelector("#file-meta"),
  fileName: document.querySelector("#file-name"),
  printReport: document.querySelector("#print-report"),
  progressFill: document.querySelector("#progress-fill"),
  profileSelect: document.querySelector("#profile-select"),
  reportCanvas: document.querySelector("#report-canvas"),
  reportTabs: document.querySelector("#report-tabs"),
  resetReport: document.querySelector("#reset-report"),
  runAnalysis: document.querySelector("#run-analysis"),
  runMessage: document.querySelector("#run-message"),
  runState: document.querySelector("#run-state"),
  sampleReport: document.querySelector("#sample-report"),
  workloadSelect: document.querySelector("#workload-select")
};

const sampleReport = {
  title: "PDF Introspector reference report",
  sourceName: "bad1.pdf",
  generatedAt: new Date().toISOString(),
  status: "spec-ready",
  score: 0.96,
  summary:
    "A single report surface that rolls parser, layout, table, native tagging, validation, font, repair, redaction, and diff outputs into one reviewer-friendly dossier.",
  metrics: [
    ["Pages", "1"],
    ["Artifacts", "12"],
    ["Table Headers", "6"],
    ["Failed Checks", "0"]
  ],
  capabilities: CAPABILITIES.map(([id, label, detail], index) => ({
    id,
    label,
    detail,
    status: index < 7 ? "ready" : index === 7 ? "available" : "planned",
    note:
      index < 7
        ? "Included in the generated report model."
        : index === 7
          ? "Included when repair artifacts are present."
          : "Included when the selected workload emits this artifact."
  })),
  evidence: [
    ["Executive Summary", "One page scorecard with document identity, queue status, validation posture, and artifact coverage."],
    ["Structure Explorer", "Tags, roles, heading levels, paragraphs, tables, artifacts, and reading-order exceptions in one navigation path."],
    ["Table Workbench", "Header matrix, spans, scopes, body coverage, and ambiguous-header errata when certainty is low."],
    ["Share Package", "Standalone HTML, printable report, JSON payload, and deep links to every emitted artifact."]
  ],
  artifacts: [
    ["taggedPdf", "Tagged PDF", "#", "PDF"],
    ["validationReport", "Validation Report", "#", "JSON"],
    ["tagDeltaReport", "Tag Delta", "#", "JSON"],
    ["writerReport", "Writer Report", "#", "JSON"],
    ["tagManifest", "Tag Manifest", "#", "JSON"],
    ["tableStructureMap", "Table Map", "#", "JSON"]
  ],
  sections: {
    pipeline: [
      ["Parse", "done", "Text runs, glyph bounds, and vertical-writing hints are normalized before layout."],
      ["Analyze", "done", "Sparse header reconstruction and table row compaction feed semantic structure."],
      ["Write", "done", "Native marked content respects rotation boundaries and paint barriers."],
      ["Validate", "done", "The report folds verifier output into a reviewer-first checklist."]
    ],
    tags: [
      ["Heading and paragraph flow", "Paragraph merge boundaries avoid rotated axis text."],
      ["Native assignment", "Operator matching rejects incompatible writing modes inside broad bounding boxes."],
      ["Artifact policy", "Stamps and non-text paint can be isolated from meaningful content."]
    ],
    tables: [
      ["CF", "Column header", "Leaf header inferred from sparse numeric column."],
      ["Min", "Column header", "Leaf header inferred from sparse numeric column."],
      ["fsw", "Column header", "Split from same-row spanning label."],
      ["Air", "Column header", "Split from same-row spanning label."],
      ["EANx 32%", "Column header", "Stacked group and percentage label."],
      ["EANx 36%", "Column header", "Stacked group and percentage label."]
    ],
    typography: [
      ["Rotation", "Vertical axis labels preserved as vertical blocks."],
      ["Fonts", "Embedding and ToUnicode findings appear beside text-structure risk."],
      ["Contrast", "Manual-check items are isolated from deterministic failures."]
    ],
    compliance: [
      ["Tagged content", "Passed in the reference run."],
      ["Tab order", "Passed in the reference run."],
      ["Bookmarks", "Passed in the reference run."],
      ["Errata", "Generated only for ambiguous or intentionally deferred interpretation."]
    ]
  }
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeStatus(value) {
  const text = String(value || "").toLowerCase();
  if (["completed", "done", "ready", "passed"].includes(text)) return "good";
  if (["failed", "error"].includes(text)) return "fail";
  if (["running", "processing", "available", "planned", "spec-ready"].includes(text)) return "warn";
  return "neutral";
}

function statusLabel(value) {
  const text = String(value || "unknown").replace(/[-_]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function artifactLabel(name) {
  return String(name || "artifact")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function artifactKind(name, url = "") {
  const text = `${name} ${url}`.toLowerCase();
  if (text.includes("pdf")) return "PDF";
  if (text.includes("html")) return "HTML";
  if (text.includes("json") || text.includes("report") || text.includes("manifest")) return "JSON";
  return "Artifact";
}

function setRunState(label, message, progress = 0) {
  els.runState.textContent = label;
  els.runMessage.textContent = message;
  els.progressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function clearPolling() {
  if (state.pollHandle) {
    window.clearTimeout(state.pollHandle);
    state.pollHandle = null;
  }
}

function getArtifactLinks(item) {
  return item?.artifacts || item?.artifactLinks || {};
}

function valueAt(object, paths, fallback = null) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = object;
    for (const part of parts) {
      current = current?.[part];
      if (current === undefined || current === null) break;
    }
    if (current !== undefined && current !== null && current !== "") {
      return current;
    }
  }
  return fallback;
}

function estimateScore({ item, payloads }) {
  if (item?.status === "failed") return 0.18;
  const validation = payloads.validationReport || item?.validation || {};
  const failedRules = Number(
    valueAt(validation, ["summary.failedRules", "failedRules", "ruleSummary.failed", "failedChecks"], 0)
  );
  const totalRules = Number(valueAt(validation, ["summary.totalRules", "totalRules", "ruleSummary.total"], 0));
  if (Number.isFinite(totalRules) && totalRules > 0) {
    return Math.max(0, Math.min(1, 1 - failedRules / totalRules));
  }
  return item?.status === "completed" ? 0.92 : 0.58;
}

function collectCapabilityStatus(artifactLinks, payloads, item) {
  const keys = new Set(Object.keys(artifactLinks || {}));
  const has = (...names) => names.some((name) => keys.has(name) || payloads[name]);
  const statusById = {
    parser: item?.status ? "completed" : "planned",
    layout: has("layoutDocument", "layoutReport", "sourceTextMap") ? "completed" : "available",
    semantic: has("semanticDocument", "tagManifest") ? "completed" : "available",
    native: has("writerReport", "taggedPdf") ? "completed" : "available",
    validation: has("validationReport") ? "completed" : "available",
    tables: has("tableStructureMap", "tableReport") ? "completed" : "available",
    fonts: has("fontReport", "fontInventory") ? "completed" : "available",
    repair: has("repairReport") ? "completed" : "planned",
    redaction: has("redactionReport", "redactedPdf") ? "completed" : "planned",
    diff: has("tagDeltaReport") ? "completed" : "available"
  };

  return CAPABILITIES.map(([id, label, detail]) => ({
    id,
    label,
    detail,
    status: statusById[id] || "planned",
    note:
      statusById[id] === "completed"
        ? "Artifact data available in this run."
        : statusById[id] === "available"
          ? "Supported by the platform; absent from this workload payload."
          : "Included in the introspector spec when emitted by future workloads."
  }));
}

function summarizeArtifacts(artifactLinks) {
  return Object.entries(artifactLinks || {}).map(([name, url]) => [
    name,
    artifactLabel(name),
    url,
    artifactKind(name, url)
  ]);
}

function countArray(payload, paths) {
  const value = valueAt(payload, paths, null);
  return Array.isArray(value) ? value.length : null;
}

function buildReportFromBatch(batch, payloads) {
  const item = batch?.items?.[0] || batch?.items?.find(Boolean) || {};
  const links = getArtifactLinks(item);
  const validation = payloads.validationReport || item.validation || {};
  const tagDelta = payloads.tagDeltaReport || {};
  const manifest = payloads.tagManifest || {};
  const tableMap = payloads.tableStructureMap || payloads.tableReport || {};
  const font = payloads.fontReport || payloads.fontInventory || {};

  const failedChecks = valueAt(validation, ["summary.failedRules", "failedRules", "failedChecks"], "n/a");
  const pageCount = valueAt(validation, ["document.pageCount", "summary.pageCount"], valueAt(tagDelta, ["after.pageCount"], "n/a"));
  const tagCount = valueAt(manifest, ["summary.totalTags", "summary.nodeCount"], valueAt(tagDelta, ["after.taggedNodes"], "n/a"));
  const tableCount = countArray(tableMap, ["tables", "tableSignals", "diagnostics.tables"]);
  const fontGrade = valueAt(font, ["grade", "overall.grade", "summary.grade"], "n/a");

  return {
    title: item.fileName || item.input?.fileName || "PDF introspection run",
    sourceName: item.fileName || item.relativePath || "document.pdf",
    generatedAt: new Date().toISOString(),
    status: item.status || batch.status || "unknown",
    score: estimateScore({ item, payloads }),
    summary:
      item.status === "failed"
        ? item.error || "The pipeline reported a failure. The report keeps all available partial artifacts."
        : "The introspector assembled every available artifact from this job into one report model.",
    metrics: [
      ["Pages", pageCount],
      ["Artifacts", Object.keys(links).length],
      ["Tags", tagCount],
      ["Failed Checks", failedChecks],
      ["Tables", tableCount ?? "n/a"],
      ["Font Grade", fontGrade]
    ],
    capabilities: collectCapabilityStatus(links, payloads, item),
    evidence: buildEvidence(validation, tagDelta, manifest, tableMap, font),
    artifacts: summarizeArtifacts(links),
    sections: buildSections({ item, batch, payloads, validation, tagDelta, manifest, tableMap, font })
  };
}

function buildEvidence(validation, tagDelta, manifest, tableMap, font) {
  const entries = [];
  entries.push(["Validation", `Status ${statusLabel(valueAt(validation, ["status", "summary.status"], "unknown"))}.`]);
  entries.push(["Tag Structure", `Nodes ${valueAt(manifest, ["summary.totalTags", "summary.nodeCount"], "n/a")}.`]);
  entries.push(["Tag Delta", `Reading-order inversions ${valueAt(tagDelta, ["after.readingOrderInversions", "readingOrderInversions"], "n/a")}.`]);
  entries.push(["Tables", `Detected table signals ${countArray(tableMap, ["tables", "tableSignals", "diagnostics.tables"]) ?? "n/a"}.`]);
  entries.push(["Fonts", `Overall font grade ${valueAt(font, ["grade", "overall.grade", "summary.grade"], "n/a")}.`]);
  return entries;
}

function buildSections({ item, batch, payloads, validation, tagDelta, manifest, tableMap, font }) {
  const stages = item.stageSummary || batch.stageSummary || payloads.writerReport?.stageSummary || null;
  return {
    pipeline: Array.isArray(stages)
      ? stages.map((stage) => [stage.name || stage.id || "Stage", stage.status || "reported", stage.summary || stage.message || ""])
      : [
          ["Queued", batch.status || "reported", `Batch ${batch.batchId || "n/a"}.`],
          ["Processed", item.status || "reported", item.error || "Queue state reported by the server."]
        ],
    tags: [
      ["Tag count", valueAt(manifest, ["summary.totalTags", "summary.nodeCount"], "n/a")],
      ["Native quality", valueAt(tagDelta, ["nativeQualityScore", "after.nativeQualityScore"], "n/a")],
      ["Reading order", valueAt(tagDelta, ["readingOrderInversionCount", "after.readingOrderInversions"], "n/a")]
    ],
    tables: extractTableRows(tableMap),
    typography: [
      ["Font grade", valueAt(font, ["grade", "overall.grade", "summary.grade"], "n/a")],
      ["Embedded fonts", valueAt(font, ["summary.embeddedFonts", "embeddedFonts"], "n/a")],
      ["Missing glyphs", valueAt(font, ["summary.missingGlyphs", "missingGlyphs"], "n/a")]
    ],
    compliance: [
      ["Validation status", valueAt(validation, ["status", "summary.status"], "unknown")],
      ["Failed rules", valueAt(validation, ["summary.failedRules", "failedRules", "failedChecks"], "n/a")],
      ["Warnings", valueAt(validation, ["summary.warningRules", "warnings"], "n/a")]
    ]
  };
}

function extractTableRows(tableMap) {
  const tables = valueAt(tableMap, ["tables", "tableSignals", "diagnostics.tables"], []);
  if (!Array.isArray(tables) || tables.length === 0) {
    return [["No table map", "n/a", "The selected workload did not emit table structure rows."]];
  }

  return tables.slice(0, 12).map((table, index) => [
    `Table ${index + 1}`,
    `${valueAt(table, ["rowCount", "rows"], "n/a")} rows x ${valueAt(table, ["columnCount", "colCount", "columns"], "n/a")} columns`,
    `Header rows ${valueAt(table, ["headerRowCount", "headers"], "n/a")}`
  ]);
}

async function loadArtifactPayloads(artifactLinks) {
  const entries = Object.entries(artifactLinks || {});
  const payloads = {};
  await Promise.all(
    entries.map(async ([name, url]) => {
      if (!url || String(url).toLowerCase().endsWith(".pdf")) return;
      try {
        const response = await fetchWithAuth(url, { auth: "api" });
        const contentType = String(response.headers.get("content-type") || "");
        if (!response.ok || !contentType.includes("json")) return;
        payloads[name] = await response.json();
      } catch {
        // Partial reports are still useful when an artifact is not JSON or cannot be fetched.
      }
    })
  );
  return payloads;
}

async function loadOptions() {
  const config = await loadAuthConfig();
  const access = getSessionAccess();
  els.accessState.textContent = config.publicMode
    ? "Public mode"
    : access.api
      ? "API access active"
      : "API key required";

  try {
    const payload = await fetchJson("/workloads", { auth: "api" });
    if (Array.isArray(payload.workloads) && payload.workloads.length) {
      els.workloadSelect.innerHTML = payload.workloads
        .map((workload) => `<option value="${escapeHtml(workload.id)}">${escapeHtml(workload.label || workload.id)}</option>`)
        .join("");
    }
  } catch {
    // Keep the fallback workload in place.
  }

  try {
    const payload = await fetchJson("/profiles", { auth: "api" });
    if (Array.isArray(payload.profiles) && payload.profiles.length) {
      els.profileSelect.innerHTML = payload.profiles
        .map((profile) => `<option value="${escapeHtml(profile.profileId)}">${escapeHtml(profile.label || profile.profileId)}</option>`)
        .join("");
    }
  } catch {
    // Keep the default profile in place.
  }
}

function renderCapabilities(report = state.report) {
  const capabilities = report?.capabilities || sampleReport.capabilities;
  els.capabilityStack.innerHTML = capabilities
    .map(
      (capability, index) => `
        <div class="capability-item">
          <span class="capability-index">${String(index + 1).padStart(2, "0")}</span>
          <span>
            <strong>${escapeHtml(capability.label)}</strong>
            <small>${escapeHtml(capability.detail)}</small>
          </span>
          <span class="badge ${normalizeStatus(capability.status)}">${escapeHtml(statusLabel(capability.status))}</span>
        </div>
      `
    )
    .join("");
}

function renderTabs() {
  els.reportTabs.innerHTML = SECTIONS.map(
    ([id, label]) => `
      <button class="tab-button" type="button" data-section="${id}" aria-selected="${id === state.activeSection ? "true" : "false"}">
        ${escapeHtml(label)}
      </button>
    `
  ).join("");
}

function renderReport() {
  renderCapabilities();
  renderTabs();

  if (!state.report) {
    els.reportCanvas.innerHTML = `
      <div class="empty-state">
        <div>
          <p class="eyebrow">PDF Introspector</p>
          <h3>Report surface ready</h3>
          <p>
            The introspector is designed as the place where every pipeline signal becomes a structured,
            shareable review package. Load the sample or run a PDF to populate the report canvas.
          </p>
        </div>
      </div>
    `;
    return;
  }

  els.reportCanvas.innerHTML = SECTIONS.map(([id]) => {
    const active = id === state.activeSection ? " active" : "";
    return `<section class="report-section${active}" id="section-${id}">${renderSection(id, state.report)}</section>`;
  }).join("");
}

function renderSection(id, report) {
  switch (id) {
    case "overview":
      return renderOverview(report);
    case "pipeline":
      return renderPipeline(report);
    case "tags":
      return renderKeyValueSection("Tag Structure", "Semantic and native tagging signals from the generated artifacts.", report.sections.tags);
    case "tables":
      return renderTableSection(report);
    case "typography":
      return renderKeyValueSection("Typography and Fonts", "Font, rotation, text, and contrast signals.", report.sections.typography);
    case "compliance":
      return renderKeyValueSection("Compliance", "Verifier and accessibility checks condensed for review.", report.sections.compliance);
    case "share":
      return renderShare(report);
    default:
      return "";
  }
}

function renderOverview(report) {
  const scorePercent = Math.round((report.score || 0) * 100);
  return `
    <div class="report-hero">
      <div class="summary-band">
        <div class="summary-title">
          <div>
            <h3>${escapeHtml(report.title)}</h3>
            <p>${escapeHtml(report.summary)}</p>
          </div>
          <span class="badge ${normalizeStatus(report.status)}">${escapeHtml(statusLabel(report.status))}</span>
        </div>
        <div class="metric-grid">
          ${report.metrics
            .map(
              ([label, value]) => `
                <div class="metric">
                  <span>${escapeHtml(label)}</span>
                  <strong>${escapeHtml(value)}</strong>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
      <div class="score-panel">
        <div class="score-stack">
          <strong>${scorePercent}</strong>
          <span>Score</span>
          <meter class="score-meter" min="0" max="100" value="${scorePercent}">${scorePercent}%</meter>
        </div>
      </div>
    </div>
    <div class="section-block">
      <h3>Evidence Map</h3>
      <p>Reviewer-facing findings distilled from the artifacts emitted by the selected workload.</p>
      <div class="evidence-list">
        ${report.evidence
          .map(
            ([title, detail]) => `
              <div class="evidence-item">
                <strong>${escapeHtml(title)}</strong>
                <span>${escapeHtml(detail)}</span>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
    <div class="section-block">
      <h3>Artifacts</h3>
      <div class="artifact-grid">${renderArtifactLinks(report.artifacts)}</div>
    </div>
  `;
}

function renderPipeline(report) {
  const rows = report.sections.pipeline || [];
  return `
    <div class="section-block">
      <h3>Pipeline Timeline</h3>
      <p>Stages are shown with the strongest status detail available from the queue and emitted artifacts.</p>
      <table class="data-table">
        <thead><tr><th>Stage</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>
          ${rows
            .map(
              ([stage, status, detail]) => `
                <tr>
                  <td><strong>${escapeHtml(stage)}</strong></td>
                  <td><span class="badge ${normalizeStatus(status)}">${escapeHtml(statusLabel(status))}</span></td>
                  <td>${escapeHtml(detail)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <div class="section-block">
      <h3>Capability Coverage</h3>
      <table class="data-table">
        <thead><tr><th>Capability</th><th>Status</th><th>Report Contract</th></tr></thead>
        <tbody>
          ${report.capabilities
            .map(
              (capability) => `
                <tr>
                  <td><strong>${escapeHtml(capability.label)}</strong><br /><span>${escapeHtml(capability.detail)}</span></td>
                  <td><span class="badge ${normalizeStatus(capability.status)}">${escapeHtml(statusLabel(capability.status))}</span></td>
                  <td>${escapeHtml(capability.note)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderKeyValueSection(title, copy, rows = []) {
  return `
    <div class="section-block">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(copy)}</p>
      <table class="data-table">
        <thead><tr><th>Signal</th><th>Value</th></tr></thead>
        <tbody>
          ${rows
            .map(
              ([label, value]) => `
                <tr>
                  <td><strong>${escapeHtml(label)}</strong></td>
                  <td>${escapeHtml(value)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTableSection(report) {
  const rows = report.sections.tables || [];
  return `
    <div class="section-block">
      <h3>Table Workbench</h3>
      <p>Header, span, and coverage signals are elevated here because irregular tables are one of the highest-risk tagging surfaces.</p>
      <table class="data-table">
        <thead><tr><th>Table or Header</th><th>Classification</th><th>Evidence</th></tr></thead>
        <tbody>
          ${rows
            .map(
              ([name, type, evidence]) => `
                <tr>
                  <td><strong>${escapeHtml(name)}</strong></td>
                  <td>${escapeHtml(type)}</td>
                  <td>${escapeHtml(evidence)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderShare(report) {
  return `
    <div class="section-block">
      <h3>Share Package</h3>
      <p>Everything in this panel can travel with a review: standalone HTML, printable output, JSON evidence, and artifact deep links.</p>
      <div class="share-layout">
        <div class="share-card">
          <strong>Standalone HTML</strong>
          <span>Self-contained executive report with tables, scorecards, and artifact index.</span>
        </div>
        <div class="share-card">
          <strong>Review JSON</strong>
          <span>Machine-readable report model for issue attachments, comparison runs, or downstream QA.</span>
        </div>
        <div class="share-card">
          <strong>Print Package</strong>
          <span>Print stylesheet expands every section for PDF export from the browser.</span>
        </div>
      </div>
    </div>
    <div class="section-block">
      <h3>Artifact Index</h3>
      <div class="artifact-grid">${renderArtifactLinks(report.artifacts)}</div>
    </div>
  `;
}

function renderArtifactLinks(artifacts = []) {
  if (!artifacts.length) {
    return `<p>No artifact links were emitted for this report.</p>`;
  }

  return artifacts
    .map(([name, label, url, kind]) => {
      const href = url || "#";
      const disabled = href === "#";
      return `
        <a class="artifact-link" href="${escapeHtml(href)}" ${disabled ? "" : 'target="_blank" rel="noreferrer"'}>
          <strong>${escapeHtml(label || artifactLabel(name))}</strong>
          <span>${escapeHtml(kind || artifactKind(name, url))}</span>
        </a>
      `;
    })
    .join("");
}

async function runAnalysis(event) {
  event.preventDefault();
  if (!state.file) {
    setRunState("Waiting", "Choose a PDF before running analysis.", 0);
    return;
  }

  clearPolling();
  els.runAnalysis.disabled = true;
  setRunState("Uploading", `Uploading ${state.file.name}.`, 12);

  try {
    const formData = new FormData();
    formData.append("files", state.file, state.file.name);
    formData.append("relativePaths", state.file.name);
    formData.append("workloadId", els.workloadSelect.value || "accessibility-tagging");
    formData.append("profileId", els.profileSelect.value || "default");

    const batch = await fetchJson("/process-pdf-upload", {
      auth: "api",
      method: "POST",
      body: formData
    });

    setRunState("Queued", `Batch ${batch.batchId} accepted.`, 25);
    pollBatch(batch.batchId, 0);
  } catch (error) {
    els.runAnalysis.disabled = false;
    setRunState("Failed", error.message || "The upload failed.", 0);
  }
}

async function pollBatch(batchId, attempt) {
  try {
    const batch = await fetchJson(`/batches/${encodeURIComponent(batchId)}`, { auth: "api" });
    const total = Math.max(1, batch.totals?.total || batch.items?.length || 1);
    const done = (batch.totals?.completed || 0) + (batch.totals?.failed || 0);
    const progress = Math.max(30, Math.round((done / total) * 86));
    setRunState(statusLabel(batch.status), `${done} of ${total} documents complete.`, progress);

    if (batch.status === "processing" || batch.status === "queued") {
      state.pollHandle = window.setTimeout(() => pollBatch(batchId, attempt + 1), Math.min(1800, 600 + attempt * 80));
      return;
    }

    const item = batch.items?.[0] || {};
    const links = getArtifactLinks(item);
    const payloads = await loadArtifactPayloads(links);
    state.artifactPayloads = payloads;
    state.report = buildReportFromBatch(batch, payloads);
    state.activeSection = "overview";
    setRunState("Complete", `Report assembled for ${state.report.sourceName}.`, 100);
    els.runAnalysis.disabled = false;
    renderReport();
    els.reportCanvas.focus();
  } catch (error) {
    els.runAnalysis.disabled = false;
    setRunState("Failed", error.message || "Polling failed.", 0);
  }
}

function loadSampleReport() {
  clearPolling();
  state.report = structuredClone(sampleReport);
  state.activeSection = "overview";
  setRunState("Sample", "Loaded the reference introspector report model.", 100);
  renderReport();
}

function resetReport() {
  clearPolling();
  state.report = null;
  state.artifactPayloads = {};
  state.activeSection = "overview";
  els.fileInput.value = "";
  state.file = null;
  els.fileName.textContent = "Choose a document";
  els.fileMeta.textContent = "Local upload, processed by the existing queue API.";
  els.runAnalysis.disabled = false;
  setRunState("Ready", "Load the sample report or process a PDF.", 0);
  renderReport();
}

function buildStandaloneReport(report) {
  const metrics = report.metrics
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
  const evidence = report.evidence
    .map(([label, value]) => `<li><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></li>`)
    .join("");
  const artifacts = report.artifacts
    .map(([name, label, url, kind]) => `<li><strong>${escapeHtml(label || name)}</strong><span>${escapeHtml(kind)} ${escapeHtml(url)}</span></li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(report.title)} - PDF Introspector</title>
<style>
body{font-family:Arial,sans-serif;margin:32px;color:#172033;background:#f5f7fb}
main{max-width:980px;margin:auto;background:#fff;border:1px solid #cfd8e3;border-radius:8px;padding:28px}
h1{margin:0 0 8px;font-size:30px}p{color:#64748b;line-height:1.55}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:20px 0}
.metrics div,li{border:1px solid #cfd8e3;border-radius:7px;padding:12px;background:#fbfdff}.metrics span,li span{display:block;color:#64748b;margin-top:5px}
section{margin-top:26px}ul{display:grid;gap:10px;list-style:none;padding:0}.score{font-size:42px;color:#0f766e}
</style>
</head>
<body>
<main>
<p>PDF Introspector</p>
<h1>${escapeHtml(report.title)}</h1>
<p>${escapeHtml(report.summary)}</p>
<strong class="score">${Math.round((report.score || 0) * 100)}%</strong>
<div class="metrics">${metrics}</div>
<section><h2>Evidence</h2><ul>${evidence}</ul></section>
<section><h2>Artifacts</h2><ul>${artifacts}</ul></section>
</main>
</body>
</html>`;
}

async function copyReportJson() {
  if (!state.report) return;
  const text = JSON.stringify(state.report, null, 2);
  await navigator.clipboard.writeText(text);
  setRunState("Copied", "Report JSON copied to the clipboard.", 100);
}

function downloadReportHtml() {
  if (!state.report) return;
  const blob = new Blob([buildStandaloneReport(state.report)], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.report.sourceName || "pdf-introspector"}-report.html`.replace(/[^\w.-]+/g, "-");
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0] || null;
  state.file = file;
  if (!file) {
    els.fileName.textContent = "Choose a document";
    els.fileMeta.textContent = "Local upload, processed by the existing queue API.";
    return;
  }
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${formatBytes(file.size)} selected.`;
});

els.analysisForm.addEventListener("submit", runAnalysis);
els.sampleReport.addEventListener("click", loadSampleReport);
els.resetReport.addEventListener("click", resetReport);
els.copyJson.addEventListener("click", () => copyReportJson().catch((error) => setRunState("Copy failed", error.message, 100)));
els.downloadHtml.addEventListener("click", downloadReportHtml);
els.printReport.addEventListener("click", () => window.print());
els.reportTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-section]");
  if (!button) return;
  state.activeSection = button.dataset.section;
  renderReport();
});

renderReport();
setRunState("Ready", `Opened ${formatTimestamp(new Date().toISOString())}.`, 0);
loadOptions().catch(() => {
  els.accessState.textContent = "Access unknown";
});
