import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import layoutSchema from "../../contracts/layout.schema.json" with { type: "json" };
import semanticSchema from "../../contracts/semantic.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateLayout = ajv.compile(layoutSchema);
const validateSemantic = ajv.compile(semanticSchema);

function isHeadingBlock(block) {
  return block.blockType === "heading" || block.headingLevel != null;
}

function isTableCandidate(block) {
  return (
    block.blockType === "table-cell" ||
    block.blockType === "table" ||
    block.tableId != null ||
    block.tableGroupId != null ||
    block.tableRowIndex != null ||
    block.tableColumnIndex != null ||
    block.rowIndex != null ||
    block.columnIndex != null ||
    block.tableCell === true ||
    block.cellRole != null
  );
}

function isListItemBlock(block) {
  const text = String(block.text || "").trim();
  return (
    block.blockType === "list-item" ||
    block.listGroupId != null ||
    block.listId != null ||
    block.listItemIndex != null ||
    /^([-*]|\u2022|\d+\.)\s+/.test(text)
  );
}

function inferArtifactPlacement(block) {
  const regionKind = String(block.regionKind || block.region || block.pageRegion || block.sectionKind || "").toLowerCase();

  if (block.isHeader || regionKind === "header") {
    return "header";
  }

  if (block.isFooter || regionKind === "footer") {
    return "footer";
  }

  if (block.isArtifact || regionKind === "artifact" || block.blockType === "artifact") {
    return "artifact";
  }

  return null;
}

function columnAnchorsMatch(activeTable, newPageCells, tolerance) {
  if (!activeTable || !activeTable.columnAnchors || activeTable.columnAnchors.length === 0) {
    return false;
  }
  let matchCount = 0;
  for (const anchor of activeTable.columnAnchors) {
    for (const x of newPageCells) {
      if (Math.abs(anchor - x) <= tolerance) {
        matchCount++;
        break;
      }
    }
  }
  return matchCount >= 2;
}

function isRepeatedHeaderRow(activeTable, rowCellTexts) {
  if (!activeTable || !activeTable.headerTexts || activeTable.headerTexts.length === 0) {
    return false;
  }
  if (rowCellTexts.length !== activeTable.headerTexts.length) {
    return false;
  }
  return rowCellTexts.every((t, i) => t === activeTable.headerTexts[i]);
}

function inferTableMetadata(block, pageNumber, index, state, options) {
  const tableContinuationAcrossPages = options?.tableContinuationAcrossPages !== false;

  if (!isTableCandidate(block)) {
    state.activeTable = null;
    return null;
  }

  const rowIndex =
    Number.isInteger(block.tableRowIndex) ? block.tableRowIndex : Number.isInteger(block.rowIndex) ? block.rowIndex : undefined;
  const columnIndex =
    Number.isInteger(block.tableColumnIndex) ? block.tableColumnIndex : Number.isInteger(block.columnIndex) ? block.columnIndex : undefined;
  const currentY = Array.isArray(block.bbox) ? block.bbox[1] : 0;
  const currentX = Array.isArray(block.bbox) ? block.bbox[0] : 0;
  const explicitTableId = block.tableId || block.tableGroupId;

  const pageWidth = options?.pageWidth || 612;
  const anchorTolerance = Math.max(15, pageWidth * 0.05);

  // Same-page continuation (original logic)
  const samePageContinuation =
    state.activeTable &&
    state.activeTable.lastPage === pageNumber &&
    (!Number.isFinite(state.activeTable.lastY) || Math.abs(currentY - state.activeTable.lastY) <= 48) &&
    (!Number.isFinite(state.activeTable.lastX) || Math.abs(currentX - state.activeTable.lastX) <= 160);

  // Same-page column-anchor continuation: if the active table has column anchors
  // (from explicit tableId or cross-page continuation), allow cells whose X matches
  // a known anchor to continue the table even if the X-distance threshold fails.
  const samePageAnchorContinuation =
    !samePageContinuation &&
    state.activeTable &&
    state.activeTable.lastPage === pageNumber &&
    state.activeTable.columnAnchors &&
    state.activeTable.columnAnchors.length >= 2 &&
    (!Number.isFinite(state.activeTable.lastY) || Math.abs(currentY - state.activeTable.lastY) <= 48) &&
    state.activeTable.columnAnchors.some((anchor) => Math.abs(anchor - currentX) <= anchorTolerance);

  // Cross-page continuation via column anchor matching
  let crossPageContinuation = false;
  let repeatedHeader = false;
  if (
    !samePageContinuation &&
    !samePageAnchorContinuation &&
    tableContinuationAcrossPages &&
    state.activeTable &&
    state.activeTable.lastPage === pageNumber - 1
  ) {
    const newPageXPositions = state.pendingNewPageXPositions || [];
    if (!newPageXPositions.includes(currentX)) {
      newPageXPositions.push(currentX);
    }
    crossPageContinuation = columnAnchorsMatch(state.activeTable, newPageXPositions, anchorTolerance);
  }

  const continuation = samePageContinuation || samePageAnchorContinuation || crossPageContinuation;

  if (explicitTableId) {
    if (!state.activeTable || state.activeTable.tableId !== String(explicitTableId)) {
      state.activeTable = {
        tableId: String(explicitTableId),
        lastY: currentY,
        lastX: currentX,
        lastPage: pageNumber,
        columnAnchors: [currentX],
        headerTexts: [],
        maxRowIndex: 0,
        rowCount: 0
      };
    } else {
      state.activeTable.lastY = currentY;
      state.activeTable.lastX = currentX;
      state.activeTable.lastPage = pageNumber;
      if (!state.activeTable.columnAnchors.includes(currentX)) {
        state.activeTable.columnAnchors.push(currentX);
      }
    }
  } else if (!continuation) {
    state.tableSequence += 1;
    state.activeTable = {
      tableId: `table:${pageNumber}:${state.tableSequence}`,
      lastY: currentY,
      lastX: currentX,
      lastPage: pageNumber,
      columnAnchors: [currentX],
      headerTexts: [],
      maxRowIndex: 0,
      rowCount: 0
    };
  } else {
    state.activeTable.lastY = currentY;
    state.activeTable.lastX = currentX;
    state.activeTable.lastPage = pageNumber;
    if (!state.activeTable.columnAnchors.includes(currentX)) {
      state.activeTable.columnAnchors.push(currentX);
    }
  }

  // Track header texts for repeated-header detection
  const tableRole = block.tableRole || block.cellRole || (block.blockType === "table" ? "table" : "cell");
  const isHeader = String(tableRole).toLowerCase() === "header";
  if (isHeader && state.activeTable.headerTexts.length < 20) {
    state.activeTable.headerTexts.push(String(block.text || "").trim());
  }

  // Track row indices for cross-page row continuation
  if (Number.isInteger(rowIndex)) {
    state.activeTable.maxRowIndex = Math.max(state.activeTable.maxRowIndex, rowIndex);
  }
  state.activeTable.rowCount = (state.activeTable.rowCount || 0);

  // Track when a cross-page continuation starts on this page
  if (crossPageContinuation) {
    state.activeTable.crossPageStartedOnPage = pageNumber;
  }

  // Detect repeated header on new page (applies to the cross-page cell itself
  // and to subsequent cells on the same page that are part of the same header row)
  const onCrossPageRow =
    crossPageContinuation ||
    (samePageAnchorContinuation && state.activeTable.crossPageStartedOnPage === pageNumber);
  if (onCrossPageRow && isHeader) {
    const cellText = String(block.text || "").trim();
    if (state.activeTable.headerTexts.includes(cellText)) {
      repeatedHeader = true;
    }
  }

  const tableId = String(state.activeTable.tableId);

  return {
    tableId,
    tableRole,
    rowIndex,
    columnIndex,
    rowSpan: Number.isInteger(block.tableRowSpan) ? block.tableRowSpan : Number.isInteger(block.rowSpan) ? block.rowSpan : 1,
    columnSpan:
      Number.isInteger(block.tableColumnSpan) ? block.tableColumnSpan : Number.isInteger(block.columnSpan) ? block.columnSpan : 1,
    tableSection: repeatedHeader ? "THead" : (block.tableSection || block.tableBand || null),
    tableSource: block.tableSource || null,
    ...(repeatedHeader ? { repeatedHeader: true } : {})
  };
}

function inferListMetadata(block, pageNumber, index, state) {
  if (!isListItemBlock(block)) {
    state.activeList = null;
    return null;
  }

  const explicitGroupId = block.listGroupId || block.listId || block.bulletGroupId;
  const level = Number.isInteger(block.listLevel) ? block.listLevel : 1;
  const itemIndex = Number.isInteger(block.listItemIndex) ? block.listItemIndex : 0;
  const listStyle = block.listStyle || (/\d+\./.test(String(block.text || "").trim()) ? "ordered" : "unordered");
  const x = Array.isArray(block.bbox) ? block.bbox[0] : 0;
  const columnHint = Number.isInteger(block.columnHint) ? block.columnHint : 0;
  const indent = Number.isFinite(block.listIndent) ? block.listIndent : Math.round(x / 18);
  const gapFromPrevious = state.activeList ? Math.abs((Array.isArray(block.bbox) ? block.bbox[1] : 0) - state.activeList.lastY) : Infinity;

  if (explicitGroupId) {
    if (!state.activeList || state.activeList.groupId !== String(explicitGroupId)) {
      state.activeList = {
        groupId: String(explicitGroupId),
        indent,
        columnHint,
        lastY: Array.isArray(block.bbox) ? block.bbox[1] : 0,
        count: 0
      };
    }

    const listItemIndex = Number.isInteger(block.listItemIndex) ? block.listItemIndex : state.activeList.count;
    state.activeList.count = Math.max(state.activeList.count + 1, listItemIndex + 1);
    state.activeList.lastY = Array.isArray(block.bbox) ? block.bbox[1] : 0;

    return {
      listGroupId: String(explicitGroupId),
      listLevel: level,
      listItemIndex,
      listStyle
    };
  }

  const continuation =
    state.activeList &&
    state.activeList.columnHint === columnHint &&
    state.activeList.indent === indent &&
    gapFromPrevious <= 28;

  if (!continuation) {
    state.activeList = {
      groupId: `list:${pageNumber}:${index + 1}`,
      indent,
      columnHint,
      lastY: Array.isArray(block.bbox) ? block.bbox[1] : 0,
      count: 0
    };
  }

  const listItemIndex = state.activeList.count;
  state.activeList.count += 1;
  state.activeList.lastY = Array.isArray(block.bbox) ? block.bbox[1] : 0;

  return {
    listGroupId: state.activeList.groupId,
    listLevel: level,
    listItemIndex,
    listStyle
  };
}

function inferRole(block, artifactPlacement, tableMetadata) {
  if (artifactPlacement) {
    return "Artifact";
  }

  if (isHeadingBlock(block)) {
    return `H${Math.min(block.headingLevel || 2, 3)}`;
  }

  if (tableMetadata) {
    if (block.blockType === "table") {
      return "Table";
    }

    return String(tableMetadata.tableRole || "").toLowerCase() === "header" ? "TH" : "TD";
  }

  if (isListItemBlock(block)) {
    return "LI";
  }

  return "P";
}

function inferConfidence(block, role, artifactPlacement, tableMetadata) {
  if (artifactPlacement) {
    return 0.99;
  }

  if (role === "Table") {
    return 0.96;
  }

  if (role === "TH" || role === "TD") {
    return tableMetadata?.tableId ? 0.96 : 0.9;
  }

  if (role === "LI") {
    return 0.94;
  }

  if (role.startsWith("H")) {
    return 0.93;
  }

  return block.blockType === "unknown" ? 0.4 : 0.88;
}

function buildSemanticNode(block, pageNumber, index, state, options) {
  const artifactPlacement = inferArtifactPlacement(block);
  const tableMetadata = inferTableMetadata(block, pageNumber, index, state, options);
  const listMetadata = inferListMetadata(block, pageNumber, index, state);
  const role = inferRole(block, artifactPlacement, tableMetadata);

  return {
    id: `n-${pageNumber}-${index + 1}`,
    pageNumber,
    sourceBlockId: block.id,
    role,
    text: block.text,
    bbox: block.bbox,
    headingLevel: role.startsWith("H") ? Math.min(block.headingLevel || 2, 6) : undefined,
    columnHint: Number.isInteger(block.columnHint) ? block.columnHint : 0,
    confidence: inferConfidence(block, role, artifactPlacement, tableMetadata),
    sourceBlockType: block.blockType,
    regionKind: block.regionKind || block.region || block.pageRegion || null,
    ...(artifactPlacement ? { artifactType: artifactPlacement } : {}),
    ...(tableMetadata
      ? {
          tableId: tableMetadata.tableId,
          tableRole: tableMetadata.tableRole,
          tableRowIndex: tableMetadata.rowIndex,
          tableColumnIndex: tableMetadata.columnIndex,
          tableRowSpan: tableMetadata.rowSpan,
          tableColumnSpan: tableMetadata.columnSpan,
          tableSection: tableMetadata.tableSection,
          tableSource: tableMetadata.tableSource,
          ...(tableMetadata.repeatedHeader ? { repeatedHeader: true } : {})
        }
      : {}),
    ...(listMetadata
      ? {
          listGroupId: listMetadata.listGroupId,
          listLevel: listMetadata.listLevel,
          listItemIndex: listMetadata.listItemIndex,
          listStyle: listMetadata.listStyle
        }
      : {})
  };
}

function collectLeadingTableXPositions(page) {
  const xPositions = [];
  for (const block of page.textBlocks) {
    if (!isTableCandidate(block)) break;
    const x = Array.isArray(block.bbox) ? block.bbox[0] : 0;
    if (!xPositions.includes(x)) {
      xPositions.push(x);
    }
  }
  return xPositions;
}

function buildNodesForPage(page, state, options) {
  if (!state) {
    state = { activeList: null, activeTable: null, tableSequence: 0 };
  }
  const pageOptions = { ...options, pageWidth: page.width || 612 };
  return page.textBlocks.map((block, index) => buildSemanticNode(block, page.pageNumber, index, state, pageOptions));
}

export async function buildSemanticDocument(inputPath, options) {
  const layoutDocument = JSON.parse(await readFile(inputPath, "utf8"));

  if (!validateLayout(layoutDocument)) {
    throw new Error(`Semantic engine input failed schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  const effectiveOptions = { tableContinuationAcrossPages: true, ...options };
  const state = { activeList: null, activeTable: null, tableSequence: 0 };

  const nodes = [];
  for (let i = 0; i < layoutDocument.pages.length; i++) {
    const page = layoutDocument.pages[i];

    // Pre-collect x-positions of this page's leading table cells
    // so cross-page column anchor matching works on the first cell of a new page
    if (effectiveOptions.tableContinuationAcrossPages) {
      state.pendingNewPageXPositions = collectLeadingTableXPositions(page);
    } else {
      state.pendingNewPageXPositions = [];
    }

    const pageNodes = buildNodesForPage(page, state, effectiveOptions);
    nodes.push(...pageNodes);
  }

  const semanticDocument = {
    schemaVersion: "1.0.0",
    documentId: `${layoutDocument.documentId}:semantic`,
    source: {
      layoutDocumentId: layoutDocument.documentId,
      filePath: layoutDocument.source.filePath,
      language: layoutDocument.source.language,
      languageConfidence: layoutDocument.source.languageConfidence
    },
    nodes
  };

  if (!validateSemantic(semanticDocument)) {
    throw new Error(`Semantic engine output failed schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  return semanticDocument;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: node modules/semantic-engine/index.js <layout.enriched.json>");
  }

  const result = await buildSemanticDocument(inputPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
