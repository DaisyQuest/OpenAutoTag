import { fetchJson, formatBytes, formatDurationSeconds } from "../auth-client.js";
import { escapeHtml, renderSummaryCards } from "../report-renderers.js";
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
const systemSummary = document.querySelector("#system-summary");
const runtimeGrid = document.querySelector("#runtime-grid");
const processGrid = document.querySelector("#process-grid");
const authGrid = document.querySelector("#auth-grid");

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

function renderDefinitionGrid(target, entries) {
  target.innerHTML = entries
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
  systemSummary.innerHTML = `
    <article class="summary-card summary-danger">
      <span class="summary-label">Access</span>
      <strong>Required</strong>
      <span class="summary-detail">${escapeHtml(message)}</span>
    </article>
  `;
  renderDefinitionGrid(runtimeGrid, [{ label: "Runtime", value: "Locked" }]);
  renderDefinitionGrid(processGrid, [{ label: "Process", value: "Locked" }]);
  renderDefinitionGrid(authGrid, [{ label: "Auth posture", value: "Locked" }]);
}

async function loadData() {
  if (!hasAdminAccess(state.authConfig)) {
    renderLocked("Enter an admin key to load protected monitoring data.");
    return;
  }

  const payload = await fetchJson("/admin/system", { auth: "admin" });
  const usedHeap = Number(payload.process.memory.heapUsed || 0);
  const totalHeap = Number(payload.process.memory.heapTotal || 0);

  systemSummary.innerHTML = renderSummaryCards([
    {
      label: "Uptime",
      value: formatDurationSeconds(payload.process.uptimeSeconds),
      detail: `PID ${payload.process.pid}`
    },
    {
      label: "Heap used",
      value: formatBytes(usedHeap),
      detail: `${formatBytes(totalHeap)} total`
    },
    {
      label: "Queue depth",
      value: String(payload.queue.pendingQueueDepth),
      detail: `${payload.queue.running} running / ${payload.queue.completed} completed`
    }
  ]);

  renderDefinitionGrid(runtimeGrid, [
    { label: "Runtime root", value: payload.runtime.root },
    { label: "Jobs root", value: payload.runtime.jobsRoot },
    { label: "Upload root", value: payload.runtime.uploadRoot },
    { label: "Platform", value: `${payload.process.platform} / ${payload.process.arch}` },
    { label: "Node", value: payload.process.nodeVersion },
    { label: "Azure App Service", value: payload.runtime.azureAppService ? "Yes" : "No" }
  ]);

  renderDefinitionGrid(processGrid, [
    { label: "CPU count", value: String(payload.process.cpuCount) },
    { label: "RSS", value: formatBytes(payload.process.memory.rss) },
    { label: "External memory", value: formatBytes(payload.process.memory.external) },
    { label: "Array buffers", value: formatBytes(payload.process.memory.arrayBuffers) },
    { label: "Queued jobs", value: String(payload.queue.queued) },
    { label: "Active batches", value: String(payload.batchCount) }
  ]);

  renderDefinitionGrid(authGrid, [
    { label: "Private mode", value: payload.auth.publicMode ? "Disabled" : "Enabled" },
    { label: "Bootstrap API key", value: payload.auth.bootstrap.apiKeyConfigured ? "Configured" : "Not configured" },
    { label: "Bootstrap admin key", value: payload.auth.bootstrap.adminKeyConfigured ? "Configured" : "Not configured" },
    { label: "Active managed keys", value: String(payload.auth.summary.activeManagedKeys) },
    { label: "Revoked managed keys", value: String(payload.auth.summary.revokedManagedKeys) },
    { label: "Generated at", value: payload.generatedAt }
  ]);

  clearPolling();
  state.pollHandle = window.setTimeout(() => {
    void loadData().catch((error) => {
      setMessage(error.message);
      renderLocked(error.message);
    });
  }, 5000);
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
