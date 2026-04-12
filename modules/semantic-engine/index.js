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

function inferTableMetadata(block, pageNumber, index, state) {
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
  const continuation =
    state.activeTable &&
    (!Number.isFinite(state.activeTable.lastY) || Math.abs(currentY - state.activeTable.lastY) <= 48) &&
    (!Number.isFinite(state.activeTable.lastX) || Math.abs(currentX - state.activeTable.lastX) <= 160);

  if (explicitTableId) {
    state.activeTable = {
      tableId: String(explicitTableId),
      lastY: currentY,
      lastX: currentX
    };
  } else if (!continuation) {
    state.tableSequence += 1;
    state.activeTable = {
      tableId: `table:${pageNumber}:${state.tableSequence}`,
      lastY: currentY,
      lastX: currentX
    };
  } else {
    state.activeTable.lastY = currentY;
    state.activeTable.lastX = currentX;
  }

  const tableId = String(state.activeTable.tableId);
  const tableRole = block.tableRole || block.cellRole || (block.blockType === "table" ? "table" : "cell");

  return {
    tableId,
    tableRole,
    rowIndex,
    columnIndex,
    rowSpan: Number.isInteger(block.tableRowSpan) ? block.tableRowSpan : Number.isInteger(block.rowSpan) ? block.rowSpan : 1,
    columnSpan:
      Number.isInteger(block.tableColumnSpan) ? block.tableColumnSpan : Number.isInteger(block.columnSpan) ? block.columnSpan : 1,
    tableSection: block.tableSection || block.tableBand || null,
    tableSource: block.tableSource || null
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

function buildSemanticNode(block, pageNumber, index, state) {
  const artifactPlacement = inferArtifactPlacement(block);
  const tableMetadata = inferTableMetadata(block, pageNumber, index, state);
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
          tableSource: tableMetadata.tableSource
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

function buildNodesForPage(page) {
  const state = { activeList: null, activeTable: null, tableSequence: 0 };
  return page.textBlocks.map((block, index) => buildSemanticNode(block, page.pageNumber, index, state));
}

export async function buildSemanticDocument(inputPath) {
  const layoutDocument = JSON.parse(await readFile(inputPath, "utf8"));

  if (!validateLayout(layoutDocument)) {
    throw new Error(`Semantic engine input failed schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  const nodes = layoutDocument.pages.flatMap((page) => buildNodesForPage(page));

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
