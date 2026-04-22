import {
  buildStructureModel,
  createDownloadHtml,
  defaultStudioHtml,
  studioSnippets,
  studioTemplates,
  summarizeStudioDocument,
  validateStudioHtml
} from "./studio-model.js?v=html-studio";

const storageKey = "perfect-studio-html-source";
const sourceInput = document.querySelector("#html-source");
const templateSelect = document.querySelector("#template-select");
const newDocumentButton = document.querySelector("#new-document");
const validateButton = document.querySelector("#validate-document");
const downloadButton = document.querySelector("#download-html");
const printButton = document.querySelector("#print-pdf");
const previewFrame = document.querySelector("#document-preview");
const sourceState = document.querySelector("#source-state");
const readyState = document.querySelector("#ready-state");
const readinessScore = document.querySelector("#readiness-score");
const errorCount = document.querySelector("#error-count");
const warningCount = document.querySelector("#warning-count");
const issueCount = document.querySelector("#issue-count");
const issueList = document.querySelector("#issue-list");
const structureCount = document.querySelector("#structure-count");
const structureList = document.querySelector("#structure-list");
const documentStatus = document.querySelector("#document-status");
const headingCount = document.querySelector("#heading-count");
const tableCount = document.querySelector("#table-count");
const figureCount = document.querySelector("#figure-count");
const fieldCount = document.querySelector("#field-count");
const snippetButtons = document.querySelectorAll("[data-snippet]");

let renderHandle = 0;
let savedMessageHandle = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSource() {
  return sourceInput.value;
}

function setSource(value, { persist = true } = {}) {
  sourceInput.value = value;
  if (persist) {
    window.localStorage.setItem(storageKey, value);
  }
  scheduleRender();
}

function createPreviewSource(source) {
  const previewStylesheet = '<base href="/"><link rel="stylesheet" href="/studio-preview.css">';

  if (/<head\b[^>]*>/i.test(source)) {
    return source.replace(/<head\b([^>]*)>/i, `<head$1>${previewStylesheet}`);
  }

  return `${previewStylesheet}${source}`;
}

function renderIssueList(validation) {
  const { issues } = validation;
  issueCount.textContent = `${issues.length} issue${issues.length === 1 ? "" : "s"}`;

  if (!issues.length) {
    issueList.innerHTML = `
      <article class="issue-card pass">
        <div class="issue-title-row">
          <strong>Ready to publish</strong>
          <span class="issue-severity">Pass</span>
        </div>
        <p>The current source has the core semantics needed for PDF/UA-native publishing.</p>
      </article>
    `;
    return;
  }

  issueList.innerHTML = issues
    .map(
      (issue) => `
        <article class="issue-card ${escapeHtml(issue.severity)}">
          <div class="issue-title-row">
            <strong>${escapeHtml(issue.label)}</strong>
            <span class="issue-severity">${escapeHtml(issue.severity)}</span>
          </div>
          <p>${escapeHtml(issue.detail)}</p>
          <p>${escapeHtml(issue.action)}</p>
        </article>
      `
    )
    .join("");
}

function renderStructure(structure) {
  structureCount.textContent = `${structure.length} node${structure.length === 1 ? "" : "s"}`;

  if (!structure.length) {
    structureList.innerHTML = `
      <li class="structure-node">
        <span class="structure-role">None</span>
        <span class="structure-label">No semantic blocks found.</span>
      </li>
    `;
    return;
  }

  structureList.innerHTML = structure
    .slice(0, 90)
    .map(
      (item) => `
        <li class="structure-node">
          <span class="structure-role">${escapeHtml(item.role)}</span>
          <span class="structure-label">
            ${escapeHtml(item.label || item.tagName)}
            <small>${escapeHtml(item.artifact ? "Artifact" : item.tagName.toUpperCase())}</small>
          </span>
        </li>
      `
    )
    .join("");
}

function setReadyState(status) {
  readyState.textContent = status === "ready" ? "Ready" : "Blocked";
  readyState.classList.toggle("ready", status === "ready");
  readyState.classList.toggle("blocked", status !== "ready");
}

function render() {
  const source = getSource();
  const validation = validateStudioHtml(source);
  const summary = summarizeStudioDocument(source);
  const structure = buildStructureModel(source);

  previewFrame.srcdoc = createPreviewSource(source);
  setReadyState(validation.status);
  readinessScore.textContent = String(summary.score);
  errorCount.textContent = String(summary.errorCount);
  warningCount.textContent = String(summary.warningCount);
  documentStatus.textContent = validation.status === "ready" ? "Publishable" : "Draft";
  headingCount.textContent = String(summary.headingCount);
  tableCount.textContent = String(summary.tableCount);
  figureCount.textContent = String(summary.figureCount);
  fieldCount.textContent = String(summary.formFieldCount);

  renderIssueList(validation);
  renderStructure(structure);
}

function scheduleRender() {
  window.clearTimeout(renderHandle);
  renderHandle = window.setTimeout(render, 120);
}

function markSaved() {
  sourceState.textContent = "Autosaved";
  sourceState.classList.add("ready");
  window.clearTimeout(savedMessageHandle);
  savedMessageHandle = window.setTimeout(() => {
    sourceState.classList.remove("ready");
  }, 900);
}

function insertSnippet(snippetId) {
  const snippet = studioSnippets.find((item) => item.id === snippetId);
  if (!snippet) return;

  const start = sourceInput.selectionStart ?? sourceInput.value.length;
  const end = sourceInput.selectionEnd ?? sourceInput.value.length;
  const next = `${sourceInput.value.slice(0, start)}${snippet.source}${sourceInput.value.slice(end)}`;
  setSource(next);
  sourceInput.focus();
  const cursor = start + snippet.source.length;
  sourceInput.setSelectionRange(cursor, cursor);
}

function downloadHtml() {
  const html = createDownloadHtml(getSource());
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "perfect-studio-document.html";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function printPdf() {
  const printWindow = window.open("", "perfect-studio-print");
  if (!printWindow) {
    sourceState.textContent = "Print window blocked";
    return;
  }

  printWindow.document.open();
  printWindow.document.write(createPreviewSource(createDownloadHtml(getSource())));
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
  }, 250);
}

function initializeTemplates() {
  templateSelect.innerHTML = studioTemplates
    .map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.label)}</option>`)
    .join("");
}

sourceInput.addEventListener("input", () => {
  window.localStorage.setItem(storageKey, getSource());
  markSaved();
  scheduleRender();
});

templateSelect.addEventListener("change", () => {
  const selected = studioTemplates.find((template) => template.id === templateSelect.value);
  if (selected) {
    setSource(selected.source);
    markSaved();
  }
});

newDocumentButton.addEventListener("click", () => {
  templateSelect.value = "brief";
  setSource(defaultStudioHtml);
  markSaved();
});

validateButton.addEventListener("click", () => {
  render();
  sourceState.textContent = "Validated";
});

downloadButton.addEventListener("click", downloadHtml);
printButton.addEventListener("click", printPdf);

for (const button of snippetButtons) {
  button.addEventListener("click", () => {
    insertSnippet(button.getAttribute("data-snippet"));
    markSaved();
  });
}

initializeTemplates();
setSource(window.localStorage.getItem(storageKey) || defaultStudioHtml, { persist: false });
render();
