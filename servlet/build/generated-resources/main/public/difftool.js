/**
 * Diff Tool — Client-side logic
 *
 * Handles file uploads, calls the /api/difftool/compare endpoint,
 * and renders the structured comparison report.
 */

import { fetchWithAuth, getSessionAccess, loadAuthConfig, verifyAndStoreAccess } from "./auth-client.js";

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

const state = {
  sourceFile: null,
  competitorFile: null,
  report: null,
  activeMode: "auto",
  modeReports: {}
};

/* -------------------------------------------------------------------------- */
/*  DOM references                                                            */
/* -------------------------------------------------------------------------- */

const sourceDropzone = document.getElementById("source-dropzone");
const competitorDropzone = document.getElementById("competitor-dropzone");
const sourceFileInput = document.getElementById("source-file");
const competitorFileInput = document.getElementById("competitor-file");
const sourceFilename = document.getElementById("source-filename");
const competitorFilename = document.getElementById("competitor-filename");
const compareBtn = document.getElementById("compare-btn");
const progressEl = document.getElementById("compare-progress");
const progressText = document.getElementById("progress-text");
const progressFill = document.getElementById("progress-fill");
const statusMsg = document.getElementById("status-msg");
const variantTabsContainer = document.getElementById("variant-tabs-container");
const winnerBanner = document.getElementById("winner-banner");
const winnerLabel = document.getElementById("winner-label");
const winnerDetail = document.getElementById("winner-detail");
const winnerScore = document.getElementById("winner-score");
const categoriesContainer = document.getElementById("categories-container");
const emptyState = document.getElementById("empty-state");

/* -------------------------------------------------------------------------- */
/*  Upload handling                                                           */
/* -------------------------------------------------------------------------- */

function setupDropzone(dropzone, fileInput, filenameEl, targetKey) {
  function handleFile(file) {
    if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
      showStatus("Please select a PDF file.", "error");
      return;
    }
    state[targetKey] = file;
    dropzone.classList.add("has-file");
    dropzone.textContent = "";
    filenameEl.textContent = file.name;
    filenameEl.hidden = false;
    dropzone.appendChild(filenameEl);
    updateCompareButton();
    hideStatus();
  }

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      handleFile(fileInput.files[0]);
    }
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
}

function updateCompareButton() {
  compareBtn.disabled = !(state.sourceFile && state.competitorFile);
}

/* -------------------------------------------------------------------------- */
/*  Status messages                                                           */
/* -------------------------------------------------------------------------- */

function showStatus(msg, type = "info") {
  statusMsg.textContent = msg;
  statusMsg.className = `status-message ${type}`;
  statusMsg.hidden = false;
}

function hideStatus() {
  statusMsg.hidden = true;
}

function showProgress(text, pct) {
  progressEl.classList.add("active");
  progressText.textContent = text;
  progressFill.style.width = `${pct}%`;
}

function hideProgress() {
  progressEl.classList.remove("active");
}

/* -------------------------------------------------------------------------- */
/*  API call                                                                  */
/* -------------------------------------------------------------------------- */

async function runComparison() {
  if (!state.sourceFile || !state.competitorFile) return;

  compareBtn.disabled = true;
  hideStatus();
  showProgress("Uploading documents…", 10);

  try {
    const selectedMode = document.querySelector('input[name="writerMode"]:checked')?.value || "auto";

    const formData = new FormData();
    formData.append("sourcePdf", state.sourceFile);
    formData.append("competitorPdf", state.competitorFile);
    formData.append("writerMode", selectedMode);

    showProgress("Running analysis…", 30);

    const response = await fetch("/api/difftool/compare", {
      method: "POST",
      body: formData
    });

    showProgress("Processing results…", 70);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(error.error || `Server returned ${response.status}`);
    }

    const report = await response.json();
    showProgress("Rendering report…", 90);

    state.report = report;
    state.activeMode = selectedMode;
    state.modeReports[selectedMode] = report;

    renderReport(report);
    showProgress("Complete!", 100);

    setTimeout(hideProgress, 800);
  } catch (err) {
    hideProgress();
    showStatus(err.message || "Comparison failed", "error");
  } finally {
    compareBtn.disabled = false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderReport(report) {
  emptyState.hidden = true;
  variantTabsContainer.hidden = false;

  // Update active tab
  document.querySelectorAll(".variant-tab").forEach((tab) => {
    const isActive = tab.dataset.mode === state.activeMode;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  // Winner banner
  if (report.overallWinner) {
    const winner = report.documents.find((d) => d.id === report.overallWinner);
    const score = report.overallScores?.[report.overallWinner];
    winnerBanner.hidden = false;
    winnerLabel.textContent = `Overall Winner: ${winner?.label || report.overallWinner}`;
    winnerDetail.textContent = "Determined by weighted accessibility category scores";
    winnerScore.textContent = score !== undefined ? `${(score * 100).toFixed(0)}%` : "";
  } else {
    winnerBanner.hidden = true;
  }

  // Categories
  categoriesContainer.innerHTML = "";
  for (const cat of report.categories) {
    categoriesContainer.appendChild(renderCategory(cat, report.documents));
  }
}

function roleToFillClass(role) {
  if (role === "source") return "fill-source";
  if (role === "competitor") return "fill-competitor";
  return "fill-ours";
}

function renderCategory(category, documents) {
  const card = document.createElement("div");
  card.className = "category-card";

  const winnerBadge = category.winner
    ? `<span class="category-winner-badge">🏆 ${escapeHtml(
        documents.find((d) => d.id === category.winner)?.label || category.winner
      )}</span>`
    : category.tied
      ? `<span class="category-winner-badge tied">🤝 Tied</span>`
      : "";

  let entriesHtml = "";
  for (const entry of category.entries) {
    const pct = (entry.score * 100).toFixed(1);
    const doc = documents.find((d) => d.id === entry.documentId);
    const fillClass = doc ? roleToFillClass(doc.role) : "fill-source";
    const isWinner = category.winner === entry.documentId;

    entriesHtml += `
      <div class="score-entry">
        <span class="score-entry-label">${escapeHtml(entry.label)}</span>
        <div class="score-bar-track">
          <div class="score-bar-fill ${isWinner ? "fill-winner" : fillClass}"
               style="width: ${pct}%"></div>
        </div>
        <span class="score-value ${isWinner ? "is-winner" : ""}">${pct}%</span>
      </div>`;
  }

  // Metric details table
  let metricHtml = renderMetricDetails(category, documents);

  card.innerHTML = `
    <div class="category-header">
      <span class="category-icon">${category.icon}</span>
      <div>
        <h3 class="category-title">${escapeHtml(category.label)}</h3>
        <p class="category-description">${escapeHtml(category.description)}</p>
      </div>
      ${winnerBadge}
    </div>
    <div class="score-entries">${entriesHtml}</div>
    ${metricHtml}`;

  return card;
}

function renderMetricDetails(category, documents) {
  if (category.id === "pdfua-compliance") {
    return renderComplianceDetails(category, documents);
  }
  if (category.id === "metadata-quality") {
    return renderMetadataDetails(category, documents);
  }
  if (category.id === "structure-tree") {
    return renderStructureDetails(category, documents);
  }
  if (category.id === "font-health") {
    return renderFontDetails(category, documents);
  }
  return "";
}

function metricCell(value, opts = {}) {
  if (value === null || value === undefined) {
    return `<td class="metric-na">N/A</td>`;
  }
  if (typeof value === "boolean") {
    return value
      ? `<td class="metric-pass">✓ Yes</td>`
      : `<td class="metric-fail">✗ No</td>`;
  }
  if (opts.lowerBetter) {
    const cls = value === 0 ? "metric-pass" : "metric-fail";
    return `<td class="${cls}">${escapeHtml(String(value))}</td>`;
  }
  return `<td>${escapeHtml(String(value))}</td>`;
}

function renderComplianceDetails(category, documents) {
  let rows = "";
  for (const entry of category.entries) {
    const m = entry.metrics;
    if (!m) continue;
    rows += `<tr>
      <td>${escapeHtml(entry.label)}</td>
      ${metricCell(m.isCompliant)}
      ${metricCell(m.failedRules, { lowerBetter: true })}
      ${metricCell(m.failedChecks, { lowerBetter: true })}
    </tr>`;
  }

  // Findings side-by-side
  let findingsHtml = "";
  const withFindings = category.entries.filter((e) => e.metrics?.findingCodes?.length > 0);
  if (withFindings.length > 0) {
    let cols = "";
    for (const entry of withFindings) {
      const items = (entry.metrics.findingCodes || [])
        .map((code) => `<li><span class="finding-code">${escapeHtml(code)}</span></li>`)
        .join("");
      cols += `<div class="findings-column">
        <h4>${escapeHtml(entry.label)}</h4>
        <ul class="findings-list">${items || "<li>None</li>"}</ul>
      </div>`;
    }
    findingsHtml = `<div class="findings-grid">${cols}</div>`;
  }

  return `<div class="metric-details">
    <table class="metric-table">
      <thead><tr>
        <th>Document</th><th>Compliant</th><th>Failed Rules</th><th>Failed Checks</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${findingsHtml}
  </div>`;
}

function renderMetadataDetails(category) {
  let rows = "";
  for (const entry of category.entries) {
    const m = entry.metrics;
    if (!m) continue;
    rows += `<tr>
      <td>${escapeHtml(entry.label)}</td>
      ${metricCell(m.metadataPresent)}
      ${metricCell(m.dcTitleDetected)}
      ${metricCell(m.pdfUaIdentificationDetected)}
      ${metricCell(m.infoMatchesXmp)}
    </tr>`;
  }

  return `<div class="metric-details">
    <table class="metric-table">
      <thead><tr>
        <th>Document</th><th>Metadata</th><th>Title</th><th>PDF/UA ID</th><th>XMP Sync</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderStructureDetails(category) {
  let rows = "";
  for (const entry of category.entries) {
    const m = entry.metrics;
    if (!m) continue;
    rows += `<tr>
      <td>${escapeHtml(entry.label)}</td>
      ${metricCell(m.hasStructureTree)}
      ${metricCell(m.typedNodes)}
      ${metricCell(m.markedContentOperators)}
      ${metricCell(m.tableAttributeNodes)}
    </tr>`;
  }

  return `<div class="metric-details">
    <table class="metric-table">
      <thead><tr>
        <th>Document</th><th>Struct Tree</th><th>Typed Nodes</th><th>Marked Content</th><th>Table Attrs</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderFontDetails(category) {
  let rows = "";
  for (const entry of category.entries) {
    const m = entry.metrics;
    if (!m) continue;
    rows += `<tr>
      <td>${escapeHtml(entry.label)}</td>
      <td>${escapeHtml(m.grade || "N/A")}</td>
      ${metricCell(m.issueCount, { lowerBetter: true })}
      ${metricCell(m.fontCount)}
    </tr>`;
  }

  return `<div class="metric-details">
    <table class="metric-table">
      <thead><tr>
        <th>Document</th><th>Grade</th><th>Issues</th><th>Fonts</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/*  Variant tab switching                                                     */
/* -------------------------------------------------------------------------- */

function setupVariantTabs() {
  document.querySelectorAll(".variant-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.mode;
      state.activeMode = mode;

      // Update radio
      const radio = document.querySelector(`input[name="writerMode"][value="${mode}"]`);
      if (radio) radio.checked = true;

      // If we have a cached report for this mode, render it
      if (state.modeReports[mode]) {
        state.report = state.modeReports[mode];
        renderReport(state.report);
      } else {
        // Re-run comparison with new mode
        runComparison();
      }
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Init                                                                      */
/* -------------------------------------------------------------------------- */

setupDropzone(sourceDropzone, sourceFileInput, sourceFilename, "sourceFile");
setupDropzone(competitorDropzone, competitorFileInput, competitorFilename, "competitorFile");
setupVariantTabs();

compareBtn.addEventListener("click", runComparison);

// Attempt auth check (non-blocking)
loadAuthConfig().catch(() => {});
