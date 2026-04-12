import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import layoutSchema from "../../contracts/layout.schema.json" with { type: "json" };
import tableStructureSchema from "../../contracts/table-structure.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateLayout = ajv.compile(layoutSchema);
const validateTableStructure = ajv.compile(tableStructureSchema);

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

function detectColumns(page, ignoredBlockIds = new Set()) {
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
  const gapThreshold = Math.max(page.width * 0.16, median(widths) * 1.9, 48);

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

function classifyBlock(block, baselineFontSize) {
  const text = normalizeText(block.text);
  const orderedListMatch = text.match(/^(\d+)[.)]\s+/);
  const isBulletListItem = /^([-*]|\u2022)\s+/.test(text);
  const isBold = /bold/i.test(block.fontName || "");
  const headingScore = block.fontSize / baselineFontSize;
  const isHeading = headingScore >= 1.55 || (headingScore >= 1.3 && isBold && text.length <= 80);

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
    const headingLevel = headingScore >= 1.9 ? 1 : headingScore >= 1.55 ? 2 : 3;
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

function looksHeaderish(text) {
  const normalized = normalizeText(text);
  return normalized.length > 0 && normalized.length <= 48 && /[A-Za-z]{2}/.test(normalized) && !looksNumericish(normalized);
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

  const rowTolerance = Math.max(6, baselineFontSize * 0.9);

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

  return (
    firstRow.boldRatio >= 0.5 ||
    (firstRow.headerishRatio >= 0.75 && restNumericRatio >= 0.3) ||
    (firstRow.headerishRatio >= 0.75 && firstRow.meanFontSize >= restFontSize * 1.08)
  );
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
    horizontalSpan: anchors.length >= 2 ? anchors.at(-1).x - anchors[0].x : 0
  };
}

function isConfidentTableBand(summary, page) {
  return (
    summary.rowCount >= 2 &&
    summary.columnCount >= 2 &&
    summary.assignedCellCount >= 4 &&
    summary.stableCoverage >= 0.67 &&
    summary.horizontalSpan >= Math.max(page.width * 0.14, 64) &&
    summary.consistentColumnRows >= Math.max(2, Math.ceil(summary.rowCount * 0.6)) &&
    !(summary.rowCount === 2 && summary.columnCount === 2 && !summary.hasHeaderRow)
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

function analyzePage(page, baselineFontSize, tableStructurePage = null) {
  const preclassifiedBlocks = page.textBlocks.map((block) => ({
    ...block,
    ...classifyBlock(block, baselineFontSize)
  }));
  const vectorTableAnalysis = detectVectorTables(page, preclassifiedBlocks, tableStructurePage, baselineFontSize);
  const remainingBlocks = preclassifiedBlocks.filter((block) => !vectorTableAnalysis.tableMetaById.has(block.id));
  const textGridTableAnalysis = detectTextGridTables(page, remainingBlocks, baselineFontSize);
  const tableMetaById = new Map([...textGridTableAnalysis.tableMetaById.entries(), ...vectorTableAnalysis.tableMetaById.entries()]);
  const tables = [...vectorTableAnalysis.tables, ...textGridTableAnalysis.tables];
  const columns = detectColumns({ ...page, textBlocks: preclassifiedBlocks }, new Set(tableMetaById.keys()));
  const largestTable = [...tables].sort(
    (left, right) => right.rowCount * right.columnCount - left.rowCount * left.columnCount
  )[0];
  const textBlocks = preclassifiedBlocks.map((block) => {
    const tableMetadata = tableMetaById.get(block.id);
    const columnHint = columns.count === 1 ? 0 : blockCenterX(block) < columns.splitX ? 0 : 1;

    return {
      ...block,
      ...tableMetadata,
      columnHint,
      columnConfidence: columns.confidence
    };
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
      textGridTableCount: textGridTableAnalysis.tables.length,
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
    pages: layoutDocument.pages.map((page) => analyzePage(page, baselineFontSize, tableStructurePages.get(page.pageNumber)))
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
