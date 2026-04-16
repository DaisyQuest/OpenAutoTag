/**
 * font-report-renderer.js
 * Renders a font health report JSON into a spectacular self-contained HTML string.
 *
 * Export: renderFontReport(fontReportJson) -> complete HTML string
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(score) {
  return Math.round((score ?? 0) * 100);
}

function healthColor(score) {
  if (score >= 0.8) return 'var(--fr-green)';
  if (score >= 0.5) return 'var(--fr-amber)';
  return 'var(--fr-red)';
}

function healthColorRaw(score) {
  if (score >= 0.8) return '#16a34a';
  if (score >= 0.5) return '#d97706';
  return '#dc2626';
}

function gradeColor(grade) {
  const map = { A: 'var(--fr-emerald)', B: 'var(--fr-green)', C: 'var(--fr-amber)', D: 'var(--fr-orange)', F: 'var(--fr-red)' };
  return map[grade] || 'var(--fr-muted)';
}

function gradeColorRaw(grade) {
  const map = { A: '#059669', B: '#16a34a', C: '#d97706', D: '#ea580c', F: '#dc2626' };
  return map[grade] || '#64748b';
}

function severityColor(sev) {
  const map = { error: 'var(--fr-red)', warning: 'var(--fr-amber)', info: 'var(--fr-blue)' };
  return map[sev] || 'var(--fr-muted)';
}

function subtypeBadgeColor(subtype) {
  const map = {
    Type1: '#7c3aed',
    TrueType: '#2563eb',
    Type0: '#0891b2',
    Type3: '#c026d3',
    CIDFont: '#059669',
    CIDFontType0: '#059669',
    CIDFontType2: '#0d9488',
    MMType1: '#9333ea',
  };
  return map[subtype] || '#64748b';
}

const CATEGORY_LABELS = {
  embedding: 'Embedding',
  encoding: 'Encoding',
  metrics: 'Metrics',
  structure: 'Structure',
  accessibility: 'Accessibility',
};

const CATEGORY_ICONS = {
  embedding: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>',
  encoding: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>',
  metrics: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14H5V5h7v12z"/></svg>',
  structure: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z"/></svg>',
  accessibility: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20.5 6c-2.61.7-5.67 1-8.5 1s-5.89-.3-8.5-1L3 8c1.86.5 4 .83 6 1v13h2v-6h2v6h2V9c2-.17 4.14-.5 6-1l-.5-2zM12 6c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>',
};

const UNICODE_BLOCKS = [
  { name: 'Basic Latin', start: 0x0020, end: 0x007F },
  { name: 'Latin-1 Supplement', start: 0x0080, end: 0x00FF },
  { name: 'Latin Extended-A', start: 0x0100, end: 0x017F },
  { name: 'Latin Extended-B', start: 0x0180, end: 0x024F },
  { name: 'Greek', start: 0x0370, end: 0x03FF },
  { name: 'Cyrillic', start: 0x0400, end: 0x04FF },
  { name: 'Arabic', start: 0x0600, end: 0x06FF },
  { name: 'Devanagari', start: 0x0900, end: 0x097F },
  { name: 'CJK Unified', start: 0x4E00, end: 0x9FFF },
  { name: 'Hangul', start: 0xAC00, end: 0xD7AF },
  { name: 'General Punctuation', start: 0x2000, end: 0x206F },
  { name: 'Currency Symbols', start: 0x20A0, end: 0x20CF },
  { name: 'Mathematical', start: 0x2200, end: 0x22FF },
  { name: 'Arrows', start: 0x2190, end: 0x21FF },
  { name: 'Box Drawing', start: 0x2500, end: 0x257F },
  { name: 'Private Use', start: 0xE000, end: 0xF8FF },
];

// ── SVG icons ────────────────────────────────────────────────────────────────

const ICON = {
  check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="var(--fr-green)"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="18" height="18" fill="var(--fr-red)"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" width="18" height="18" fill="var(--fr-blue)"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>',
  warning: '<svg viewBox="0 0 24 24" width="18" height="18" fill="var(--fr-amber)"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="var(--fr-blue)"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
  embedded: '<svg viewBox="0 0 24 24" width="16" height="16" fill="var(--fr-green)"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  notEmbedded: '<svg viewBox="0 0 24 24" width="16" height="16" fill="var(--fr-red)"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
};

function findingIcon(finding) {
  if (finding.repaired) return ICON.wrench;
  if (finding.severity === 'error') return ICON.cross;
  if (finding.severity === 'warning') return ICON.warning;
  if (finding.severity === 'info') return ICON.info;
  return ICON.check;
}

// ── Parse font key ───────────────────────────────────────────────────────────

function parseFontKey(fontKey) {
  const match = (fontKey || '').match(/^([A-Z]{6}\+)?(.+)$/);
  if (match) return { prefix: match[1] || '', name: match[2] || fontKey };
  return { prefix: '', name: fontKey || 'Unknown' };
}

// ── Build categories from findings ───────────────────────────────────────────

const ALL_CATEGORIES = ['embedding', 'encoding', 'metrics', 'structure', 'accessibility'];

function groupFindingsByCategory(findings) {
  const groups = {};
  for (const cat of ALL_CATEGORIES) groups[cat] = [];
  for (const f of (findings || [])) {
    const cat = f.category || 'structure';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(f);
  }
  return groups;
}

// ── Encoding visualization ───────────────────────────────────────────────────

function renderEncodingGrid(font) {
  const details = font.findings?.find(f => f.category === 'encoding')?.details || {};
  const coveredRanges = details.unicodeCoverage || details.coveredRanges || [];
  const missingRanges = details.missingRanges || [];

  const cells = UNICODE_BLOCKS.map(block => {
    const isCovered = coveredRanges.some(r =>
      (typeof r === 'string' && r.toLowerCase() === block.name.toLowerCase()) ||
      (r.start !== undefined && r.start <= block.end && r.end >= block.start)
    );
    const isMissing = missingRanges.some(r =>
      (typeof r === 'string' && r.toLowerCase() === block.name.toLowerCase()) ||
      (r.start !== undefined && r.start <= block.end && r.end >= block.start)
    );
    let cls = 'enc-cell enc-neutral';
    if (isMissing) cls = 'enc-cell enc-missing';
    else if (isCovered) cls = 'enc-cell enc-covered';
    return `<div class="${cls}" title="${esc(block.name)} (U+${block.start.toString(16).toUpperCase().padStart(4, '0')}..U+${block.end.toString(16).toUpperCase().padStart(4, '0')})">${esc(block.name.replace(/ /g, '\u00a0'))}</div>`;
  });

  return `
    <div class="enc-grid-section">
      <div class="enc-grid-title">Unicode Coverage</div>
      <div class="enc-legend">
        <span class="enc-legend-item"><span class="enc-dot enc-covered"></span> Covered</span>
        <span class="enc-legend-item"><span class="enc-dot enc-missing"></span> Needed but missing</span>
        <span class="enc-legend-item"><span class="enc-dot enc-neutral"></span> Not applicable</span>
      </div>
      <div class="enc-grid">${cells.join('')}</div>
    </div>`;
}

// ── Card rendering ───────────────────────────────────────────────────────────

function renderFontCard(font, index) {
  const { prefix, name } = parseFontKey(font.fontKey);
  const score = font.health?.score ?? 0;
  const grade = font.health?.grade || '?';
  const scorePct = pct(score);
  const findingsByCategory = groupFindingsByCategory(font.findings);
  const errorCount = font.health?.errorCount ?? 0;
  const warningCount = font.health?.warningCount ?? 0;
  const infoCount = font.health?.infoCount ?? 0;
  const hasEncodingData = font.findings?.some(f => f.category === 'encoding' && f.details && (f.details.unicodeCoverage || f.details.coveredRanges || f.details.missingRanges));
  const cardId = `font-card-${index}`;
  const detailId = `font-detail-${index}`;

  // Finding pills
  const pills = [];
  if (errorCount > 0) pills.push(`<span class="finding-pill pill-error">${errorCount} error${errorCount > 1 ? 's' : ''}</span>`);
  if (warningCount > 0) pills.push(`<span class="finding-pill pill-warning">${warningCount} warning${warningCount > 1 ? 's' : ''}</span>`);
  if (infoCount > 0) pills.push(`<span class="finding-pill pill-info">${infoCount} info</span>`);

  // Category detail sections
  const categoryHtml = ALL_CATEGORIES.map(cat => {
    const findings = findingsByCategory[cat] || [];
    const catErrors = findings.filter(f => f.severity === 'error').length;
    const catWarnings = findings.filter(f => f.severity === 'warning').length;
    const catClean = findings.length === 0;
    const catColor = catClean ? 'var(--fr-green)' : catErrors > 0 ? 'var(--fr-red)' : catWarnings > 0 ? 'var(--fr-amber)' : 'var(--fr-blue)';

    const checksHtml = findings.length === 0
      ? `<div class="cat-check"><span class="cat-check-icon">${ICON.check}</span><span class="cat-check-text">All checks passed</span></div>`
      : findings.map((f, fi) => {
          const fIcon = findingIcon(f);
          const detJsonId = `finding-${index}-${cat}-${fi}`;
          const detailsJson = f.details ? esc(JSON.stringify(f.details, null, 2)) : null;
          return `
            <div class="cat-check">
              <span class="cat-check-icon">${fIcon}</span>
              <span class="cat-check-text">
                ${f.repaired
                  ? `<span class="repaired-label">Repaired:</span> ${esc(f.repairAction || f.description)}`
                  : esc(f.description)}
                <span class="severity-micro" style="color:${severityColor(f.severity)}">${esc(f.severity)}</span>
              </span>
              ${detailsJson ? `<button class="det-toggle" aria-expanded="false" aria-controls="${detJsonId}" onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='false');document.getElementById('${detJsonId}').hidden=!document.getElementById('${detJsonId}').hidden">Details</button>
              <pre class="det-json" id="${detJsonId}" hidden>${detailsJson}</pre>` : ''}
            </div>`;
        }).join('');

    return `
      <div class="cat-section">
        <div class="cat-header">
          <span class="cat-icon" style="color:${catColor}">${CATEGORY_ICONS[cat] || ''}</span>
          <span class="cat-name">${esc(CATEGORY_LABELS[cat] || cat)}</span>
          <span class="cat-indicator" style="background:${catColor}"></span>
        </div>
        ${checksHtml}
      </div>`;
  }).join('');

  return `
    <div class="font-card" id="${cardId}">
      <div class="font-card-header" onclick="let d=document.getElementById('${detailId}');let card=document.getElementById('${cardId}');d.hidden=!d.hidden;card.classList.toggle('expanded')" role="button" tabindex="0" aria-expanded="false" aria-controls="${detailId}">
        <div class="font-card-top">
          <div class="font-name-block">
            ${prefix ? `<span class="font-prefix">${esc(prefix)}</span>` : ''}
            <span class="font-name">${esc(name)}</span>
          </div>
          <div class="font-grade-badge" style="background:${gradeColor(grade)}">${esc(grade)}</div>
        </div>
        <div class="font-card-meta">
          <span class="subtype-badge" style="background:${subtypeBadgeColor(font.subtype)}">${esc(font.subtype || '?')}</span>
          <span class="embed-indicator">${font.embedded ? ICON.embedded : ICON.notEmbedded} ${font.embedded ? 'Embedded' : 'Not embedded'}</span>
          ${font.glyphsUsed != null ? `<span class="glyph-count">${font.glyphsUsed} glyphs</span>` : ''}
        </div>
        <div class="font-health-bar-wrap">
          <div class="font-health-bar" style="width:${scorePct}%;background:${healthColor(score)}"></div>
        </div>
        <div class="font-card-bottom">
          <span class="font-pages">Pages: ${(font.pages || []).join(', ') || 'N/A'}</span>
          <div class="finding-pills">${pills.join(' ')}</div>
        </div>
        <div class="card-expand-hint">Click to ${`expand`}</div>
      </div>
      <div class="font-card-detail" id="${detailId}" hidden>
        ${categoryHtml}
        ${hasEncodingData ? renderEncodingGrid(font) : ''}
      </div>
    </div>`;
}

// ── Repair timeline ──────────────────────────────────────────────────────────

function renderRepairTimeline(fonts) {
  const repaired = [];
  for (const font of (fonts || [])) {
    for (const f of (font.findings || [])) {
      if (f.repaired) {
        repaired.push({ fontKey: font.fontKey, ...f });
      }
    }
  }
  if (repaired.length === 0) return '';

  const items = repaired.map((r, i) => {
    const nodeColor = r.severity === 'error' ? 'var(--fr-red)' : r.severity === 'warning' ? 'var(--fr-amber)' : 'var(--fr-blue)';
    const { name } = parseFontKey(r.fontKey);
    return `
      <div class="tl-item">
        <div class="tl-line" ${i === 0 ? 'style="background:transparent"' : ''}></div>
        <div class="tl-node" style="background:${nodeColor}"></div>
        <div class="tl-content">
          <div class="tl-title">
            <strong>${esc(name)}</strong>
            <span class="severity-micro" style="color:${nodeColor}">${esc(r.severity)}</span>
          </div>
          <div class="tl-desc">${esc(r.description)}</div>
          <div class="tl-action">${ICON.wrench} <span>${esc(r.repairAction || 'Auto-repaired')}</span></div>
        </div>
      </div>`;
  });

  return `
    <div class="fr-section">
      <div class="fr-section-title">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="var(--fr-blue)"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
        Repair Timeline
      </div>
      <div class="tl-container">${items.join('')}</div>
    </div>`;
}

// ── Findings table ───────────────────────────────────────────────────────────

function renderFindingsTable(fonts) {
  const allFindings = [];
  for (const font of (fonts || [])) {
    for (const f of (font.findings || [])) {
      allFindings.push({ fontKey: font.fontKey, ...f });
    }
  }
  if (allFindings.length === 0) return '';

  // Sort: errors first, then warnings, then info
  const sevOrder = { error: 0, warning: 1, info: 2 };
  allFindings.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9));

  const rows = allFindings.map(f => {
    const { name } = parseFontKey(f.fontKey);
    return `
      <tr>
        <td class="ft-font">${esc(name)}</td>
        <td>${esc(CATEGORY_LABELS[f.category] || f.category)}</td>
        <td>${esc(f.checkId || '-')}</td>
        <td><span class="severity-pill" style="background:${severityColor(f.severity)}20;color:${severityColor(f.severity)};border:1px solid ${severityColor(f.severity)}40">${esc(f.severity)}</span></td>
        <td>${esc(f.description)}</td>
        <td>${f.repaired ? `<span class="repaired-yes">Yes</span>` : `<span class="repaired-no">No</span>`}</td>
        <td class="ft-action">${esc(f.repairAction || '-')}</td>
      </tr>`;
  });

  return `
    <div class="fr-section">
      <div class="fr-section-title">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="var(--fr-muted)"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
        All Findings
      </div>
      <div class="ft-wrap">
        <table class="findings-table">
          <thead>
            <tr>
              <th>Font</th><th>Category</th><th>Check</th><th>Severity</th><th>Description</th><th>Repaired</th><th>Action</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Main export ──────────────────────────────────────────────────────────────

export function renderFontReport(report) {
  const summary = report.summary || {};
  const fonts = report.fonts || [];
  const overallScore = summary.overallFontHealth ?? 0;
  const overallPct = pct(overallScore);
  const overallGrade = summary.overallGrade || '?';
  const arcDeg = Math.round(overallPct * 1.8); // 180-degree arc
  const hColor = healthColorRaw(overallScore);
  const gColor = gradeColorRaw(overallGrade);

  const totalChecks = fonts.reduce((sum, f) => {
    const catChecks = ALL_CATEGORIES.length; // 5 categories per font
    return sum + Math.max(catChecks, (f.findings || []).length);
  }, 0);

  const summaryText = `${summary.totalFonts ?? fonts.length} fonts analyzed &middot; ${summary.healthyFonts ?? 0} healthy &middot; ${summary.damagedFonts ?? 0} need attention &middot; ${summary.repairsApplied ?? 0} repaired`;

  const fontCards = fonts.map((f, i) => renderFontCard(f, i)).join('');
  const repairTimeline = renderRepairTimeline(fonts);
  const findingsTable = renderFindingsTable(fonts);
  const timestamp = new Date().toISOString().replace('T', ' at ').replace(/\.\d+Z/, ' UTC');
  const totalFontCount = summary.totalFonts ?? fonts.length;
  const assessmentCount = ALL_CATEGORIES.length * totalFontCount;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Font Health Report</title>
<style>
/* ── CSS Custom Properties ─────────────────────────────────────────── */
:root {
  --fr-bg: #f8fafc;
  --fr-fg: #0f172a;
  --fr-muted: #64748b;
  --fr-border: #e2e8f0;
  --fr-card-bg: #ffffff;
  --fr-card-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 6px 16px rgba(0,0,0,0.04);
  --fr-card-hover-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06);
  --fr-green: #16a34a;
  --fr-emerald: #059669;
  --fr-amber: #d97706;
  --fr-orange: #ea580c;
  --fr-red: #dc2626;
  --fr-blue: #2563eb;
  --fr-gauge-trail: #e2e8f0;
  --fr-header-bg: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%);
  --fr-radius: 14px;
  --fr-radius-sm: 8px;
  --fr-transition: 0.2s ease;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fr-bg: #0c1222;
    --fr-fg: #e2e8f0;
    --fr-muted: #94a3b8;
    --fr-border: #1e293b;
    --fr-card-bg: #1e293b;
    --fr-card-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 6px 16px rgba(0,0,0,0.15);
    --fr-card-hover-shadow: 0 4px 12px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.2);
    --fr-gauge-trail: #334155;
    --fr-header-bg: linear-gradient(135deg, #020617 0%, #0f172a 50%, #1e293b 100%);
  }
}

/* ── Reset & Base ──────────────────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--fr-bg);color:var(--fr-fg);line-height:1.6;min-height:100vh;-webkit-font-smoothing:antialiased}
.fr-container{max-width:1200px;margin:0 auto;padding:0 1.5rem 3rem}

/* ── Header ────────────────────────────────────────────────────────── */
.fr-header{background:var(--fr-header-bg);color:#f1f5f9;padding:3rem 2.5rem 2.5rem;border-radius:0 0 var(--fr-radius) var(--fr-radius);margin-bottom:2rem;position:relative;overflow:hidden}
.fr-header::before{content:'';position:absolute;top:-40%;right:-8%;width:500px;height:500px;background:radial-gradient(circle,rgba(255,255,255,0.03) 0%,transparent 70%);pointer-events:none}
.fr-header::after{content:'';position:absolute;bottom:-30%;left:-5%;width:400px;height:400px;background:radial-gradient(circle,rgba(99,102,241,0.06) 0%,transparent 70%);pointer-events:none}
.fr-header-content{display:flex;align-items:center;gap:2.5rem;flex-wrap:wrap;position:relative;z-index:1}
.fr-header-text{flex:1 1 300px}
.fr-doc-title{font-size:1.1rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.3rem}
.fr-report-title{font-size:2rem;font-weight:800;letter-spacing:-0.02em;line-height:1.2}

/* ── Arc Gauge (180 degree) ────────────────────────────────────────── */
.fr-gauge-wrap{display:flex;align-items:center;gap:1.5rem;flex-shrink:0}
.fr-arc-gauge{position:relative;width:160px;height:88px;overflow:hidden}
.fr-arc-outer{width:160px;height:160px;border-radius:50%;background:conic-gradient(
  ${hColor} 0deg ${arcDeg}deg,
  var(--fr-gauge-trail) ${arcDeg}deg 180deg,
  transparent 180deg 360deg
);position:relative;animation:fr-arc-in 1.2s cubic-bezier(0.22,1,0.36,1)}
.fr-arc-inner{position:absolute;top:20px;left:20px;width:120px;height:120px;border-radius:50%;background:var(--fr-header-bg);display:flex;flex-direction:column;align-items:center;justify-content:center}
.fr-arc-value{font-size:2.2rem;font-weight:900;line-height:1;color:#fff}
.fr-arc-label{font-size:0.65rem;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin-top:2px}
@keyframes fr-arc-in{from{opacity:0;transform:scale(0.8) rotate(-20deg)}to{opacity:1;transform:scale(1) rotate(0)}}

.fr-grade-badge{width:64px;height:64px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:2rem;font-weight:900;color:#fff;background:${gColor};box-shadow:0 4px 12px ${gColor}40;animation:fr-grade-pop 0.6s 0.3s both cubic-bezier(0.34,1.56,0.64,1)}
@keyframes fr-grade-pop{from{opacity:0;transform:scale(0)}to{opacity:1;transform:scale(1)}}

.fr-summary-row{margin-top:1.2rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap;position:relative;z-index:1}
.fr-summary-text{color:#cbd5e1;font-size:0.95rem;line-height:1.5}

/* ── Stats Row ─────────────────────────────────────────────────────── */
.fr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;margin-bottom:2rem}
.fr-stat{background:var(--fr-card-bg);border:1px solid var(--fr-border);border-radius:var(--fr-radius-sm);padding:1.2rem;text-align:center;box-shadow:var(--fr-card-shadow);transition:transform var(--fr-transition),box-shadow var(--fr-transition)}
.fr-stat:hover{transform:translateY(-2px);box-shadow:var(--fr-card-hover-shadow)}
.fr-stat-value{font-size:1.8rem;font-weight:800;line-height:1.2}
.fr-stat-label{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--fr-muted);margin-top:0.2rem}

/* ── Section ───────────────────────────────────────────────────────── */
.fr-section{background:var(--fr-card-bg);border:1px solid var(--fr-border);border-radius:var(--fr-radius);padding:1.5rem 1.8rem;margin-bottom:1.5rem;box-shadow:var(--fr-card-shadow)}
.fr-section-title{font-size:1.15rem;font-weight:700;margin-bottom:1.2rem;display:flex;align-items:center;gap:0.6rem}

/* ── Font Grid ─────────────────────────────────────────────────────── */
.font-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.2rem;margin-bottom:2rem}
@media(max-width:960px){.font-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){.font-grid{grid-template-columns:1fr}}

/* ── Font Card ─────────────────────────────────────────────────────── */
.font-card{background:var(--fr-card-bg);border:1px solid var(--fr-border);border-radius:var(--fr-radius);box-shadow:var(--fr-card-shadow);transition:box-shadow var(--fr-transition),transform var(--fr-transition),border-color var(--fr-transition);overflow:hidden}
.font-card:hover{box-shadow:var(--fr-card-hover-shadow);transform:translateY(-2px);border-color:color-mix(in srgb, var(--fr-fg) 15%, var(--fr-border))}
.font-card.expanded{border-color:var(--fr-blue);box-shadow:0 0 0 2px color-mix(in srgb, var(--fr-blue) 20%, transparent),var(--fr-card-hover-shadow)}
.font-card.expanded:hover{transform:none}
.font-card-header{padding:1.2rem;cursor:pointer;user-select:none}
.font-card-header:focus-visible{outline:2px solid var(--fr-blue);outline-offset:-2px;border-radius:var(--fr-radius)}
.font-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;margin-bottom:0.6rem}
.font-name-block{display:flex;flex-direction:column}
.font-prefix{font-size:0.7rem;color:var(--fr-muted);font-family:"SF Mono",Menlo,Consolas,monospace;letter-spacing:0.02em}
.font-name{font-size:1rem;font-weight:700;line-height:1.3}
.font-grade-badge{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.1rem;font-weight:800;color:#fff;flex-shrink:0}
.font-card-meta{display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;margin-bottom:0.6rem;font-size:0.8rem}
.subtype-badge{color:#fff;padding:0.15rem 0.5rem;border-radius:6px;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em}
.embed-indicator{display:inline-flex;align-items:center;gap:0.25rem;color:var(--fr-muted);font-size:0.78rem}
.glyph-count{color:var(--fr-muted);font-size:0.78rem}
.font-health-bar-wrap{height:4px;background:var(--fr-gauge-trail);border-radius:2px;overflow:hidden;margin-bottom:0.5rem}
.font-health-bar{height:100%;border-radius:2px;transition:width 0.8s ease-out}
.font-card-bottom{display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:wrap}
.font-pages{font-size:0.72rem;color:var(--fr-muted)}
.finding-pills{display:flex;gap:0.4rem;flex-wrap:wrap}
.finding-pill{font-size:0.65rem;font-weight:700;padding:0.1rem 0.45rem;border-radius:10px;white-space:nowrap}
.pill-error{background:color-mix(in srgb, var(--fr-red) 15%, transparent);color:var(--fr-red)}
.pill-warning{background:color-mix(in srgb, var(--fr-amber) 15%, transparent);color:var(--fr-amber)}
.pill-info{background:color-mix(in srgb, var(--fr-blue) 15%, transparent);color:var(--fr-blue)}
.card-expand-hint{font-size:0.68rem;color:var(--fr-muted);text-align:center;margin-top:0.4rem;opacity:0;transition:opacity var(--fr-transition)}
.font-card:hover .card-expand-hint{opacity:1}

/* ── Card Detail (expanded) ────────────────────────────────────────── */
.font-card-detail{padding:0 1.2rem 1.2rem;border-top:1px solid var(--fr-border);animation:fr-slide-down 0.25s ease-out}
@keyframes fr-slide-down{from{opacity:0;max-height:0}to{opacity:1;max-height:2000px}}
.cat-section{margin-top:1rem;padding:0.8rem;background:color-mix(in srgb, var(--fr-fg) 3%, transparent);border-radius:var(--fr-radius-sm)}
.cat-header{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;font-weight:600;font-size:0.88rem}
.cat-indicator{width:8px;height:8px;border-radius:50%;margin-left:auto}
.cat-check{display:flex;align-items:flex-start;gap:0.5rem;padding:0.35rem 0;font-size:0.82rem;flex-wrap:wrap}
.cat-check-icon{flex-shrink:0;display:flex;align-items:center;padding-top:1px}
.cat-check-text{flex:1;min-width:0}
.repaired-label{font-weight:600;color:var(--fr-blue)}
.severity-micro{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;margin-left:0.3rem}
.det-toggle{font-size:0.68rem;background:none;border:1px solid var(--fr-border);border-radius:4px;padding:0.1rem 0.4rem;color:var(--fr-muted);cursor:pointer;transition:border-color var(--fr-transition);flex-shrink:0}
.det-toggle:hover{border-color:var(--fr-fg)}
.det-json{width:100%;background:color-mix(in srgb, var(--fr-fg) 5%, transparent);border-radius:6px;padding:0.6rem 0.8rem;font-size:0.72rem;font-family:"SF Mono",Menlo,Consolas,monospace;overflow-x:auto;white-space:pre-wrap;line-height:1.5;margin-top:0.3rem}

/* ── Encoding Grid ─────────────────────────────────────────────────── */
.enc-grid-section{margin-top:1rem}
.enc-grid-title{font-weight:600;font-size:0.88rem;margin-bottom:0.4rem}
.enc-legend{display:flex;gap:1rem;margin-bottom:0.5rem;font-size:0.72rem;color:var(--fr-muted)}
.enc-legend-item{display:flex;align-items:center;gap:0.3rem}
.enc-dot{width:10px;height:10px;border-radius:3px}
.enc-dot.enc-covered{background:var(--fr-green)}
.enc-dot.enc-missing{background:var(--fr-red)}
.enc-dot.enc-neutral{background:var(--fr-border)}
.enc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:4px}
.enc-cell{padding:0.3rem 0.5rem;border-radius:4px;font-size:0.62rem;font-weight:600;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:transform 0.15s}
.enc-cell:hover{transform:scale(1.05);z-index:1}
.enc-covered{background:color-mix(in srgb, var(--fr-green) 15%, transparent);color:var(--fr-green);border:1px solid color-mix(in srgb, var(--fr-green) 30%, transparent)}
.enc-missing{background:color-mix(in srgb, var(--fr-red) 12%, transparent);color:var(--fr-red);border:1px solid color-mix(in srgb, var(--fr-red) 25%, transparent)}
.enc-neutral{background:color-mix(in srgb, var(--fr-fg) 4%, transparent);color:var(--fr-muted);border:1px solid var(--fr-border)}

/* ── Timeline ──────────────────────────────────────────────────────── */
.tl-container{padding-left:0.5rem}
.tl-item{display:flex;gap:1rem;position:relative;padding-bottom:1.5rem}
.tl-item:last-child{padding-bottom:0}
.tl-line{position:absolute;left:11px;top:-1.5rem;width:2px;height:1.5rem;background:var(--fr-border)}
.tl-item:first-child .tl-line{background:transparent}
.tl-node{width:24px;height:24px;border-radius:50%;flex-shrink:0;box-shadow:0 0 0 4px var(--fr-card-bg)}
.tl-content{flex:1}
.tl-title{display:flex;align-items:center;gap:0.4rem;font-size:0.9rem}
.tl-desc{font-size:0.82rem;color:var(--fr-muted);margin-top:0.15rem}
.tl-action{display:flex;align-items:center;gap:0.3rem;font-size:0.78rem;color:var(--fr-blue);margin-top:0.3rem}

/* ── Findings Table ────────────────────────────────────────────────── */
.ft-wrap{overflow-x:auto;margin-top:0.5rem}
.findings-table{width:100%;border-collapse:collapse;font-size:0.82rem}
.findings-table th{text-align:left;padding:0.6rem 0.8rem;border-bottom:2px solid var(--fr-border);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--fr-muted);white-space:nowrap}
.findings-table td{padding:0.55rem 0.8rem;border-bottom:1px solid var(--fr-border);vertical-align:top}
.findings-table tbody tr:hover{background:color-mix(in srgb, var(--fr-fg) 3%, transparent)}
.ft-font{font-weight:600;white-space:nowrap}
.ft-action{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:0.75rem;color:var(--fr-muted)}
.severity-pill{font-size:0.68rem;font-weight:700;padding:0.15rem 0.5rem;border-radius:10px;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap}
.repaired-yes{color:var(--fr-green);font-weight:600}
.repaired-no{color:var(--fr-muted)}

/* ── Footer ────────────────────────────────────────────────────────── */
.fr-footer{text-align:center;padding:2.5rem 1rem 1.5rem;color:var(--fr-muted);font-size:0.78rem}
.fr-footer strong{color:var(--fr-fg);font-weight:600}
.fr-footer-line{margin-top:0.25rem}

/* ── Print ─────────────────────────────────────────────────────────── */
@media print {
  body{background:#fff;color:#000}
  .fr-header{background:#1e293b !important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .font-card:hover{transform:none;box-shadow:none}
  .card-expand-hint,.det-toggle{display:none}
  .font-card-detail{display:block !important}
  .font-card-detail[hidden]{display:block !important}
  .fr-arc-outer{animation:none}
  .fr-grade-badge{animation:none}
  .fr-stat:hover{transform:none}
  .enc-cell:hover{transform:none}
}
</style>
</head>
<body>
<div class="fr-container">

  <!-- HEADER -->
  <div class="fr-header">
    <div class="fr-header-content">
      <div class="fr-header-text">
        <div class="fr-doc-title">Font Health Report</div>
        <div class="fr-report-title">PDF Font Analysis</div>
      </div>
      <div class="fr-gauge-wrap">
        <div class="fr-arc-gauge">
          <div class="fr-arc-outer">
            <div class="fr-arc-inner">
              <span class="fr-arc-value">${overallPct}%</span>
              <span class="fr-arc-label">Font Health</span>
            </div>
          </div>
        </div>
        <div class="fr-grade-badge">${esc(overallGrade)}</div>
      </div>
    </div>
    <div class="fr-summary-row">
      <span class="fr-summary-text">${summaryText}</span>
    </div>
  </div>

  <!-- STATS -->
  <div class="fr-stats">
    <div class="fr-stat">
      <div class="fr-stat-value">${summary.totalFonts ?? fonts.length}</div>
      <div class="fr-stat-label">Total Fonts</div>
    </div>
    <div class="fr-stat">
      <div class="fr-stat-value" style="color:var(--fr-green)">${summary.healthyFonts ?? 0}</div>
      <div class="fr-stat-label">Healthy</div>
    </div>
    <div class="fr-stat">
      <div class="fr-stat-value" style="color:var(--fr-red)">${summary.damagedFonts ?? 0}</div>
      <div class="fr-stat-label">Need Attention</div>
    </div>
    <div class="fr-stat">
      <div class="fr-stat-value" style="color:var(--fr-amber)">${summary.totalFindings ?? 0}</div>
      <div class="fr-stat-label">Findings</div>
    </div>
    <div class="fr-stat">
      <div class="fr-stat-value" style="color:var(--fr-blue)">${summary.repairsApplied ?? 0}</div>
      <div class="fr-stat-label">Repairs</div>
    </div>
  </div>

  <!-- FONT OVERVIEW GRID -->
  <div class="fr-section">
    <div class="fr-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="var(--fr-blue)"><path d="M9.93 13.5h4.14L12 7.98zM20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-4.05 16.5l-1.14-3H9.17l-1.12 3H5.96l5.11-13h1.86l5.11 13h-2.09z"/></svg>
      Font Overview
    </div>
    <div class="font-grid">
      ${fontCards}
    </div>
  </div>

  <!-- REPAIR TIMELINE -->
  ${repairTimeline}

  <!-- FINDINGS TABLE -->
  ${findingsTable}

  <!-- FOOTER -->
  <div class="fr-footer">
    <strong>Font Health Report</strong> &middot; Generated by PDF Accessibility Engine
    <div class="fr-footer-line">${timestamp}</div>
    <div class="fr-footer-line">${ALL_CATEGORIES.length} checks &times; ${totalFontCount} fonts = ${assessmentCount} individual assessments</div>
  </div>

</div>
</body>
</html>`;
}
