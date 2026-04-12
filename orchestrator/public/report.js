import {
  artifactLabels,
  buildArtifactView,
  escapeHtml,
  formatStatus,
  renderSummaryCards
} from "./report-renderers.js";

const reportTitle = document.querySelector("#report-title");
const reportSubtitle = document.querySelector("#report-subtitle");
const reportJobStatus = document.querySelector("#report-job-status strong");
const reportArtifactCount = document.querySelector("#report-artifact-count");
const reportTabs = document.querySelector("#report-tabs");
const reportLinks = document.querySelector("#report-links");
const reportSummary = document.querySelector("#report-summary");
const reportContent = document.querySelector("#report-content");
const reportRawJson = document.querySelector("#report-raw-json");

const search = new URLSearchParams(window.location.search);
const jobId = search.get("jobId");
const requestedArtifact = search.get("artifact");

const fallbackPreviewArtifacts = ["redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"];
const fallbackDownloadArtifacts = ["taggedPdf", "redactedPdf", "redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"];
const downloadLabels = {
  taggedPdf: "Download tagged PDF",
  redactedPdf: "Download redacted PDF",
  validationReport: "Download validation report",
  tagDeltaReport: "Download tag delta",
  writerReport: "Download writer report",
  tagManifest: "Download tag tree",
  redactionReport: "Download redaction report"
};

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
    links.push(
      `<a class="action-link ${artifactName.endsWith("Pdf") ? "primary" : "subtle"}" href="${createArtifactUrl(job.jobId, artifactName)}" target="_blank" rel="noreferrer">${escapeHtml(
        downloadLabels[artifactName] || `Download ${artifactName}`
      )}</a>`
    );
  }

  if (job.artifacts?.[activeArtifact]) {
    links.push(
      `<a class="action-link subtle" href="${createArtifactUrl(job.jobId, activeArtifact)}" target="_blank" rel="noreferrer">Open raw JSON</a>`
    );
  }

  reportLinks.innerHTML = links.join("");
}

function renderError(message) {
  reportTitle.textContent = "Report unavailable";
  reportSubtitle.textContent = message;
  reportJobStatus.textContent = "Unavailable";
  reportSummary.innerHTML = renderSummaryCards([
    {
      label: "Status",
      value: "Error",
      tone: "danger"
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

  const jobResponse = await fetch(`/jobs/${encodeURIComponent(jobId)}`);
  const job = await jobResponse.json();

  if (!jobResponse.ok) {
    throw new Error(job.error || "Unable to load the requested job.");
  }

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
    fetch(createArtifactUrl(job.jobId, activeArtifact)),
    activeArtifact !== "tagDeltaReport" && job.artifacts?.tagDeltaReport
      ? fetch(createArtifactUrl(job.jobId, "tagDeltaReport"))
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

loadReport().catch((error) => {
  renderError(error.message);
});
