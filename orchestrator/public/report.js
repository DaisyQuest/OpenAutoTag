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
  getSessionAccess,
  loadAuthConfig,
  verifyAndStoreAccess
} from "./auth-client.js";

const reportTitle = document.querySelector("#report-title");
const reportSubtitle = document.querySelector("#report-subtitle");
const reportJobStatus = document.querySelector("#report-job-status strong");
const reportArtifactCount = document.querySelector("#report-artifact-count");
const reportTabs = document.querySelector("#report-tabs");
const reportLinks = document.querySelector("#report-links");
const reportSummary = document.querySelector("#report-summary");
const reportContent = document.querySelector("#report-content");
const reportRawJson = document.querySelector("#report-raw-json");
const sessionPill = document.querySelector("#session-pill");
const clearSessionButton = document.querySelector("#clear-session");
const authCaption = document.querySelector("#auth-caption");
const authCopy = document.querySelector("#auth-copy");
const authForm = document.querySelector("#auth-form");
const authKeyInput = document.querySelector("#auth-key");
const authSubmitButton = document.querySelector("#auth-submit");
const authMessage = document.querySelector("#auth-message");

const search = new URLSearchParams(window.location.search);
const jobId = search.get("jobId");
const requestedArtifact = search.get("artifact");

const fallbackPreviewArtifacts = ["redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"];
const fallbackDownloadArtifacts = [
  "taggedPdf",
  "redactedPdf",
  "redactionReport",
  "validationReport",
  "tagDeltaReport",
  "writerReport",
  "tagManifest"
];
const downloadLabels = {
  taggedPdf: "Download tagged PDF",
  redactedPdf: "Download redacted PDF",
  validationReport: "Download validation report",
  tagDeltaReport: "Download tag delta",
  writerReport: "Download writer report",
  tagManifest: "Download tag tree",
  redactionReport: "Download redaction report"
};

let authConfig = null;

function hasWorkspaceAccess() {
  return Boolean(authConfig?.publicMode || getSessionAccess().api);
}

function createQuery(jobIdValue, artifactName) {
  return `/report.html?jobId=${encodeURIComponent(jobIdValue)}&artifact=${encodeURIComponent(artifactName)}`;
}

function createArtifactUrl(jobIdValue, artifactName) {
  return `/jobs/${encodeURIComponent(jobIdValue)}/artifacts/${encodeURIComponent(artifactName)}`;
}

function getPreviewArtifacts(job) {
  const preferred = job.workload?.previewArtifacts?.length ? job.workload.previewArtifacts : fallbackPreviewArtifacts;
  return preferred.filter((artifactName) => job.artifacts?.[artifactName]);
}

function getDownloadArtifacts(job) {
  const preferred = job.workload?.downloadArtifacts?.length ? job.workload.downloadArtifacts : fallbackDownloadArtifacts;
  return preferred.filter((artifactName) => job.artifacts?.[artifactName]);
}

function setAuthMessage(message) {
  authMessage.textContent = message;
}

function renderSessionChrome() {
  const access = getSessionAccess();
  const publicMode = Boolean(authConfig?.publicMode);

  let label = "Locked";
  let description = "Reports use the same session-scoped workspace key as the dashboard.";

  if (publicMode) {
    label = "Public mode";
    description = "This workspace is open. Protected headers are not required.";
  } else if (access.admin) {
    label = "Admin session";
    description = "Admin access is active in this tab and can open protected report artifacts.";
  } else if (access.api) {
    label = "API session";
    description = "API access is active in this tab and can open protected report artifacts.";
  }

  sessionPill.textContent = label;
  authCaption.textContent = label;
  authCopy.textContent = description;
  authForm.hidden = publicMode;
  authKeyInput.disabled = publicMode;
  authSubmitButton.disabled = publicMode;
  clearSessionButton.disabled = publicMode && !access.api && !access.admin;
}

function renderArtifactTabs(job, activeArtifact) {
  const availableArtifacts = getPreviewArtifacts(job);

  reportArtifactCount.textContent = `${availableArtifacts.length} available`;
  reportTabs.innerHTML = availableArtifacts
    .map(
      (artifactName) => `
        <a class="report-tab ${artifactName === activeArtifact ? "is-active" : ""}" href="${createQuery(job.jobId, artifactName)}">
          <span>${escapeHtml(artifactLabels[artifactName] || artifactName)}</span>
        </a>
      `
    )
    .join("");

  const links = [];

  for (const artifactName of getDownloadArtifacts(job)) {
    links.push(`
      <button
        class="action-link ${artifactName.endsWith("Pdf") ? "primary" : "subtle"} button-link"
        type="button"
        data-download-url="${escapeHtml(createArtifactUrl(job.jobId, artifactName))}"
        data-download-name="${escapeHtml(downloadLabels[artifactName] || artifactName)}"
      >
        ${escapeHtml(downloadLabels[artifactName] || `Download ${artifactName}`)}
      </button>
    `);
  }

  if (job.artifacts?.[activeArtifact]) {
    links.push(`
      <button
        class="action-link subtle button-link"
        type="button"
        data-download-url="${escapeHtml(createArtifactUrl(job.jobId, activeArtifact))}"
        data-download-name="${escapeHtml(`${artifactLabels[activeArtifact] || activeArtifact}.json`)}"
      >
        Download raw JSON
      </button>
    `);
  }

  reportLinks.innerHTML = links.join("");
}

function renderLocked(message) {
  reportTitle.textContent = "Unlock required";
  reportSubtitle.textContent = message;
  reportJobStatus.textContent = "Locked";
  reportSummary.innerHTML = renderSummaryCards([
    {
      label: "Access",
      value: "Required",
      tone: "danger",
      detail: message
    }
  ]);
  reportArtifactCount.textContent = "0 available";
  reportTabs.innerHTML = "";
  reportLinks.innerHTML = "";
  reportContent.innerHTML = `<div class="empty-report">${escapeHtml(message)}</div>`;
  reportRawJson.textContent = "";
}

function renderError(message) {
  reportTitle.textContent = "Report unavailable";
  reportSubtitle.textContent = message;
  reportJobStatus.textContent = "Unavailable";
  reportSummary.innerHTML = renderSummaryCards([
    {
      label: "Status",
      value: "Error",
      tone: "danger",
      detail: message
    }
  ]);
  reportArtifactCount.textContent = "0 available";
  reportTabs.innerHTML = "";
  reportLinks.innerHTML = "";
  reportContent.innerHTML = `<div class="empty-report">${escapeHtml(message)}</div>`;
  reportRawJson.textContent = "";
}

async function loadReport() {
  if (!jobId) {
    renderError("A jobId query parameter is required.");
    return;
  }

  renderSessionChrome();

  if (!hasWorkspaceAccess()) {
    renderLocked("Enter an API key or admin key to load protected report data.");
    return;
  }

  const job = await fetchJson(`/jobs/${encodeURIComponent(jobId)}`, { auth: "api" });
  const availableArtifacts = Object.keys(job.artifacts || {});
  const activeArtifact =
    requestedArtifact && availableArtifacts.includes(requestedArtifact)
      ? requestedArtifact
      : getPreviewArtifacts(job)[0] || job.workload?.primaryArtifact || null;

  if (!activeArtifact) {
    throw new Error("This job does not expose a browser-renderable report artifact yet.");
  }

  reportTitle.textContent = `${artifactLabels[activeArtifact] || activeArtifact} for ${
    job.input?.filePath?.split(/[\\/]/).pop() || "job"
  }`;
  reportSubtitle.textContent = job.input?.filePath || "Artifact report";
  reportJobStatus.textContent = formatStatus(job.status);

  renderArtifactTabs(job, activeArtifact);

  const [artifactResponse, tagDeltaResponse] = await Promise.all([
    fetchWithAuth(createArtifactUrl(job.jobId, activeArtifact), { auth: "api" }),
    activeArtifact !== "tagDeltaReport" && job.artifacts?.tagDeltaReport
      ? fetchWithAuth(createArtifactUrl(job.jobId, "tagDeltaReport"), { auth: "api" })
      : Promise.resolve(null)
  ]);
  const report = await artifactResponse.json();

  if (!artifactResponse.ok) {
    throw new Error(report.error || `Unable to load ${activeArtifact}.`);
  }

  let tagDelta = null;
  if (tagDeltaResponse) {
    const tagDeltaPayload = await tagDeltaResponse.json();
    if (tagDeltaResponse.ok) {
      tagDelta = tagDeltaPayload;
    }
  }

  const view = buildArtifactView(report, activeArtifact, { compact: false, tagDelta });
  reportSummary.innerHTML = renderSummaryCards(view.summaryCards);
  reportContent.innerHTML = view.contentHtml;
  reportRawJson.textContent = JSON.stringify(report, null, 2);
}

async function unlockReport(event) {
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
    await loadReport();
  } catch (error) {
    renderSessionChrome();
    renderLocked(error.message);
    setAuthMessage(error.message);
  } finally {
    authSubmitButton.disabled = false;
  }
}

reportLinks.addEventListener("click", async (event) => {
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
    setAuthMessage("Artifact download started.");
  } catch (error) {
    setAuthMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

authForm.addEventListener("submit", (event) => {
  void unlockReport(event);
});

clearSessionButton.addEventListener("click", async () => {
  clearStoredKeys();
  setAuthMessage("Session keys cleared from this tab.");
  renderSessionChrome();
  renderLocked("Enter an API key or admin key to load protected report data.");
});

async function initialize() {
  authConfig = await loadAuthConfig();

  if (authConfig.publicMode) {
    setAuthMessage("Public mode is enabled. Protected headers are not required in this tab.");
  } else if (getSessionAccess().admin) {
    setAuthMessage("Admin access is active in this tab.");
  } else if (getSessionAccess().api) {
    setAuthMessage("API access is active in this tab.");
  } else {
    setAuthMessage("Enter an API key or admin key to load protected report data.");
  }

  renderSessionChrome();

  try {
    await loadReport();
  } catch (error) {
    renderSessionChrome();
    renderError(error.message);
  }
}

void initialize();
