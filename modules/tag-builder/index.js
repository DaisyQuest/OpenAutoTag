import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import semanticSchema from "../../contracts/semantic.schema.json" with { type: "json" };
import taggingSchema from "../../contracts/tagging.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateSemantic = ajv.compile(semanticSchema);
const validateTagging = ajv.compile(taggingSchema);

function clampHeadingLevel(level) {
  return Math.max(1, Math.min(Number(level) || 1, 3));
}

function getDetectedHeadingLevel(node) {
  if (Number.isInteger(node.headingLevel)) {
    return clampHeadingLevel(node.headingLevel);
  }

  if (!String(node.role || "").startsWith("H")) {
    return null;
  }

  return clampHeadingLevel(Number(String(node.role).slice(1)));
}

function inferNormalizedHeadingLevel(originalLevel, knownMappings) {
  if (knownMappings.size === 0) {
    return 1;
  }

  const knownLevels = [...knownMappings.keys()].sort((left, right) => left - right);
  const lowerLevel = [...knownLevels].reverse().find((level) => level < originalLevel);
  const higherLevel = knownLevels.find((level) => level > originalLevel);

  if (lowerLevel != null && higherLevel != null) {
    return clampHeadingLevel(Math.min(knownMappings.get(lowerLevel) + 1, knownMappings.get(higherLevel)));
  }

  if (lowerLevel != null) {
    return clampHeadingLevel(knownMappings.get(lowerLevel) + 1);
  }

  if (higherLevel != null) {
    return clampHeadingLevel(knownMappings.get(higherLevel) - 1);
  }

  return 1;
}

function buildHeadingNormalization(orderedNodes) {
  const levelsByNodeId = new Map();
  const detectedToNormalized = new Map();
  const adjustments = [];
  let totalHeadingCount = 0;
  let firstHeadingLevel = null;
  let maxNormalizedLevel = 0;

  for (const node of orderedNodes) {
    const detectedLevel = getDetectedHeadingLevel(node);
    if (!detectedLevel) {
      continue;
    }

    totalHeadingCount += 1;

    if (firstHeadingLevel == null) {
      firstHeadingLevel = detectedLevel;
    }

    let normalizedLevel = detectedToNormalized.has(detectedLevel)
      ? detectedToNormalized.get(detectedLevel)
      : inferNormalizedHeadingLevel(detectedLevel, detectedToNormalized);

    normalizedLevel = clampHeadingLevel(normalizedLevel);

    if (!detectedToNormalized.has(detectedLevel)) {
      detectedToNormalized.set(detectedLevel, normalizedLevel);
    }

    levelsByNodeId.set(node.id, normalizedLevel);
    maxNormalizedLevel = Math.max(maxNormalizedLevel, normalizedLevel);

    if (normalizedLevel !== detectedLevel) {
      adjustments.push({
        nodeId: node.id,
        text: node.text,
        from: `H${detectedLevel}`,
        to: `H${normalizedLevel}`
      });
    }
  }

  return {
    levelsByNodeId,
    summary: {
      applied: adjustments.length > 0,
      totalHeadingCount,
      adjustedHeadingCount: adjustments.length,
      firstDetectedHeading: firstHeadingLevel ? `H${firstHeadingLevel}` : null,
      maxNormalizedHeading: maxNormalizedLevel ? `H${maxNormalizedLevel}` : null,
      adjustments
    }
  };
}

function resolveTagRole(node, headingNormalization) {
  const normalizedHeadingLevel = headingNormalization.levelsByNodeId.get(node.id);
  if (normalizedHeadingLevel) {
    return `H${normalizedHeadingLevel}`;
  }

  return node.role;
}

function createLeaf(node, headingNormalization) {
  const resolvedRole = resolveTagRole(node, headingNormalization);
  const leaf = {
    id: `tag:${node.id}`,
    type: resolvedRole,
    label: node.text,
    sourceNodeIds: [node.id],
    children: []
  };

  if (resolvedRole !== node.role) {
    leaf.detectedType = node.role;
    leaf.detectedHeadingLevel = getDetectedHeadingLevel(node);
  }

  if (resolvedRole === "TH" || resolvedRole === "TD") {
    const tableRowIndex = getTableRowIndex(node);
    const tableColumnIndex = getTableColumnIndex(node);

    if ((node.tableRowSpan || 1) > 1) {
      leaf.rowSpan = node.tableRowSpan;
    }
    if ((node.tableColumnSpan || 1) > 1) {
      leaf.columnSpan = node.tableColumnSpan;
    }
    if (node.tableSection) {
      leaf.tableSection = node.tableSection;
    }
    if (node.tableSource) {
      leaf.tableSource = node.tableSource;
    }
    if (Number.isInteger(tableRowIndex) && tableRowIndex >= 0) {
      leaf.tableRowIndex = tableRowIndex;
    }
    if (Number.isInteger(tableColumnIndex) && tableColumnIndex >= 0) {
      leaf.tableColumnIndex = tableColumnIndex;
    }
  }

  return leaf;
}

function getHeadingLevel(node) {
  const detectedHeadingLevel = getDetectedHeadingLevel(node);
  if (!detectedHeadingLevel) {
    return null;
  }

  return detectedHeadingLevel;
}

function createListNode(container, listIndex) {
  const listNode = {
    id: `${container.id}:list:${listIndex}`,
    type: "L",
    children: []
  };
  container.children.push(listNode);
  return listNode;
}

function getTableGroupId(node) {
  return (
    node.tableGroupId ||
    node.tableId ||
    node.tableGroup ||
    (node.role === "Table" ? node.id : null)
  );
}

function getTableRowIndex(node) {
  return node.tableRowIndex ?? node.rowIndex ?? node.tableRow ?? 0;
}

function getTableColumnIndex(node) {
  return node.tableColumnIndex ?? node.columnIndex ?? node.tableColumn ?? null;
}

function createTableNode(node, groupId) {
  return {
    id: `tag:table:${groupId}`,
    type: "Table",
    sourceNodeIds: node ? [node.id] : [],
    children: []
  };
}

function normalizeExplicitTableSectionValue(value) {
  const explicitSection = String(value || "").trim().toLowerCase();
  if (explicitSection === "head" || explicitSection === "thead" || explicitSection === "header") {
    return "head";
  }

  if (explicitSection === "foot" || explicitSection === "tfoot" || explicitSection === "footer") {
    return "foot";
  }

  if (explicitSection === "body" || explicitSection === "tbody") {
    return "body";
  }

  return null;
}

function normalizeTableSection(node) {
  const explicitSection = normalizeExplicitTableSectionValue(node.tableSection);
  if (explicitSection) {
    return explicitSection;
  }

  if (node.role === "TH" && getTableRowIndex(node) === 0) {
    return "head";
  }

  return "body";
}

function getTableSectionType(sectionKey) {
  switch (sectionKey) {
    case "head":
      return "THead";
    case "foot":
      return "TFoot";
    default:
      return "TBody";
  }
}

function createTableSectionNode(tableNode, sectionKey) {
  const sectionNode = {
    id: `${tableNode.id}:${sectionKey}`,
    type: getTableSectionType(sectionKey),
    children: []
  };
  tableNode.children.push(sectionNode);
  return sectionNode;
}

function createTableRowNode(containerNode, rowIndex) {
  const rowNode = {
    id: `${containerNode.id}:row:${rowIndex}`,
    type: "TR",
    tableRowIndex: rowIndex,
    children: []
  };
  containerNode.children.push(rowNode);
  return rowNode;
}

function isTableCellNode(node) {
  return node?.type === "TH" || node?.type === "TD";
}

function toTableCoordinate(value) {
  const coordinate = Number(value);
  return Number.isInteger(coordinate) && coordinate >= 0 ? coordinate : null;
}

function getSectionKeyFromNode(sectionNode) {
  switch (sectionNode?.type) {
    case "THead":
      return "head";
    case "TFoot":
      return "foot";
    default:
      return "body";
  }
}

function getMaxOccupiedColumn(occupiedColumns) {
  let maxColumn = -1;
  for (const column of occupiedColumns) {
    if (column > maxColumn) {
      maxColumn = column;
    }
  }
  return maxColumn;
}

function getOccupiedColumnCount(occupiedColumns) {
  return getMaxOccupiedColumn(occupiedColumns) + 1;
}

function findNextAvailableColumn(occupiedColumns, startColumn = 0) {
  let column = Math.max(0, Number(startColumn) || 0);
  while (occupiedColumns.has(column)) {
    column += 1;
  }
  return column;
}

function isRangeAvailable(occupiedColumns, startColumn, span) {
  for (let column = startColumn; column < startColumn + span; column += 1) {
    if (occupiedColumns.has(column)) {
      return false;
    }
  }
  return true;
}

function sumDeclaredColumnWidths(cells) {
  return cells.reduce((total, cell) => total + Math.max(1, Number(cell.columnSpan || 1)), 0);
}

function inferPlaceholderCellType(sectionNode, rowNode) {
  if (sectionNode?.type === "THead") {
    return "TH";
  }

  const rowCells = (rowNode?.children || []).filter(isTableCellNode);
  if (rowCells.length > 0 && rowCells.every((cell) => cell.type === "TH")) {
    return "TH";
  }

  return "TD";
}

function createPlaceholderCell(rowNode, sectionNode, rowIndex, columnIndex, type) {
  return {
    id: `${rowNode.id}:placeholder:${columnIndex}`,
    type,
    label: "",
    sourceNodeIds: [],
    synthetic: true,
    repairReason: "table-row-irregularity",
    tableSection: getSectionKeyFromNode(sectionNode),
    tableRowIndex: rowIndex,
    tableColumnIndex: columnIndex,
    children: []
  };
}

function sameChildSequence(existingChildren, replacementChildren) {
  if (existingChildren.length !== replacementChildren.length) {
    return false;
  }

  for (let index = 0; index < existingChildren.length; index += 1) {
    if (existingChildren[index] !== replacementChildren[index]) {
      return false;
    }
  }

  return true;
}

function collectOrderedTableRows(tableNode) {
  const rowEntries = [];
  let fallbackRowIndex = 0;

  for (const childNode of tableNode.children || []) {
    if (childNode?.type === "TR") {
      const firstCell = (childNode.children || []).find(isTableCellNode);
      const rowIndex =
        toTableCoordinate(childNode.tableRowIndex) ?? toTableCoordinate(firstCell?.tableRowIndex) ?? fallbackRowIndex;

      childNode.tableRowIndex = rowIndex;
      fallbackRowIndex = rowIndex + 1;
      rowEntries.push({
        sectionNode: null,
        rowNode: childNode,
        rowIndex
      });
      continue;
    }

    if (!["THead", "TBody", "TFoot"].includes(childNode.type)) {
      continue;
    }

    for (const rowNode of childNode.children || []) {
      if (rowNode.type !== "TR") {
        continue;
      }

      const firstCell = (rowNode.children || []).find(isTableCellNode);
      const rowIndex =
        toTableCoordinate(rowNode.tableRowIndex) ?? toTableCoordinate(firstCell?.tableRowIndex) ?? fallbackRowIndex;

      rowNode.tableRowIndex = rowIndex;
      fallbackRowIndex = rowIndex + 1;
      rowEntries.push({
        sectionNode: childNode,
        rowNode,
        rowIndex
      });
    }
  }

  return rowEntries;
}

function collectTableRowDescriptors(tableNode) {
  return collectOrderedTableRows(tableNode).map(({ sectionNode, rowNode, rowIndex }) => ({
    sectionNode,
    rowNode,
    rowIndex
  }));
}

function getSubstantiveTableCells(rowNode) {
  return (rowNode?.children || []).filter((cell) => {
    if (!isTableCellNode(cell)) {
      return false;
    }

    if (!cell.synthetic) {
      return true;
    }

    if ((cell.sourceNodeIds || []).length > 0) {
      return true;
    }

    return String(cell.label || "").trim().length > 0;
  });
}

function isHeaderLikeTableRow(rowNode) {
  const cells = getSubstantiveTableCells(rowNode);
  return cells.length > 0 && cells.every((cell) => cell.type === "TH");
}

function isBodyLikeTableRow(rowNode) {
  return getSubstantiveTableCells(rowNode).some((cell) => cell.type === "TD");
}

function getExplicitRowSectionKey(rowNode, currentSectionKey) {
  const explicitHints = new Set();
  const rowHint = normalizeExplicitTableSectionValue(rowNode?.tableSection);
  if (rowHint) {
    explicitHints.add(rowHint);
  }

  for (const cell of rowNode?.children || []) {
    if (!isTableCellNode(cell)) {
      continue;
    }

    const cellHint = normalizeExplicitTableSectionValue(cell.tableSection);
    if (cellHint) {
      explicitHints.add(cellHint);
    }
  }

  if (explicitHints.has("foot")) {
    return "foot";
  }

  if (explicitHints.has("head") && !explicitHints.has("body")) {
    return "head";
  }

  if (explicitHints.size === 1 && explicitHints.has("body")) {
    return "body";
  }

  return currentSectionKey;
}

function rekeyRowForSection(tableNode, rowNode, sectionKey) {
  const rowIndex = toTableCoordinate(rowNode.tableRowIndex) ?? 0;
  const nextRowId = `${tableNode.id}:${sectionKey}:row:${rowIndex}`;
  rowNode.id = nextRowId;

  for (const cell of rowNode.children || []) {
    if (!cell?.synthetic || !String(cell.id || "").includes(":placeholder:")) {
      continue;
    }

    const columnIndex = toTableCoordinate(cell.tableColumnIndex) ?? 0;
    cell.id = `${nextRowId}:placeholder:${columnIndex}`;
  }
}

function applySectionKeyToRow(rowNode, sectionKey) {
  for (const cell of rowNode.children || []) {
    if (!isTableCellNode(cell)) {
      continue;
    }

    cell.tableSection = sectionKey;
    if (sectionKey === "head" && cell.synthetic && (cell.sourceNodeIds || []).length === 0 && !String(cell.label || "").trim()) {
      cell.type = "TH";
    }
  }
}

function buildTableSectionChildren(tableNode, sectionKey, rowEntries) {
  if (rowEntries.length === 0) {
    return null;
  }

  for (const entry of rowEntries) {
    rekeyRowForSection(tableNode, entry.rowNode, sectionKey);
    applySectionKeyToRow(entry.rowNode, sectionKey);
  }

  return {
    id: `${tableNode.id}:${sectionKey}`,
    type: getTableSectionType(sectionKey),
    children: rowEntries.map((entry) => entry.rowNode)
  };
}

function normalizeTableSections(rootNode) {
  const visit = (node) => {
    if (!node) {
      return;
    }

    for (const child of node.children || []) {
      visit(child);
    }

    if (node.type !== "Table") {
      return;
    }

    const rowEntries = collectOrderedTableRows(node).map((entry) => {
      const currentSectionKey = entry.sectionNode ? getSectionKeyFromNode(entry.sectionNode) : "body";
      return {
        ...entry,
        currentSectionKey,
        assignedSectionKey: getExplicitRowSectionKey(entry.rowNode, currentSectionKey),
        headerLike: isHeaderLikeTableRow(entry.rowNode),
        bodyLike: isBodyLikeTableRow(entry.rowNode)
      };
    });

    if (rowEntries.length === 0) {
      return;
    }

    const firstBodyLikeIndex = rowEntries.findIndex((entry) => entry.bodyLike);
    if (firstBodyLikeIndex > 0) {
      for (let index = 0; index < firstBodyLikeIndex; index += 1) {
        const entry = rowEntries[index];
        if (entry.assignedSectionKey === "foot") {
          break;
        }

        if (!entry.headerLike && entry.assignedSectionKey !== "head") {
          break;
        }

        entry.assignedSectionKey = "head";
      }
    }

    const headRows = rowEntries.filter((entry) => entry.assignedSectionKey === "head");
    const bodyRows = rowEntries.filter((entry) => entry.assignedSectionKey === "body");
    const footRows = rowEntries.filter((entry) => entry.assignedSectionKey === "foot");
    const nextChildren = [];

    const headSection = buildTableSectionChildren(node, "head", headRows);
    if (headSection) {
      nextChildren.push(headSection);
    }

    const bodySection = buildTableSectionChildren(node, "body", bodyRows);
    if (bodySection) {
      nextChildren.push(bodySection);
    }

    const footSection = buildTableSectionChildren(node, "foot", footRows);
    if (footSection) {
      nextChildren.push(footSection);
    }

    node.children = nextChildren;
  };

  visit(rootNode);
}

function buildRowPlacementPlan(rowDescriptors, targetColumnCount = null) {
  const plans = [];
  let requiredColumnCount = Math.max(0, Number(targetColumnCount) || 0);
  let carry = [];

  for (const descriptor of rowDescriptors) {
    const carryColumns = new Set();
    for (let column = 0; column < carry.length; column += 1) {
      if ((carry[column] || 0) > 0) {
        carryColumns.add(column);
      }
    }

    const occupiedColumns = new Set(carryColumns);
    const rowCells = (descriptor.rowNode.children || []).filter(isTableCellNode);
    const placements = [];
    let nextAvailableColumn = findNextAvailableColumn(occupiedColumns, 0);

    for (let cellIndex = 0; cellIndex < rowCells.length; cellIndex += 1) {
      const cell = rowCells[cellIndex];
      const columnSpan = Math.max(1, Number(cell.columnSpan || 1));
      const remainingDeclaredWidth = sumDeclaredColumnWidths(rowCells.slice(cellIndex));
      const hintedColumn = toTableCoordinate(cell.tableColumnIndex);
      const maxReasonableStart = getOccupiedColumnCount(occupiedColumns) + remainingDeclaredWidth + 2;

      let startColumn =
        hintedColumn != null && hintedColumn <= maxReasonableStart ? hintedColumn : nextAvailableColumn;
      startColumn = findNextAvailableColumn(occupiedColumns, startColumn);

      while (!isRangeAvailable(occupiedColumns, startColumn, columnSpan)) {
        startColumn = findNextAvailableColumn(occupiedColumns, startColumn + 1);
      }

      placements.push({
        cell,
        startColumn,
        columnSpan
      });

      for (let column = startColumn; column < startColumn + columnSpan; column += 1) {
        occupiedColumns.add(column);
      }

      nextAvailableColumn = findNextAvailableColumn(occupiedColumns, startColumn + columnSpan);
    }

    requiredColumnCount = Math.max(requiredColumnCount, getOccupiedColumnCount(occupiedColumns));

    plans.push({
      ...descriptor,
      carryColumns,
      placements
    });

    const nextCarry = [];
    for (let column = 0; column < carry.length; column += 1) {
      const remainingRows = (carry[column] || 0) - 1;
      if (remainingRows > 0) {
        nextCarry[column] = remainingRows;
      }
    }

    for (const placement of placements) {
      const rowSpan = Math.max(1, Number(placement.cell.rowSpan || 1));
      const remainingRows = rowSpan - 1;
      if (remainingRows <= 0) {
        continue;
      }

      for (let column = placement.startColumn; column < placement.startColumn + placement.columnSpan; column += 1) {
        nextCarry[column] = Math.max(nextCarry[column] || 0, remainingRows);
      }
    }

    carry = nextCarry;
  }

  return {
    plans,
    requiredColumnCount,
    remainingCarry: carry
  };
}

function normalizeTableNode(tableNode) {
  const rowDescriptors = collectTableRowDescriptors(tableNode);
  if (rowDescriptors.length === 0) {
    tableNode.tableRegularity = {
      applied: false,
      expectedColumnCount: 0,
      repairedRowCount: 0,
      insertedPlaceholderCellCount: 0,
      insertedSyntheticRowCount: 0,
      shiftedCellCount: 0
    };
    return tableNode.tableRegularity;
  }

  const initialPlan = buildRowPlacementPlan(rowDescriptors);
  const expectedColumnCount = Math.max(1, initialPlan.requiredColumnCount);
  const normalizedPlan = buildRowPlacementPlan(rowDescriptors, expectedColumnCount);

  let repairedRowCount = 0;
  let insertedPlaceholderCellCount = 0;
  let insertedSyntheticRowCount = 0;
  let shiftedCellCount = 0;

  for (const rowPlan of normalizedPlan.plans) {
    const placeholderType = inferPlaceholderCellType(rowPlan.sectionNode, rowPlan.rowNode);
    const replacementEntries = [];
    const occupiedColumns = new Set(rowPlan.carryColumns);

    for (const placement of rowPlan.placements) {
      replacementEntries.push({
        startColumn: placement.startColumn,
        node: placement.cell,
        synthetic: false
      });

      for (let column = placement.startColumn; column < placement.startColumn + placement.columnSpan; column += 1) {
        occupiedColumns.add(column);
      }
    }

    for (let column = 0; column < expectedColumnCount; column += 1) {
      if (occupiedColumns.has(column)) {
        continue;
      }

      replacementEntries.push({
        startColumn: column,
        node: createPlaceholderCell(rowPlan.rowNode, rowPlan.sectionNode, rowPlan.rowIndex, column, placeholderType),
        synthetic: true
      });
      insertedPlaceholderCellCount += 1;
    }

    replacementEntries.sort((left, right) => left.startColumn - right.startColumn);
    const replacementChildren = replacementEntries.map((entry) => entry.node);
    let rowRepaired = replacementEntries.some((entry) => entry.synthetic);

    for (const placement of rowPlan.placements) {
      const normalizedColumnIndex = placement.startColumn;
      const previousColumnIndex = toTableCoordinate(placement.cell.tableColumnIndex);

      if (previousColumnIndex != null && previousColumnIndex !== normalizedColumnIndex) {
        shiftedCellCount += 1;
        rowRepaired = true;
      }

      placement.cell.tableRowIndex = rowPlan.rowIndex;
      placement.cell.tableColumnIndex = normalizedColumnIndex;
    }

    if (!sameChildSequence(rowPlan.rowNode.children || [], replacementChildren)) {
      rowRepaired = true;
    }

    rowPlan.rowNode.children = replacementChildren;
    rowPlan.rowNode.tableRowIndex = rowPlan.rowIndex;
    rowPlan.rowNode.tableColumnCount = expectedColumnCount;
    if (rowRepaired) {
      rowPlan.rowNode.repairReason = "table-row-irregularity";
      repairedRowCount += 1;
    }
  }

  const lastRow = rowDescriptors.at(-1);
  let trailingCarry = [...normalizedPlan.remainingCarry];
  let nextSyntheticRowIndex = (lastRow?.rowIndex ?? -1) + 1;

  while (trailingCarry.some((remainingRows) => Number(remainingRows || 0) > 0)) {
    const targetSectionNode = lastRow?.sectionNode || tableNode.children.at(-1);
    if (!targetSectionNode) {
      break;
    }

    const syntheticRow = createTableRowNode(targetSectionNode, nextSyntheticRowIndex);
    syntheticRow.synthetic = true;
    syntheticRow.repairReason = "table-rowspan-continuation";
    syntheticRow.tableColumnCount = expectedColumnCount;

    const placeholderType = inferPlaceholderCellType(targetSectionNode, lastRow?.rowNode || syntheticRow);
    const occupiedColumns = new Set();
    for (let column = 0; column < trailingCarry.length; column += 1) {
      if ((trailingCarry[column] || 0) > 0) {
        occupiedColumns.add(column);
      }
    }

    syntheticRow.children = [];
    for (let column = 0; column < expectedColumnCount; column += 1) {
      if (occupiedColumns.has(column)) {
        continue;
      }

      syntheticRow.children.push(
        createPlaceholderCell(syntheticRow, targetSectionNode, nextSyntheticRowIndex, column, placeholderType)
      );
      insertedPlaceholderCellCount += 1;
    }

    insertedSyntheticRowCount += 1;
    repairedRowCount += 1;
    nextSyntheticRowIndex += 1;
    trailingCarry = trailingCarry.map((remainingRows) => Math.max(0, Number(remainingRows || 0) - 1));
  }

  tableNode.tableColumnCount = expectedColumnCount;
  tableNode.tableRegularity = {
    applied: repairedRowCount > 0,
    expectedColumnCount,
    repairedRowCount,
    insertedPlaceholderCellCount,
    insertedSyntheticRowCount,
    shiftedCellCount
  };

  return tableNode.tableRegularity;
}

function normalizeTableRegularity(rootNode) {
  const summary = {
    applied: false,
    algorithm: "grid-normalization-v1",
    tablesInspected: 0,
    correctedTables: 0,
    repairedRowCount: 0,
    insertedPlaceholderCellCount: 0,
    insertedSyntheticRowCount: 0,
    shiftedCellCount: 0
  };

  const visit = (node) => {
    if (!node) {
      return;
    }

    if (node.type === "Table") {
      const tableSummary = normalizeTableNode(node);
      summary.tablesInspected += 1;
      summary.repairedRowCount += tableSummary.repairedRowCount;
      summary.insertedPlaceholderCellCount += tableSummary.insertedPlaceholderCellCount;
      summary.insertedSyntheticRowCount += tableSummary.insertedSyntheticRowCount;
      summary.shiftedCellCount += tableSummary.shiftedCellCount;

      if (tableSummary.applied) {
        summary.correctedTables += 1;
      }
    }

    for (const child of node.children || []) {
      visit(child);
    }
  };

  visit(rootNode);
  summary.applied = summary.correctedTables > 0;
  return summary;
}

function flattenRedundantTableBodySections(rootNode) {
  const visit = (node) => {
    if (!node) {
      return;
    }

    for (const child of node.children || []) {
      visit(child);
    }

    if (node.type !== "Table") {
      return;
    }

    const sectionChildren = (node.children || []).filter((child) =>
      ["THead", "TBody", "TFoot"].includes(child?.type)
    );

    if (sectionChildren.length !== 1 || sectionChildren[0]?.type !== "TBody") {
      return;
    }

    const [bodySection] = sectionChildren;
    node.children = (node.children || []).flatMap((child) => (child === bodySection ? bodySection.children || [] : [child]));
  };

  visit(rootNode);
}

export async function buildTagTree(inputPath) {
  const semanticDocument = JSON.parse(await readFile(inputPath, "utf8"));

  if (!validateSemantic(semanticDocument)) {
    throw new Error(`Tag builder input failed schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  const orderedNodes = semanticDocument.orderedNodeIds
    ? semanticDocument.orderedNodeIds.map((id) => semanticDocument.nodes.find((node) => node.id === id))
    : [...semanticDocument.nodes].sort((left, right) => (left.readingOrder || 0) - (right.readingOrder || 0));

  const root = {
    id: "tag:document",
    type: "Document",
    children: []
  };
  const headingNormalization = buildHeadingNormalization(orderedNodes);
  const sectionStack = [];
  let activeList = null;
  let activeTable = null;
  let listIndex = 0;

  const currentContainer = () => sectionStack.at(-1)?.node || root;

  for (const node of orderedNodes) {
    if (!node) {
      continue;
    }

    if (node.role === "Artifact") {
      activeList = null;
      activeTable = null;
      continue;
    }

    const headingLevel = getHeadingLevel(node);
    if (headingLevel) {
      const normalizedHeadingLevel = headingNormalization.levelsByNodeId.get(node.id) || headingLevel;

      while (sectionStack.length > 0 && sectionStack.at(-1).level >= normalizedHeadingLevel) {
        sectionStack.pop();
      }

      const sectionNode = {
        id: `tag:section:${node.id}`,
        type: "Sect",
        children: [createLeaf(node, headingNormalization)]
      };
      currentContainer().children.push(sectionNode);
      sectionStack.push({
        level: normalizedHeadingLevel,
        node: sectionNode
      });
      activeList = null;
      activeTable = null;
      continue;
    }

    if (node.role === "LI") {
      if (!activeList) {
        listIndex += 1;
        activeList = createListNode(currentContainer(), listIndex);
      }

      activeList.children.push(createLeaf(node, headingNormalization));
      activeTable = null;
      continue;
    }

    activeList = null;

    if (node.role === "Table") {
      const groupId = getTableGroupId(node) || node.id;
      const tableNode = createTableNode(node, groupId);
      currentContainer().children.push(tableNode);
      activeTable = {
        groupId,
        node: tableNode,
        rows: new Map()
      };
      continue;
    }

    if (node.role === "TH" || node.role === "TD") {
      const groupId = getTableGroupId(node) || `page-${node.pageNumber}-table`;
      if (!activeTable || activeTable.groupId !== groupId) {
        const tableNode = createTableNode(null, groupId);
        currentContainer().children.push(tableNode);
        activeTable = {
          groupId,
          node: tableNode,
          rows: new Map()
        };
      }

      const rowIndex = getTableRowIndex(node);
      let rowNode = activeTable.rows.get(rowIndex);
      if (!rowNode) {
        rowNode = createTableRowNode(activeTable.node, rowIndex);
        activeTable.rows.set(rowIndex, rowNode);
      }

      rowNode.children.push(createLeaf(node, headingNormalization));
      continue;
    }

    activeTable = null;
    currentContainer().children.push(createLeaf(node, headingNormalization));
  }

  normalizeTableSections(root);
  const tableRegularityCorrection = normalizeTableRegularity(root);
  normalizeTableSections(root);
  flattenRedundantTableBodySections(root);
  const taggingDocument = {
    schemaVersion: "1.0.0",
    documentId: `${semanticDocument.documentId}:tagging`,
    source: {
      semanticDocumentId: semanticDocument.documentId,
      ...(semanticDocument.source.filePath ? { filePath: semanticDocument.source.filePath } : {}),
      headingNormalization: headingNormalization.summary,
      tableRegularityCorrection
    },
    root
  };

  if (!validateTagging(taggingDocument)) {
    throw new Error(`Tag builder output failed schema validation: ${ajv.errorsText(validateTagging.errors)}`);
  }

  return taggingDocument;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: node modules/tag-builder/index.js <semantic.ordered.json>");
  }

  const result = await buildTagTree(inputPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
