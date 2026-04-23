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

function renderDefinitionList(element, entries) {
  element.innerHTML = entries
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
}

function formatNumber(value) {
  if (value == null) {
    return "n/a";
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : "n/a";
}

function formatMetric(value, { percent = true } = {}) {
  if (value == null) {
    return "n/a";
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }
  if (!percent) {
    return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return `${(numeric * 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function shortHash(value) {
  return value ? String(value).slice(0, 12) : "n/a";
}

function formatList(values) {
  return Array.isArray(values) && values.length ? values.join("; ") : "none";
}

function renderMethodology(config) {
  const methodology = config.methodology || {};
  const list = document.querySelector("#methodology-list");
  const items = [
    ...(methodology.pipeline || []),
    methodology.trainingSignal?.humanGate,
    "The classifier remains a shadow-mode evidence producer; deterministic OpenAutoTag output is still the final output."
  ].filter(Boolean);
  list.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderModelDistribution(config) {
  const target = document.querySelector("#model-distribution");
  const rows = config.review.modelDistribution || [];
  if (!rows.length) {
    target.textContent = "No model evidence has been loaded.";
    return;
  }

  target.innerHTML = rows
    .map((row) => `
      <div class="evidence-item">
        <span>${escapeHtml(row.modelId)}</span>
        <strong>${formatNumber(row.itemCount)}</strong>
        <small>${escapeHtml(shortHash(row.modelHash))}</small>
      </div>
    `)
    .join("");
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  if (!response.ok) {
    throw new Error(config.error || `Configuration request failed with ${response.status}`);
  }

  const training = config.model.training || {};
  const metrics = training.metrics || {};
  const matrix = config.methodology?.corpusMatrix || {};
  const pairCoverage = matrix.pairCoverageSummary || {};
  const release = training.releaseGateStatus || {};
  const experiment = config.experiment || {};

  renderDefinitionList(document.querySelector("#model-config"), [
    ["Classifier", training.classifierId || "n/a"],
    ["Model hash", shortHash(training.modelHash)],
    ["Dataset", training.trainingDatasetVersion || "n/a"],
    ["Label source", training.labelSource || "n/a"],
    ["Default model", config.model.defaultPath],
    ["Runtime mode", config.model.mode],
    ["Output policy", config.model.outputFinality]
  ]);

  renderDefinitionList(document.querySelector("#review-config"), [
    ["Report roots", formatList(config.review.reportRoots)],
    ["Label store", config.review.labelPath],
    ["Total items", config.summary.totalItems],
    ["Reviewed", config.summary.reviewedItems],
    ["Unreviewed", config.summary.unreviewedItems],
    ["Decisions", `YES ${config.summary.decisions.yes}, NO ${config.summary.decisions.no}, REVIEW ${config.summary.decisions.review}`],
    ["Agent notes", config.summary.notesForAgents]
  ]);

  renderDefinitionList(document.querySelector("#results-config"), [
    ["Evaluation examples", formatNumber(metrics.exampleCount)],
    ["Accuracy", formatMetric(metrics.accuracy)],
    ["Supported macro F1", formatMetric(metrics.supportedMacroF1)],
    ["Balanced accuracy", formatMetric(metrics.balancedAccuracy)],
    ["Calibration error", formatMetric(metrics.expectedCalibrationError, { percent: false })],
    ["Majority baseline", `${metrics.majorityBaselineRole || "n/a"} ${formatMetric(metrics.majorityBaselineAccuracy)}`],
    ["Zero-support roles", formatList(metrics.zeroSupportRoles)]
  ]);

  renderDefinitionList(document.querySelector("#matrix-config"), [
    ["Manifest", matrix.manifestPath || "n/a"],
    ["Generated PDFs", formatNumber(matrix.count)],
    ["Matrix factors", formatNumber(matrix.generator?.matrixFactorCount || Object.keys(matrix.factorValueCounts || {}).length)],
    ["Archetypes", formatNumber(Object.keys(matrix.archetypeCounts || {}).length)],
    ["Pair coverage", `${formatNumber(pairCoverage.observedPairsTotal)} / ${formatNumber(pairCoverage.possiblePairsTotal)} (${formatMetric(pairCoverage.ratio)})`],
    ["Strategy", matrix.generator?.matrixStrategy || "n/a"]
  ]);

  renderDefinitionList(document.querySelector("#preview-config"), [
    ["Renderer", config.preview.renderer],
    ["Raster DPI", config.preview.rasterDpi],
    ["Raster cache", config.review.rasterCacheDir],
    ["Sample endpoint", config.preview.sampleEndpoint],
    ["Page PNG endpoint", config.preview.pageRasterEndpoint],
    ["Zoom range", config.preview.zoomRange]
  ]);

  renderDefinitionList(document.querySelector("#experiment-config"), [
    ["Preset", experiment.defaultPreset || "matrix-smoke"],
    ["Input", experiment.defaultInputDir || "n/a"],
    ["Output", experiment.defaultOutputDir || "n/a"],
    ["Default limit", experiment.defaultLimit || "none"],
    ["Arms", (experiment.comparisonArms || []).map((arm) => arm.label).join(" -> ") || "ML-enhanced -> vanilla-noML"],
    ["Reports", formatList(experiment.reportFiles)]
  ]);

  renderMethodology(config);
  renderModelDistribution(config);
  renderDefinitionList(document.querySelector("#release-config"), [
    ["Mode", release.mode || config.methodology?.operatingMode || "research-only"],
    ["Deterministic final", release.deterministicOutputFinal === false ? "no" : "yes"],
    ["Assistive output", release.assistiveOutputAllowed ? "allowed" : "not allowed"],
    ["Reason", release.reason || "Human-reviewed release gates have not been satisfied."]
  ]);

  const modelPath = config.model.defaultPath || "output\\ml-pilot\\role-baseline-large-v4-matrix.json";
  const reportRoots = formatList(config.review.reportRoots);
  document.querySelector("#command-config").textContent = [
    "npm run ml:experiment",
    `npm run ml:experiment -- --limit 12`,
    `npm run ml:compare -- --input-dir "C:\\PDFs\\real-docs" --output-dir output\\ml-experiments\\real-docs --model ${modelPath} --limit 25`,
    `npm run ml:train-role -- --artifacts-dir "output;tmp" --model ${modelPath}`,
    `npm run ml:review-generate -- --artifacts-dir "output;tmp" --model ${modelPath} --output-dir output\\ml-human-review\\predictions-large-v4-matrix`,
    `npm run ml:review -- --reports "${reportRoots}" --labels output\\ml-human-review\\human-classification-reviews.jsonl --model ${modelPath}`
  ].join("\n");
}

loadConfig().catch((error) => {
  const target = document.querySelector("#model-config");
  target.innerHTML = `<dt>Error</dt><dd>${escapeHtml(error.message)}</dd>`;
});
