function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return entities[character];
  });
}

function formatTimestamp(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatStatusLabel(value) {
  switch (value) {
    case "covered":
      return "Covered";
    case "partial":
      return "Partial";
    case "gap":
      return "Gap";
    default:
      return "N/A";
  }
}

function buildSummaryCards(data) {
  const cards = [];
  for (const column of data.columns) {
    const counts = data.summary.columnStatusCounts[column.id];
    cards.push(`
      <article class="report-tab matrix-summary-card">
        <strong>${escapeHtml(column.label)}</strong>
        <span class="matrix-summary-line">Covered: ${counts.covered}</span>
        <span class="matrix-summary-line">Partial: ${counts.partial}</span>
        <span class="matrix-summary-line">Gap: ${counts.gap}</span>
      </article>
    `);
  }
  return cards.join("");
}

function buildGapCards(gaps) {
  if (!gaps.length) {
    return `<div class="report-tab">No urgent coverage gaps registered.</div>`;
  }

  return gaps
    .map(
      (gap) => `
        <article class="report-tab matrix-gap-card priority-${escapeHtml(gap.priority)}">
          <strong>${escapeHtml(gap.capability)}</strong>
          <span class="matrix-gap-meta">${escapeHtml(gap.sectionTitle)} · ${escapeHtml(gap.priority)}</span>
          <span class="matrix-gap-summary">${escapeHtml(gap.summary)}</span>
        </article>
      `
    )
    .join("");
}

function buildEvidenceMarkup(evidence) {
  if (!evidence?.length) {
    return `<span class="matrix-evidence-empty">No linked evidence</span>`;
  }

  return evidence
    .map(
      (item) => `
        <span class="matrix-evidence-item">
          <strong>${escapeHtml(item.label)}</strong>
          <code>${escapeHtml(item.path)}</code>
        </span>
      `
    )
    .join("");
}

function buildSection(section, columns) {
  const headerCells = columns
    .map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`)
    .join("");

  const rows = section.rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const status = row.statuses?.[column.id] || "na";
          return `
            <td>
              <span class="matrix-cell status-${escapeHtml(status)}">${formatStatusLabel(status)}</span>
            </td>
          `;
        })
        .join("");

      const gapMarkup = row.gap
        ? `<p class="matrix-row-gap"><strong>Gap:</strong> ${escapeHtml(row.gap.summary)}</p>`
        : "";

      return `
        <tr>
          <th scope="row">
            <div class="matrix-row-title">${escapeHtml(row.capability)}</div>
            <div class="matrix-row-module">${escapeHtml(row.module)}</div>
            <p class="matrix-row-note">${escapeHtml(row.notes || "")}</p>
            ${gapMarkup}
            <div class="matrix-evidence">${buildEvidenceMarkup(row.evidence)}</div>
          </th>
          ${cells}
        </tr>
      `;
    })
    .join("");

  return `
    <section class="report-section matrix-section" id="${escapeHtml(section.id)}">
      <div class="section-heading">
        <h2>${escapeHtml(section.title)}</h2>
        <span>${section.rows.length} coverage rows</span>
      </div>
      <div class="matrix-table-shell">
        <table class="matrix-table">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              ${headerCells}
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function loadMatrix() {
  const response = await fetch("/testing-matrix.data.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load testing matrix data.");
  }
  return response.json();
}

async function main() {
  const title = document.querySelector("#matrix-title");
  const subtitle = document.querySelector("#matrix-subtitle");
  const generatedAt = document.querySelector("#matrix-generated-at");
  const rowCount = document.querySelector("#matrix-row-count");
  const gapCount = document.querySelector("#matrix-gap-count");
  const summaryCards = document.querySelector("#matrix-summary-cards");
  const gapList = document.querySelector("#matrix-gap-list");
  const sections = document.querySelector("#matrix-sections");

  try {
    const data = await loadMatrix();
    title.textContent = data.title;
    subtitle.textContent = data.description;
    generatedAt.textContent = formatTimestamp(data.generatedAt);
    rowCount.textContent = `${data.summary.rowCount} rows`;
    gapCount.textContent = `${data.gaps.length} open`;
    summaryCards.innerHTML = buildSummaryCards(data);
    gapList.innerHTML = buildGapCards(data.gaps);
    sections.innerHTML = data.sections.map((section) => buildSection(section, data.columns)).join("");
  } catch (error) {
    title.textContent = "Testing matrix unavailable";
    subtitle.textContent = error.message;
    generatedAt.textContent = "Unavailable";
    summaryCards.innerHTML = "";
    gapList.innerHTML = "";
    sections.innerHTML = `<div class="empty-report">${escapeHtml(error.message)}</div>`;
  }
}

main();
