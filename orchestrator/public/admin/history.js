import { fetchJson, formatTimestamp, sanitizeStatusToken } from "../auth-client.js";
import { escapeHtml, formatStatus, renderSummaryCards } from "../report-renderers.js";
import {
  clearAdminSession,
  hasAdminAccess,
  initializeAdminPage,
  renderAdminSessionChrome,
  unlockAdminPage
} from "./admin-shell.js";

const state = {
  authConfig: null,
  pollHandle: null
};

const sessionPill = document.querySelector("#session-pill");
const clearSessionButton = document.querySelector("#clear-session");
const authCaption = document.querySelector("#auth-caption");
const authCopy = document.querySelector("#auth-copy");
const authForm = document.querySelector("#auth-form");
const authKeyInput = document.querySelector("#auth-key");
const authSubmitButton = document.querySelector("#auth-submit");
const authMessage = document.querySelector("#auth-message");
const historySummary = document.querySelector("#history-summary");
const historyTableCaption = document.querySelector("#history-table-caption");
const historyTableBody = document.querySelector("#history-table-body");

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

function renderLocked(message) {
  clearPolling();
  historySummary.innerHTML = `
    <article class="summary-card summary-danger">
      <span class="summary-label">Access</span>
      <strong>Required</strong>
      <span class="summary-detail">${escapeHtml(message)}</span>
    </article>
  `;
  historyTableCaption.textContent = "Locked";
  historyTableBody.innerHTML = `
    <tr>
      <td colspan="6" class="empty-row">Enter an admin key to inspect the job ledger.</td>
    </tr>
  `;
}

function renderHistory(payload) {
  historySummary.innerHTML = renderSummaryCards([
    {
      label: "Total jobs",
      value: String(payload.summary.total),
      detail: `${payload.summary.completed} completed / ${payload.summary.failed} failed`
    },
    {
      label: "Running",
      value: String(payload.summary.running),
      detail: `${payload.summary.queued} queued`
    },
    {
      label: "Generated",
      value: formatTimestamp(payload.generatedAt),
      detail: "Newest jobs first"
    }
  ]);

  historyTableCaption.textContent = `${payload.jobs.length} job${payload.jobs.length === 1 ? "" : "s"} tracked`;

  if (!payload.jobs.length) {
    historyTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-row">No jobs have been recorded yet.</td>
      </tr>
    `;
    return;
  }

  historyTableBody.innerHTML = payload.jobs
    .map((job) => {
      const primaryArtifact = job.artifactLinks?.redactionReport ? "redactionReport" : job.artifactLinks?.validationReport ? "validationReport" : null;

      return `
        <tr>
          <td>
            <div class="table-cell-stack">
              <strong class="table-primary">${escapeHtml(job.fileName)}</strong>
              <span class="table-note">${escapeHtml(job.relativePath || job.fileName)}</span>
            </div>
          </td>
          <td class="table-secondary">${escapeHtml(job.workload?.label || job.workload?.id || "Unknown")}</td>
          <td>
            <span class="status-pill status-${escapeHtml(sanitizeStatusToken(job.status))}">
              ${escapeHtml(formatStatus(job.status))}
            </span>
          </td>
          <td>
            <div class="table-cell-stack">
              <strong class="table-primary">${escapeHtml(job.summary?.label || formatStatus(job.status))}</strong>
              <span class="table-note">${escapeHtml(job.summary?.detail || job.error || "No additional detail")}</span>
            </div>
          </td>
          <td class="table-secondary">${escapeHtml(formatTimestamp(job.updatedAt))}</td>
          <td>
            ${
              primaryArtifact
                ? `
                  <a
                    class="action-link primary compact-link"
                    href="/report.html?jobId=${encodeURIComponent(job.jobId)}&artifact=${encodeURIComponent(primaryArtifact)}"
                  >
                    Open report
                  </a>
                `
                : `<span class="table-note">No browser report</span>`
            }
          </td>
        </tr>
      `;
    })
    .join("");
}

async function loadData() {
  if (!hasAdminAccess(state.authConfig)) {
    renderLocked("Enter an admin key to load protected monitoring data.");
    return;
  }

  const payload = await fetchJson("/admin/history", { auth: "admin" });
  renderHistory(payload);

  clearPolling();
  state.pollHandle = window.setTimeout(() => {
    void loadData().catch((error) => {
      setMessage(error.message);
      renderLocked(error.message);
    });
  }, 4000);
}

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
