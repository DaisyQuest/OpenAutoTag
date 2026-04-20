import { fetchJson, formatTimestamp } from "../auth-client.js";
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
  payload: null,
  createdKey: null
};

const sessionPill = document.querySelector("#session-pill");
const clearSessionButton = document.querySelector("#clear-session");
const authCaption = document.querySelector("#auth-caption");
const authCopy = document.querySelector("#auth-copy");
const authForm = document.querySelector("#auth-form");
const authKeyInput = document.querySelector("#auth-key");
const authSubmitButton = document.querySelector("#auth-submit");
const authMessage = document.querySelector("#auth-message");
const keyHeroSummary = document.querySelector("#key-hero-summary");
const createKeyForm = document.querySelector("#create-key-form");
const keyLabelInput = document.querySelector("#key-label");
const keyDescriptionInput = document.querySelector("#key-description");
const createKeySubmit = document.querySelector("#create-key-submit");
const createKeyMessage = document.querySelector("#create-key-message");
const createdKeyPanel = document.querySelector("#created-key-panel");
const keyTableCaption = document.querySelector("#key-table-caption");
const keyTableBody = document.querySelector("#key-table-body");

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

function renderCreatedKey() {
  if (!state.createdKey) {
    createdKeyPanel.className = "secure-output empty-state";
    createdKeyPanel.textContent = "Create a managed key to reveal it here once.";
    return;
  }

  createdKeyPanel.className = "secure-output";
  createdKeyPanel.innerHTML = `
    <div class="secure-output-copy">
      <span class="summary-label">Managed key</span>
      <code class="secret-code">${escapeHtml(state.createdKey.key)}</code>
      <p class="section-copy">
        Store this value now. It is hashed at rest and will not be shown again by the server after this response.
      </p>
    </div>
    <div class="action-row">
      <button id="copy-created-key" class="action-button" type="button">Copy key</button>
    </div>
  `;
}

function renderHero(payload) {
  if (!payload) {
    keyHeroSummary.innerHTML = `
      <article class="summary-card">
        <span class="summary-label">Auth mode</span>
        <strong>Locked</strong>
      </article>
    `;
    return;
  }

  keyHeroSummary.innerHTML = renderSummaryCards([
    {
      label: "Auth mode",
      value: payload.publicMode ? "Public" : "Private",
      detail: payload.publicMode ? "Headers optional" : "Headers required",
      tone: payload.publicMode ? "success" : "danger"
    },
    {
      label: "Active keys",
      value: String(payload.summary.activeManagedKeys),
      detail: "Managed API keys currently accepted"
    },
    {
      label: "Revoked keys",
      value: String(payload.summary.revokedManagedKeys),
      detail: "Retained for audit context"
    }
  ]);
}

function renderTable(payload) {
  if (!payload) {
    keyTableCaption.textContent = "Locked";
    keyTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-row">Unlock admin access to inspect managed keys.</td>
      </tr>
    `;
    return;
  }

  keyTableCaption.textContent = `${payload.managedKeys.length} key${payload.managedKeys.length === 1 ? "" : "s"} tracked`;

  if (!payload.managedKeys.length) {
    keyTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-row">No managed keys have been created yet.</td>
      </tr>
    `;
    return;
  }

  keyTableBody.innerHTML = payload.managedKeys
    .map(
      (record) => `
        <tr>
          <td>
            <div class="table-cell-stack">
              <strong class="table-primary">${escapeHtml(record.label)}</strong>
              <span class="table-note">${escapeHtml(record.description || "No description")}</span>
            </div>
          </td>
          <td class="table-secondary"><code>${escapeHtml(record.prefix)}</code></td>
          <td class="table-secondary">${escapeHtml(formatTimestamp(record.createdAt))}</td>
          <td class="table-secondary">${escapeHtml(formatTimestamp(record.lastUsedAt))}</td>
          <td>
            <span class="status-pill status-${record.revokedAt ? "failed" : "completed"}">
              ${escapeHtml(record.revokedAt ? "revoked" : "active")}
            </span>
          </td>
          <td>
            ${
              record.revokedAt
                ? `<span class="table-note">Revoked ${escapeHtml(formatTimestamp(record.revokedAt))}</span>`
                : `
                  <button
                    class="ghost-button compact-button"
                    type="button"
                    data-revoke-id="${escapeHtml(record.id)}"
                  >
                    Revoke
                  </button>
                `
            }
          </td>
        </tr>
      `
    )
    .join("");
}

function renderLocked(message) {
  state.payload = null;
  state.createdKey = null;
  renderHero(null);
  renderTable(null);
  renderCreatedKey();
  createKeyMessage.textContent = message;
}

async function loadData() {
  if (!hasAdminAccess(state.authConfig)) {
    renderLocked("Enter an admin key to load protected monitoring data.");
    return;
  }

  const payload = await fetchJson("/admin/api-keys", { auth: "admin" });
  state.payload = payload;
  renderHero(payload);
  renderTable(payload);
  renderCreatedKey();
}

async function createKey(event) {
  event.preventDefault();

  createKeySubmit.disabled = true;
  createKeyMessage.textContent = "Creating managed key.";

  try {
    const payload = await fetchJson("/admin/api-keys", {
      auth: "admin",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        label: keyLabelInput.value,
        description: keyDescriptionInput.value
      })
    });

    state.createdKey = payload;
    keyLabelInput.value = "";
    keyDescriptionInput.value = "";
    createKeyMessage.textContent = `Managed key ${payload.record.prefix} created. Copy it now.`;
    renderCreatedKey();
    await loadData();
  } catch (error) {
    createKeyMessage.textContent = error.message;
  } finally {
    createKeySubmit.disabled = false;
  }
}

createdKeyPanel.addEventListener("click", async (event) => {
  const button = event.target.closest("#copy-created-key");
  if (!button || !state.createdKey?.key) {
    return;
  }

  button.disabled = true;

  try {
    await navigator.clipboard.writeText(state.createdKey.key);
    createKeyMessage.textContent = "Managed key copied to the clipboard.";
  } catch {
    createKeyMessage.textContent = "Clipboard access was unavailable. Copy the key manually from the reveal panel.";
  } finally {
    button.disabled = false;
  }
});

keyTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-revoke-id]");
  if (!button) {
    return;
  }

  button.disabled = true;

  try {
    await fetchJson(`/admin/api-keys/${encodeURIComponent(button.getAttribute("data-revoke-id"))}`, {
      auth: "admin",
      method: "DELETE"
    });
    createKeyMessage.textContent = "Managed key revoked.";
    await loadData();
  } catch (error) {
    createKeyMessage.textContent = error.message;
  } finally {
    button.disabled = false;
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

createKeyForm.addEventListener("submit", (event) => {
  void createKey(event);
});

clearSessionButton.addEventListener("click", () => {
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
