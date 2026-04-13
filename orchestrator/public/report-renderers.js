export const artifactLabels = {
  layout: "Layout extract",
  sourceTextMap: "Source text map",
  tableStructureMap: "Table structure map",
  layoutEnriched: "Layout analysis",
  semantic: "Semantic document",
  semanticOrdered: "Reading-order document",
  semanticRedacted: "Semantic redaction output",
  redactionPlan: "Redaction plan",
  tagging: "Tagging plan",
  taggedPdf: "Tagged PDF",
  redactedPdf: "Redacted PDF",
  validationReport: "Validation report",
  tagDeltaReport: "Tag delta",
  writerReport: "Writer report",
  tagManifest: "Tag tree",
  redactionReport: "Redaction report"
};

const JSON_PREVIEW_ITEM_LIMIT = 8;
const JSON_PREVIEW_DEPTH_LIMIT = 4;

function humanizeArtifactName(value) {
  const normalized = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.\-]+/g, " ")
    .trim();

  if (!normalized) {
    return "Artifact";
  }

  const acronymMap = new Map([
    ["pdf", "PDF"],
    ["ssn", "SSN"],
    ["ocr", "OCR"],
    ["xmp", "XMP"],
    ["mcid", "MCID"],
    ["json", "JSON"]
  ]);

  return normalized
    .split(/\s+/)
    .map((segment) => {
      const lowered = segment.toLowerCase();
      if (acronymMap.has(lowered)) {
        return acronymMap.get(lowered);
      }

      return `${lowered.charAt(0).toUpperCase()}${lowered.slice(1)}`;
    })
    .join(" ");
}

export function getArtifactLabel(artifactName) {
  return artifactLabels[artifactName] || humanizeArtifactName(artifactName);
}

export function escapeHtml(value) {
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

export function formatStatus(value) {
  return String(value || "unknown").replace(/_/g, " ");
}

function getJsonValueType(value) {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function formatBoolean(value) {
  return value ? "Yes" : "No";
}

function formatSignedNumber(value) {
  const numeric = Number(value || 0);
  if (numeric > 0) {
    return `+${numeric}`;
  }

  return String(numeric);
}

function formatPrimitiveValue(value, { maxLength = 120 } = {}) {
  const type = getJsonValueType(value);

  if (type === "string") {
    return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
  }

  if (type === "number" || type === "boolean") {
    return String(value);
  }

  if (type === "null") {
    return "null";
  }

  if (type === "undefined") {
    return "undefined";
  }

  return JSON.stringify(value);
}

function formatJsonCountLabel(value) {
  const type = getJsonValueType(value);
  if (type === "array") {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }

  if (type === "object") {
    const count = Object.keys(value).length;
    return `${count} key${count === 1 ? "" : "s"}`;
  }

  return type;
}

function getTopLevelEntryCount(value) {
  const type = getJsonValueType(value);
  if (type === "array") {
    return value.length;
  }

  if (type === "object") {
    return Object.keys(value).length;
  }

  return 1;
}

function buildScalarDefinitions(report) {
  if (getJsonValueType(report) !== "object") {
    return [];
  }

  return Object.entries(report)
    .filter(([, value]) => {
      const type = getJsonValueType(value);
      return type === "string" || type === "number" || type === "boolean" || type === "null";
    })
    .slice(0, 8)
    .map(([key, value]) => ({
      label: humanizeArtifactName(key),
      value: formatPrimitiveValue(value)
    }));
}

function renderJsonPreviewValue(value, { depth }) {
  const type = getJsonValueType(value);

  if (type === "object" || type === "array") {
    return renderJsonPreview(value, { depth });
  }

  return `
    <div class="json-preview-leaf">
      <span class="json-value-chip type-${escapeHtml(type)}">${escapeHtml(type)}</span>
      <code>${escapeHtml(formatPrimitiveValue(value))}</code>
    </div>
  `;
}

function renderJsonPreview(value, { depth = 0 } = {}) {
  const type = getJsonValueType(value);

  if (type !== "object" && type !== "array") {
    return renderJsonPreviewValue(value, { depth });
  }

  const entries = type === "array" ? value.map((item, index) => [`[${index}]`, item]) : Object.entries(value);

  if (!entries.length) {
    return `<div class="empty-report">This ${type} is empty.</div>`;
  }

  const visibleEntries = entries.slice(0, JSON_PREVIEW_ITEM_LIMIT);
  const overflow = entries.length - visibleEntries.length;
  const openAttribute = depth < 2 ? " open" : "";
  const limitReached = depth >= JSON_PREVIEW_DEPTH_LIMIT;

  return `
    <details class="json-preview-group"${openAttribute}>
      <summary>
        <span class="json-value-chip type-${escapeHtml(type)}">${escapeHtml(type)}</span>
        <span>${escapeHtml(formatJsonCountLabel(value))}</span>
      </summary>
      ${
        limitReached
          ? `<p class="report-note compact-preview-note">Nested ${escapeHtml(type)} content is truncated at depth ${escapeHtml(
              String(JSON_PREVIEW_DEPTH_LIMIT)
            )}. Use Raw JSON for the full payload.</p>`
          : `
            <div class="json-preview-grid">
              ${visibleEntries
                .map(
                  ([key, childValue]) => `
                    <article class="json-preview-item">
                      <div class="json-preview-item-header">
                        <strong>${escapeHtml(humanizeArtifactName(key))}</strong>
                        <span>${escapeHtml(key)}</span>
                      </div>
                      ${renderJsonPreviewValue(childValue, { depth: depth + 1 })}
                    </article>
                  `
                )
                .join("")}
            </div>
          `
      }
      ${
        !limitReached && overflow > 0
          ? `<p class="report-note compact-preview-note">Showing ${visibleEntries.length} of ${entries.length} entries. Use Raw JSON for the full payload.</p>`
          : ""
      }
    </details>
  `;
}

export function renderSummaryCards(cards) {
  return cards
    .map(
      (card) => `
        <article class="summary-card ${card.tone ? `summary-${card.tone}` : ""}">
          <span class="summary-label">${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          ${card.detail ? `<span class="summary-detail">${escapeHtml(card.detail)}</span>` : ""}
        </article>
      `
    )
    .join("");
}

function renderDefinitionGrid(entries) {
  if (!entries.length) {
    return `<div class="empty-report">No structured details available.</div>`;
  }

  return `
    <div class="definition-grid">
      ${entries
        .map(
          (entry) => `
            <article class="definition-card">
              <span class="definition-label">${escapeHtml(entry.label)}</span>
              <strong>${escapeHtml(entry.value)}</strong>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTagDeltaSection(tagDelta, { compact = false } = {}) {
  if (!tagDelta?.delta) {
    return "";
  }

  return `
    <section class="report-section ${compact ? "compact-section" : ""}">
      <div class="section-heading ${compact ? "compact-heading" : ""}">
        <h2>Tag delta</h2>
        <span>Source vs tagged output</span>
      </div>
      ${renderDefinitionGrid([
        { label: "Struct tree added", value: formatBoolean(tagDelta.delta.structTreeAdded) },
        { label: "Typed nodes delta", value: formatSignedNumber(tagDelta.delta.totalTypedNodesDelta) },
        { label: "Marked content delta", value: formatSignedNumber(tagDelta.delta.markedContentOperatorCountDelta) },
        { label: "Artifact content delta", value: formatSignedNumber(tagDelta.delta.artifactMarkedContentCountDelta) },
        { label: "Table attribute delta", value: formatSignedNumber(tagDelta.delta.tableAttributeNodeCountDelta) },
        { label: "Image XObject delta", value: formatSignedNumber(tagDelta.delta.imageXObjectCountDelta) }
      ])}
    </section>
  `;
}

function renderChecks(checks) {
  if (!checks?.length) {
    return `<p class="report-note">No check-level detail returned.</p>`;
  }

  return `
    <div class="check-list">
      ${checks
        .map(
          (check) => `
            <article class="check-card">
              <div class="check-header">
                <span class="status-pill status-${escapeHtml(check.status || "unknown")}">${escapeHtml(
                  check.status || "unknown"
                )}</span>
              </div>
              <p class="check-context">${escapeHtml(check.context || "No context provided.")}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderValidationFindings(findings, { compact = false } = {}) {
  if (findings.length === 0) {
    return `<div class="empty-report">No findings returned by the validator.</div>`;
  }

  const visibleFindings = compact ? findings.slice(0, 3) : findings;
  const overflow = findings.length - visibleFindings.length;

  const cards = visibleFindings
    .map(
      (finding) => `
        <article class="finding-card finding-${escapeHtml(finding.severity || "info")} ${compact ? "compact-card" : ""}">
          <div class="finding-card-header">
            <div>
              <p class="eyebrow report-eyebrow">${escapeHtml(finding.code || "Finding")}</p>
              <h3>${escapeHtml(finding.description || "Validator finding")}</h3>
            </div>
            <span class="status-pill status-${escapeHtml(finding.severity || "error")}">${escapeHtml(
              finding.severity || "error"
            )}</span>
          </div>
          <p class="finding-meta">
            Clause ${escapeHtml(finding.clause || "n/a")} / ${escapeHtml(
              finding.specification || "Specification unavailable"
            )} / ${escapeHtml(String(finding.failedChecks || 0))} failed check${
              finding.failedChecks === 1 ? "" : "s"
            }
          </p>
          <p class="finding-description">${escapeHtml(finding.test || "")}</p>
          ${
            finding.tags?.length
              ? `<div class="finding-list">${finding.tags
                  .map((tag) => `<span class="finding-chip">${escapeHtml(tag)}</span>`)
                  .join("")}</div>`
              : ""
          }
          ${compact ? "" : renderChecks(finding.checks)}
        </article>
      `
    )
    .join("");

  return `
    <div class="finding-stack ${compact ? "compact-stack" : ""}">${cards}</div>
    ${
      compact && overflow > 0
        ? `<p class="report-note compact-preview-note">Showing ${visibleFindings.length} of ${findings.length} findings. Open the full report for the remaining clauses.</p>`
        : ""
    }
  `;
}

function renderCompactTreeSummary(root) {
  if (!root) {
    return `<div class="empty-report">No logical tree is available in this manifest.</div>`;
  }

  const children = Array.isArray(root.children) ? root.children : [];
  const previewChildren = children.slice(0, 6);
  const overflow = children.length - previewChildren.length;

  return `
    <section class="report-section compact-section">
      <div class="section-heading compact-heading">
        <h4>Tree overview</h4>
        <span>${escapeHtml(root.type || "root")}</span>
      </div>
      <div class="definition-grid">
        <article class="definition-card">
          <span class="definition-label">Root node</span>
          <strong>${escapeHtml(root.type || "Unknown")}</strong>
        </article>
        <article class="definition-card">
          <span class="definition-label">Top-level nodes</span>
          <strong>${escapeHtml(String(children.length))}</strong>
        </article>
      </div>
      <div class="compact-inline-tree">
        ${previewChildren
          .map(
            (child) => `
              <article class="definition-card compact-tree-node">
                <span class="definition-label">${escapeHtml(child.type || "Node")}</span>
                <strong>${escapeHtml(child.label || child.id || "Unlabeled node")}</strong>
              </article>
            `
          )
          .join("")}
      </div>
      ${
        overflow > 0
          ? `<p class="report-note compact-preview-note">Showing ${previewChildren.length} of ${children.length} top-level nodes. Open the full tag tree for the complete hierarchy.</p>`
          : ""
      }
    </section>
  `;
}

function buildValidationView(report, { compact = false, tagDelta = null } = {}) {
  const findings = report.findings || [];
  const metadataDiagnostics = report.metadataDiagnostics || {};

  const summaryCards = [
    {
      label: "Compliance",
      value: report.isCompliant ? "Pass" : "Needs work",
      tone: report.isCompliant ? "success" : "danger"
    },
    {
      label: "Failed rules",
      value: String(report.summary?.failedRules ?? 0)
    },
    {
      label: "Failed checks",
      value: String(report.summary?.failedChecks ?? 0)
    },
    {
      label: "Engine",
      value: `${report.engine?.name || "Validator"} ${report.engine?.version || ""}`.trim()
    }
  ];

  const resolvedTagDelta = tagDelta || report.tagDelta || null;
  if (resolvedTagDelta?.delta) {
    summaryCards.push({
      label: "Typed node delta",
      value: formatSignedNumber(resolvedTagDelta.delta.totalTypedNodesDelta)
    });
    summaryCards.push({
      label: "Marked content delta",
      value: formatSignedNumber(resolvedTagDelta.delta.markedContentOperatorCountDelta)
    });
  }

  const diagnosticsEntries = [
    { label: "Metadata stream present", value: formatBoolean(metadataDiagnostics.metadataPresent) },
    { label: "Info matches XMP", value: formatBoolean(metadataDiagnostics.infoMatchesXmp) },
    { label: "dc:title detected", value: metadataDiagnostics.dcTitleValue || formatBoolean(metadataDiagnostics.dcTitleDetected) },
    {
      label: "PDF/UA identification",
      value: metadataDiagnostics.pdfUaIdentificationDetected
        ? `Part ${metadataDiagnostics.pdfUaIdentificationPart || "1"}`
        : "Missing"
    }
  ];

  return {
    summaryCards,
    contentHtml: `
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading ${compact ? "compact-heading" : ""}">
          <h2>${compact ? "Validation overview" : "Validation overview"}</h2>
          <span>${escapeHtml(report.profileName || "Validation profile unavailable")}</span>
        </div>
        <p class="report-note">${escapeHtml(report.statement || "Validation finished.")}</p>
      </section>
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading ${compact ? "compact-heading" : ""}">
          <h2>${compact ? "Metadata diagnostics" : "Metadata diagnostics"}</h2>
          <span>${metadataDiagnostics.suspectedVeraPdfMetadataMismatch ? "veraPDF mismatch suspected" : "Live probe summary"}</span>
        </div>
        ${renderDefinitionGrid(diagnosticsEntries)}
        ${
          metadataDiagnostics.suspectedVeraPdfMetadataMismatch
            ? `<p class="report-note emphasis-note">The local probe sees synchronized PDF/UA metadata, but veraPDF still reports the two metadata clauses.</p>`
            : ""
        }
      </section>
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading ${compact ? "compact-heading" : ""}">
          <h2>${compact ? "Key findings" : "Findings"}</h2>
          <span>${escapeHtml(String(findings.length))} total</span>
        </div>
        ${renderValidationFindings(findings, { compact })}
      </section>
      ${renderTagDeltaSection(resolvedTagDelta, { compact })}
    `
  };
}

function buildWriterView(report, { compact = false, tagDelta = null } = {}) {
  const resolvedTagDelta = tagDelta || report.tagDelta || null;
  const summaryCards = [
    {
      label: "Native tagging",
      value: formatBoolean(report.nativeTaggingApplied),
      tone: report.nativeTaggingApplied ? "success" : "danger"
    },
    {
      label: "Tag nodes",
      value: String(report.tagNodeCount ?? 0)
    },
    {
      label: "Structure elements",
      value: String(report.structureElementCount ?? 0)
    },
    {
      label: "Marked content",
      value: String(report.markedContentCount ?? 0)
    }
  ];

  if (resolvedTagDelta?.delta) {
    summaryCards.push({
      label: "Typed node delta",
      value: formatSignedNumber(resolvedTagDelta.delta.totalTypedNodesDelta)
    });
    summaryCards.push({
      label: "Table attr delta",
      value: formatSignedNumber(resolvedTagDelta.delta.tableAttributeNodeCountDelta)
    });
  }

  return {
    summaryCards,
    contentHtml: `
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading ${compact ? "compact-heading" : ""}">
          <h2>Writer output</h2>
          <span>${escapeHtml(report.status || "completed")}</span>
        </div>
        ${renderDefinitionGrid([
          { label: "Title", value: report.title || "Untitled" },
          { label: "Metadata applied", value: formatBoolean(report.metadataApplied) },
          { label: "Language", value: report.language || "en-US" },
          { label: "Manifest path", value: report.manifestPath || "Unavailable" },
          { label: "Output PDF", value: report.outputPath || "Unavailable" }
        ])}
      </section>
      ${
        compact
          ? ""
          : `
            <section class="report-section">
              <div class="section-heading">
                <h2>Structure metrics</h2>
              </div>
              ${renderDefinitionGrid([
                { label: "Table attributes", value: String(report.tableAttributeCount ?? 0) },
                { label: "Structure elements", value: String(report.structureElementCount ?? 0) },
                { label: "Marked content", value: String(report.markedContentCount ?? 0) },
                { label: "Native tagging", value: formatBoolean(report.nativeTaggingApplied) }
              ])}
            </section>
          `
      }
      ${renderTagDeltaSection(resolvedTagDelta, { compact })}
    `
  };
}

function buildRedactionView(report, { compact = false, tagDelta = null } = {}) {
  const matches = report.matches || [];
  const visibleMatches = compact ? matches.slice(0, 6) : matches;
  const overflow = matches.length - visibleMatches.length;
  const resolvedTagDelta = tagDelta || report.tagDelta || null;
  const summaryCards = [
    {
      label: "SSNs redacted",
      value: String(report.summary?.redactedMatches ?? 0),
      tone: (report.summary?.redactedMatches ?? 0) > 0 ? "success" : ""
    },
    {
      label: "Pages touched",
      value: String(report.summary?.pagesRedacted ?? 0)
    },
    {
      label: "Pages processed",
      value: String(report.summary?.pagesProcessed ?? 0)
    },
    {
      label: "Output mode",
      value: report.summary?.outputMode || "unknown"
    }
  ];

  if (typeof report.accessibilityTreeRedacted === "boolean") {
    summaryCards.push({
      label: "Accessibility text",
      value: report.accessibilityTreeRedacted ? "Redacted" : "Unchanged",
      tone: report.accessibilityTreeRedacted ? "success" : ""
    });
  }

  if (resolvedTagDelta?.delta) {
    summaryCards.push({
      label: "Typed node delta",
      value: formatSignedNumber(resolvedTagDelta.delta.totalTypedNodesDelta)
    });
    summaryCards.push({
      label: "Marked content delta",
      value: formatSignedNumber(resolvedTagDelta.delta.markedContentOperatorCountDelta)
    });
  }

  return {
    summaryCards,
    contentHtml: `
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading ${compact ? "compact-heading" : ""}">
          <h2>Redaction summary</h2>
          <span>${escapeHtml(report.status || "completed")}</span>
        </div>
        ${renderDefinitionGrid([
          { label: "Source PDF", value: report.sourcePdf || "Unavailable" },
          { label: "Output PDF", value: report.outputPdf || "Unavailable" },
          { label: "Candidate matches", value: String(report.summary?.candidateMatches ?? 0) },
          { label: "Pages redacted", value: String(report.summary?.pagesRedacted ?? 0) },
          {
            label: "Accessibility tree",
            value:
              typeof report.accessibilityTreeRedacted === "boolean"
                ? report.accessibilityTreeRedacted
                  ? "Redacted"
                  : "Unchanged"
                : "Unavailable"
          }
        ])}
        <p class="report-note">${
          report.accessibilityTreeRedacted
            ? "Masked match previews are safe to show inline. The output PDF removes the original SSN text from both the visible page content and the accessibility layer."
            : "Masked match previews are safe to show inline. The output PDF keeps download access while removing the original SSN text layer."
        }</p>
      </section>
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading ${compact ? "compact-heading" : ""}">
          <h2>${compact ? "Redacted matches" : "Redacted matches"}</h2>
          <span>${escapeHtml(String(matches.length))} total</span>
        </div>
        ${
          visibleMatches.length === 0
            ? '<div class="empty-report">No SSNs were detected in this document.</div>'
            : `
              <div class="definition-grid">
                ${visibleMatches
                  .map(
                    (match) => `
                      <article class="definition-card">
                        <span class="definition-label">Page ${escapeHtml(String(match.pageNumber))}</span>
                        <strong>${escapeHtml(match.maskedText)}</strong>
                      </article>
                    `
                  )
                  .join("")}
              </div>
              ${
                compact && overflow > 0
                  ? `<p class="report-note compact-preview-note">Showing ${visibleMatches.length} of ${matches.length} redacted matches.</p>`
                  : ""
              }
            `
        }
      </section>
      ${renderTagDeltaSection(resolvedTagDelta, { compact })}
    `
  };
}

function renderTagNode(node, depth = 0) {
  const children = Array.isArray(node.children) ? node.children : [];
  const label = node.label ? escapeHtml(node.label) : "";
  const sourceIds = node.sourceNodeIds?.length ? `Source: ${escapeHtml(node.sourceNodeIds.join(", "))}` : "";

  return `
    <li class="tree-node depth-${Math.min(depth, 4)}">
      <div class="tree-card">
        <div class="tree-header">
          <strong>${escapeHtml(node.type || "Node")}</strong>
          <span class="tree-id">${escapeHtml(node.id || "")}</span>
        </div>
        ${label ? `<p class="tree-label">${label}</p>` : ""}
        ${sourceIds ? `<p class="tree-source">${sourceIds}</p>` : ""}
      </div>
      ${
        children.length
          ? `<ul class="tree-children">${children.map((child) => renderTagNode(child, depth + 1)).join("")}</ul>`
          : ""
      }
    </li>
  `;
}

function buildTagManifestView(report, { compact = false, tagDelta = null } = {}) {
  const summary = report.summary || {};
  const root = report.tagging?.root;
  const resolvedTagDelta = tagDelta || report.tagDelta || null;

  const summaryCards = [
    {
      label: "Writer mode",
      value: report.writerMode || "Unknown"
    },
    {
      label: "Native tagging",
      value: formatBoolean(report.nativeTaggingApplied),
      tone: report.nativeTaggingApplied ? "success" : "danger"
    },
    {
      label: "Structure elements",
      value: String(summary.structureElementCount ?? 0)
    },
    {
      label: "Marked content",
      value: String(summary.markedContentCount ?? 0)
    }
  ];

  if (resolvedTagDelta?.delta) {
    summaryCards.push({
      label: "Typed node delta",
      value: formatSignedNumber(resolvedTagDelta.delta.totalTypedNodesDelta)
    });
    summaryCards.push({
      label: "Marked content delta",
      value: formatSignedNumber(resolvedTagDelta.delta.markedContentOperatorCountDelta)
    });
  }

  return {
    summaryCards,
    contentHtml: compact
      ? `
        <section class="report-section compact-section">
          <div class="section-heading compact-heading">
            <h2>Manifest summary</h2>
            <span>${escapeHtml(report.tagging?.documentId || "No document id")}</span>
          </div>
          ${renderDefinitionGrid([
            { label: "Source PDF", value: report.sourcePdf || "Unavailable" },
            { label: "Output PDF", value: report.outputPdf || "Unavailable" },
            { label: "Instruction records", value: String(summary.instructionRecordCount ?? 0) },
            { label: "Metadata applied", value: formatBoolean(summary.metadataApplied) }
          ])}
        </section>
        ${renderCompactTreeSummary(root)}
        ${renderTagDeltaSection(resolvedTagDelta, { compact: true })}
      `
      : `
        <section class="report-section">
          <div class="section-heading">
            <h2>Manifest summary</h2>
            <span>${escapeHtml(report.tagging?.documentId || "No document id")}</span>
          </div>
          ${renderDefinitionGrid([
            { label: "Source PDF", value: report.sourcePdf || "Unavailable" },
            { label: "Output PDF", value: report.outputPdf || "Unavailable" },
            { label: "Instruction records", value: String(summary.instructionRecordCount ?? 0) },
            { label: "Metadata applied", value: formatBoolean(summary.metadataApplied) }
          ])}
        </section>
        <section class="report-section">
          <div class="section-heading">
            <h2>Logical tag tree</h2>
            <span>${root ? escapeHtml(root.type || "root") : "No tree"}</span>
          </div>
          ${
            root
              ? `<ul class="tree-root">${renderTagNode(root)}</ul>`
              : `<div class="empty-report">No logical tree is available in this manifest.</div>`
          }
        </section>
        ${renderTagDeltaSection(resolvedTagDelta, { compact: false })}
      `
  };
}

function buildTagDeltaView(report, { compact = false } = {}) {
  return {
    summaryCards: [
      {
        label: "Struct tree added",
        value: formatBoolean(report?.delta?.structTreeAdded),
        tone: report?.delta?.structTreeAdded ? "success" : ""
      },
      {
        label: "Typed node delta",
        value: formatSignedNumber(report?.delta?.totalTypedNodesDelta)
      },
      {
        label: "Marked content delta",
        value: formatSignedNumber(report?.delta?.markedContentOperatorCountDelta)
      },
      {
        label: "Table attr delta",
        value: formatSignedNumber(report?.delta?.tableAttributeNodeCountDelta)
      }
    ],
    contentHtml: `
      ${renderTagDeltaSection(report, { compact })}
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading ${compact ? "compact-heading" : ""}">
          <h2>Before / after</h2>
          <span>Corpus-level tagging indicators</span>
        </div>
        ${renderDefinitionGrid([
          { label: "Source typed nodes", value: String(report?.source?.totalTypedNodes ?? 0) },
          { label: "Tagged typed nodes", value: String(report?.tagged?.totalTypedNodes ?? 0) },
          { label: "Source marked content", value: String(report?.source?.markedContentOperatorCount ?? 0) },
          { label: "Tagged marked content", value: String(report?.tagged?.markedContentOperatorCount ?? 0) },
          { label: "Source table attrs", value: String(report?.source?.tableAttributeNodeCount ?? 0) },
          { label: "Tagged table attrs", value: String(report?.tagged?.tableAttributeNodeCount ?? 0) }
        ])}
      </section>
    `
  };
}

function buildGenericView(report, artifactName, { compact = false } = {}) {
  const type = getJsonValueType(report);
  const summaryCards = [
    {
      label: "Artifact",
      value: getArtifactLabel(artifactName)
    },
    {
      label: "Root type",
      value: humanizeArtifactName(type)
    },
    {
      label: "Top-level",
      value: formatJsonCountLabel(report)
    }
  ];

  if (type === "object" && typeof report?.status === "string") {
    summaryCards.push({
      label: "Status",
      value: report.status
    });
  } else if (type === "object" && typeof report?.schemaVersion === "string") {
    summaryCards.push({
      label: "Schema",
      value: report.schemaVersion
    });
  }

  const overviewEntries = [
    {
      label: "Artifact name",
      value: artifactName
    },
    {
      label: "Display label",
      value: getArtifactLabel(artifactName)
    },
    {
      label: "Root type",
      value: humanizeArtifactName(type)
    },
    {
      label: "Top-level count",
      value: String(getTopLevelEntryCount(report))
    }
  ];

  const scalarDefinitions = buildScalarDefinitions(report);

  return {
    summaryCards,
    contentHtml: `
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading">
          <h2>Artifact overview</h2>
          <span>${escapeHtml(getArtifactLabel(artifactName))}</span>
        </div>
        ${renderDefinitionGrid(overviewEntries)}
      </section>
      ${
        scalarDefinitions.length
          ? `
            <section class="report-section ${compact ? "compact-section" : ""}">
              <div class="section-heading">
                <h2>Quick facts</h2>
                <span>${escapeHtml(String(scalarDefinitions.length))} surfaced</span>
              </div>
              ${renderDefinitionGrid(scalarDefinitions)}
            </section>
          `
          : ""
      }
      <section class="report-section ${compact ? "compact-section" : ""}">
        <div class="section-heading">
          <h2>Structured preview</h2>
          <span>Browser JSON explorer</span>
        </div>
        ${renderJsonPreview(report)}
      </section>
    `
  };
}

export function buildArtifactView(report, artifactName, options = {}) {
  if (artifactName === "validationReport") {
    return buildValidationView(report, options);
  }

  if (artifactName === "tagDeltaReport") {
    return buildTagDeltaView(report, options);
  }

  if (artifactName === "writerReport") {
    return buildWriterView(report, options);
  }

  if (artifactName === "tagManifest") {
    return buildTagManifestView(report, options);
  }

  if (artifactName === "redactionReport") {
    return buildRedactionView(report, options);
  }

  return buildGenericView(report, artifactName, options);
}
