/**
 * HTML report renderer for paragraph-merger improvement reports.
 * Produces self-contained HTML with no external dependencies.
 */

const STYLES = `
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f6f8; --fg: #1a1a2e; --fg2: #555;
    --border: #d0d5dd; --accent: #2563eb; --accent2: #1d4ed8;
    --green: #16a34a; --green-bg: #dcfce7; --yellow: #ca8a04; --yellow-bg: #fef9c3;
    --red: #dc2626; --red-bg: #fee2e2; --bar-bg: #e2e8f0;
    --card-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a; --bg2: #1e293b; --fg: #e2e8f0; --fg2: #94a3b8;
      --border: #334155; --accent: #60a5fa; --accent2: #93bbfd;
      --green: #4ade80; --green-bg: #14532d; --yellow: #facc15; --yellow-bg: #422006;
      --red: #f87171; --red-bg: #450a0a; --bar-bg: #334155;
      --card-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.35rem; margin: 1.5rem 0 0.75rem; border-bottom: 2px solid var(--accent); padding-bottom: 0.25rem; }
  h3 { font-size: 1.1rem; margin: 1rem 0 0.5rem; }
  .subtitle { color: var(--fg2); margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1rem; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
  th { background: var(--bg2); font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.02em; }
  tr:nth-child(even) td { background: var(--bg2); }
  tr.row-best td { font-weight: 600; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
  .badge-green { background: var(--green-bg); color: var(--green); }
  .badge-yellow { background: var(--yellow-bg); color: var(--yellow); }
  .badge-red { background: var(--red-bg); color: var(--red); }
  .badge-flag { background: var(--bg2); color: var(--fg2); border: 1px solid var(--border); }
  .card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin: 0.75rem 0; box-shadow: var(--card-shadow); }
  .best-card { border-left: 4px solid var(--green); }
  details { margin: 0.5rem 0; }
  summary { cursor: pointer; font-weight: 600; padding: 0.4rem 0; user-select: none; }
  summary:hover { color: var(--accent); }
  ul.reasons { margin: 0.25rem 0 0.5rem 1.25rem; }
  ul.reasons li { font-size: 0.9rem; color: var(--fg2); }
  .merge-item, .skip-item { padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
  .merge-item:last-child, .skip-item:last-child { border-bottom: none; }
  .meta { font-size: 0.85rem; color: var(--fg2); }
  /* Bar chart */
  .bar-chart { margin: 0.75rem 0 1.25rem; }
  .bar-row { display: flex; align-items: center; margin: 0.35rem 0; }
  .bar-label { width: 160px; font-size: 0.85rem; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 24px; background: var(--bar-bg); border-radius: 4px; overflow: hidden; position: relative; }
  .bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; }
  .bar-value { font-size: 0.75rem; font-weight: 600; color: #fff; }
  /* Matrix */
  .matrix-cell { text-align: center; font-weight: 600; font-size: 0.85rem; min-width: 70px; }
  .cell-best { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 2px; }
  .generated { margin-top: 2rem; font-size: 0.75rem; color: var(--fg2); text-align: center; }
</style>
`;

function esc(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function confidenceBadge(confidence) {
  const val = Number(confidence);
  const cls = val >= 0.7 ? "badge-green" : val >= 0.5 ? "badge-yellow" : "badge-red";
  return `<span class="badge ${cls}">${val.toFixed(2)}</span>`;
}

function flagBadge(flag) {
  return `<span class="badge badge-flag">${esc(flag)}</span>`;
}

function scoreColor(score) {
  const v = Number(score);
  if (v >= 0.7) return "var(--green)";
  if (v >= 0.4) return "var(--yellow)";
  return "var(--red)";
}

function cellColor(score) {
  const v = Number(score);
  if (v >= 0.7) return "var(--green-bg)";
  if (v >= 0.4) return "var(--yellow-bg)";
  return "var(--red-bg)";
}

// ── Document Report ──────────────────────────────────────────────────

export function renderDocumentReport(report) {
  const r = report;
  const best = r.bestVersion || {};

  // Comparison table
  const compRows = (r.comparison || []).map((c, i) => {
    const isBest = c.versionId === best.versionId;
    return `<tr class="${isBest ? "row-best" : ""}">
      <td>${c.rank}</td>
      <td>${esc(c.versionId)}${isBest ? ' <span class="badge badge-green">BEST</span>' : ""}</td>
      <td style="color:${scoreColor(c.aggregate)}">${c.aggregate}</td>
      <td>${c.nodeReduction}</td>
      <td>${c.coherence}</td>
      <td>${c.overMerge}</td>
      <td>${c.underMerge}</td>
      <td>${c.riskyMerges}</td>
      <td>${c.borderlineSkips}</td>
    </tr>`;
  }).join("\n");

  // Best version explanation
  const bestVersion = r.versions ? r.versions.find(v => v.versionId === best.versionId) : null;
  let bestExplanation = "";
  if (bestVersion) {
    bestExplanation = `<strong>${esc(best.versionId)}</strong> wins with an aggregate score of <strong>${Number(best.aggregateScore).toFixed(3)}</strong>, ` +
      `achieving ${(bestVersion.scores.nodeReduction * 100).toFixed(1)}% node reduction ` +
      `with ${(bestVersion.scores.paragraphCoherence * 100).toFixed(1)}% coherence ` +
      `and only ${bestVersion.interestingMerges.length} risky merge(s).`;
  }

  // Interesting merges grouped by page
  const allMerges = [];
  for (const v of (r.versions || [])) {
    for (const m of (v.interestingMerges || [])) {
      allMerges.push({ ...m, versionId: v.versionId });
    }
  }
  const mergesByPage = {};
  for (const m of allMerges) {
    (mergesByPage[m.page] = mergesByPage[m.page] || []).push(m);
  }

  let mergesHtml = "";
  if (allMerges.length === 0) {
    mergesHtml = "<p>No risky merges detected.</p>";
  } else {
    for (const [page, merges] of Object.entries(mergesByPage).sort((a, b) => a[0] - b[0])) {
      mergesHtml += `<details><summary>Page ${esc(page)} (${merges.length} merge${merges.length > 1 ? "s" : ""})</summary>\n`;
      for (const m of merges) {
        mergesHtml += `<div class="merge-item">
          <span class="meta">[${esc(m.versionId)}]</span>
          Blocks: <strong>${esc(Array.isArray(m.blocks) ? m.blocks.join(", ") : m.blocks)}</strong>
          ${confidenceBadge(m.confidence)} ${flagBadge(m.flag)}
          <ul class="reasons">${(m.reasons || []).map(r2 => `<li>${esc(r2)}</li>`).join("")}</ul>
        </div>\n`;
      }
      mergesHtml += "</details>\n";
    }
  }

  // Interesting skips grouped by page
  const allSkips = [];
  for (const v of (r.versions || [])) {
    for (const s of (v.interestingSkips || [])) {
      allSkips.push({ ...s, versionId: v.versionId });
    }
  }
  const skipsByPage = {};
  for (const s of allSkips) {
    (skipsByPage[s.page] = skipsByPage[s.page] || []).push(s);
  }

  let skipsHtml = "";
  if (allSkips.length === 0) {
    skipsHtml = "<p>No borderline skips detected.</p>";
  } else {
    for (const [page, skips] of Object.entries(skipsByPage).sort((a, b) => a[0] - b[0])) {
      skipsHtml += `<details><summary>Page ${esc(page)} (${skips.length} skip${skips.length > 1 ? "s" : ""})</summary>\n`;
      for (const s of skips) {
        skipsHtml += `<div class="skip-item">
          <span class="meta">[${esc(s.versionId)}]</span>
          Blocks: <strong>${esc(Array.isArray(s.blocks) ? s.blocks.join(", ") : s.blocks)}</strong>
          Gap: ${s.gap != null ? s.gap + "px" : "n/a"}
          ${confidenceBadge(s.confidence)} ${flagBadge(s.flag)}
          <ul class="reasons">${(s.reasons || []).map(r2 => `<li>${esc(r2)}</li>`).join("")}</ul>
        </div>\n`;
      }
      skipsHtml += "</details>\n";
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paragraph Merger Report - ${esc(r.documentId)}</title>
${STYLES}
</head>
<body>
<h1>Paragraph Merger Report</h1>
<p class="subtitle">${esc(r.documentId)} &mdash; ${r.originalNodeCount} nodes, ${r.originalParagraphCount} paragraphs</p>

<h2>Version Comparison</h2>
<table>
<thead><tr><th>Rank</th><th>Version</th><th>Score</th><th>Reduction</th><th>Coherence</th><th>Over-Merge</th><th>Under-Merge</th><th>Risky Merges</th><th>Borderline Skips</th></tr></thead>
<tbody>${compRows}</tbody>
</table>

<div class="card best-card">
<h3>Best Version</h3>
<p>${bestExplanation}</p>
</div>

<h2>Interesting Merges</h2>
${mergesHtml}

<h2>Interesting Skips</h2>
${skipsHtml}

<p class="generated">Generated ${new Date().toISOString()}</p>
</body>
</html>`;
}

// ── Corpus Summary ───────────────────────────────────────────────────

export function renderCorpusSummary(summary) {
  const s = summary;
  const aggs = s.versionAggregates || {};
  const vids = Object.keys(aggs).sort((a, b) => (aggs[b].wins - aggs[a].wins) || (aggs[b].meanAggregate - aggs[a].meanAggregate));
  const maxWins = Math.max(1, ...vids.map(v => aggs[v].wins));

  // Bar chart for wins
  let barChart = "";
  for (const vid of vids) {
    const wins = aggs[vid].wins;
    const pct = (wins / maxWins) * 100;
    barChart += `<div class="bar-row">
      <span class="bar-label">${esc(vid)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"><span class="bar-value">${wins}</span></div></div>
    </div>\n`;
  }

  // Leaderboard table
  const leaderRows = vids.map(vid => {
    const a = aggs[vid];
    return `<tr>
      <td>${esc(vid)}</td>
      <td>${esc(a.label || "")}</td>
      <td><strong>${a.wins}</strong></td>
      <td style="color:${scoreColor(a.meanAggregate)}">${a.meanAggregate.toFixed(3)}</td>
      <td>${(a.meanReduction * 100).toFixed(1)}%</td>
      <td>${(a.meanCoherence * 100).toFixed(1)}%</td>
      <td>${(a.meanOverMerge * 100).toFixed(1)}%</td>
      <td>${(a.meanUnderMerge * 100).toFixed(1)}%</td>
      <td>${a.totalRiskyMerges}</td>
      <td>${a.totalBorderlineSkips}</td>
    </tr>`;
  }).join("\n");

  // Per-document matrix
  const docs = s.perDocument || [];
  // Get all version IDs from comparison entries
  const allVersionIds = [...new Set(docs.flatMap(d => (d.comparison || []).map(c => c.versionId)))].sort();

  let matrixRows = "";
  for (const doc of docs) {
    const compMap = {};
    for (const c of (doc.comparison || [])) compMap[c.versionId] = c;
    let cells = "";
    for (const vid of allVersionIds) {
      const c = compMap[vid];
      const score = c ? Number(c.aggregate) : 0;
      const isBest = vid === doc.bestVersion;
      cells += `<td class="matrix-cell${isBest ? " cell-best" : ""}" style="background:${cellColor(score)};color:${scoreColor(score)}">${score.toFixed(3)}</td>`;
    }
    matrixRows += `<tr><td>${esc(doc.documentId)}</td>${cells}</tr>\n`;
  }

  // Improvement opportunities: largest gap between best and worst
  const opportunities = docs.map(doc => {
    const scores = (doc.comparison || []).map(c => Number(c.aggregate));
    const gap = scores.length >= 2 ? Math.max(...scores) - Math.min(...scores) : 0;
    return { documentId: doc.documentId, bestVersion: doc.bestVersion, bestScore: doc.bestScore, gap };
  }).sort((a, b) => b.gap - a.gap).slice(0, 10);

  const oppRows = opportunities.map(o =>
    `<tr><td>${esc(o.documentId)}</td><td>${esc(o.bestVersion)}</td><td>${o.bestScore.toFixed(3)}</td><td><strong>${o.gap.toFixed(3)}</strong></td></tr>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paragraph Merger - Corpus Summary</title>
${STYLES}
</head>
<body>
<h1>Paragraph Merger - Corpus Summary</h1>
<p class="subtitle">${s.documentsEvaluated} documents evaluated across ${s.versionsCompared} versions</p>

<h2>Version Leaderboard</h2>
<div class="bar-chart">
${barChart}
</div>
<table>
<thead><tr><th>Version</th><th>Label</th><th>Wins</th><th>Avg Score</th><th>Reduction</th><th>Coherence</th><th>Over-Merge</th><th>Under-Merge</th><th>Risky Merges</th><th>Borderline Skips</th></tr></thead>
<tbody>${leaderRows}</tbody>
</table>

<h2>Per-Document Matrix</h2>
<div style="overflow-x:auto">
<table>
<thead><tr><th>Document</th>${allVersionIds.map(v => `<th class="matrix-cell">${esc(v)}</th>`).join("")}</tr></thead>
<tbody>${matrixRows}</tbody>
</table>
</div>

<h2>Improvement Opportunities</h2>
<p class="subtitle">Documents with the largest gap between best and worst version scores (most room to improve by choosing the right version).</p>
<table>
<thead><tr><th>Document</th><th>Best Version</th><th>Best Score</th><th>Gap (Best - Worst)</th></tr></thead>
<tbody>${oppRows}</tbody>
</table>

<p class="generated">Generated ${new Date().toISOString()}</p>
</body>
</html>`;
}
