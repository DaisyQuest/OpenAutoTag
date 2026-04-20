import { downloadWithAuth, fetchJson, formatBytes, formatTimestamp } from "../auth-client.js";
import { buildArtifactView, escapeHtml, formatStatus, renderSummaryCards } from "../report-renderers.js";
import {
  clearAdminSession,
  hasAdminAccess,
  initializeAdminPage,
  renderAdminSessionChrome,
  unlockAdminPage
} from "./admin-shell.js";

const initialSearch = new URLSearchParams(window.location.search);

const state = {
  authConfig: null,
  pollHandle: null,
  payload: null,
  previewCache: new Map(),
  selectedArtifactId: null,
  filters: {
    query: "",
    kind: "all",
    status: "all"
  }
};

const sessionPill = document.querySelector("#session-pill");
const clearSessionButton = document.querySelector("#clear-session");
const authCaption = document.querySelector("#auth-caption");
const authCopy = document.querySelector("#auth-copy");
const authForm = document.querySelector("#auth-form");
const authKeyInput = document.querySelector("#auth-key");
const authSubmitButton = document.querySelector("#auth-submit");
const authMessage = document.querySelector("#auth-message");
const artifactHeroSummary = document.querySelector("#artifact-hero-summary");
const artifactTableCaption = document.querySelector("#artifact-table-caption");
const artifactSearch = document.querySelector("#artifact-search");
const artifactKind = document.querySelector("#artifact-kind");
const artifactStatus = document.querySelector("#artifact-status");
const artifactTableBody = document.querySelector("#artifact-table-body");
const artifactPreviewTitle = document.querySelector("#artifact-preview-title");
const artifactPreviewSubtitle = document.querySelector("#artifact-preview-subtitle");
const artifactPreviewStatus = document.querySelector("#artifact-preview-status");
const artifactPreviewActions = document.querySelector("#artifact-preview-actions");
const artifactPreviewMeta = document.querySelector("#artifact-preview-meta");
const artifactPreviewSummary = document.querySelector("#artifact-preview-summary");
const artifactPreviewContent = document.querySelector("#artifact-preview-content");
const artifactPreviewRawJson = document.querySelector("#artifact-preview-raw-json");

function createArtifactId(jobId, artifactName) {
  return `${jobId}:${artifactName}`;
}

function setMessage(message) {
  authMessage.textContent = message;
}

function renderSessionChrome() {
  renderAdminSessionChrome({
    authConfig: state.authConfig,
    sessionPill,
    authCaption,
    authCopy,
    authForm,
    authKeyInput,
    authSubmitButton,
    clearSessionButton
  });
}

function clearPolling() {
  if (state.pollHandle) {
    window.clearTimeout(state.pollHandle);
    state.pollHandle = null;
  }
}

function renderDefinitionGrid(entries) {
  if (!entries.length) {
    return `
      <article class="definition-card">
        <span class="definition-label">Details</span>
        <strong>Unavailable</strong>
      </article>
    `;
  }

  return entries
    .map(
      (entry) => `
        <article class="definition-card">
          <span class="definition-label">${escapeHtml(entry.label)}</span>
          <strong>${escapeHtml(entry.value)}</strong>
        </article>
      `
    )
    .join("");
}

function renderLocked(message) {
  clearPolling();
  artifactHeroSummary.innerHTML = `
    <article class="summary-card summary-danger">
      <span class="summary-label">Access</span>
      <strong>Required</strong>
      <span class="summary-detail">${escapeHtml(message)}</span>
    </article>
  `;
  artifactTableCaption.textContent = "Locked";
  artifactTableBody.innerHTML = `
    <tr>
      <td colspan="7" class="empty-row">Enter an admin key to inspect emitted artifacts.</td>
    </tr>
  `;
  artifactPreviewTitle.textContent = "Artifact preview locked";
  artifactPreviewSubtitle.textContent = message;
  artifactPreviewStatus.className = "status-pill status-unknown";
  artifactPreviewStatus.textContent = "Locked";
  artifactPreviewActions.innerHTML = "";
  artifactPreviewMeta.innerHTML = renderDefinitionGrid([{ label: "Access", value: "Required" }]);
  artifactPreviewSummary.innerHTML = renderSummaryCards([
    {
      label: "Preview",
      value: "Locked",
      tone: "danger",
      detail: message
    }
  ]);
  artifactPreviewContent.innerHTML = `<div class="empty-report">${escapeHtml(message)}</div>`;
  artifactPreviewRawJson.textContent = "";
}

function getArtifacts() {
  return Array.isArray(state.payload?.artifacts) ? state.payload.artifacts : [];
}

function getFilteredArtifacts() {
  const query = state.filters.query.trim().toLowerCase();

  return getArtifacts().filter((artifact) => {
    if (state.filters.kind !== "all" && artifact.kind !== state.filters.kind) {
      return false;
    }

    if (state.filters.status !== "all" && artifact.jobStatus !== state.filters.status) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      artifact.documentName,
      artifact.documentPath,
      artifact.label,
      artifact.name,
      artifact.artifactFileName,
      artifact.jobId,
      artifact.workload?.label,
      artifact.workload?.id
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

function findArtifactById(artifactId, artifacts = getArtifacts()) {
  return artifacts.find((artifact) => artifact.id === artifactId) || null;
}

function getInitialSelectionId(artifacts) {
  const requestedJobId = initialSearch.get("jobId");
  const requestedArtifact = initialSearch.get("artifact");
  if (!requestedJobId || !requestedArtifact) {
    return null;
  }

  const requestedId = createArtifactId(requestedJobId, requestedArtifact);
  return artifacts.some((artifact) => artifact.id === requestedId) ? requestedId : null;
}

function syncSelection(filteredArtifacts) {
  const availableIds = new Set(filteredArtifacts.map((artifact) => artifact.id));

  if (!state.selectedArtifactId) {
    state.selectedArtifactId = getInitialSelectionId(filteredArtifacts);
  }

  if (state.selectedArtifactId && availableIds.has(state.selectedArtifactId)) {
    return findArtifactById(state.selectedArtifactId, filteredArtifacts);
  }

  const nextSelection = filteredArtifacts[0] || null;
  state.selectedArtifactId = nextSelection?.id || null;
  return nextSelection;
}

function updateSelectionUrl(artifact) {
  const url = new URL(window.location.href);

  if (artifact) {
    url.searchParams.set("jobId", artifact.jobId);
    url.searchParams.set("artifact", artifact.name);
  } else {
    url.searchParams.delete("jobId");
    url.searchParams.delete("artifact");
  }

  window.history.replaceState({}, "", url);
}

function renderInventorySummary(filteredArtifacts) {
  const summary = state.payload?.summary || {};

  artifactHeroSummary.innerHTML = renderSummaryCards([
    {
      label: "Artifacts",
      value: String(summary.totalArtifacts ?? 0),
      detail: `${filteredArtifacts.length} visible`
    },
    {
      label: "Browser previews",
      value: String(summary.previewableArtifacts ?? 0),
      detail: `${summary.jsonArtifacts ?? 0} JSON artifacts`
    },
    {
      label: "PDF outputs",
      value: String(summary.pdfArtifacts ?? 0),
      detail: formatBytes(summary.totalBytes ?? 0)
    }
  ]);
}

function renderArtifactTable(filteredArtifacts, selectedArtifact) {
  artifactTableCaption.textContent = `${filteredArtifacts.length} artifact${filteredArtifacts.length === 1 ? "" : "s"} visible`;

  if (!filteredArtifacts.length) {
    artifactTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-row">No artifacts match the current filters.</td>
      </tr>
    `;
    return;
  }

  artifactTableBody.innerHTML = filteredArtifacts
    .map((artifact) => {
      const isActive = selectedArtifact?.id === artifact.id;
      const actionHtml = artifact.browserPreviewable
        ? `
            <button class="action-link primary compact-link button-link" type="button" data-artifact-id="${escapeHtml(artifact.id)}">
              Preview
            </button>
          `
        : `
            <button
              class="action-link subtle compact-link button-link"
              type="button"
              data-download-url="${escapeHtml(artifact.url)}"
              data-download-name="${escapeHtml(artifact.artifactFileName || artifact.name)}"
            >
              Download
            </button>
          `;

      return `
        <tr class="result-row ${isActive ? "is-active" : ""}">
          <td>
            <button class="row-select" type="button" data-artifact-id="${escapeHtml(artifact.id)}">
              <strong class="table-primary">${escapeHtml(artifact.documentName)}</strong>
              <span class="table-note">${escapeHtml(artifact.documentPath || artifact.documentName)}</span>
            </button>
          </td>
          <td>
            <div class="table-cell-stack">
              <strong class="table-primary">${escapeHtml(artifact.label)}</strong>
              <span class="table-note">${escapeHtml(artifact.artifactFileName || artifact.name)}</span>
              <span class="table-note">${escapeHtml(artifact.contentType)}</span>
            </div>
          </td>
          <td class="table-secondary">${escapeHtml(artifact.workload?.label || artifact.workload?.id || "Unknown")}</td>
          <td>
            <span class="status-pill status-${escapeHtml(artifact.jobStatus)}">${escapeHtml(formatStatus(artifact.jobStatus))}</span>
          </td>
          <td class="table-secondary">${escapeHtml(formatTimestamp(artifact.updatedAt || artifact.jobUpdatedAt))}</td>
          <td class="table-secondary">${escapeHtml(formatBytes(artifact.sizeBytes || 0))}</td>
          <td>${actionHtml}</td>
        </tr>
      `;
    })
    .join("");
}

function renderPreviewSkeleton(artifact) {
  artifactPreviewTitle.textContent = artifact.label;
  artifactPreviewSubtitle.textContent = artifact.documentPath || artifact.documentName;
  artifactPreviewStatus.className = `status-pill status-${escapeHtml(artifact.jobStatus)}`;
  artifactPreviewStatus.textContent = formatStatus(artifact.jobStatus);
  artifactPreviewMeta.innerHTML = renderDefinitionGrid([
    { label: "Document", value: artifact.documentName },
    { label: "Artifact file", value: artifact.artifactFileName || artifact.name },
    { label: "Workload", value: artifact.workload?.label || artifact.workload?.id || "Unknown" },
    { label: "Kind", value: `${artifact.kind.toUpperCase()} / ${artifact.contentType}` },
    { label: "Updated", value: formatTimestamp(artifact.updatedAt || artifact.jobUpdatedAt) },
    { label: "Size", value: formatBytes(artifact.sizeBytes || 0) }
  ]);

  const actions = [
    `
      <button
        class="ghost-button button-link"
        type="button"
        data-download-url="${escapeHtml(artifact.url)}"
        data-download-name="${escapeHtml(artifact.artifactFileName || artifact.name)}"
      >
        Download artifact
      </button>
    `
  ];

  if (artifact.browserPreviewable) {
    actions.unshift(`
      <a class="ghost-link" href="${escapeHtml(artifact.reportUrl)}">
        Open standalone report
      </a>
    `);
  }

  artifactPreviewActions.innerHTML = actions.join("");
}

function renderNonJsonPreview(artifact) {
  renderPreviewSkeleton(artifact);
  artifactPreviewSummary.innerHTML = renderSummaryCards([
    {
      label: "Preview",
      value: artifact.kind === "pdf" ? "Download only" : "Binary artifact"
    },
    {
      label: "Content type",
      value: artifact.contentType
    },
    {
      label: "Availability",
      value: artifact.available ? "Ready" : "Missing",
      tone: artifact.available ? "" : "danger"
    }
  ]);
  artifactPreviewContent.innerHTML = `
    <section class="report-section">
      <div class="section-heading">
        <h2>Artifact output</h2>
        <span>${escapeHtml(artifact.kind.toUpperCase())}</span>
      </div>
      <div class="empty-report">
        ${
          artifact.kind === "pdf"
            ? "PDF outputs currently download directly from this browser. Use the artifact action buttons above."
            : "This artifact is not JSON-renderable in the browser yet. Use the download action to inspect the raw file."
        }
      </div>
    </section>
  `;
  artifactPreviewRawJson.textContent = "";
}

function renderPreviewError(artifact, message) {
  renderPreviewSkeleton(artifact);
  artifactPreviewSummary.innerHTML = renderSummaryCards([
    {
      label: "Preview",
      value: "Error",
      tone: "danger",
      detail: message
    }
  ]);
  artifactPreviewContent.innerHTML = `<div class="empty-report">${escapeHtml(message)}</div>`;
  artifactPreviewRawJson.textContent = "";
}

async function getPreviewPayload(artifact) {
  if (state.previewCache.has(artifact.id)) {
    return state.previewCache.get(artifact.id);
  }

  const tagDeltaArtifact =
    artifact.name !== "tagDeltaReport"
      ? getArtifacts().find((candidate) => candidate.jobId === artifact.jobId && candidate.name === "tagDeltaReport")
      : null;

  const [report, tagDelta] = await Promise.all([
    fetchJson(artifact.url, { auth: "admin" }),
    tagDeltaArtifact ? fetchJson(tagDeltaArtifact.url, { auth: "admin" }).catch(() => null) : Promise.resolve(null)
  ]);

  const payload = { report, tagDelta };
  state.previewCache.set(artifact.id, payload);
  return payload;
}

async function renderPreview(selectedArtifact) {
  updateSelectionUrl(selectedArtifact);

  if (!selectedArtifact) {
    artifactPreviewTitle.textContent = "No artifact selected";
    artifactPreviewSubtitle.textContent = "Adjust the filters or choose an artifact from the table.";
    artifactPreviewStatus.className = "status-pill status-unknown";
    artifactPreviewStatus.textContent = "Idle";
    artifactPreviewActions.innerHTML = "";
    artifactPreviewMeta.innerHTML = renderDefinitionGrid([{ label: "Selection", value: "None" }]);
    artifactPreviewSummary.innerHTML = renderSummaryCards([
      {
        label: "Preview",
        value: "Unavailable"
      }
    ]);
    artifactPreviewContent.innerHTML = `<div class="empty-report">Choose an artifact to load a preview.</div>`;
    artifactPreviewRawJson.textContent = "";
    return;
  }

  renderPreviewSkeleton(selectedArtifact);

  if (!selectedArtifact.browserPreviewable) {
    renderNonJsonPreview(selectedArtifact);
    return;
  }

  artifactPreviewSummary.innerHTML = renderSummaryCards([
    {
      label: "Preview",
      value: "Loading"
    }
  ]);
  artifactPreviewContent.innerHTML = `<div class="empty-report">Rendering ${escapeHtml(selectedArtifact.label)}...</div>`;
  artifactPreviewRawJson.textContent = "";

  try {
    const { report, tagDelta } = await getPreviewPayload(selectedArtifact);
    const view = buildArtifactView(report, selectedArtifact.name, { compact: false, tagDelta });

    if (state.selectedArtifactId !== selectedArtifact.id) {
      return;
    }

    artifactPreviewSummary.innerHTML = renderSummaryCards(view.summaryCards);
    artifactPreviewContent.innerHTML = view.contentHtml;
    artifactPreviewRawJson.textContent = JSON.stringify(report, null, 2);
  } catch (error) {
    if (state.selectedArtifactId !== selectedArtifact.id) {
      return;
    }

    renderPreviewError(selectedArtifact, error.message);
  }
}

async function renderPage() {
  const filteredArtifacts = getFilteredArtifacts();
  const selectedArtifact = syncSelection(filteredArtifacts);
  renderInventorySummary(filteredArtifacts);
  renderArtifactTable(filteredArtifacts, selectedArtifact);
  await renderPreview(selectedArtifact);
}

async function loadData() {
  if (!hasAdminAccess(state.authConfig)) {
    renderLocked("Enter an admin key to load protected artifact metadata.");
    return;
  }

  state.payload = await fetchJson("/admin/artifacts", { auth: "admin" });
  await renderPage();

  clearPolling();
  state.pollHandle = window.setTimeout(() => {
    void loadData().catch((error) => {
      setMessage(error.message);
      renderLocked(error.message);
    });
  }, 4000);
}

function updateFilters() {
  state.filters.query = artifactSearch.value || "";
  state.filters.kind = artifactKind.value || "all";
  state.filters.status = artifactStatus.value || "all";
}

artifactSearch.addEventListener("input", () => {
  updateFilters();
  void renderPage();
});

artifactKind.addEventListener("change", () => {
  updateFilters();
  void renderPage();
});

artifactStatus.addEventListener("change", () => {
  updateFilters();
  void renderPage();
});

artifactTableBody.addEventListener("click", async (event) => {
  const downloadButton = event.target.closest("[data-download-url]");
  if (downloadButton) {
    downloadButton.disabled = true;

    try {
      await downloadWithAuth(downloadButton.getAttribute("data-download-url"), {
        auth: "admin",
        filename: downloadButton.getAttribute("data-download-name") || undefined
      });
      setMessage("Artifact download started.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      downloadButton.disabled = false;
    }

    return;
  }

  const trigger = event.target.closest("[data-artifact-id]");
  if (!trigger) {
    return;
  }

  state.selectedArtifactId = trigger.getAttribute("data-artifact-id");
  await renderPage();
});

artifactPreviewActions.addEventListener("click", async (event) => {
  const downloadButton = event.target.closest("[data-download-url]");
  if (!downloadButton) {
    return;
  }

  downloadButton.disabled = true;

  try {
    await downloadWithAuth(downloadButton.getAttribute("data-download-url"), {
      auth: "admin",
      filename: downloadButton.getAttribute("data-download-name") || undefined
    });
    setMessage("Artifact download started.");
  } catch (error) {
    setMessage(error.message);
  } finally {
    downloadButton.disabled = false;
  }
});

authForm.addEventListener("submit", (event) => {
  void unlockAdminPage(event, {
    state,
    setMessage,
    renderLocked,
    renderSessionChrome,
    loadData,
    authKeyInput,
    authSubmitButton
  });
});

clearSessionButton.addEventListener("click", () => {
  clearPolling();
  clearAdminSession({
    setMessage,
    renderLocked,
    renderSessionChrome
  });
});

void initializeAdminPage({
  state,
  setMessage,
  renderLocked,
  renderSessionChrome,
  loadData
});
