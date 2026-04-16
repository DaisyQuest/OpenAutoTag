/**
 * repair-report-renderer.js
 * Renders a corruption-repair report JSON into a self-contained HTML string.
 */

const CHECK_TYPE_LABELS = {
  'xref-table': 'Cross-Reference Table',
  'flate-stream': 'Flate/Deflate Streams',
  'fonts': 'Font Integrity',
  'page-tree': 'Page Tree',
  'content-streams': 'Content Streams',
  'metadata': 'Metadata',
  'annotations': 'Annotations',
  'images': 'Image Objects',
  'linearization': 'Linearization',
  'encryption': 'Encryption',
  'trailer': 'Trailer Dictionary',
  'object-streams': 'Object Streams',
};

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2, clean: 3 };

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function humanLabel(type) {
  return CHECK_TYPE_LABELS[type] || type.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function riskColor(level) {
  const map = { clean: '#16a34a', low: '#2563eb', medium: '#d97706', high: '#dc2626', critical: '#991b1b' };
  return map[level] || '#64748b';
}

function severityColor(sev) {
  const map = { error: 'var(--rr-red)', warning: 'var(--rr-amber)', info: 'var(--rr-blue)', clean: 'var(--rr-green)' };
  return map[sev] || 'var(--rr-muted)';
}

function healthColor(score) {
  if (score >= 0.8) return 'var(--rr-green)';
  if (score >= 0.5) return 'var(--rr-amber)';
  return 'var(--rr-red)';
}

function iconForRow(repair) {
  if (!repair) return `<svg viewBox="0 0 24 24" width="20" height="20" fill="var(--rr-green)" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
  if (repair.repaired) return `<svg viewBox="0 0 24 24" width="20" height="20" fill="var(--rr-amber)" aria-hidden="true"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>`;
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="var(--rr-red)" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`;
}

/**
 * Build the full set of 8 check rows (merging repairs + clean checks).
 */
function buildCheckRows(report) {
  const allTypes = [
    'xref-table', 'flate-stream', 'fonts', 'page-tree',
    'content-streams', 'metadata', 'annotations', 'images',
  ];
  const repairMap = new Map();
  for (const r of (report.repairs || [])) {
    repairMap.set(r.type, r);
  }
  const rows = allTypes.map(type => {
    const repair = repairMap.get(type);
    return {
      type,
      label: humanLabel(type),
      severity: repair ? repair.severity : 'clean',
      description: repair ? repair.description : 'No issues detected',
      repaired: repair ? repair.repaired : null,
      details: repair ? repair.details : null,
      repair,
    };
  });
  rows.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  return rows;
}

export function renderRepairReport(report) {
  const healthPct = Math.round((report.healthScore ?? 0) * 100);
  const corruptPct = Math.round((report.corruptionScore ?? 0) * 100);
  const effectPct = Math.round((report.repairEffectiveness ?? 0) * 100);
  const docName = escapeHtml(report.inputPath || 'Unknown document');
  const outputName = escapeHtml(report.outputPath || '');
  const hColor = healthColor(report.healthScore ?? 0);
  const rColor = riskColor(report.riskLevel || 'clean');
  const rows = buildCheckRows(report);
  const summary = report.summary || {};
  const afterCorruption = summary.overallStatus === 'repaired'
    ? Math.round(report.corruptionScore * (1 - (report.repairEffectiveness ?? 0)) * 100)
    : corruptPct;

  // Gauge: CSS conic-gradient circle
  const gaugeDeg = Math.round(healthPct * 3.6);

  const checkRowsHtml = rows.map((row, i) => {
    const icon = row.repair ? iconForRow(row.repair) : iconForRow(null);
    const sevLabel = row.severity.charAt(0).toUpperCase() + row.severity.slice(1);
    const detailsId = `details-${i}`;
    const detailsJson = row.details ? escapeHtml(JSON.stringify(row.details, null, 2)) : null;
    return `
      <div class="check-row" tabindex="0">
        <span class="check-icon">${icon}</span>
        <span class="check-name">${escapeHtml(row.label)}</span>
        <span class="severity-badge" style="background:${severityColor(row.severity)}20;color:${severityColor(row.severity)};border:1px solid ${severityColor(row.severity)}40">${sevLabel}</span>
        <span class="check-desc">${escapeHtml(row.description)}</span>
        ${detailsJson ? `<button class="details-toggle" aria-expanded="false" aria-controls="${detailsId}" onclick="let d=document.getElementById('${detailsId}');let open=d.hidden;d.hidden=!open;this.setAttribute('aria-expanded',open);this.textContent=open?'Hide details':'Show details'">Show details</button>
        <pre class="details-json" id="${detailsId}" hidden>${detailsJson}</pre>` : ''}
      </div>`;
  }).join('');

  // Timeline
  const timelineHtml = (report.repairs || []).map((r, i) => {
    const nodeColor = r.severity === 'error' ? 'var(--rr-red)' : r.severity === 'warning' ? 'var(--rr-amber)' : 'var(--rr-muted)';
    const status = r.repaired ? 'Repaired' : 'Unresolved';
    return `
      <div class="timeline-item">
        <div class="timeline-line-segment" ${i === 0 ? 'style="background:transparent"' : ''}></div>
        <div class="timeline-node" style="background:${nodeColor}"></div>
        <div class="timeline-content">
          <strong>${escapeHtml(humanLabel(r.type))}</strong>
          <span class="timeline-status" style="color:${nodeColor}">${status}</span>
          <p>${escapeHtml(r.description)}</p>
        </div>
      </div>`;
  }).join('');

  // Bar widths for file size comparison
  const inputSize = report.fileSize || 1;
  const outputSize = report.outputFileSize || inputSize;
  const maxSize = Math.max(inputSize, outputSize);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Repair Report &mdash; ${docName}</title>
<style>
:root {
  --rr-bg: #fafbfc;
  --rr-fg: #1e293b;
  --rr-muted: #64748b;
  --rr-border: #e2e8f0;
  --rr-card-bg: #ffffff;
  --rr-card-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04);
  --rr-green: #16a34a;
  --rr-green-bg: #f0fdf4;
  --rr-amber: #d97706;
  --rr-amber-bg: #fffbeb;
  --rr-red: #dc2626;
  --rr-red-bg: #fef2f2;
  --rr-blue: #2563eb;
  --rr-blue-bg: #eff6ff;
  --rr-gauge-trail: #e2e8f0;
  --rr-header-gradient: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%);
  --rr-section-radius: 12px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --rr-bg: #0f172a;
    --rr-fg: #e2e8f0;
    --rr-muted: #94a3b8;
    --rr-border: #334155;
    --rr-card-bg: #1e293b;
    --rr-card-shadow: 0 1px 4px rgba(0,0,0,0.2), 0 4px 16px rgba(0,0,0,0.15);
    --rr-green-bg: #052e16;
    --rr-amber-bg: #451a03;
    --rr-red-bg: #450a0a;
    --rr-blue-bg: #1e3a5f;
    --rr-gauge-trail: #334155;
    --rr-header-gradient: linear-gradient(135deg, #020617 0%, #0f172a 50%, #1e293b 100%);
  }
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--rr-bg);color:var(--rr-fg);line-height:1.6;min-height:100vh}
.rr-container{max-width:960px;margin:0 auto;padding:0 1rem 3rem}

/* ── Header ─────────────────────────────────────────── */
.rr-header{background:var(--rr-header-gradient);color:#f8fafc;padding:2.5rem 2rem 2rem;border-radius:0 0 var(--rr-section-radius) var(--rr-section-radius);margin-bottom:2rem;position:relative;overflow:hidden}
.rr-header::before{content:'';position:absolute;top:-60%;right:-10%;width:400px;height:400px;background:radial-gradient(circle,rgba(255,255,255,0.04) 0%,transparent 70%);pointer-events:none}
.rr-header-top{display:flex;align-items:center;gap:2rem;flex-wrap:wrap}
.rr-doc-name{font-size:1.75rem;font-weight:700;word-break:break-word;flex:1 1 300px}

/* Gauge */
.rr-gauge{position:relative;width:120px;height:120px;flex-shrink:0}
.rr-gauge-circle{width:120px;height:120px;border-radius:50%;background:conic-gradient(${hColor} 0deg ${gaugeDeg}deg, var(--rr-gauge-trail) ${gaugeDeg}deg 360deg);display:flex;align-items:center;justify-content:center;animation:rr-spin-in 1s ease-out}
.rr-gauge-inner{width:90px;height:90px;border-radius:50%;background:var(--rr-header-gradient);display:flex;flex-direction:column;align-items:center;justify-content:center}
.rr-gauge-value{font-size:1.8rem;font-weight:800;line-height:1}
.rr-gauge-label{font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-top:2px}
@keyframes rr-spin-in{from{transform:rotate(-90deg);opacity:0}to{transform:rotate(0);opacity:1}}

.rr-header-meta{display:flex;align-items:center;gap:1rem;margin-top:1rem;flex-wrap:wrap}
.rr-risk-badge{display:inline-flex;align-items:center;padding:0.3rem 0.9rem;border-radius:20px;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;background:${rColor};color:#fff}
.rr-summary-text{color:#cbd5e1;font-size:0.95rem}

/* ── Section card ───────────────────────────────────── */
.rr-section{background:var(--rr-card-bg);border:1px solid var(--rr-border);border-radius:var(--rr-section-radius);padding:1.5rem;margin-bottom:1.5rem;box-shadow:var(--rr-card-shadow)}
.rr-section-title{font-size:1.15rem;font-weight:700;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem}
.rr-section-title svg{flex-shrink:0}

/* ── Check rows ─────────────────────────────────────── */
.check-row{display:grid;grid-template-columns:28px 1fr auto 2fr auto;gap:0.75rem;align-items:center;padding:0.75rem 0.5rem;border-radius:8px;transition:background 0.15s,box-shadow 0.15s;cursor:default;border-bottom:1px solid var(--rr-border)}
.check-row:last-child{border-bottom:none}
.check-row:hover{background:color-mix(in srgb, var(--rr-fg) 4%, transparent);box-shadow:0 1px 4px rgba(0,0,0,0.04)}
.check-icon{display:flex;align-items:center;justify-content:center}
.check-name{font-weight:600;font-size:0.9rem;white-space:nowrap}
.severity-badge{font-size:0.7rem;font-weight:700;padding:0.15rem 0.55rem;border-radius:12px;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap}
.check-desc{font-size:0.85rem;color:var(--rr-muted)}
.details-toggle{font-size:0.75rem;background:none;border:1px solid var(--rr-border);border-radius:6px;padding:0.2rem 0.6rem;color:var(--rr-muted);cursor:pointer;white-space:nowrap;transition:border-color 0.15s}
.details-toggle:hover{border-color:var(--rr-fg)}
.details-json{grid-column:1/-1;background:color-mix(in srgb, var(--rr-fg) 4%, transparent);border-radius:8px;padding:0.8rem 1rem;font-size:0.78rem;overflow-x:auto;font-family:"SF Mono",Menlo,Consolas,monospace;margin-top:0.25rem;line-height:1.5;white-space:pre-wrap}

@media (max-width:700px){
  .check-row{grid-template-columns:28px 1fr auto;gap:0.4rem}
  .check-desc{grid-column:1/-1}
  .details-toggle{grid-column:1/-1;justify-self:start}
}

/* ── Comparison bars ────────────────────────────────── */
.rr-bar-group{margin-bottom:1.2rem}
.rr-bar-label{display:flex;justify-content:space-between;font-size:0.82rem;margin-bottom:0.3rem}
.rr-bar-track{height:28px;background:var(--rr-gauge-trail);border-radius:6px;overflow:hidden}
.rr-bar-fill{height:100%;border-radius:6px;display:flex;align-items:center;padding-left:0.6rem;font-size:0.75rem;font-weight:600;color:#fff;transition:width 0.8s ease-out}
.rr-comparison-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
@media(max-width:600px){.rr-comparison-grid{grid-template-columns:1fr}}

/* ── Mini gauge (corruption) ────────────────────────── */
.rr-mini-gauge{width:80px;height:80px;margin:0.5rem auto}
.rr-mini-gauge-circle{width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.rr-mini-gauge-inner{width:60px;height:60px;border-radius:50%;background:var(--rr-card-bg);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1rem}
.rr-mini-label{text-align:center;font-size:0.75rem;color:var(--rr-muted);margin-top:0.3rem}

/* ── Timeline ───────────────────────────────────────── */
.timeline-item{display:flex;align-items:flex-start;gap:1rem;position:relative;padding-bottom:1.2rem}
.timeline-item:last-child{padding-bottom:0}
.timeline-line-segment{position:absolute;left:11px;top:-1.2rem;width:2px;height:1.2rem;background:var(--rr-border)}
.timeline-item:first-child .timeline-line-segment{background:transparent}
.timeline-node{width:24px;height:24px;border-radius:50%;flex-shrink:0;margin-top:2px;box-shadow:0 0 0 4px color-mix(in srgb, var(--rr-card-bg) 100%, transparent)}
.timeline-content{flex:1}
.timeline-content strong{font-size:0.92rem}
.timeline-status{font-size:0.78rem;font-weight:600;margin-left:0.5rem}
.timeline-content p{font-size:0.83rem;color:var(--rr-muted);margin-top:0.15rem}

/* ── Summary stats ──────────────────────────────────── */
.rr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1rem;text-align:center;margin-top:0.5rem}
.rr-stat-value{font-size:1.6rem;font-weight:800}
.rr-stat-label{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--rr-muted)}

/* ── Footer ─────────────────────────────────────────── */
.rr-footer{text-align:center;padding:2rem 1rem 1rem;color:var(--rr-muted);font-size:0.78rem}
.rr-footer strong{color:var(--rr-fg);font-weight:600}
</style>
</head>
<body>
<div class="rr-container">

  <!-- ═══ HEADER ═══ -->
  <div class="rr-header">
    <div class="rr-header-top">
      <div style="flex:1 1 300px">
        <div class="rr-doc-name">${docName}</div>
        ${outputName ? `<div style="font-size:0.82rem;color:#94a3b8;margin-top:0.25rem">&#8594; ${outputName}</div>` : ''}
      </div>
      <div class="rr-gauge">
        <div class="rr-gauge-circle">
          <div class="rr-gauge-inner">
            <span class="rr-gauge-value">${healthPct}</span>
            <span class="rr-gauge-label">Health Score</span>
          </div>
        </div>
      </div>
    </div>
    <div class="rr-header-meta">
      <span class="rr-risk-badge">${escapeHtml((report.riskLevel || 'unknown').toUpperCase())} RISK</span>
      <span class="rr-summary-text">${escapeHtml(report.humanSummary || '')}</span>
    </div>
  </div>

  <!-- ═══ SUMMARY STATS ═══ -->
  <div class="rr-section">
    <div class="rr-stats">
      <div><div class="rr-stat-value">${summary.totalChecks ?? '-'}</div><div class="rr-stat-label">Total Checks</div></div>
      <div><div class="rr-stat-value" style="color:var(--rr-red)">${summary.issuesFound ?? '-'}</div><div class="rr-stat-label">Issues Found</div></div>
      <div><div class="rr-stat-value" style="color:var(--rr-green)">${summary.issuesRepaired ?? '-'}</div><div class="rr-stat-label">Repaired</div></div>
      <div><div class="rr-stat-value" style="color:var(--rr-amber)">${summary.issuesUnrepairable ?? '-'}</div><div class="rr-stat-label">Unrepairable</div></div>
      <div><div class="rr-stat-value">${effectPct}%</div><div class="rr-stat-label">Effectiveness</div></div>
    </div>
  </div>

  <!-- ═══ CORRUPTION SCAN RESULTS ═══ -->
  <div class="rr-section">
    <div class="rr-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="var(--rr-blue)"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
      Corruption Scan Results
    </div>
    ${checkRowsHtml}
  </div>

  <!-- ═══ BEFORE / AFTER COMPARISON ═══ -->
  <div class="rr-section">
    <div class="rr-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="var(--rr-amber)"><path d="M9.01 14H2v2h7.01v3L13 15l-3.99-4v3zm5.98-1v-3H22V8h-7.01V5L11 9l3.99 4z"/></svg>
      Before &amp; After Comparison
    </div>
    <div class="rr-comparison-grid">
      <div>
        <div class="rr-bar-group">
          <div class="rr-bar-label"><span>Input File</span><span>${formatBytes(inputSize)}</span></div>
          <div class="rr-bar-track"><div class="rr-bar-fill" style="width:${Math.round(inputSize / maxSize * 100)}%;background:var(--rr-blue)">${formatBytes(inputSize)}</div></div>
        </div>
        <div class="rr-bar-group">
          <div class="rr-bar-label"><span>Output File</span><span>${formatBytes(outputSize)}</span></div>
          <div class="rr-bar-track"><div class="rr-bar-fill" style="width:${Math.round(outputSize / maxSize * 100)}%;background:var(--rr-green)">${formatBytes(outputSize)}</div></div>
        </div>
      </div>
      <div style="display:flex;gap:2rem;justify-content:center">
        <div>
          <div class="rr-mini-gauge">
            <div class="rr-mini-gauge-circle" style="background:conic-gradient(var(--rr-red) 0deg ${Math.round(corruptPct * 3.6)}deg, var(--rr-gauge-trail) ${Math.round(corruptPct * 3.6)}deg 360deg)">
              <div class="rr-mini-gauge-inner">${corruptPct}%</div>
            </div>
          </div>
          <div class="rr-mini-label">Before</div>
        </div>
        <div>
          <div class="rr-mini-gauge">
            <div class="rr-mini-gauge-circle" style="background:conic-gradient(var(--rr-green) 0deg ${Math.round(afterCorruption * 3.6)}deg, var(--rr-gauge-trail) ${Math.round(afterCorruption * 3.6)}deg 360deg)">
              <div class="rr-mini-gauge-inner">${afterCorruption}%</div>
            </div>
          </div>
          <div class="rr-mini-label">After</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ REPAIR TIMELINE ═══ -->
  ${(report.repairs || []).length > 0 ? `
  <div class="rr-section">
    <div class="rr-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="var(--rr-green)"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
      Repair Timeline
    </div>
    ${timelineHtml}
  </div>` : ''}

  <!-- ═══ FOOTER ═══ -->
  <div class="rr-footer">
    <strong>Powered by PDF Accessibility Engine</strong><br>
    Report generated ${new Date().toISOString().replace('T', ' at ').replace(/\.\d+Z/, ' UTC')}
  </div>

</div>
</body>
</html>`;
}
