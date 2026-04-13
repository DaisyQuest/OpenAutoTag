import { fetchJson, formatDurationSeconds, formatTimestamp, sanitizeStatusToken } from "../auth-client.js";
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
  pollHandle: null,
  payload: null,
  selectedAgentId: null
};

const sessionPill = document.querySelector("#session-pill");
const clearSessionButton = document.querySelector("#clear-session");
const authCaption = document.querySelector("#auth-caption");
const authCopy = document.querySelector("#auth-copy");
const authForm = document.querySelector("#auth-form");
const authKeyInput = document.querySelector("#auth-key");
const authSubmitButton = document.querySelector("#auth-submit");
const authMessage = document.querySelector("#auth-message");
const agentRadarReadout = document.querySelector("#agent-radar-readout");
const agentSummary = document.querySelector("#agent-summary");
const dispatchCaption = document.querySelector("#dispatch-caption");
const dispatchMatrix = document.querySelector("#dispatch-matrix");
const agentGridCaption = document.querySelector("#agent-grid-caption");
const agentGrid = document.querySelector("#agent-grid");
const agentDetailTitle = document.querySelector("#agent-detail-title");
const agentDetailSubtitle = document.querySelector("#agent-detail-subtitle");
const agentDetailStatus = document.querySelector("#agent-detail-status");
const agentDetailMeta = document.querySelector("#agent-detail-meta");
const agentDetailSummary = document.querySelector("#agent-detail-summary");
const agentStageCaption = document.querySelector("#agent-stage-caption");
const agentStagePanel = document.querySelector("#agent-stage-panel");
const agentCapabilitiesCaption = document.querySelector("#agent-capabilities-caption");
const agentCapabilities = document.querySelector("#agent-capabilities");

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

function getAgents() {
  return Array.isArray(state.payload?.agents) ? state.payload.agents : [];
}

function getAgentStatus(agent) {
  if (!agent) {
    return "unknown";
  }

  if (agent.stale) {
    return "stale";
  }

  return agent.status || "unknown";
}

function getAgeSeconds(timestamp) {
  if (!timestamp) {
    return null;
  }

  const elapsedMs = Date.now() - new Date(timestamp).getTime();
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs / 1000) : null;
}

function formatLastSeen(agent) {
  const ageSeconds = getAgeSeconds(agent?.lastSeenAt);
  if (ageSeconds == null) {
    return "No heartbeat";
  }

  return `${formatDurationSeconds(ageSeconds)} ago`;
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
  agentRadarReadout.innerHTML = `
    <span>Fleet</span>
    <strong>Locked</strong>
    <small>${escapeHtml(message)}</small>
  `;
  agentSummary.innerHTML = `
    <article class="summary-card summary-danger">
      <span class="summary-label">Access</span>
      <strong>Required</strong>
      <span class="summary-detail">${escapeHtml(message)}</span>
    </article>
  `;
  dispatchCaption.textContent = "Locked";
  dispatchMatrix.innerHTML = renderDefinitionGrid([{ label: "Dispatch", value: "Locked" }]);
  agentGridCaption.textContent = "Locked";
  agentGrid.innerHTML = `
    <article class="agent-card empty-agent-card">
      <strong>Locked</strong>
      <p>${escapeHtml(message)}</p>
    </article>
  `;
  agentDetailTitle.textContent = "Agent telemetry locked";
  agentDetailSubtitle.textContent = message;
  agentDetailStatus.className = "status-pill status-unknown";
  agentDetailStatus.textContent = "Locked";
  agentDetailMeta.innerHTML = renderDefinitionGrid([{ label: "Access", value: "Required" }]);
  agentDetailSummary.innerHTML = renderSummaryCards([
    {
      label: "Fleet",
      value: "Locked",
      tone: "danger",
      detail: message
    }
  ]);
  agentStageCaption.textContent = "Locked";
  agentStagePanel.innerHTML = `<div class="empty-report">${escapeHtml(message)}</div>`;
  agentCapabilitiesCaption.textContent = "Locked";
  agentCapabilities.innerHTML = `<span class="finding-chip">${escapeHtml(message)}</span>`;
}

function syncSelection(agents) {
  if (!state.selectedAgentId || !agents.some((agent) => agent.agentId === state.selectedAgentId)) {
    state.selectedAgentId = agents[0]?.agentId || null;
  }

  return agents.find((agent) => agent.agentId === state.selectedAgentId) || null;
}

function renderSummary(payload) {
  const summary = payload?.summary || {};
  const queue = summary.queue || {};
  agentRadarReadout.innerHTML = `
    <span>Fleet</span>
    <strong>${escapeHtml(String(summary.total ?? 0))}</strong>
    <small>${escapeHtml(`${summary.idle ?? 0} idle / ${summary.busy ?? 0} busy / ${summary.stale ?? 0} stale`)}</small>
  `;
  agentSummary.innerHTML = renderSummaryCards([
    {
      label: "Idle agents",
      value: String(summary.idle ?? 0),
      detail: `${summary.total ?? 0} tracked`
    },
    {
      label: "Busy agents",
      value: String(summary.busy ?? 0),
      detail: `${queue.running ?? 0} running jobs`
    },
    {
      label: "Stale heartbeats",
      value: String(summary.stale ?? 0),
      detail: `${queue.pendingQueueDepth ?? 0} waiting in queue`
    }
  ]);
}

function renderDispatch(payload) {
  const summary = payload?.summary || {};
  const queue = summary.queue || {};
  dispatchCaption.textContent = `${queue.pendingQueueDepth ?? 0} queued / ${queue.running ?? 0} running`;
  dispatchMatrix.innerHTML = renderDefinitionGrid([
    { label: "Queued jobs", value: String(queue.queued ?? 0) },
    { label: "Remote capacity", value: String(queue.remoteCapacity ?? 0) },
    { label: "Remote workers busy", value: String(queue.remoteWorkersBusy ?? 0) },
    { label: "Primary fallback", value: queue.localWorkerBusy ? "Busy" : "Idle" },
    { label: "Claims observed", value: String(summary.jobsClaimed ?? 0) },
    { label: "Completed remotely", value: String(summary.jobsCompleted ?? 0) }
  ]);
}

function renderFleetBoard(agents, selectedAgent) {
  agentGridCaption.textContent = `${agents.length} checked-in agent${agents.length === 1 ? "" : "s"}`;

  if (!agents.length) {
    agentGrid.innerHTML = `
      <article class="agent-card empty-agent-card">
        <strong>No agents checked in</strong>
        <p>Deploy an agent App Service or start a local agent runtime to populate this board.</p>
      </article>
    `;
    return;
  }

  agentGrid.innerHTML = agents
    .map((agent) => {
      const status = getAgentStatus(agent);
      const workloads = Array.isArray(agent?.capabilities?.workloads) ? agent.capabilities.workloads : [];
      const active = selectedAgent?.agentId === agent.agentId;

      return `
        <button class="agent-card ${active ? "is-active" : ""}" type="button" data-agent-id="${escapeHtml(agent.agentId)}">
          <div class="agent-card-header">
            <div>
              <strong>${escapeHtml(agent.label || agent.agentId)}</strong>
              <span class="agent-card-note">${escapeHtml(agent.hostname || agent.agentId)}</span>
            </div>
            <span class="status-pill status-${escapeHtml(sanitizeStatusToken(status))}">${escapeHtml(status)}</span>
          </div>
          <div class="agent-card-grid">
            <span>
              <small>Last seen</small>
              <strong>${escapeHtml(formatLastSeen(agent))}</strong>
            </span>
            <span>
              <small>Current job</small>
              <strong>${escapeHtml(agent.currentJobId || "Idle")}</strong>
            </span>
            <span>
              <small>Completed</small>
              <strong>${escapeHtml(String(agent.jobsCompleted || 0))}</strong>
            </span>
            <span>
              <small>Failed</small>
              <strong>${escapeHtml(String(agent.jobsFailed || 0))}</strong>
            </span>
          </div>
          <p class="agent-card-message">${escapeHtml(agent.currentMessage || "No active message.")}</p>
          <div class="finding-list compact-list">
            ${
              workloads.length
                ? workloads.slice(0, 4).map((workloadId) => `<span class="finding-chip">${escapeHtml(workloadId)}</span>`).join("")
                : '<span class="finding-chip">No workload list</span>'
            }
          </div>
        </button>
      `;
    })
    .join("");
}

function renderAgentDetail(agent) {
  if (!agent) {
    agentDetailTitle.textContent = "No agent selected";
    agentDetailSubtitle.textContent = "Select a checked-in agent to inspect its latest telemetry.";
    agentDetailStatus.className = "status-pill status-unknown";
    agentDetailStatus.textContent = "Unknown";
    agentDetailMeta.innerHTML = renderDefinitionGrid([{ label: "Fleet", value: "No selection" }]);
    agentDetailSummary.innerHTML = renderSummaryCards([
      {
        label: "Heartbeat",
        value: "Unavailable",
        detail: "No agent has checked in yet."
      }
    ]);
    agentStageCaption.textContent = "No stage";
    agentStagePanel.innerHTML = `<div class="empty-report">Select an agent to inspect live stage telemetry.</div>`;
    agentCapabilitiesCaption.textContent = "No workloads";
    agentCapabilities.innerHTML = `<span class="finding-chip">No selection</span>`;
    return;
  }

  const status = getAgentStatus(agent);
  const workloads = Array.isArray(agent?.capabilities?.workloads) ? agent.capabilities.workloads : [];
  const ageSeconds = getAgeSeconds(agent.lastSeenAt);

  agentDetailTitle.textContent = agent.label || agent.agentId;
  agentDetailSubtitle.textContent = agent.currentMessage || "No active agent message.";
  agentDetailStatus.className = `status-pill status-${sanitizeStatusToken(status)}`;
  agentDetailStatus.textContent = status;
  agentDetailMeta.innerHTML = renderDefinitionGrid([
    { label: "Agent id", value: agent.agentId },
    { label: "Hostname", value: agent.hostname || "Unavailable" },
    { label: "Version", value: agent.version || "Unknown" },
    { label: "Platform", value: [agent.platform, agent.arch].filter(Boolean).join(" / ") || "Unknown" },
    { label: "Last heartbeat", value: formatTimestamp(agent.lastSeenAt) },
    { label: "Current workload", value: agent.currentWorkloadId || "Idle" }
  ]);
  agentDetailSummary.innerHTML = renderSummaryCards([
    {
      label: "Heartbeat age",
      value: ageSeconds == null ? "n/a" : formatDurationSeconds(ageSeconds),
      tone: agent.stale ? "danger" : status === "busy" ? "success" : "",
      detail: ageSeconds == null ? "No heartbeat received" : `${formatLastSeen(agent)}`
    },
    {
      label: "Claims",
      value: String(agent.jobsClaimed || 0),
      detail: `${agent.jobsCompleted || 0} completed`
    },
    {
      label: "Failures",
      value: String(agent.jobsFailed || 0),
      detail: agent.lastError || "No recent failure reported"
    }
  ]);
  agentStageCaption.textContent = agent.currentStage?.label
    ? `Live stage: ${agent.currentStage.label}`
    : agent.currentJobId
      ? "Assigned, waiting for stage telemetry"
      : "Idle";
  agentStagePanel.innerHTML = agent.currentStage
    ? `
      <div class="definition-grid">
        <article class="definition-card">
          <span class="definition-label">Stage</span>
          <strong>${escapeHtml(agent.currentStage.label || agent.currentStage.key || "Unknown")}</strong>
        </article>
        <article class="definition-card">
          <span class="definition-label">Attempt</span>
          <strong>${escapeHtml(`${agent.currentStage.attempt || 1}/${agent.currentStage.maxAttempts || 1}`)}</strong>
        </article>
        <article class="definition-card">
          <span class="definition-label">Position</span>
          <strong>${escapeHtml(`${agent.currentStage.index || 0}/${agent.currentStage.total || 0}`)}</strong>
        </article>
        <article class="definition-card">
          <span class="definition-label">Started</span>
          <strong>${escapeHtml(formatTimestamp(agent.currentStage.startedAt))}</strong>
        </article>
      </div>
    `
    : `<div class="empty-report">${escapeHtml(agent.currentMessage || "No active stage telemetry.")}</div>`;
  agentCapabilitiesCaption.textContent = `${workloads.length} workload${workloads.length === 1 ? "" : "s"}`;
  agentCapabilities.innerHTML = workloads.length
    ? workloads.map((workloadId) => `<span class="finding-chip">${escapeHtml(workloadId)}</span>`).join("")
    : `<span class="finding-chip">No workload list</span>`;
}

async function loadData() {
  if (!hasAdminAccess(state.authConfig)) {
    renderLocked("Enter an admin key to load protected monitoring data.");
    return;
  }

  state.payload = await fetchJson("/admin/agents", { auth: "admin" });
  const agents = getAgents();
  const selectedAgent = syncSelection(agents);

  renderSummary(state.payload);
  renderDispatch(state.payload);
  renderFleetBoard(agents, selectedAgent);
  renderAgentDetail(selectedAgent);

  clearPolling();
  state.pollHandle = window.setTimeout(() => {
    void loadData().catch((error) => {
      setMessage(error.message);
      renderLocked(error.message);
    });
  }, 1500);
}

agentGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-agent-id]");
  if (!button) {
    return;
  }

  state.selectedAgentId = button.getAttribute("data-agent-id");
  const selectedAgent = syncSelection(getAgents());
  renderFleetBoard(getAgents(), selectedAgent);
  renderAgentDetail(selectedAgent);
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
