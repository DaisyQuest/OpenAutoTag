import {
  artifactLabels,
  buildArtifactView,
  escapeHtml,
  formatStatus,
  renderSummaryCards
} from "./report-renderers.js";
import {
  clearStoredKeys,
  downloadWithAuth,
  fetchJson,
  fetchWithAuth,
  formatTimestamp,
  getSessionAccess,
  loadAuthConfig,
  sanitizeStatusToken,
  verifyAndStoreAccess
} from "./auth-client.js";

const fallbackWorkloads = [
  {
    id: "accessibility-tagging",
    label: "Accessibility Tagging",
    shortLabel: "Tagging",
    description: "Create tagged, validated PDF/UA output with browser-native reports.",
    primaryArtifact: "validationReport",
    previewArtifacts: ["validationReport", "tagDeltaReport", "writerReport", "tagManifest"],
    downloadArtifacts: ["taggedPdf", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"]
  }
];

const downloadLabels = {
  taggedPdf: "Download tagged PDF",
  validationReport: "Download validation report",
  tagDeltaReport: "Download tag delta",
  writerReport: "Download writer report",
  tagManifest: "Download tag tree",
  redactedPdf: "Download redacted PDF",
  redactionReport: "Download redaction report"
};

const state = {
  selections: [],
  batch: null,
  selectedJobId: null,
  selectedWorkloadId: "accessibility-tagging",
  workloads: [...fallbackWorkloads],
  previewSelectionByJob: Object.create(null),
  previewCache: new Map(),
  pollHandle: null,
  authConfig: null
};

const queuedCount = document.querySelector("#queued-count");
const queuedSize = document.querySelector("#queued-size");
const batchState = document.querySelector("#batch-state");
const sessionPill = document.querySelector("#session-pill");
const clearSessionButton = document.querySelector("#clear-session");
const authCaption = document.querySelector("#auth-caption");
const authCopy = document.querySelector("#auth-copy");
const authForm = document.querySelector("#auth-form");
const authKeyInput = document.querySelector("#auth-key");
const authSubmitButton = document.querySelector("#auth-submit");
const authMessage = document.querySelector("#auth-message");
const workloadCaption = document.querySelector("#workload-caption");
const workloadList = document.querySelector("#workload-list");
const dropzone = document.querySelector("#dropzone");
const filePicker = document.querySelector("#file-picker");
const directoryPicker = document.querySelector("#directory-picker");
const urlInput = document.querySelector("#url-input");
const startUrlJobButton = document.querySelector("#start-url-job");
const clearSelectionButton = document.querySelector("#clear-selection");
const startBatchButton = document.querySelector("#start-batch");
const intakeMessage = document.querySelector("#intake-message");
const selectionCaption = document.querySelector("#selection-caption");
const selectionBody = document.querySelector("#selection-body");
const batchCaption = document.querySelector("#batch-caption");
const batchOverview = document.querySelector("#batch-overview");
const resultsBody = document.querySelector("#results-body");
const detailPanel = document.querySelector("#detail-panel");

function hasWorkspaceAccess() {
  return Boolean(state.authConfig?.publicMode || getSessionAccess().api);
}

function getAccessTone() {
  const access = getSessionAccess();
  if (state.authConfig?.publicMode) {
    return { label: "Public mode", description: "This workspace is open. Protected headers are not required." };
  }

  if (access.admin) {
    return { label: "Admin session", description: "Admin access is active in this tab and can operate the workspace." };
  }

  if (access.api) {
    return { label: "API session", description: "An API key is active in this tab for workload and artifact access." };
  }

  return { label: "Locked", description: "Enter an API key or admin key to use protected workload actions." };
}

function setAuthMessage(message) {
  authMessage.textContent = message;
}

function renderSessionChrome() {
  const tone = getAccessTone();
  sessionPill.textContent = tone.label;
  authCaption.textContent = tone.label;
  authCopy.textContent = tone.description;

  const isPublic = Boolean(state.authConfig?.publicMode);
  authForm.hidden = isPublic;
  authKeyInput.disabled = isPublic;
  authSubmitButton.disabled = isPublic;
  clearSessionButton.disabled = isPublic && !getSessionAccess().api && !getSessionAccess().admin;
}

function updateActionAvailability() {
  const locked = !hasWorkspaceAccess();
  const interactiveNodes = [
    startBatchButton,
    startUrlJobButton,
    filePicker,
    directoryPicker,
    urlInput
  ];

  for (const node of interactiveNodes) {
    node.disabled = locked;
  }

  dropzone.setAttribute("aria-disabled", locked ? "true" : "false");
  dropzone.classList.toggle("is-disabled", locked);

  if (locked) {
    workloadCaption.textContent = "Unlock the workspace to load workload definitions.";
  }
}

function getSelectedWorkload() {
  return state.workloads.find((workload) => workload.id === state.selectedWorkloadId) || state.workloads[0];
}

function getWorkloadForItem(item) {
  return item?.workload || getSelectedWorkload();
}

function getPreviewArtifactsForItem(item) {
  const workload = getWorkloadForItem(item);
  const preferred = workload?.previewArtifacts?.length
    ? workload.previewArtifacts
    : ["redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"];
  return preferred.filter((artifactName) => item?.artifacts?.[artifactName]);
}

function getDownloadArtifactsForItem(item) {
  const workload = getWorkloadForItem(item);
  const preferred = workload?.downloadArtifacts?.length
    ? workload.downloadArtifacts
    : ["taggedPdf", "redactedPdf", "redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"];
  return preferred.filter((artifactName) => item?.artifacts?.[artifactName]);
}

function getPreviewSelection(item) {
  const available = getPreviewArtifactsForItem(item);
  const current = state.previewSelectionByJob[item.jobId];

  if (current && available.includes(current)) {
    return current;
  }

  return available[0] || null;
}

function setPreviewSelection(jobId, artifactName) {
  state.previewSelectionByJob[jobId] = artifactName;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(scaled >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function normalizeSignalList(summary) {
  return Array.isArray(summary?.signals) ? summary.signals.filter(Boolean).slice(0, 6) : [];
}

function summarizeSelectionQueue() {
  return state.selections.reduce(
    (summary, item) => {
      summary.count += 1;
      summary.bytes += item.file.size || 0;
      return summary;
    },
    { count: 0, bytes: 0 }
  );
}

function statusToneForSummary(summary, status) {
  if (summary?.tone) {
    return summary.tone;
  }

  if (status === "completed") {
    return "success";
  }

  if (status === "failed" || status === "completed_with_failures") {
    return "danger";
  }

  return "";
}

function createPreviewCacheKey(jobId, artifactName) {
  return `${jobId}:${artifactName}`;
}

function setIntakeMessage(message) {
  intakeMessage.textContent = message;
}

function isLiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function buildSingleJobBatch(job) {
  const jobStatus = job?.status || "failed";

  return {
    batchId: `job:${job.jobId}`,
    workload: job?.workload || getSelectedWorkload(),
    status: isLiveJobStatus(jobStatus) ? "processing" : jobStatus,
    totals: {
      total: 1,
      queued: jobStatus === "queued" ? 1 : 0,
      running: jobStatus === "running" ? 1 : 0,
      completed: jobStatus === "completed" ? 1 : 0,
      failed: jobStatus === "failed" ? 1 : 0,
      missing: 0
    },
    createdAt: job?.createdAt,
    updatedAt: job?.updatedAt,
    items: [
      {
        jobId: job.jobId,
        fileName: job.fileName || "Remote PDF",
        relativePath: job.relativePath || job.sourceUrl || job.input?.filePath || job.fileName || "Remote PDF",
        workload: job?.workload || getSelectedWorkload(),
        status: jobStatus,
        error: job?.error || null,
        createdAt: job?.createdAt,
        updatedAt: job?.updatedAt,
        summary: job?.summary || null,
        validation: job?.validation || null,
        artifacts: job?.artifactLinks || {}
      }
    ]
  };
}

function updateRunButton() {
  const workload = getSelectedWorkload();
  if (!workload) {
    startBatchButton.textContent = "Run Selected Workload";
    return;
  }

  startBatchButton.textContent =
    workload.id === "accessibility-tagging" ? "Autotag and Validate" : `Run ${workload.label}`;
}

function renderWorkloads() {
  if (!hasWorkspaceAccess()) {
    workloadList.innerHTML = `
      <div class="empty-workload">
        Unlock the workspace to load the available workload catalog.
      </div>
    `;
    updateRunButton();
    return;
  }

  const workload = getSelectedWorkload();
  workloadCaption.textContent = workload ? workload.description : "No workloads available.";

  workloadList.innerHTML = state.workloads
    .map(
      (item) => `
        <button
          class="workload-card ${item.id === state.selectedWorkloadId ? "is-active" : ""}"
          type="button"
          data-workload-id="${escapeHtml(item.id)}"
        >
          <span class="workload-card-kicker">${escapeHtml(item.shortLabel || item.label)}</span>
          <strong>${escapeHtml(item.label)}</strong>
          <span class="workload-card-copy">${escapeHtml(item.description || "No description available.")}</span>
        </button>
      `
    )
    .join("");

  updateRunButton();
}

function renderHeroStats() {
  const queue = summarizeSelectionQueue();
  queuedCount.textContent = String(queue.count);
  queuedSize.textContent = formatBytes(queue.bytes);
  batchState.textContent = state.batch ? formatStatus(state.batch.status) : "Idle";
}

function renderSelectionTable() {
  selectionCaption.textContent = `${state.selections.length} document${state.selections.length === 1 ? "" : "s"} ready`;

  if (!state.selections.length) {
    selectionBody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-row">Queue PDF files or folders to prepare a workload batch.</td>
      </tr>
    `;
    return;
  }

  selectionBody.innerHTML = state.selections
    .map((item) => {
      const workloadLabel = getSelectedWorkload()?.label || item.workloadLabel;

      return `
        <tr>
          <td>
            <div class="table-cell-stack">
              <strong class="table-primary">${escapeHtml(item.file.name)}</strong>
              <span class="table-note">${escapeHtml(workloadLabel)}</span>
            </div>
          </td>
          <td class="table-secondary">${escapeHtml(item.relativePath)}</td>
          <td class="table-secondary">${escapeHtml(item.source)}</td>
          <td class="table-secondary">${escapeHtml(formatBytes(item.file.size))}</td>
        </tr>
      `;
    })
    .join("");
}

function renderBatchOverview() {
  if (!state.batch) {
    batchCaption.textContent = "No batch running";
    batchOverview.className = "batch-overview empty-state";
    batchOverview.textContent = "Start a batch to see workload results here.";
    return;
  }

  const { totals } = state.batch;
  const finished = totals.completed + totals.failed;
  const progress = totals.total ? Math.round((finished / totals.total) * 100) : 0;
  const workload = state.batch.workload || getSelectedWorkload();

  batchCaption.textContent = `${totals.completed} completed / ${totals.failed} failed / ${totals.total} total`;
  batchOverview.className = "batch-overview";
  batchOverview.innerHTML = `
    <div class="overview-progress">
      <div class="overview-stat">
        <span class="summary-label">Active workload</span>
        <strong>${escapeHtml(workload?.label || "Unknown workload")}</strong>
        <span class="summary-detail">${escapeHtml(workload?.description || "No workload description available.")}</span>
      </div>
      <div class="progress-meter" aria-hidden="true">
        <span style="width: ${progress}%"></span>
      </div>
      <span class="summary-detail">${escapeHtml(formatStatus(state.batch.status))} · Updated ${escapeHtml(
        formatTimestamp(state.batch.updatedAt)
      )}</span>
    </div>
    <div class="overview-stat">
      <span class="summary-label">Total jobs</span>
      <strong>${escapeHtml(String(totals.total))}</strong>
      <span class="summary-detail">${escapeHtml(String(progress))}% through the batch</span>
    </div>
    <div class="overview-stat">
      <span class="summary-label">Running</span>
      <strong>${escapeHtml(String(totals.running))}</strong>
      <span class="summary-detail">${escapeHtml(String(totals.queued))} queued</span>
    </div>
    <div class="overview-stat">
      <span class="summary-label">Completed</span>
      <strong>${escapeHtml(String(totals.completed))}</strong>
      <span class="summary-detail">${escapeHtml(String(totals.failed))} failed</span>
    </div>
    <div class="overview-stat">
      <span class="summary-label">Created</span>
      <strong>${escapeHtml(formatTimestamp(state.batch.createdAt))}</strong>
      <span class="summary-detail">${escapeHtml(state.batch.batchId)}</span>
    </div>
  `;
}

function renderOutcomeCell(item) {
  if (item.error) {
    return `
      <div class="table-cell-stack">
        <strong class="table-primary">Failed</strong>
        <span class="table-note">${escapeHtml(item.error)}</span>
      </div>
    `;
  }

  if (!item.summary) {
    return `
      <div class="table-cell-stack">
        <strong class="table-primary">${escapeHtml(formatStatus(item.status))}</strong>
        <span class="table-note">Summary will appear after processing.</span>
      </div>
    `;
  }

  return `
    <div class="table-cell-stack">
      <strong class="table-primary">${escapeHtml(item.summary.label || "Ready")}</strong>
      <span class="table-note">${escapeHtml(item.summary.detail || "No additional detail available.")}</span>
    </div>
  `;
}

function renderSignalCell(item) {
  const signals = normalizeSignalList(item.summary);
  if (!signals.length) {
    return `<span class="table-note">No signals yet.</span>`;
  }

  return `<div class="finding-list compact-list">${signals
    .map((signal) => `<span class="finding-chip">${escapeHtml(signal)}</span>`)
    .join("")}</div>`;
}

function renderPrimaryActionCell(item) {
  const previewArtifact = getPreviewSelection(item);
  if (previewArtifact && item.artifacts?.[previewArtifact]) {
    return `
      <a class="action-link primary compact-link" href="/report.html?jobId=${encodeURIComponent(item.jobId)}&artifact=${encodeURIComponent(
        previewArtifact
      )}">
        Open ${escapeHtml(artifactLabels[previewArtifact] || "report")}
      </a>
    `;
  }

  const downloadArtifact = getDownloadArtifactsForItem(item)[0];
  if (downloadArtifact) {
    return `
      <button
        class="action-link download compact-link button-link"
        type="button"
        data-download-url="${escapeHtml(item.artifacts[downloadArtifact])}"
        data-download-name="${escapeHtml(downloadLabels[downloadArtifact] || `artifact-${downloadArtifact}`)}"
      >
        ${escapeHtml(downloadLabels[downloadArtifact] || `Download ${downloadArtifact}`)}
      </button>
    `;
  }

  return `<span class="table-note">No action yet.</span>`;
}

function renderResultsTable() {
  if (!state.batch?.items?.length) {
    resultsBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-row">Run a workload batch to populate this operations table.</td>
      </tr>
    `;
    return;
  }

  resultsBody.innerHTML = state.batch.items
    .map((item) => {
      const workload = getWorkloadForItem(item);
      const isActive = item.jobId === state.selectedJobId;

      return `
        <tr class="result-row ${isActive ? "is-active" : ""}" data-job-id="${escapeHtml(item.jobId)}">
          <td>
            <button class="row-select" type="button" data-job-id="${escapeHtml(item.jobId)}">
              <strong class="table-primary">${escapeHtml(item.fileName)}</strong>
              <span class="table-note">${escapeHtml(item.relativePath || item.fileName)}</span>
            </button>
          </td>
          <td>
            <div class="table-cell-stack">
              <strong class="table-primary">${escapeHtml(workload?.shortLabel || workload?.label || "Unknown")}</strong>
              <span class="table-note">${escapeHtml(workload?.id || "unknown")}</span>
            </div>
          </td>
          <td>
            <span class="status-pill status-${escapeHtml(sanitizeStatusToken(item.status))}">${escapeHtml(
              formatStatus(item.status)
            )}</span>
          </td>
          <td>${renderOutcomeCell(item)}</td>
          <td>${renderSignalCell(item)}</td>
          <td class="table-secondary">${escapeHtml(formatTimestamp(item.updatedAt))}</td>
          <td>${renderPrimaryActionCell(item)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderInlinePreviewBody(previewState, artifactName) {
  if (!artifactName) {
    return `<div class="empty-detail">No preview artifact is available for this job.</div>`;
  }

  if (!previewState || previewState.status === "loading") {
    return `<div class="empty-detail">Loading ${escapeHtml(artifactLabels[artifactName] || artifactName)}.</div>`;
  }

  if (previewState.status === "error") {
    return `<div class="empty-detail">${escapeHtml(previewState.error || "The inline preview could not be rendered.")}</div>`;
  }

  return `
    <div class="detail-preview-rendered">
      <div class="report-summary-grid inline-report-summary">
        ${renderSummaryCards(previewState.view.summaryCards)}
      </div>
      <div class="report-content compact-report-content">
        ${previewState.view.contentHtml}
      </div>
    </div>
  `;
}

function renderDetailPanel() {
  if (!state.batch?.items?.length || !state.selectedJobId) {
    detailPanel.innerHTML = `
      <div class="empty-detail">
        Select a batch row to inspect workload diagnostics, inline reports, and download actions.
      </div>
    `;
    return;
  }

  const item = state.batch.items.find((candidate) => candidate.jobId === state.selectedJobId);
  if (!item) {
    detailPanel.innerHTML = `
      <div class="empty-detail">
        The selected job is no longer present in this batch snapshot.
      </div>
    `;
    return;
  }

  const workload = getWorkloadForItem(item);
  const previewArtifacts = getPreviewArtifactsForItem(item);
  const selectedArtifact = previewArtifacts.length ? getPreviewSelection(item) : null;

  if (selectedArtifact) {
    setPreviewSelection(item.jobId, selectedArtifact);
  }

  const signals = normalizeSignalList(item.summary);
  const cards = [
    {
      label: "Outcome",
      value: item.summary?.label || formatStatus(item.status),
      tone: statusToneForSummary(item.summary, item.status),
      detail: item.summary?.detail || item.error || "Waiting for a completed workload summary."
    },
    {
      label: "Signals",
      value: String(signals.length),
      detail: signals.length ? "Visible cues from the current report summary." : "No report signals surfaced yet."
    },
    {
      label: "Workload",
      value: workload?.shortLabel || workload?.label || "Unknown",
      detail: workload?.id || "No workload id"
    },
    {
      label: "Updated",
      value: formatTimestamp(item.updatedAt),
      detail: `Job ${item.jobId}`
    }
  ];

  const previewLinks = selectedArtifact
    ? [
        {
          href: `/report.html?jobId=${encodeURIComponent(item.jobId)}&artifact=${encodeURIComponent(selectedArtifact)}`,
          label: `Open full ${artifactLabels[selectedArtifact] || "report"}`,
          variant: "primary",
          kind: "link"
        }
      ]
    : [];
  const downloadLinks = getDownloadArtifactsForItem(item).map((artifactName) => ({
    href: item.artifacts[artifactName],
    label: downloadLabels[artifactName] || `Download ${artifactName}`,
    variant: artifactName.endsWith("Pdf") ? "download" : "subtle",
    kind: "download"
  }));

  const previewCacheKey = selectedArtifact ? createPreviewCacheKey(item.jobId, selectedArtifact) : null;
  const previewState = previewCacheKey ? state.previewCache.get(previewCacheKey) : null;

  detailPanel.innerHTML = `
    <div class="detail-header">
      <div>
        <p class="eyebrow detail-eyebrow">${escapeHtml(workload?.label || "Workload")}</p>
        <h3>${escapeHtml(item.fileName)}</h3>
        <p class="detail-subtitle">${escapeHtml(item.relativePath || item.fileName)}</p>
      </div>
      <span class="status-pill status-${escapeHtml(sanitizeStatusToken(item.status))}">${escapeHtml(
        formatStatus(item.status)
      )}</span>
    </div>

    <div class="report-summary-grid detail-stat-grid">
      ${renderSummaryCards(cards)}
    </div>

    <section class="detail-section">
      <div class="section-heading compact-heading">
        <h4>Signals</h4>
        <span>${escapeHtml(String(signals.length))} visible</span>
      </div>
      ${
        signals.length
          ? `<div class="finding-list">${signals.map((signal) => `<span class="finding-chip">${escapeHtml(signal)}</span>`).join("")}</div>`
          : `<p class="report-note">No inline signals are available yet for this job.</p>`
      }
      ${item.error ? `<p class="report-note emphasis-note">${escapeHtml(item.error)}</p>` : ""}
    </section>

    <section class="detail-section">
      <div class="section-heading compact-heading">
        <h4>Actions</h4>
        <span>${escapeHtml(String(previewLinks.length + downloadLinks.length))} link${previewLinks.length + downloadLinks.length === 1 ? "" : "s"}</span>
      </div>
      <div class="detail-link-grid">
        ${[...previewLinks, ...downloadLinks]
          .map(
            (link) => `
              ${
                link.kind === "download"
                  ? `
                    <button
                      class="action-link ${link.variant || "subtle"} compact-link button-link"
                      type="button"
                      data-download-url="${escapeHtml(link.href)}"
                      data-download-name="${escapeHtml(link.label)}"
                    >
                      ${escapeHtml(link.label)}
                    </button>
                  `
                  : `
                    <a class="action-link ${link.variant || "subtle"} compact-link" href="${escapeHtml(link.href)}">
                      ${escapeHtml(link.label)}
                    </a>
                  `
              }
            `
          )
          .join("")}
      </div>
    </section>

    <section class="detail-section detail-preview-shell">
      <div class="section-heading compact-heading">
        <h4>Inline preview</h4>
        <span>${selectedArtifact ? escapeHtml(artifactLabels[selectedArtifact] || selectedArtifact) : "No preview"}</span>
      </div>
      ${
        previewArtifacts.length
          ? `
            <div class="detail-preview-tabs">
              ${previewArtifacts
                .map(
                  (artifactName) => `
                    <button
                      class="detail-preview-tab ${artifactName === selectedArtifact ? "is-active" : ""}"
                      type="button"
                      data-preview-artifact="${escapeHtml(artifactName)}"
                      data-job-id="${escapeHtml(item.jobId)}"
                    >
                      ${escapeHtml(artifactLabels[artifactName] || artifactName)}
                    </button>
                  `
                )
                .join("")}
            </div>
            <div class="detail-preview-body">
              ${renderInlinePreviewBody(previewState, selectedArtifact)}
            </div>
          `
          : `<div class="empty-detail">This workload does not expose a browser-renderable artifact for the selected job yet.</div>`
      }
    </section>
  `;

  if (selectedArtifact) {
    void ensurePreviewLoaded(item, selectedArtifact);
  }
}

async function ensurePreviewLoaded(item, artifactName) {
  if (!item?.artifacts?.[artifactName]) {
    return;
  }

  const cacheKey = createPreviewCacheKey(item.jobId, artifactName);
  if (state.previewCache.has(cacheKey)) {
    return;
  }

  state.previewCache.set(cacheKey, { status: "loading" });
  if (item.jobId === state.selectedJobId && getPreviewSelection(item) === artifactName) {
    renderDetailPanel();
  }

  try {
    const [response, tagDeltaResponse] = await Promise.all([
      fetchWithAuth(item.artifacts[artifactName], { auth: "api" }),
      artifactName !== "tagDeltaReport" && item.artifacts?.tagDeltaReport
        ? fetchWithAuth(item.artifacts.tagDeltaReport, { auth: "api" })
        : Promise.resolve(null)
    ]);
    const report = await response.json();
    if (!response.ok) {
      throw new Error(report.error || `Unable to load ${artifactName}.`);
    }

    let tagDelta = null;
    if (tagDeltaResponse) {
      const tagDeltaPayload = await tagDeltaResponse.json();
      if (tagDeltaResponse.ok) {
        tagDelta = tagDeltaPayload;
      }
    }

    state.previewCache.set(cacheKey, {
      status: "ready",
      report,
      view: buildArtifactView(report, artifactName, { compact: true, tagDelta })
    });
  } catch (error) {
    state.previewCache.set(cacheKey, {
      status: "error",
      error: error.message
    });
  }

  if (item.jobId === state.selectedJobId && getPreviewSelection(item) === artifactName) {
    renderDetailPanel();
  }
}

function render() {
  renderSessionChrome();
  updateActionAvailability();
  renderHeroStats();
  renderWorkloads();
  renderSelectionTable();
  renderBatchOverview();
  renderResultsTable();
  renderDetailPanel();
}

function updateSelectionState() {
  const queue = summarizeSelectionQueue();
  if (!queue.count) {
    setIntakeMessage("Nothing queued yet.");
  } else {
    setIntakeMessage(`${queue.count} PDF${queue.count === 1 ? "" : "s"} ready in ${formatBytes(queue.bytes)}.`);
  }

  render();
}

function toSelectionRecord(file, relativePath, source) {
  return {
    key: `${relativePath}::${file.size}::${file.lastModified}`,
    file,
    relativePath,
    source,
    workloadId: state.selectedWorkloadId,
    workloadLabel: getSelectedWorkload()?.label || "Workload"
  };
}

function addSelections(records) {
  const dedupe = new Map(state.selections.map((item) => [item.key, item]));
  for (const record of records) {
    dedupe.set(record.key, record);
  }

  state.selections = [...dedupe.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  updateSelectionState();
}

function extractRelativePath(file, fallbackPath) {
  const relativePath = file.webkitRelativePath || fallbackPath || file.name;
  return String(relativePath || file.name).replace(/^[/\\]+/, "");
}

function queueInputFiles(fileList, sourceLabel) {
  const pdfFiles = [...fileList].filter((file) => file.name.toLowerCase().endsWith(".pdf"));
  const records = pdfFiles.map((file) => toSelectionRecord(file, extractRelativePath(file, file.name), sourceLabel));

  addSelections(records);
}

function readEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];

    function drain() {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(entries);
            return;
          }

          entries.push(...batch);
          drain();
        },
        (error) => reject(error)
      );
    }

    drain();
  });
}

async function readDropEntry(entry, parentPath = "") {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });

    return file.name.toLowerCase().endsWith(".pdf")
      ? [toSelectionRecord(file, relativePath, "Drag and drop")]
      : [];
  }

  if (!entry.isDirectory) {
    return [];
  }

  const childEntries = await readEntries(entry.createReader());
  const nested = await Promise.all(childEntries.map((child) => readDropEntry(child, relativePath)));
  return nested.flat();
}

async function collectDroppedSelections(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const withEntries = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (withEntries.length) {
    const nested = await Promise.all(withEntries.map((entry) => readDropEntry(entry)));
    return nested.flat();
  }

  return [...(dataTransfer.files || [])]
    .filter((file) => file.name.toLowerCase().endsWith(".pdf"))
    .map((file) => toSelectionRecord(file, file.name, "Drag and drop"));
}

function clearPolling() {
  if (state.pollHandle) {
    window.clearTimeout(state.pollHandle);
    state.pollHandle = null;
  }
}

async function pollBatch(batchId) {
  try {
    state.batch = await fetchJson(`/batches/${encodeURIComponent(batchId)}`, { auth: "api" });
    const batch = state.batch;
    if (!state.selectedJobId && batch.items[0]) {
      state.selectedJobId = batch.items[0].jobId;
    }
    render();

    if (batch.status === "processing") {
      state.pollHandle = window.setTimeout(() => {
        void pollBatch(batchId);
      }, 1200);
      return;
    }

    clearPolling();
  } catch (error) {
    clearPolling();
    setIntakeMessage(error.message);
    render();
  }
}

async function pollJob(jobId) {
  try {
    const job = await fetchJson(`/jobs/${encodeURIComponent(jobId)}`, { auth: "api" });
    state.batch = buildSingleJobBatch(job);
    state.selectedJobId = job.jobId;
    render();

    if (isLiveJobStatus(job.status)) {
      state.pollHandle = window.setTimeout(() => {
        void pollJob(jobId);
      }, 1200);
      return;
    }

    clearPolling();
  } catch (error) {
    clearPolling();
    setIntakeMessage(error.message);
    render();
  }
}

async function startBatch() {
  if (!hasWorkspaceAccess()) {
    setIntakeMessage("Unlock the workspace before starting a batch.");
    return;
  }

  if (!state.selections.length) {
    setIntakeMessage("Queue at least one PDF before starting a batch.");
    return;
  }

  startBatchButton.disabled = true;
  clearPolling();
  setIntakeMessage(`Uploading ${state.selections.length} queued PDF${state.selections.length === 1 ? "" : "s"}.`);

  try {
    const formData = new FormData();
    formData.append("workloadId", state.selectedWorkloadId);

    for (const item of state.selections) {
      formData.append("files", item.file);
      formData.append("relativePaths", item.relativePath);
    }

    const response = await fetchWithAuth("/process-pdf-upload", {
      auth: "api",
      method: "POST",
      body: formData
    });
    const batch = await response.json();
    if (!response.ok) {
      throw new Error(batch.error || "The batch could not be created.");
    }

    state.batch = batch;
    state.selectedJobId = batch.items[0]?.jobId || null;
    setIntakeMessage(`Batch ${batch.batchId.slice(0, 8)} created for ${batch.items.length} PDF${batch.items.length === 1 ? "" : "s"}.`);
    render();

    if (batch.status === "processing") {
      void pollBatch(batch.batchId);
    }
  } catch (error) {
    setIntakeMessage(error.message);
    render();
  } finally {
    startBatchButton.disabled = false;
  }
}

async function startUrlJob() {
  if (!hasWorkspaceAccess()) {
    setIntakeMessage("Unlock the workspace before starting a remote job.");
    return;
  }

  const fileUrl = String(urlInput.value || "").trim();
  if (!fileUrl) {
    setIntakeMessage("Enter a remote PDF URL before starting the selected workload.");
    return;
  }

  startUrlJobButton.disabled = true;
  clearPolling();
  setIntakeMessage(`Fetching ${fileUrl}.`);

  try {
    const response = await fetchWithAuth("/process-pdf-url", {
      auth: "api",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileUrl,
        workloadId: state.selectedWorkloadId
      })
    });
    const job = await response.json();
    if (!response.ok) {
      throw new Error(job.error || "The remote job could not be created.");
    }

    state.batch = buildSingleJobBatch(job);
    state.selectedJobId = job.jobId;
    setIntakeMessage(
      `Remote job ${job.jobId.slice(0, 8)} created for ${job.fileName || fileUrl}.`
    );
    render();

    if (isLiveJobStatus(job.status)) {
      void pollJob(job.jobId);
    }
  } catch (error) {
    setIntakeMessage(error.message);
    render();
  } finally {
    startUrlJobButton.disabled = false;
  }
}

async function loadWorkloads() {
  if (!hasWorkspaceAccess()) {
    state.workloads = [...fallbackWorkloads];
    render();
    return;
  }

  try {
    const payload = await fetchJson("/workloads", { auth: "api" });

    if (Array.isArray(payload.workloads) && payload.workloads.length) {
      state.workloads = payload.workloads;
      if (!state.workloads.some((workload) => workload.id === state.selectedWorkloadId)) {
        state.selectedWorkloadId = state.workloads[0].id;
      }
    }
  } catch (error) {
    state.workloads = [...fallbackWorkloads];
    setIntakeMessage(`${error.message} Falling back to the default workload.`);
  }

  render();
}

async function initializeAccess() {
  state.authConfig = await loadAuthConfig();

  if (state.authConfig.publicMode) {
    setAuthMessage("Public mode is enabled. Protected headers are not required in this tab.");
    render();
    await loadWorkloads();
    return;
  }

  const access = getSessionAccess();
  if (access.admin) {
    setAuthMessage("Admin access is active in this tab.");
  } else if (access.api) {
    setAuthMessage("API access is active in this tab.");
  } else {
    setAuthMessage("Enter an API key or admin key to use protected workspace actions.");
  }

  render();

  if (hasWorkspaceAccess()) {
    await loadWorkloads();
  }
}

async function unlockWorkspace(event) {
  event.preventDefault();

  authSubmitButton.disabled = true;
  setAuthMessage("Verifying the supplied key.");

  try {
    const payload = await verifyAndStoreAccess({
      key: authKeyInput.value,
      admin: false
    });

    authKeyInput.value = "";
    setAuthMessage(payload.access?.admin ? "Admin access is active in this tab." : "API access is active in this tab.");
    render();
    await loadWorkloads();
  } catch (error) {
    setAuthMessage(error.message);
    render();
  } finally {
    authSubmitButton.disabled = false;
  }
}

async function handleDownloadClick(event) {
  const button = event.target.closest("[data-download-url]");
  if (!button) {
    return;
  }

  const url = button.getAttribute("data-download-url");
  const filename = button.getAttribute("data-download-name") || undefined;
  if (!url) {
    return;
  }

  button.disabled = true;

  try {
    await downloadWithAuth(url, { auth: "api", filename });
    setIntakeMessage("Artifact download started.");
  } catch (error) {
    setIntakeMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

function handlePreviewTabClick(event) {
  const button = event.target.closest("[data-preview-artifact]");
  if (!button) {
    return;
  }

  const jobId = button.getAttribute("data-job-id");
  const artifactName = button.getAttribute("data-preview-artifact");
  if (!jobId || !artifactName) {
    return;
  }

  state.selectedJobId = jobId;
  setPreviewSelection(jobId, artifactName);
  render();

  const item = state.batch?.items?.find((candidate) => candidate.jobId === jobId);
  if (item) {
    void ensurePreviewLoaded(item, artifactName);
  }
}

workloadList.addEventListener("click", (event) => {
  if (!hasWorkspaceAccess()) {
    setIntakeMessage("Unlock the workspace before choosing a workload.");
    return;
  }

  const button = event.target.closest("[data-workload-id]");
  if (!button) {
    return;
  }

  state.selectedWorkloadId = button.getAttribute("data-workload-id");
  render();
});

resultsBody.addEventListener("click", (event) => {
  void handleDownloadClick(event);

  const button = event.target.closest("[data-job-id]");
  if (!button) {
    return;
  }

  state.selectedJobId = button.getAttribute("data-job-id");
  render();
});

detailPanel.addEventListener("click", (event) => {
  void handleDownloadClick(event);
  handlePreviewTabClick(event);
});

authForm.addEventListener("submit", (event) => {
  void unlockWorkspace(event);
});

clearSessionButton.addEventListener("click", async () => {
  clearPolling();
  clearStoredKeys();
  state.batch = null;
  state.selectedJobId = null;
  state.previewCache.clear();
  setAuthMessage("Session keys cleared from this tab.");
  render();
  await loadWorkloads();
});

dropzone.addEventListener("click", () => {
  if (!hasWorkspaceAccess()) {
    setIntakeMessage("Unlock the workspace before queueing PDFs.");
    return;
  }

  filePicker.click();
});
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (!hasWorkspaceAccess()) {
      setIntakeMessage("Unlock the workspace before queueing PDFs.");
      return;
    }
    filePicker.click();
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-active");
  });
}

for (const eventName of ["dragleave", "dragend", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-active");
  });
}

dropzone.addEventListener("drop", async (event) => {
  if (!hasWorkspaceAccess()) {
    setIntakeMessage("Unlock the workspace before queueing PDFs.");
    return;
  }

  const records = await collectDroppedSelections(event.dataTransfer);
  addSelections(records);
});

filePicker.addEventListener("change", () => {
  queueInputFiles(filePicker.files, "File picker");
  filePicker.value = "";
});

directoryPicker.addEventListener("change", () => {
  queueInputFiles(directoryPicker.files, "Folder picker");
  directoryPicker.value = "";
});

clearSelectionButton.addEventListener("click", () => {
  state.selections = [];
  updateSelectionState();
});

startBatchButton.addEventListener("click", () => {
  void startBatch();
});

startUrlJobButton.addEventListener("click", () => {
  void startUrlJob();
});

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void startUrlJob();
  }
});

updateSelectionState();
void initializeAccess();
