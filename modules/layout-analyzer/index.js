import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import layoutSchema from "../../contracts/layout.schema.json" with { type: "json" };
import tableStructureSchema from "../../contracts/table-structure.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateLayout = ajv.compile(layoutSchema);
const validateTableStructure = ajv.compile(tableStructureSchema);

// Profile-tunable thresholds. Defaults mirror the default.json profile
// so un-configured runs behave identically to today; specialized
// profiles (legal, scientific, etc.) override via env vars set by
// orchestrator/profile-runtime.js. Read lazily so tests and callers
// can adjust env and re-run analyze in the same process.
function readFloatEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readThresholds() {
  return {
    columnGapThresholdPercent: readFloatEnv("LAYOUT_COLUMN_GAP_THRESHOLD_PERCENT", 0.16),
    columnGapMinPixels: readFloatEnv("LAYOUT_COLUMN_GAP_MIN_PIXELS", 48),
    headingScoreThreshold: readFloatEnv("LAYOUT_HEADING_SCORE_THRESHOLD", 1.55),
    headingBoldScoreThreshold: readFloatEnv("LAYOUT_HEADING_BOLD_SCORE_THRESHOLD", 1.3),
    headingH1Threshold: readFloatEnv("LAYOUT_HEADING_H1_THRESHOLD", 1.9),
    headingH2Threshold: readFloatEnv("LAYOUT_HEADING_H2_THRESHOLD", 1.55),
    rowTolerancePixels: readFloatEnv("LAYOUT_ROW_TOLERANCE_PIXELS", 6),
    tableRowMinItems: readFloatEnv("LAYOUT_TABLE_ROW_MIN_ITEMS", 2)
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length === 0) {
    return 12;
  }

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function blockLeft(block) {
  return block.bbox[0];
}

function blockTop(block) {
  return block.bbox[1];
}

function blockRight(block) {
  return block.bbox[0] + block.bbox[2];
}

function blockBottom(block) {
  return block.bbox[1] + block.bbox[3];
}

function blockCenterX(block) {
  return block.bbox[0] + block.bbox[2] / 2;
}

function blockCenterY(block) {
  return block.bbox[1] + block.bbox[3] / 2;
}

function blockWidth(block) {
  return block.bbox[2];
}

function blockHeight(block) {
  return block.bbox[3];
}

function looksLikeStampArtifact(block, page, baselineFontSize) {
  const text = normalizeText(block.text);
  if (!text || text.length > 40) {
    return false;
  }

  return (
    block.fontSize >= baselineFontSize * 5 &&
    blockWidth(block) >= page.width * 0.35 &&
    blockHeight(block) >= page.height * 0.08
  );
}

function clusterByProximity(items, measureFn, tolerance) {
  const sorted = [...items].sort((left, right) => measureFn(left) - measureFn(right));
  const clusters = [];

  for (const item of sorted) {
    const value = measureFn(item);
    const current = clusters.at(-1);

    if (!current || Math.abs(value - current.centroid) > tolerance) {
      clusters.push({
        items: [item],
        centroid: value,
        min: value,
        max: value
      });
      continue;
    }

    current.items.push(item);
    current.min = Math.min(current.min, value);
    current.max = Math.max(current.max, value);
    current.centroid = mean(current.items.map(measureFn));
  }

  return clusters;
}

function detectColumns(page, ignoredBlockIds = new Set(), thresholds = readThresholds()) {
  const blocks = page.textBlocks.filter(
    (block) => normalizeText(block.text).length > 0 && !ignoredBlockIds.has(block.id)
  );

  if (blocks.length < 4) {
    return {
      count: 1,
      splitX: page.width / 2,
      gutter: 0,
      confidence: 0
    };
  }

  const centers = blocks.map(blockCenterX).sort((left, right) => left - right);
  const widths = blocks.map(blockWidth).filter((width) => width > 0);
  const gapThreshold = Math.max(page.width * thresholds.columnGapThresholdPercent, median(widths) * 1.9, thresholds.columnGapMinPixels);

  let largestGap = 0;
  let splitIndex = -1;

  for (let index = 0; index < centers.length - 1; index += 1) {
    const gap = centers[index + 1] - centers[index];
    if (gap > largestGap) {
      largestGap = gap;
      splitIndex = index;
    }
  }

  const leftCount = splitIndex + 1;
  const rightCount = centers.length - leftCount;
  const confidence = Math.min(1, largestGap / Math.max(page.width * 0.32, 1));

  if (largestGap >= gapThreshold && leftCount >= 2 && rightCount >= 2) {
    return {
      count: 2,
      splitX: (centers[splitIndex] + centers[splitIndex + 1]) / 2,
      gutter: largestGap,
      confidence
    };
  }

  return {
    count: 1,
    splitX: page.width / 2,
    gutter: largestGap,
    confidence: 0
  };
}

function classifyBlock(block, baselineFontSize, thresholds = readThresholds(), page = null) {
  const text = normalizeText(block.text);
  const orderedListMatch = text.match(/^(\d+)[.)]\s+/);
  const isBulletListItem = /^([-*]|\u2022)\s+/.test(text);
  const isBold = /bold/i.test(block.fontName || "");
  const headingScore = block.fontSize / baselineFontSize;
  const isHeading = headingScore >= thresholds.headingScoreThreshold || (headingScore >= thresholds.headingBoldScoreThreshold && isBold && text.length <= 80);

  if (page && looksLikeStampArtifact(block, page, baselineFontSize)) {
    return {
      blockType: "paragraph",
      isArtifact: true,
      artifactReason: "oversized-stamp"
    };
  }

  if (orderedListMatch) {
    return {
      blockType: "list-item",
      listStyle: "ordered",
      listItemNumber: Number(orderedListMatch[1]),
      listMarker: orderedListMatch[0].trim()
    };
  }

  if (isBulletListItem) {
    return {
      blockType: "list-item",
      listStyle: "unordered",
      listMarker: text.split(/\s+/, 1)[0]
    };
  }

  if (isHeading) {
    const headingLevel = headingScore >= thresholds.headingH1Threshold ? 1 : headingScore >= thresholds.headingH2Threshold ? 2 : 3;
    return {
      blockType: "heading",
      headingLevel
    };
  }

  return {
    blockType: "paragraph"
  };
}

function looksNumericish(text) {
  return /\d/.test(text) || /[$£€¥%]/.test(text);
}

function isCompactNumericToken(text) {
  return /^-?(?:[$£€¥])?(?:\d+(?:[.,]\d+)*|\d*\.\d+)(?:%)?$|^n\/a$/i.test(String(text || "").trim());
}

function looksHeaderish(text) {
  const normalized = normalizeText(text);
  // Require at least one Latin letter or non-ASCII letter/symbol (e.g. ℃, ℉).
  // Single-character column codes ('A', 'B') and Unicode unit symbols are valid
  // column headers.  Pure digits and currency are still excluded by the
  // !looksNumericish guard, so "1" or "$5" cannot pass.
  return normalized.length > 0 && normalized.length <= 48 && /[A-Za-z\u0080-\uFFFF]/.test(normalized) && !looksNumericish(normalized);
}

function countMatches(leftValues, rightValues, tolerance) {
  const remaining = [...rightValues];
  let matches = 0;

  for (const value of leftValues) {
    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let index = 0; index < remaining.length; index += 1) {
      const distance = Math.abs(value - remaining[index]);
      if (distance <= tolerance && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }

    if (bestIndex >= 0) {
      remaining.splice(bestIndex, 1);
      matches += 1;
    }
  }

  return matches;
}

function buildCandidateRows(page, blocks, baselineFontSize) {
  const candidateBlocks = blocks
    .map((block) => ({
      block,
      text: normalizeText(block.text),
      xCenter: blockCenterX(block),
      yCenter: blockCenterY(block)
    }))
    .filter(
      ({ block, text }) =>
        text.length > 0 &&
        text.length <= 64 &&
        block.blockType === "paragraph" &&
        blockWidth(block) <= page.width * 0.68 &&
        blockHeight(block) <= Math.max(24, baselineFontSize * 2.4)
    );

  const rowTolerance = Math.max(readThresholds().rowTolerancePixels, baselineFontSize * 0.9);

  return clusterByProximity(candidateBlocks, (item) => item.yCenter, rowTolerance)
    .map((row, index) => {
      const items = [...row.items].sort((left, right) => blockLeft(left.block) - blockLeft(right.block));
      const gaps = items.slice(1).map((item, itemIndex) => blockLeft(item.block) - blockRight(items[itemIndex].block));
      const horizontalSpan = blockRight(items.at(-1).block) - blockLeft(items[0].block);
      const numericRatio = items.filter((item) => looksNumericish(item.text)).length / items.length;
      const headerishRatio = items.filter((item) => looksHeaderish(item.text)).length / items.length;
      const boldRatio = items.filter((item) => /bold/i.test(item.block.fontName || "")).length / items.length;

      return {
        id: `row:${index}`,
        items,
        gaps,
        top: Math.min(...items.map((item) => blockTop(item.block))),
        bottom: Math.max(...items.map((item) => blockBottom(item.block))),
        left: blockLeft(items[0].block),
        right: blockRight(items.at(-1).block),
        horizontalSpan,
        xAnchors: items.map((item) => blockLeft(item.block)),
        numericRatio,
        headerishRatio,
        boldRatio,
        meanFontSize: mean(items.map((item) => item.block.fontSize))
      };
    })
    .filter(
      (row) =>
        row.items.length >= 2 &&
        row.horizontalSpan >= Math.max(page.width * 0.16, 72) &&
        row.gaps.some((gap) => gap >= Math.max(14, baselineFontSize * 0.8))
    );
}

function areRowsCompatible(leftRow, rightRow, page, baselineFontSize) {
  const verticalGap = rightRow.top - leftRow.bottom;
  const xTolerance = Math.max(12, page.width * 0.03, baselineFontSize * 1.2);
  const matches = countMatches(leftRow.xAnchors, rightRow.xAnchors, xTolerance);

  return (
    verticalGap <= Math.max(22, baselineFontSize * 3.2) &&
    matches >= 2 &&
    Math.abs(leftRow.items.length - rightRow.items.length) <= 1
  );
}

function assignItemsToAnchors(items, anchors, tolerance) {
  const assignments = [];
  const usedColumns = new Set();

  for (const item of items) {
    let bestColumnIndex = -1;
    let bestDistance = Infinity;

    anchors.forEach((anchor, columnIndex) => {
      if (usedColumns.has(columnIndex)) {
        return;
      }

      const distance = Math.abs(blockLeft(item.block) - anchor.x);
      if (distance <= tolerance && distance < bestDistance) {
        bestColumnIndex = columnIndex;
        bestDistance = distance;
      }
    });

    if (bestColumnIndex >= 0) {
      usedColumns.add(bestColumnIndex);
      assignments.push({
        item,
        columnIndex: bestColumnIndex
      });
    }
  }

  return assignments.sort((left, right) => left.columnIndex - right.columnIndex);
}

function detectHeaderRow(rows) {
  if (rows.length < 2) {
    return false;
  }

  const [firstRow, ...restRows] = rows;
  const restNumericRatio = mean(restRows.map((row) => row.numericRatio));
  const restFontSize = mean(restRows.map((row) => row.meanFontSize));

  if (firstRow.boldRatio >= 0.5) return true;
  if (firstRow.headerishRatio >= 0.75 && restNumericRatio >= 0.3) return true;
  // Lowered ratio from 1.08 to 1.03: a consistent 3-5% font-size bump (e.g. 10pt
  // header over 9.5pt body) is a reliable header signal in technical manuals.
  if (firstRow.headerishRatio >= 0.75 && firstRow.meanFontSize >= restFontSize * 1.03) return true;

  // Font-name distinctiveness: if the first row uses at least one font name
  // that does not appear in any data row, it is highly likely to be a header
  // (technical PDFs often use a separate font for column labels).
  const firstRowFonts = new Set(firstRow.items.map((i) => i.block.fontName).filter(Boolean));
  const restFonts = new Set(restRows.flatMap((r) => r.items.map((i) => i.block.fontName)).filter(Boolean));

  let firstRowHasDistinctFont = false;
  for (const f of firstRowFonts) {
    if (!restFonts.has(f)) { firstRowHasDistinctFont = true; break; }
  }
  if (firstRowHasDistinctFont && firstRow.headerishRatio >= 0.5) {
    return true;
  }

  return false;
}

function summarizeTableBand(rows, page, baselineFontSize) {
  const flatItems = rows.flatMap((row) => row.items.map((item) => ({ ...item, rowId: row.id })));
  const xTolerance = Math.max(
    12,
    median(flatItems.map((item) => blockWidth(item.block)).filter((width) => width > 0)) * 0.65,
    page.width * 0.025,
    baselineFontSize * 1.1
  );
  const minimumRowCoverage = Math.max(2, Math.ceil(rows.length * 0.6));
  const anchors = clusterByProximity(flatItems, (item) => blockLeft(item.block), xTolerance)
    .filter((cluster) => new Set(cluster.items.map((item) => item.rowId)).size >= minimumRowCoverage)
    .map((cluster) => ({
      x: cluster.centroid
    }))
    .sort((left, right) => left.x - right.x);
  const assignedRows = rows.map((row) => ({
    ...row,
    assignments: assignItemsToAnchors(row.items, anchors, xTolerance)
  }));
  const stableRows = assignedRows.filter((row) => row.assignments.length >= 2);
  const consistentColumnRows = stableRows.filter(
    (row) => row.assignments.length >= Math.max(2, Math.min(anchors.length, anchors.length - 1))
  ).length;
  // Measure horizontal span as the wider of anchor-centroid spread and the widest
  // multi-item row's visual extent.  The anchor-centroid measure underestimates span
  // when the rightmost column has wide cells (its anchor sits at the left edge of those
  // cells, not their right edge), which causes narrow-but-valid tables to fail the
  // minimum-span gate in isConfidentTableBand / isValidBorderless.
  const anchorSpan = anchors.length >= 2 ? anchors.at(-1).x - anchors[0].x : 0;
  const rowVisualSpan = rows
    .filter((r) => r.items.length >= 2)
    .reduce((maxSpan, r) => Math.max(maxSpan, r.right - r.left), 0);

  return {
    rows,
    assignedRows,
    stableRows,
    anchors,
    columnCount: anchors.length,
    rowCount: stableRows.length,
    assignedCellCount: stableRows.reduce((total, row) => total + row.assignments.length, 0),
    stableCoverage: rows.length === 0 ? 0 : stableRows.length / rows.length,
    consistentColumnRows,
    hasHeaderRow: detectHeaderRow(stableRows),
    horizontalSpan: Math.max(anchorSpan, rowVisualSpan)
  };
}

function hasStrongNumericDataGrid(summary) {
  const numericRatio = mean(summary.stableRows.map((row) => row.numericRatio));
  return summary.columnCount >= 4 && summary.rowCount >= 2 && numericRatio >= 0.72;
}

function isConfidentTableBand(summary, page) {
  return (
    summary.rowCount >= 2 &&
    summary.columnCount >= 2 &&
    summary.assignedCellCount >= 4 &&
    summary.stableCoverage >= 0.67 &&
    summary.horizontalSpan >= Math.max(page.width * 0.14, 64) &&
    summary.consistentColumnRows >= Math.max(2, Math.ceil(summary.rowCount * 0.6)) &&
    (summary.hasHeaderRow || hasStrongNumericDataGrid(summary)) &&
    !(summary.columnCount === 2 && !summary.hasHeaderRow)
  );
}

function detectVectorHeaderRows(table, blockById, baselineFontSize) {
  const rows = [...new Set((table.cells || []).map((cell) => cell.rowIndex))].sort((left, right) => left - right);
  const headerRows = new Set();

  for (const rowIndex of rows) {
    const rowCells = (table.cells || []).filter((cell) => cell.rowIndex === rowIndex);
    const rowBlocks = rowCells.flatMap((cell) => (cell.assignedBlockIds || []).map((blockId) => blockById.get(blockId)).filter(Boolean));
    const boldRatio = rowBlocks.length === 0 ? 0 : rowBlocks.filter((block) => /bold/i.test(block.fontName || "")).length / rowBlocks.length;
    const headerishRatio =
      rowBlocks.length === 0 ? 0 : rowBlocks.filter((block) => looksHeaderish(block.text)).length / rowBlocks.length;
    const numericRatio =
      rowBlocks.length === 0 ? 0 : rowBlocks.filter((block) => looksNumericish(block.text)).length / rowBlocks.length;
    const meanFontSize = rowBlocks.length === 0 ? baselineFontSize : mean(rowBlocks.map((block) => block.fontSize));
    const hasMergedCell = rowCells.some((cell) => (cell.columnSpan || 1) > 1 || (cell.rowSpan || 1) > 1);
    const shouldTreatAsHeader =
      (rowIndex === 0 && hasMergedCell) ||
      boldRatio >= 0.6 ||
      (headerishRatio >= 0.75 && numericRatio <= 0.5) ||
      (rowIndex === 0 && headerishRatio >= 0.6 && meanFontSize >= baselineFontSize * 1.04);

    if (!shouldTreatAsHeader) {
      break;
    }

    headerRows.add(rowIndex);
  }

  return headerRows;
}

function detectVectorTables(page, blocks, tableStructurePage, baselineFontSize) {
  if (!tableStructurePage || tableStructurePage.status === "unavailable" || !(tableStructurePage.tables || []).length) {
    return {
      tableMetaById: new Map(),
      tables: []
    };
  }

  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const tableMetaById = new Map();
  const tables = [];

  for (const table of tableStructurePage.tables || []) {
    const headerRows = detectVectorHeaderRows(table, blockById, baselineFontSize);

    for (const cell of table.cells || []) {
      const assignedBlocks = (cell.assignedBlockIds || []).map((blockId) => blockById.get(blockId)).filter(Boolean);
      const isHeaderCell = headerRows.has(cell.rowIndex);

      for (const block of assignedBlocks) {
        tableMetaById.set(block.id, {
          blockType: "table-cell",
          tableId: table.id,
          tableRole: isHeaderCell ? "header" : "cell",
          tableSection: isHeaderCell ? "head" : "body",
          tableRowIndex: cell.rowIndex,
          tableColumnIndex: cell.columnIndex,
          tableRowSpan: cell.rowSpan || 1,
          tableColumnSpan: cell.columnSpan || 1,
          tableSource: "vector-grid",
          tableCellConfidence: table.confidence
        });
      }
    }

    tables.push({
      id: table.id,
      source: "vector-grid",
      rowCount: table.rowCount,
      columnCount: table.columnCount,
      headerRowCount: headerRows.size,
      mergeSignalCount: (table.mergeSignals || []).length,
      confidence: table.confidence
    });
  }

  return {
    tableMetaById,
    tables
  };
}

function buildBorderlessRows(page, blocks, baselineFontSize) {
  const candidateBlocks = blocks
    .map((block) => ({
      block,
      text: normalizeText(block.text),
      xCenter: blockCenterX(block),
      yCenter: blockCenterY(block)
    }))
    .filter(
      ({ block, text }) =>
        text.length > 0 &&
        text.length <= 64 &&
        block.blockType === "paragraph" &&
        blockHeight(block) <= Math.max(24, baselineFontSize * 2.4)
    );

  const rowTolerance = Math.max(readThresholds().rowTolerancePixels, baselineFontSize * 0.9);

  return clusterByProximity(candidateBlocks, (item) => item.yCenter, rowTolerance)
    .map((row, index) => {
      const items = [...row.items].sort((left, right) => blockLeft(left.block) - blockLeft(right.block));
      const gaps = items.slice(1).map((item, itemIndex) => blockLeft(item.block) - blockRight(items[itemIndex].block));
      const horizontalSpan = blockRight(items.at(-1).block) - blockLeft(items[0].block);
      const numericRatio = items.filter((item) => looksNumericish(item.text)).length / items.length;
      const headerishRatio = items.filter((item) => looksHeaderish(item.text)).length / items.length;
      const boldRatio = items.filter((item) => /bold/i.test(item.block.fontName || "")).length / items.length;

      return {
        id: `brow:${index}`,
        items,
        gaps,
        top: Math.min(...items.map((item) => blockTop(item.block))),
        bottom: Math.max(...items.map((item) => blockBottom(item.block))),
        left: blockLeft(items[0].block),
        right: blockRight(items.at(-1).block),
        horizontalSpan,
        xAnchors: items.map((item) => blockLeft(item.block)),
        numericRatio,
        headerishRatio,
        boldRatio,
        meanFontSize: mean(items.map((item) => item.block.fontSize))
      };
    });
}

function detectBorderlessTables(page, blocks, baselineFontSize) {
  const allRows = buildBorderlessRows(page, blocks, baselineFontSize);
  const xTolerance = Math.max(12, page.width * 0.03, baselineFontSize * 1.2);

  // Separate multi-item rows and single-item rows
  const multiItemRows = allRows.filter((row) => row.items.length >= 2);

  if (multiItemRows.length < 2) {
    return { tableMetaById: new Map(), tables: [] };
  }

  // Build candidate bands of consecutive multi-item rows that share column anchors
  const candidateBands = [];
  let currentBand = [];

  for (const row of multiItemRows) {
    if (currentBand.length === 0) {
      currentBand = [row];
      continue;
    }

    const lastRow = currentBand.at(-1);
    const verticalGap = row.top - lastRow.bottom;
    const matches = countMatches(lastRow.xAnchors, row.xAnchors, xTolerance);

    if (verticalGap <= Math.max(22, baselineFontSize * 3.2) && matches >= 2) {
      currentBand.push(row);
      continue;
    }

    if (currentBand.length >= 2) {
      candidateBands.push(currentBand);
    }
    currentBand = [row];
  }

  if (currentBand.length >= 2) {
    candidateBands.push(currentBand);
  }

  // Also check for single-row + header pattern: find single multi-item rows
  // that have a header-like row directly above them
  for (const row of multiItemRows) {
    const alreadyInBand = candidateBands.some((band) => band.some((bandRow) => bandRow.id === row.id));
    if (alreadyInBand) {
      continue;
    }

    // Look for a header row above this row among all rows (multi or single item)
    const potentialHeaders = allRows.filter((candidate) => {
      if (candidate.id === row.id || candidate.items.length < 2) {
        return false;
      }
      const verticalGap = row.top - candidate.bottom;
      const matches = countMatches(candidate.xAnchors, row.xAnchors, xTolerance);
      return verticalGap >= 0 && verticalGap <= Math.max(22, baselineFontSize * 3.2) && matches >= 2;
    });

    if (potentialHeaders.length > 0) {
      const header = potentialHeaders.at(-1);
      const headerAlreadyInBand = candidateBands.some((band) => band.some((bandRow) => bandRow.id === header.id));
      if (!headerAlreadyInBand) {
        candidateBands.push([header, row]);
      }
    }
  }

  // Also try to include single-item rows adjacent to bands (merged cells)
  for (const band of candidateBands) {
    const bandTop = Math.min(...band.map((row) => row.top));
    const bandBottom = Math.max(...band.map((row) => row.bottom));

    for (const singleRow of allRows.filter((row) => row.items.length === 1)) {
      const alreadyInBand = band.some((bandRow) => bandRow.id === singleRow.id);
      if (alreadyInBand) {
        continue;
      }

      const isAdjacent =
        (singleRow.top >= bandTop - baselineFontSize && singleRow.bottom <= bandBottom + baselineFontSize) ||
        (Math.abs(singleRow.bottom - bandTop) <= Math.max(22, baselineFontSize * 3.2)) ||
        (Math.abs(singleRow.top - bandBottom) <= Math.max(22, baselineFontSize * 3.2));

      // Single item must span multiple column anchors to be a merged cell
      if (isAdjacent && singleRow.horizontalSpan >= page.width * 0.14) {
        band.push(singleRow);
        band.sort((left, right) => left.top - right.top);
      }
    }
  }

  const tableMetaById = new Map();
  const tables = [];
  let tableSequence = 0;

  for (const bandRows of candidateBands) {
    const summary = summarizeTableBand(bandRows, page, baselineFontSize);

    // Borderless tables: relaxed requirements
    // Need >= 2 columns and >= 60% stable coverage
    // Reject 2x2 tables without a header (likely label-value pairs)
    const isValidBorderless =
      summary.columnCount >= 2 &&
      summary.rowCount >= 2 &&
      summary.assignedCellCount >= 4 &&
      summary.stableCoverage >= 0.6 &&
      summary.horizontalSpan >= Math.max(page.width * 0.14, 64) &&
      (summary.hasHeaderRow || hasStrongNumericDataGrid(summary)) &&
      !(summary.columnCount === 2 && !summary.hasHeaderRow);

    if (!isValidBorderless) {
      continue;
    }

    tableSequence += 1;
    const tableId = `table:${page.pageNumber}:borderless:${tableSequence}`;
    const headerRowId = summary.hasHeaderRow ? summary.stableRows[0]?.id : null;
    const confidence = Number(
      Math.min(0.95, 0.72 + summary.rowCount * 0.03 + summary.columnCount * 0.01 + (summary.stableCoverage - 0.6) * 0.1).toFixed(2)
    );

    summary.stableRows.forEach((row, rowIndex) => {
      const isHeaderRow = row.id === headerRowId;

      row.assignments.forEach(({ item, columnIndex }) => {
        tableMetaById.set(item.block.id, {
          blockType: "table-cell",
          tableId,
          tableRole: isHeaderRow ? "header" : "cell",
          tableSection: isHeaderRow ? "head" : "body",
          tableRowIndex: rowIndex,
          tableColumnIndex: columnIndex,
          tableCellConfidence: confidence,
          tableDetectionMethod: "borderless-alignment"
        });
      });
    });

    tables.push({
      id: tableId,
      source: "borderless-alignment",
      rowCount: summary.rowCount,
      columnCount: summary.columnCount,
      headerRowCount: headerRowId ? 1 : 0,
      mergeSignalCount: 0,
      confidence
    });
  }

  return { tableMetaById, tables };
}

function looksSparseNumericCell(text) {
  return isCompactNumericToken(text);
}

function buildSparseNumericRows(blocks, baselineFontSize) {
  const candidateBlocks = blocks
    .filter((block) => !block.isArtifact)
    .filter((block) => block.blockType === "paragraph")
    .filter((block) => blockHeight(block) <= Math.max(24, baselineFontSize * 2.4))
    .map((block) => ({
      block,
      text: normalizeText(block.text),
      yCenter: blockCenterY(block)
    }))
    .filter((item) => item.text);

  const rowTolerance = Math.max(readThresholds().rowTolerancePixels, baselineFontSize * 0.9);

  return clusterByProximity(candidateBlocks, (item) => item.yCenter, rowTolerance)
    .map((row, index) => {
      const items = [...row.items].sort((left, right) => blockLeft(left.block) - blockLeft(right.block));
      const numericItems = items.filter((item) => looksSparseNumericCell(item.text));
      const headerItems = items.filter((item) => looksHeaderish(item.text));

      return {
        id: `srow:${index}`,
        items,
        numericItems,
        headerItems,
        top: Math.min(...items.map((item) => blockTop(item.block))),
        bottom: Math.max(...items.map((item) => blockBottom(item.block))),
        left: blockLeft(items[0].block),
        right: blockRight(items.at(-1).block)
      };
    })
    .sort((left, right) => left.top - right.top);
}

function rowOverlapsAnchors(row, anchors, tolerance) {
  if (anchors.length < 2) return false;
  const left = anchors[0].x - tolerance;
  const right = anchors.at(-1).x + tolerance;
  return row.right >= left && row.left <= right;
}

function assignBlockToSparseAnchors(block, anchors, tolerance, { allowSpan = false } = {}) {
  let bestColumnIndex = -1;
  let bestDistance = Infinity;
  const left = blockLeft(block);
  const right = blockRight(block);

  anchors.forEach((anchor, columnIndex) => {
    const distance = Math.abs(left - anchor.x);
    if (distance <= tolerance * 3 && distance < bestDistance) {
      bestColumnIndex = columnIndex;
      bestDistance = distance;
    }
  });

  if (bestColumnIndex < 0) {
    return null;
  }

  if (!allowSpan) {
    return {
      columnIndex: bestColumnIndex,
      columnSpan: 1
    };
  }

  let rightColumnIndex = bestColumnIndex;
  anchors.forEach((anchor, columnIndex) => {
    if (columnIndex >= bestColumnIndex && anchor.x <= right + tolerance * 1.5) {
      rightColumnIndex = columnIndex;
    }
  });

  return {
    columnIndex: bestColumnIndex,
    columnSpan: Math.max(1, rightColumnIndex - bestColumnIndex + 1)
  };
}

function splitHeaderTokens(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean);
}

function unionBbox(boxes) {
  const validBoxes = boxes.filter((box) => Array.isArray(box) && box.length >= 4);
  if (validBoxes.length === 0) {
    return [0, 0, 0, 0];
  }

  const left = Math.min(...validBoxes.map((box) => box[0]));
  const top = Math.min(...validBoxes.map((box) => box[1]));
  const right = Math.max(...validBoxes.map((box) => box[0] + box[2]));
  const bottom = Math.max(...validBoxes.map((box) => box[1] + box[3]));
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

function tokenBboxForSpan(block, tokenIndex, tokenCount, headerTop, headerBottom) {
  const width = blockWidth(block) / tokenCount;
  return [
    blockLeft(block) + width * tokenIndex,
    headerTop,
    width,
    Math.max(blockHeight(block), headerBottom - headerTop)
  ];
}

function buildSparseLeafHeaderBlocks({ tableRows, headerRowCount, anchors, anchorTolerance, tableId, pageNumber }) {
  if (headerRowCount < 2 || anchors.length < 2) {
    return null;
  }

  const headerRows = tableRows.slice(0, headerRowCount);
  const headerTop = Math.min(...headerRows.map((row) => row.top));
  const headerBottom = Math.max(...headerRows.map((row) => row.bottom));
  const fragmentsByColumn = anchors.map(() => []);
  const suppressedBlockIds = new Set();
  let decomposedSpanningHeader = false;
  let stackedHeaderFragments = false;

  headerRows.forEach((row, sourceRowIndex) => {
    for (const item of row.items) {
      const assignment = assignBlockToSparseAnchors(item.block, anchors, anchorTolerance, {
        allowSpan: !looksSparseNumericCell(item.text)
      });
      if (!assignment) {
        continue;
      }

      const span = Math.max(1, Math.min(assignment.columnSpan || 1, anchors.length - assignment.columnIndex));
      const tokens = splitHeaderTokens(item.text);
      if (tokens.length === 0) {
        continue;
      }

      suppressedBlockIds.add(item.block.id);

      if (span > 1 && tokens.length === span) {
        decomposedSpanningHeader = true;
        tokens.forEach((token, offset) => {
          const columnIndex = assignment.columnIndex + offset;
          fragmentsByColumn[columnIndex].push({
            text: token,
            sourceRowIndex,
            block: item.block,
            bbox: tokenBboxForSpan(item.block, offset, span, headerTop, headerBottom)
          });
        });
        continue;
      }

      for (let offset = 0; offset < span; offset += 1) {
        const columnIndex = assignment.columnIndex + offset;
        fragmentsByColumn[columnIndex].push({
          text: item.text,
          sourceRowIndex,
          block: item.block,
          bbox: [blockLeft(item.block), headerTop, blockWidth(item.block), Math.max(blockHeight(item.block), headerBottom - headerTop)]
        });
      }
    }
  });

  if (fragmentsByColumn.some((fragments) => fragments.length === 0)) {
    return null;
  }

  if (fragmentsByColumn.some((fragments) => fragments.length > 1)) {
    stackedHeaderFragments = true;
  }

  if (!decomposedSpanningHeader && !stackedHeaderFragments) {
    return null;
  }

  const headerBlocks = fragmentsByColumn.map((fragments, columnIndex) => {
    const orderedFragments = [...fragments].sort((left, right) => left.sourceRowIndex - right.sourceRowIndex);
    const text = orderedFragments.map((fragment) => fragment.text).join(" ").replace(/\s+/g, " ").trim();
    const bbox = unionBbox(orderedFragments.map((fragment) => fragment.bbox));
    const sourceBlocks = orderedFragments.map((fragment) => fragment.block);
    const fontSizes = sourceBlocks.map((block) => block.fontSize).filter((value) => Number.isFinite(value) && value > 0);
    const maxFontSize = fontSizes.length > 0 ? Math.max(...fontSizes) : 10;
    const firstBlock = sourceBlocks[0] || {};

    return {
      id: `p${pageNumber}-sparse-header-${tableId.replace(/[^A-Za-z0-9_-]+/g, "-")}-c${columnIndex}`,
      text,
      bbox,
      fontSize: maxFontSize,
      fontName: firstBlock.fontName || "",
      blockType: "table-cell",
      synthetic: true,
      syntheticReason: "sparse-numeric-leaf-header",
      sourceBlockIds: [...new Set(sourceBlocks.map((block) => block.id).filter(Boolean))],
      tableId,
      tableRole: "header",
      tableSection: "head",
      tableRowIndex: 0,
      tableColumnIndex: columnIndex,
      tableColumnSpan: 1,
      tableCellConfidence: 0.94,
      tableSource: "sparse-numeric-grid",
      tableDetectionMethod: "sparse-numeric-leaf-header"
    };
  });

  return {
    headerBlocks,
    suppressedBlockIds,
    sourceHeaderRowCount: headerRowCount
  };
}

function findSparseTableHeaderRowCount(tableRows, firstDenseRow) {
  const firstDenseRowIndex = tableRows.findIndex((row) => row.id === firstDenseRow.id);
  const searchLimit = firstDenseRowIndex >= 0 ? firstDenseRowIndex : tableRows.length - 1;

  for (let rowIndex = 0; rowIndex <= searchLimit; rowIndex += 1) {
    const row = tableRows[rowIndex];
    const numericCoverage = row.items.length > 0 ? row.numericItems.length / row.items.length : 0;

    if (row.numericItems.length >= 2 && row.headerItems.length === 0 && numericCoverage >= 0.75) {
      return rowIndex;
    }
  }

  return Math.max(0, firstDenseRowIndex);
}

function detectSparseNumericTables(page, blocks, baselineFontSize) {
  const rows = buildSparseNumericRows(blocks, baselineFontSize);
  const denseBands = [];
  let currentBand = [];
  const maxRowGap = Math.max(18, baselineFontSize * 2.4);

  for (const row of rows) {
    const isDenseNumericRow =
      row.numericItems.length >= 4 &&
      row.right - row.left >= Math.max(96, page.width * 0.16);

    if (!isDenseNumericRow) {
      if (currentBand.length >= 3) {
        denseBands.push(currentBand);
      }
      currentBand = [];
      continue;
    }

    const previous = currentBand.at(-1);
    if (!previous || row.top - previous.bottom <= maxRowGap) {
      currentBand.push(row);
      continue;
    }

    if (currentBand.length >= 3) {
      denseBands.push(currentBand);
    }
    currentBand = [row];
  }

  if (currentBand.length >= 3) {
    denseBands.push(currentBand);
  }

  const tableMetaById = new Map();
  const tables = [];
  const syntheticBlocks = [];
  const suppressedBlockIds = new Set();
  let tableSequence = 0;

  for (const denseBand of denseBands) {
    const flatNumericItems = denseBand.flatMap((row) => row.numericItems);
    const anchorTolerance = Math.max(10, baselineFontSize * 1.4);
    const anchors = clusterByProximity(flatNumericItems, (item) => blockLeft(item.block), anchorTolerance)
      .filter((cluster) => cluster.items.length >= Math.max(2, Math.ceil(denseBand.length * 0.45)))
      .map((cluster) => ({ x: cluster.centroid }))
      .sort((left, right) => left.x - right.x);

    if (anchors.length < 4) {
      continue;
    }

    const firstDenseRow = denseBand[0];
    const tableRows = [...denseBand];
    let cursor = rows.indexOf(firstDenseRow) - 1;

    while (cursor >= 0) {
      const candidate = rows[cursor];
      const nextRow = tableRows[0];
      const gap = nextRow.top - candidate.bottom;
      const plausibleSparseRow =
        candidate.numericItems.length >= 2 ||
        candidate.headerItems.length >= 1 ||
        candidate.items.some((item) => item.text.length <= 24 && /[A-Za-z%]/.test(item.text));

      if (gap < -baselineFontSize || gap > maxRowGap || !plausibleSparseRow || !rowOverlapsAnchors(candidate, anchors, anchorTolerance * 3)) {
        break;
      }

      tableRows.unshift(candidate);
      cursor -= 1;
    }

    tableSequence += 1;
    const tableId = `table:${page.pageNumber}:sparse-numeric:${tableSequence}`;
    const headerRowCount = findSparseTableHeaderRowCount(tableRows, firstDenseRow);
    const leafHeaderPlan = buildSparseLeafHeaderBlocks({
      tableRows,
      headerRowCount,
      anchors,
      anchorTolerance,
      tableId,
      pageNumber: page.pageNumber
    });
    const logicalHeaderRowCount = leafHeaderPlan ? 1 : headerRowCount;

    if (leafHeaderPlan) {
      syntheticBlocks.push(...leafHeaderPlan.headerBlocks);
      for (const blockId of leafHeaderPlan.suppressedBlockIds) {
        suppressedBlockIds.add(blockId);
      }
    }

    let nextBodyRowIndex = logicalHeaderRowCount;
    let logicalRowCount = logicalHeaderRowCount;
    tableRows.forEach((row, rowIndex) => {
      const isHeaderRow = rowIndex < headerRowCount;
      if (leafHeaderPlan && isHeaderRow) {
        return;
      }

      const rowAssignments = [];
      for (const item of row.items) {
        if (!isHeaderRow && !looksSparseNumericCell(item.text)) {
          continue;
        }

        const assignment = assignBlockToSparseAnchors(item.block, anchors, anchorTolerance, {
          allowSpan: isHeaderRow && !looksSparseNumericCell(item.text)
        });
        if (!assignment) {
          continue;
        }

        rowAssignments.push({ item, assignment });
      }

      if (rowAssignments.length === 0) {
        return;
      }

      const logicalRowIndex = isHeaderRow ? rowIndex : nextBodyRowIndex++;
      logicalRowCount = Math.max(logicalRowCount, logicalRowIndex + 1);

      for (const { item, assignment } of rowAssignments) {
        tableMetaById.set(item.block.id, {
          blockType: "table-cell",
          tableId,
          tableRole: isHeaderRow ? "header" : "cell",
          tableSection: isHeaderRow ? "head" : "body",
          tableRowIndex: logicalRowIndex,
          tableColumnIndex: assignment.columnIndex,
          tableColumnSpan: assignment.columnSpan,
          tableCellConfidence: 0.92,
          tableSource: "sparse-numeric-grid",
          tableDetectionMethod: "sparse-numeric-grid"
        });
      }
    });

    tables.push({
      id: tableId,
      source: "sparse-numeric-grid",
      rowCount: logicalRowCount,
      columnCount: anchors.length,
      headerRowCount: logicalHeaderRowCount,
      mergeSignalCount: 0,
      confidence: 0.92,
      ...(leafHeaderPlan
        ? {
            headerNormalization: {
              applied: true,
              strategy: "sparse-leaf-column-headers-v1",
              sourceHeaderRowCount: leafHeaderPlan.sourceHeaderRowCount,
              logicalHeaderRowCount
            }
          }
        : {})
    });
  }

  return { tableMetaById, tables, syntheticBlocks, suppressedBlockIds };
}

function detectTextGridTables(page, blocks, baselineFontSize) {
  const rows = buildCandidateRows(page, blocks, baselineFontSize);

  if (rows.length < 2) {
    return {
      tableMetaById: new Map(),
      tables: []
    };
  }

  const candidateBands = [];
  let currentBand = [];

  for (const row of rows) {
    if (currentBand.length === 0) {
      currentBand = [row];
      continue;
    }

    const lastRow = currentBand.at(-1);
    const summary = summarizeTableBand([...currentBand, row], page, baselineFontSize);

    if (areRowsCompatible(lastRow, row, page, baselineFontSize) && summary.stableRows.some((stableRow) => stableRow.id === row.id)) {
      currentBand.push(row);
      continue;
    }

    if (currentBand.length >= 2) {
      candidateBands.push(currentBand);
    }
    currentBand = [row];
  }

  if (currentBand.length >= 2) {
    candidateBands.push(currentBand);
  }

  const tableMetaById = new Map();
  const tables = [];
  let tableSequence = 0;

  for (const bandRows of candidateBands) {
    const summary = summarizeTableBand(bandRows, page, baselineFontSize);
    if (!isConfidentTableBand(summary, page)) {
      continue;
    }

    tableSequence += 1;
    const tableId = `table:${page.pageNumber}:${tableSequence}`;
    const headerRowId = summary.hasHeaderRow ? summary.stableRows[0]?.id : null;
    const confidence = Number(Math.min(0.98, 0.88 + summary.rowCount * 0.02 + summary.columnCount * 0.01).toFixed(2));

    summary.stableRows.forEach((row, rowIndex) => {
      const isHeaderRow = row.id === headerRowId;

      row.assignments.forEach(({ item, columnIndex }) => {
        tableMetaById.set(item.block.id, {
          blockType: "table-cell",
          tableId,
          tableRole: isHeaderRow ? "header" : "cell",
          tableSection: isHeaderRow ? "head" : "body",
          tableRowIndex: rowIndex,
          tableColumnIndex: columnIndex,
          tableCellConfidence: confidence
        });
      });
    });

    tables.push({
      id: tableId,
      source: "text-grid",
      rowCount: summary.rowCount,
      columnCount: summary.columnCount,
      headerRowCount: headerRowId ? 1 : 0,
      mergeSignalCount: 0,
      confidence
    });
  }

  return {
    tableMetaById,
    tables
  };
}

// Post-detection pass that adopts two classes of orphan blocks into already-detected
// tables:
//
//  Pass A – same-row orphans: blocks that sit at the same y-level as an existing
//    table row (within rowTolerance) but were never assigned to a column anchor
//    because their x-position fell outside the narrow tolerance used when building
//    the band.  Typical cause: a leftmost header cell is indented relative to the
//    data cells in that column (e.g. "Metric" centred in a label column whose data
//    cells start further left).  We re-try with 4× the normal tolerance.
//
//  Pass B – above-table orphans: blocks that sit just above the table's topmost
//    row (within gapThreshold) and overlap horizontally with the table but were
//    never brought into the detection band.  Two kinds:
//      • single-item merged rows whose text.length > 64 or width > 68 % of the
//        page width caused them to be stripped by buildCandidateRows (e.g. a row
//        where all 7 column labels were merged into one text block by the parser)
//      • spanner-header rows whose x-anchors do not align with any individual data
//        column anchor (the cells span multiple columns and are centred between them)
//    After adoption, all existing row indices for that table are shifted up by the
//    number of inserted pre-header rows so that the final numbering is contiguous
//    and 0-based.
//
// Guard rails that prevent false-positive adoption of prose or caption text:
//  • block height ≤ max(24, 2.4 × baselineFontSize) – excludes section headings
//  • block type must not be 'heading' or 'list-item'
//  • block text must not start with a lower-case letter            – excludes
//    continuation sentences ("disaggregated by …")
//  • block text must not contain ". " (period-space)              – excludes
//    numbered captions ("Table 2. Present-value …")
//  • block must not be purely numeric                             – excludes
//    page numbers and footnote markers
//  • block must intersect the table's horizontal extent           – excludes
//    narrow margin annotations
function adoptOrphanTableBlocks(tableMetaById, tables, page, allBlocks, baselineFontSize) {
  if (tables.length === 0) return;

  const rowTolerance = Math.max(readThresholds().rowTolerancePixels, baselineFontSize * 0.9);
  const gapThreshold = Math.max(22, baselineFontSize * 3.2);
  const xTolBase = Math.max(12, page.width * 0.03, baselineFontSize * 1.2);
  const xTolWide = xTolBase * 4;

  for (const table of tables) {
    if (table.headerNormalization?.applied) {
      continue;
    }

    // Collect all cells assigned to this table
    const assignedCells = [];
    for (const [blockId, meta] of tableMetaById.entries()) {
      if (meta.tableId !== table.id) continue;
      const block = allBlocks.find((b) => b.id === blockId);
      if (block) assignedCells.push({ blockId, meta, block });
    }
    if (assignedCells.length === 0) continue;

    // Table bounding box from assigned cells
    const tableLeft = Math.min(...assignedCells.map((c) => c.block.bbox[0]));
    const tableRight = Math.max(...assignedCells.map((c) => c.block.bbox[0] + c.block.bbox[2]));
    const tableTop = Math.min(...assignedCells.map((c) => c.block.bbox[1]));

    // Column anchors: mean x per column index derived from all assigned cells
    const colXValues = new Map();
    for (const { block, meta } of assignedCells) {
      const col = meta.tableColumnIndex;
      if (!colXValues.has(col)) colXValues.set(col, []);
      colXValues.get(col).push(block.bbox[0]);
    }
    const columnAnchors = [...colXValues.entries()]
      .sort(([a], [b]) => a - b)
      .map(([col, xValues]) => ({ col, x: mean(xValues) }));

    if (columnAnchors.length === 0) continue;

    // ------------------------------------------------------------------
    // Pass A: adopt unassigned blocks at the same y-level as an existing row
    // ------------------------------------------------------------------
    // Build row y-bands from already-assigned cells
    const rowBands = new Map(); // rowIndex → { yMin, yMax, isHeader }
    for (const { block, meta } of assignedCells) {
      const ri = meta.tableRowIndex;
      if (!rowBands.has(ri)) rowBands.set(ri, { yMin: Infinity, yMax: -Infinity, isHeader: false });
      const band = rowBands.get(ri);
      band.yMin = Math.min(band.yMin, block.bbox[1]);
      band.yMax = Math.max(band.yMax, block.bbox[1] + block.bbox[3]);
      if (meta.tableRole === "header") band.isHeader = true;
    }

    for (const [rowIndex, band] of rowBands.entries()) {
      const rowYCenter = (band.yMin + band.yMax) / 2;
      const orphans = allBlocks.filter((b) => {
        if (tableMetaById.has(b.id)) return false;
        if (b.isArtifact) return false;
        const bCenter = b.bbox[1] + b.bbox[3] / 2;
        if (Math.abs(bCenter - rowYCenter) > rowTolerance) return false;
        const bRight = b.bbox[0] + b.bbox[2];
        return b.bbox[0] < tableRight + xTolWide && bRight > tableLeft - xTolWide;
      });

      for (const orphan of orphans) {
        let bestCol = -1;
        let bestDist = Infinity;
        for (const anchor of columnAnchors) {
          const dist = Math.abs(orphan.bbox[0] - anchor.x);
          if (dist <= xTolWide && dist < bestDist) {
            bestCol = anchor.col;
            bestDist = dist;
          }
        }
        if (bestCol === -1) continue;

        const orphanRight = orphan.bbox[0] + orphan.bbox[2];
        let colSpan = 1;
        for (const anchor of columnAnchors) {
          if (anchor.col > bestCol && anchor.x <= orphanRight + xTolBase) {
            colSpan = Math.max(colSpan, anchor.col - bestCol + 1);
          }
        }

        tableMetaById.set(orphan.id, {
          blockType: "table-cell",
          tableId: table.id,
          tableRole: band.isHeader ? "header" : "cell",
          tableSection: band.isHeader ? "head" : "body",
          tableRowIndex: rowIndex,
          tableColumnIndex: bestCol,
          tableColumnSpan: colSpan,
          tableDetectionMethod: "orphan-adoption-same-row"
        });
      }
    }

    // ------------------------------------------------------------------
    // Pass B: adopt blocks ABOVE the table as pre-header rows
    // ------------------------------------------------------------------
    const orphanAbove = allBlocks.filter((b) => {
      if (tableMetaById.has(b.id)) return false;
      if (b.isArtifact) return false;
      const bBottom = b.bbox[1] + b.bbox[3];
      // Must sit just above the table top (with 2 px rounding tolerance)
      if (bBottom > tableTop + 2) return false;
      if (tableTop - bBottom > gapThreshold) return false;
      // Must fall within the table's horizontal extent (not a pure margin annotation)
      const bRight = b.bbox[0] + b.bbox[2];
      if (b.bbox[0] >= tableRight || bRight <= tableLeft) return false;
      // Must not be unusually tall (would indicate a section heading)
      if (b.bbox[3] > Math.max(24, baselineFontSize * 2.4)) return false;
      // Skip already-classified headings or list items
      if (b.blockType === "heading" || b.blockType === "list-item") return false;
      // Skip purely numeric blocks (page numbers, footnote markers)
      if (looksNumericish(normalizeText(b.text))) return false;
      // Guard: skip prose-like blocks.  Caption sentences start with a lower-case
      // word or contain ". " (e.g. "Table 2. Present-value …").
      const firstChar = b.text.trimStart()[0] ?? "";
      if (firstChar >= "a" && firstChar <= "z") return false;
      if (b.text.includes(". ")) return false;
      return true;
    });

    if (orphanAbove.length === 0) continue;

    // Group orphan-above blocks into rows by y-proximity, topmost row first
    const orphanAboveRows = clusterByProximity(
      orphanAbove.map((b) => ({ b, yCenter: b.bbox[1] + b.bbox[3] / 2 })),
      (item) => item.yCenter,
      rowTolerance
    );
    orphanAboveRows.sort((a, b) => a.centroid - b.centroid);

    const numPre = orphanAboveRows.length;

    // Shift all existing row indices up by numPre so indices remain contiguous
    for (const [blockId, meta] of tableMetaById.entries()) {
      if (meta.tableId !== table.id) continue;
      meta.tableRowIndex += numPre;
    }
    table.headerRowCount += numPre;
    table.rowCount += numPre;

    // Assign the orphan rows as pre-header rows (indices 0 … numPre-1)
    for (let ri = 0; ri < orphanAboveRows.length; ri++) {
      const rowBlocks = orphanAboveRows[ri].items.map((item) => item.b).sort((a, b) => a.bbox[0] - b.bbox[0]);

      for (const block of rowBlocks) {
        const blockRight = block.bbox[0] + block.bbox[2];

        // Determine which columns the spanner block covers.
        //
        // LEFT column: the anchor closest to the block's left edge whose x is
        //   ≤ block.x + xTolBase (i.e. within or just to the right of the block).
        //   This avoids picking a distant column on the other side of the table.
        //   Fall back to the nearest anchor within xTolWide when none satisfies
        //   the tighter condition (e.g. narrow single-column header labels).
        //
        // RIGHT column: the rightmost anchor in [block.x, blockRight + xTolBase].
        //   Falls back to the left column (span = 1) when nothing is found.
        let leftCol = -1;
        let leftDist = Infinity;
        let rightCol = -1;

        for (const anchor of columnAnchors) {
          // Candidate for LEFT column: anchor is within xTolBase past the block's left edge
          if (anchor.x <= block.bbox[0] + xTolBase) {
            const dist = Math.abs(anchor.x - block.bbox[0]);
            if (dist < leftDist) {
              leftCol = anchor.col;
              leftDist = dist;
            }
          }
          // Candidate for RIGHT column: anchor falls within the block's width.
          // Use 2×xTolBase on the right so that a spanner label whose right edge sits
          // slightly left of the rightmost spanned column's anchor is still captured
          // (e.g. "IFR" at x=324-341 with col4 anchor at x=363: gap = 22 px which
          // exceeds xTolBase=18 but is well within 2×xTolBase=36).
          if (anchor.x >= block.bbox[0] && anchor.x <= blockRight + xTolBase * 2) {
            if (rightCol === -1 || anchor.col > rightCol) {
              rightCol = anchor.col;
            }
          }
        }

        // Fallback: if no anchor is within xTolBase of the left edge, use the
        // nearest anchor overall (within xTolWide), which handles columns whose
        // anchors lie entirely to the right of the label (e.g. single-word labels
        // whose column's data cells start further left on the same row).
        if (leftCol === -1) {
          let nearestDist = Infinity;
          for (const anchor of columnAnchors) {
            const dist = Math.abs(anchor.x - block.bbox[0]);
            if (dist <= xTolWide && dist < nearestDist) {
              leftCol = anchor.col;
              nearestDist = dist;
            }
          }
        }
        if (leftCol === -1) continue; // cannot assign this block

        if (rightCol === -1) rightCol = leftCol;
        if (leftCol > rightCol) rightCol = leftCol;

        const bestCol = leftCol;
        const colSpan = rightCol - leftCol + 1;

        tableMetaById.set(block.id, {
          blockType: "table-cell",
          tableId: table.id,
          tableRole: "header",
          tableSection: "head",
          tableRowIndex: ri,
          tableColumnIndex: bestCol,
          tableColumnSpan: colSpan,
          tableDetectionMethod: "orphan-header-above"
        });
      }
    }
  }
}

function analyzePage(page, baselineFontSize, tableStructurePage = null) {
  const thresholds = readThresholds();
  const preclassifiedBlocks = page.textBlocks.map((block) => ({
    ...block,
    ...classifyBlock(block, baselineFontSize, thresholds, page)
  }));
  const vectorTableAnalysis = detectVectorTables(page, preclassifiedBlocks, tableStructurePage, baselineFontSize);
  const remainingAfterVector = preclassifiedBlocks.filter((block) => !vectorTableAnalysis.tableMetaById.has(block.id));
  const sparseNumericTableAnalysis = detectSparseNumericTables(page, remainingAfterVector, baselineFontSize);
  const remainingAfterSparseNumeric = remainingAfterVector.filter(
    (block) => !sparseNumericTableAnalysis.tableMetaById.has(block.id) && !sparseNumericTableAnalysis.suppressedBlockIds.has(block.id)
  );
  const textGridTableAnalysis = detectTextGridTables(page, remainingAfterSparseNumeric, baselineFontSize);
  const remainingAfterGrid = remainingAfterSparseNumeric.filter((block) => !textGridTableAnalysis.tableMetaById.has(block.id));
  const borderlessTableAnalysis = detectBorderlessTables(page, remainingAfterGrid, baselineFontSize);
  const tableMetaById = new Map([
    ...borderlessTableAnalysis.tableMetaById.entries(),
    ...textGridTableAnalysis.tableMetaById.entries(),
    ...sparseNumericTableAnalysis.tableMetaById.entries(),
    ...vectorTableAnalysis.tableMetaById.entries()
  ]);
  const tables = [
    ...vectorTableAnalysis.tables,
    ...sparseNumericTableAnalysis.tables,
    ...textGridTableAnalysis.tables,
    ...borderlessTableAnalysis.tables
  ];
  adoptOrphanTableBlocks(tableMetaById, tables, page, preclassifiedBlocks, baselineFontSize);
  const columns = detectColumns({ ...page, textBlocks: preclassifiedBlocks }, new Set(tableMetaById.keys()), thresholds);
  const largestTable = [...tables].sort(
    (left, right) => right.rowCount * right.columnCount - left.rowCount * left.columnCount
  )[0];
  const sourceBlocks = preclassifiedBlocks.filter((block) => !sparseNumericTableAnalysis.suppressedBlockIds.has(block.id));
  const textBlocks = [...sourceBlocks, ...sparseNumericTableAnalysis.syntheticBlocks].map((block) => {
    const tableMetadata = tableMetaById.get(block.id);
    const columnHint = columns.count === 1 ? 0 : blockCenterX(block) < columns.splitX ? 0 : 1;

    return {
      ...block,
      ...tableMetadata,
      columnHint,
      columnConfidence: columns.confidence
    };
  }).sort((left, right) => {
    const rowLeft = Number.isInteger(left.tableRowIndex) ? left.tableRowIndex : null;
    const rowRight = Number.isInteger(right.tableRowIndex) ? right.tableRowIndex : null;
    if (left.tableId && left.tableId === right.tableId && rowLeft != null && rowRight != null) {
      if (rowLeft !== rowRight) return rowLeft - rowRight;
      const columnLeft = Number.isInteger(left.tableColumnIndex) ? left.tableColumnIndex : 0;
      const columnRight = Number.isInteger(right.tableColumnIndex) ? right.tableColumnIndex : 0;
      if (columnLeft !== columnRight) return columnLeft - columnRight;
    }

    return blockTop(left) - blockTop(right) || blockLeft(left) - blockLeft(right);
  });

  return {
    ...page,
    columns: columns.count,
    columnSplitX: columns.splitX,
    columnGutter: columns.gutter,
    structureSignals: {
      columnCount: columns.count,
      columnSplitX: columns.splitX,
      columnGutter: columns.gutter,
      columnConfidence: columns.confidence,
      tableDetected: tables.length > 0,
      tableCount: tables.length,
      vectorTableCount: vectorTableAnalysis.tables.length,
      sparseNumericTableCount: sparseNumericTableAnalysis.tables.length,
      textGridTableCount: textGridTableAnalysis.tables.length,
      borderlessTableCount: borderlessTableAnalysis.tables.length,
      tableRowCount: largestTable?.rowCount || 0,
      tableColumnCount: largestTable?.columnCount || 0,
      tableHeaderRowCount: tables.reduce((total, table) => total + table.headerRowCount, 0),
      tableMergeSignalCount: tables.reduce((total, table) => total + (table.mergeSignalCount || 0), 0),
      orderedListItemCount: textBlocks.filter((block) => block.listStyle === "ordered").length
    },
    textBlocks
  };
}

async function loadOptionalTableStructureMap(tableStructurePath) {
  if (!tableStructurePath) {
    return null;
  }

  const tableStructureMap = JSON.parse(await readFile(tableStructurePath, "utf8"));
  if (tableStructureMap.status === "unavailable") {
    return null;
  }

  if (!validateTableStructure(tableStructureMap)) {
    throw new Error(`Layout analyzer table-structure input failed schema validation: ${ajv.errorsText(validateTableStructure.errors)}`);
  }

  return tableStructureMap;
}

export async function analyzeLayout(inputPath, options = {}) {
  const layoutDocument = JSON.parse(await readFile(inputPath, "utf8"));

  if (!validateLayout(layoutDocument)) {
    throw new Error(`Layout analyzer input failed schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  const tableStructureMap = await loadOptionalTableStructureMap(options.tableStructurePath);
  const tableStructurePages = new Map((tableStructureMap?.pages || []).map((page) => [page.pageNumber, page]));
  const allFontSizes = layoutDocument.pages.flatMap((page) => page.textBlocks.map((block) => block.fontSize));
  const baselineFontSize = median(allFontSizes);

  const output = {
    ...layoutDocument,
    pages: layoutDocument.pages.map((page) => {
      const pageBaselineFontSize = median(page.textBlocks.map((block) => block.fontSize));
      return analyzePage(page, pageBaselineFontSize || baselineFontSize, tableStructurePages.get(page.pageNumber));
    })
  };

  if (!validateLayout(output)) {
    throw new Error(`Layout analyzer output failed schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  return output;
}

async function main() {
  const args = new Map();
  let inputPath = "";

  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith("--") && !inputPath) {
      inputPath = token;
      continue;
    }

    if (token.startsWith("--")) {
      args.set(token, process.argv[index + 1]);
      index += 1;
    }
  }

  if (!inputPath) {
    throw new Error("Usage: node modules/layout-analyzer/index.js <layout.json> [--table-structure <table-structure-map.json>]");
  }

  const result = await analyzeLayout(inputPath, {
    tableStructurePath: args.get("--table-structure")
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
