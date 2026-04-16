/**
 * Renders a proof report JSON to an HTML string for visual comparison.
 * @param {object} report - proof report object from compareWriterModes
 * @returns {string} HTML document string
 */
export function renderProofReportHtml(report) {
  const { document: docName, modes, comparison, verdict, confidence } = report;
  const raster = modes.raster;
  const native = modes.native;

  const verdictColor = verdict === "native-recommended" ? "#22c55e" : "#ef4444";
  const verdictLabel = verdict === "native-recommended" ? "Native Recommended" : "Raster Preferred";

  const maxSize = Math.max(raster.fileSize, native.fileSize) || 1;
  const rasterBarPct = ((raster.fileSize / maxSize) * 100).toFixed(1);
  const nativeBarPct = ((native.fileSize / maxSize) * 100).toFixed(1);

  function indicator(nativeVal, rasterVal, higherIsBetter = true) {
    if (higherIsBetter) {
      return nativeVal >= rasterVal ? "green" : "red";
    }
    return nativeVal <= rasterVal ? "green" : "red";
  }

  function dot(color) {
    return `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${color === "green" ? "#22c55e" : "#ef4444"};margin-right:6px;"></span>`;
  }

  const advantages = (comparison.nativeAdvantages || []).map((a) => `<li>${escapeHtml(a)}</li>`).join("\n");
  const risks = (comparison.nativeRisks || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Proof Report: ${escapeHtml(docName)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1e293b; background: #f8fafc; }
  h1 { font-size: 1.5rem; }
  .verdict-badge { display: inline-block; padding: 0.4rem 1.2rem; border-radius: 6px; color: #fff; font-weight: 700; font-size: 1.1rem; background: ${verdictColor}; }
  .confidence { color: #64748b; margin-left: 1rem; }
  table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
  th, td { text-align: left; padding: 0.6rem 1rem; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; }
  .bar-container { display: flex; align-items: center; gap: 0.5rem; }
  .bar { height: 22px; border-radius: 4px; min-width: 2px; }
  .bar-raster { background: #f97316; }
  .bar-native { background: #3b82f6; }
  .bar-label { font-size: 0.85rem; color: #64748b; min-width: 80px; }
  .advantages li { color: #16a34a; }
  .risks li { color: #dc2626; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<h1>Proof Report: ${escapeHtml(docName)}</h1>
<div>
  <span class="verdict-badge">${verdictLabel}</span>
  <span class="confidence">Confidence: ${(confidence * 100).toFixed(0)}%</span>
</div>

<h2>File Size Comparison</h2>
<div style="margin: 1rem 0;">
  <div class="bar-container">
    <span class="bar-label">Raster</span>
    <div class="bar bar-raster" style="width: ${rasterBarPct}%;"></div>
    <span>${formatBytes(raster.fileSize)}</span>
  </div>
  <div class="bar-container" style="margin-top: 0.4rem;">
    <span class="bar-label">Native</span>
    <div class="bar bar-native" style="width: ${nativeBarPct}%;"></div>
    <span>${formatBytes(native.fileSize)}</span>
  </div>
</div>

<h2>Side-by-Side Metrics</h2>
<table>
  <thead>
    <tr><th>Metric</th><th>Raster</th><th>Native</th><th>Status</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>File Size</td>
      <td>${formatBytes(raster.fileSize)}</td>
      <td>${formatBytes(native.fileSize)}</td>
      <td>${dot(indicator(native.fileSize, raster.fileSize, false))} ${comparison.fileSizeRatio < 1 ? "Smaller" : "Larger"}</td>
    </tr>
    <tr>
      <td>Text Selectable</td>
      <td>${raster.textSelectable ? "Yes" : "No"}</td>
      <td>${native.textSelectable ? "Yes" : "No"}</td>
      <td>${dot(native.textSelectable ? "green" : "red")} ${native.textSelectable ? "Preserved" : "Lost"}</td>
    </tr>
    <tr>
      <td>Native Text Operators</td>
      <td>${raster.nativeTextPreserved}</td>
      <td>${native.nativeTextPreserved}</td>
      <td>${dot(indicator(native.nativeTextPreserved, raster.nativeTextPreserved))} ${native.nativeTextPreserved > 0 ? "Preserved" : "None"}</td>
    </tr>
    <tr>
      <td>Links Preserved</td>
      <td>${raster.linksPreserved}</td>
      <td>${native.linksPreserved}</td>
      <td>${dot(indicator(native.linksPreserved, raster.linksPreserved))} ${native.linksPreserved} links</td>
    </tr>
    <tr>
      <td>Form Fields</td>
      <td>${raster.formFieldsPreserved}</td>
      <td>${native.formFieldsPreserved}</td>
      <td>${dot(indicator(native.formFieldsPreserved, raster.formFieldsPreserved))} ${native.formFieldsPreserved} fields</td>
    </tr>
    <tr>
      <td>Content Preservation</td>
      <td>-</td>
      <td>${(comparison.contentPreservationScore * 100).toFixed(1)}%</td>
      <td>${dot(comparison.contentPreservationScore >= 0.9 ? "green" : "red")} Score</td>
    </tr>
    <tr>
      <td>Structure Fidelity</td>
      <td>-</td>
      <td>${(comparison.structureFidelity * 100).toFixed(1)}%</td>
      <td>${dot(comparison.structureFidelity >= 0.85 ? "green" : "red")} Fidelity</td>
    </tr>
  </tbody>
</table>

<h2>Advantages</h2>
<ul class="advantages">${advantages || "<li>None identified</li>"}</ul>

<h2>Risks</h2>
<ul class="risks">${risks || "<li>None identified</li>"}</ul>

</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
