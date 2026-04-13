import { clearStoredKeys, getSessionAccess, loadAuthConfig, verifyAndStoreAccess } from "../auth-client.js";

export function hasAdminAccess(authConfig) {
  return Boolean(authConfig?.publicMode || getSessionAccess().admin);
}

export function renderAdminSessionChrome({
  authConfig,
  sessionPill,
  authCaption,
  authCopy,
  authForm,
  authKeyInput,
  authSubmitButton,
  clearSessionButton
}) {
  const access = getSessionAccess();
  const publicMode = Boolean(authConfig?.publicMode);

  let label = "Locked";
  let description = "Enter an admin key to access protected operations monitoring and key management.";

  if (publicMode) {
    label = "Public mode";
    description = "This workspace is open. Admin monitoring endpoints do not require a key.";
  } else if (access.admin) {
    label = "Admin session";
    description = "Admin access is active in this tab for monitoring and key management.";
  }

  sessionPill.textContent = label;
  authCaption.textContent = label;
  authCopy.textContent = description;
  authForm.hidden = publicMode;
  authKeyInput.disabled = publicMode;
  authSubmitButton.disabled = publicMode;
  clearSessionButton.disabled = publicMode && !access.admin;
}

export async function initializeAdminPage({ state, setMessage, renderLocked, renderSessionChrome, loadData }) {
  state.authConfig = await loadAuthConfig();

  if (state.authConfig.publicMode) {
    setMessage("Public mode is enabled. Admin monitoring is open in this tab.");
  } else if (getSessionAccess().admin) {
    setMessage("Admin access is active in this tab.");
  } else {
    setMessage("Enter an admin key to load protected monitoring data.");
  }

  renderSessionChrome();

  if (!hasAdminAccess(state.authConfig)) {
    renderLocked("Enter an admin key to load protected monitoring data.");
    return;
  }

  await loadData();
}

export async function unlockAdminPage(event, { state, setMessage, renderLocked, renderSessionChrome, loadData, authKeyInput, authSubmitButton }) {
  event.preventDefault();
  authSubmitButton.disabled = true;
  setMessage("Verifying the supplied admin key.");

  try {
    await verifyAndStoreAccess({
      key: authKeyInput.value,
      admin: true
    });

    authKeyInput.value = "";
    setMessage("Admin access is active in this tab.");
    renderSessionChrome();
    await loadData();
  } catch (error) {
    setMessage(error.message);
    renderSessionChrome();
    renderLocked(error.message);
  } finally {
    authSubmitButton.disabled = false;
  }
}

export function clearAdminSession({ setMessage, renderLocked, renderSessionChrome }) {
  clearStoredKeys();
  setMessage("Session keys cleared from this tab.");
  renderSessionChrome();
  renderLocked("Enter an admin key to load protected monitoring data.");
}
