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
const queueSummary = document.querySelector("#queue-summary");
const activeJobsCaption = document.querySelector("#active-jobs-caption");
const activeJobsBody = document.querySelector("#active-jobs-body");
const batchMonitorCaption = document.querySelector("#batch-monitor-caption");
const batchMonitorBody = document.querySelector("#batch-monitor-body");

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
  queueSummary.innerHTML = `
    <article class="summary-card summary-danger">
      <span class="summary-label">Access</span>
      <strong>Required</strong>
      <span class="summary-detail">${escapeHtml(message)}</span>
    </article>
  `;
  activeJobsCaption.textContent = "Locked";
  batchMonitorCaption.textContent = "Locked";
  activeJobsBody.innerHTML = `
    <tr>
      <td colspan="5" class="empty-row">Enter an admin key to inspect live jobs.</td>
    </tr>
  `;
  batchMonitorBody.innerHTML = `
    <tr>
      <td colspan="5" class="empty-row">Enter an admin key to inspect batch activity.</td>
    </tr>
  `;
}

function renderActiveJobs(jobs) {
  activeJobsCaption.textContent = `${jobs.length} active job${jobs.length === 1 ? "" : "s"}`;

  if (!jobs.length) {
    activeJobsBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-row">No jobs are currently queued or running.</td>
      </tr>
    `;
    return;
  }

  activeJobsBody.innerHTML = jobs
    .map(
      (job) => `
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
          <td class="table-secondary">${escapeHtml(formatTimestamp(job.updatedAt))}</td>
          <td>
            ${
              job.artifactLinks?.validationReport || job.artifactLinks?.redactionReport
                ? `
                  <a
                    class="action-link primary compact-link"
                    href="/report.html?jobId=${encodeURIComponent(job.jobId)}&artifact=${encodeURIComponent(
                      job.artifactLinks?.redactionReport ? "redactionReport" : "validationReport"
                    )}"
                  >
                    Open report
                  </a>
                `
                : `<span class="table-note">Waiting for artifacts</span>`
            }
          </td>
        </tr>
      `
    )
    .join("");
}

function renderBatches(batches) {
  batchMonitorCaption.textContent = `${batches.length} recent batch${batches.length === 1 ? "" : "es"}`;

  if (!batches.length) {
    batchMonitorBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-row">No batch activity has been recorded yet.</td>
      </tr>
    `;
    return;
  }

  batchMonitorBody.innerHTML = batches
    .map(
      (batch) => `
        <tr>
          <td>
            <div class="table-cell-stack">
              <strong class="table-primary">${escapeHtml(batch.batchId)}</strong>
              <span class="table-note">${escapeHtml(formatTimestamp(batch.createdAt))}</span>
            </div>
          </td>
          <td class="table-secondary">${escapeHtml(batch.workload?.label || batch.workload?.id || "Unknown")}</td>
          <td>
            <span class="status-pill status-${escapeHtml(sanitizeStatusToken(batch.status))}">
              ${escapeHtml(formatStatus(batch.status))}
            </span>
          </td>
          <td class="table-secondary">
            ${escapeHtml(`${batch.totals.completed} completed / ${batch.totals.failed} failed / ${batch.totals.total} total`)}
          </td>
          <td class="table-secondary">${escapeHtml(formatTimestamp(batch.updatedAt))}</td>
        </tr>
      `
    )
    .join("");
}

async function loadData() {
  if (!hasAdminAccess(state.authConfig)) {
    renderLocked("Enter an admin key to load protected monitoring data.");
    return;
  }

  const payload = await fetchJson("/admin/queue", { auth: "admin" });
  queueSummary.innerHTML = renderSummaryCards([
    {
      label: "Queued",
      value: String(payload.queue.queued),
      detail: `${payload.queue.pendingQueueDepth} waiting in memory`
    },
    {
      label: "Running",
      value: String(payload.queue.running),
      detail: `${payload.queue.completed} completed`
    },
    {
      label: "Batches",
      value: String(payload.totalBatches),
      detail: `${payload.recentJobs.length} recent jobs tracked`
    }
  ]);

  renderActiveJobs(payload.activeJobs);
  renderBatches(payload.batches);

  clearPolling();
  state.pollHandle = window.setTimeout(() => {
    void loadData().catch((error) => {
      setMessage(error.message);
      renderLocked(error.message);
    });
  }, 1500);
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
