import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import semanticSchema from "../../contracts/semantic.schema.json" with { type: "json" };
import taggingSchema from "../../contracts/tagging.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateSemantic = ajv.compile(semanticSchema);
const validateTagging = ajv.compile(taggingSchema);

// Feature flags for WTPDF / PDF/UA-2 additions. Default-off to
// preserve existing fixture output and keep the rewriter's /Form
// XObject handling untouched on the corpus. Each flag can be lit
// via an environment variable so integration tests can opt in
// without plumbing arguments through every call site.
function readBooleanEnv(name) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function resolveTagBuilderOptions(overrides = {}) {
  return {
    enableTitleDetection:
      overrides.enableTitleDetection ?? readBooleanEnv("TAG_BUILDER_ENABLE_TITLE"),
    enableCaptionDetection:
      overrides.enableCaptionDetection ?? readBooleanEnv("TAG_BUILDER_ENABLE_CAPTION"),
    enableSectionPromotion:
      overrides.enableSectionPromotion ?? readBooleanEnv("TAG_BUILDER_ENABLE_SECTION_PROMOTION"),
    enableLayoutAttrs:
      overrides.enableLayoutAttrs ?? readBooleanEnv("TAG_BUILDER_ENABLE_LAYOUT_ATTRS"),
    enableTableHeaders:
      overrides.enableTableHeaders ?? readBooleanEnv("TAG_BUILDER_ENABLE_TABLE_HEADERS"),
    enablePrintFieldAttrs:
      overrides.enablePrintFieldAttrs ?? readBooleanEnv("TAG_BUILDER_ENABLE_PRINT_FIELD_ATTRS"),
    captionLookbackParagraphs: Number(overrides.captionLookbackParagraphs ?? 3)
  };
}

// Heading level clamp range. PDF/UA allows H1-H6, but many docs
// don't benefit from deeper hierarchies — the defaults (1-3) keep
// output conservative for general-purpose profiles. Scientific
// papers and legal briefs with numbered subsection hierarchies
// can extend via the tagBuilder.headingLevelClamp* profile fields.
function readClampRange() {
  const min = Number(process.env.TAG_BUILDER_HEADING_LEVEL_CLAMP_MIN);
  const max = Number(process.env.TAG_BUILDER_HEADING_LEVEL_CLAMP_MAX);
  return {
    min: Number.isFinite(min) && min >= 1 && min <= 6 ? min : 1,
    max: Number.isFinite(max) && max >= 1 && max <= 6 ? max : 3
  };
}

function clampHeadingLevel(level) {
  const { min, max } = readClampRange();
  return Math.max(min, Math.min(Number(level) || min, max));
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

  // Set /ActualText on the innermost MCID-bearing element (Span child
  // when wrapping, leaf itself otherwise). Adobe's Accessibility Full
  // Check flags "Nested alternate text" (PDF/UA Matterhorn 19-003)
  // when /ActualText appears on both parent and child — the outer
  // one is never read. For wrapping roles (P/H#/Caption/Title/Code),
  // /ActualText lives on the Span child below; for direct-MCID roles
  // (TH/TD/LI/Lbl/LBody) it lives on the leaf itself.
  const hasTextContent = typeof node.text === "string" && node.text.trim().length > 0;
  const directMcidLeaf = ["TH", "TD", "LI", "Lbl", "LBody"].includes(resolvedRole);
  if (directMcidLeaf && hasTextContent) {
    leaf.actualText = node.text;
  }

  // Block-level structural roles (P, H#, Caption, Title, Code) — wrap
  // their MCID content in a Span child. Adobe's Tags panel derives the
  // tag-row preview text from the element's direct marked-content
  // descendants; when the MCID lives under a /Span intermediary, Adobe
  // shows the text, while a bare /P with a direct MCID kid can leave
  // the preview blank (observed on scanned PDFs with invisible-text
  // layers). Table cells (TH/TD), list items (LI, Lbl, LBody) and
  // inline roles keep their direct MCID layout — Adobe's table and
  // list views already render their cell/item text correctly.
  const wrapInSpan = ["P", "H1", "H2", "H3", "H4", "H5", "H6", "Caption", "Title", "Code"].includes(resolvedRole);
  if (wrapInSpan) {
    leaf.sourceNodeIds = [];
    const spanChild = {
      id: `tag:${node.id}:span`,
      type: "Span",
      label: node.text,
      sourceNodeIds: [node.id],
      children: []
    };
    if (hasTextContent) {
      spanChild.actualText = node.text;
    }
    leaf.children.push(spanChild);
  }

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

// ---- List marker helpers (Item 9: Lbl/LBody) ----------------------------

function inferListMarker(node) {
  if (node.listMarker) return String(node.listMarker);
  const text = String(node.text || "").trimStart();
  const bullet = /^([•◦▪▸‣–—]|\*|-)\s+/.exec(text);
  if (bullet) return bullet[1];
  const ordered = /^(\d+[.)]\s*|[a-z][.)]\s*|[ivxlcdm]+[.)]\s*)/i.exec(text);
  if (ordered) return ordered[1].trimEnd();
  return null;
}

function inferListNumbering(node) {
  const style = String(node.listStyle || "");
  const marker = String(node.listMarker || node.text || "").trimStart();
  if (/^\d+[.)]/.test(marker) || style === "ordered") return "Decimal";
  if (/^[a-z][.)]/.test(marker)) return "LowerAlpha";
  if (/^[A-Z][.)]/.test(marker)) return "UpperAlpha";
  if (/^[ivxlcdm]+[.)]/i.test(marker) && !/^\d/.test(marker)) return "LowerRoman";
  if (/^[•◦▪▸‣]/.test(marker) || /^[-*]\s/.test(marker) || style === "unordered") return "Disc";
  return null;
}

function createLiLeaf(node, headingNormalization) {
  const fullText = String(node.text || "");
  const marker = inferListMarker(node);

  // Escape special regex chars so we can strip the marker safely.
  let bodyText = fullText;
  if (marker) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = fullText.replace(new RegExp(`^${escaped}\\s*`), "").trim();
    if (stripped.length > 0) bodyText = stripped;
  }

  const hasMarkerAndBody = marker && bodyText !== fullText && bodyText.length > 0;

  const liNode = {
    id: `tag:${node.id}`,
    type: "LI",
    sourceNodeIds: [],
    children: []
  };

  if (hasMarkerAndBody) {
    // PDF/UA: LI must contain Lbl (marker) and LBody (content).
    liNode.children.push({
      id: `tag:${node.id}:lbl`,
      type: "Lbl",
      label: marker,
      actualText: marker,
      sourceNodeIds: [node.id],
      children: []
    });
    liNode.children.push({
      id: `tag:${node.id}:lbody`,
      type: "LBody",
      label: bodyText,
      actualText: bodyText,
      sourceNodeIds: [node.id],
      children: []
    });
  } else {
    // No detectable marker — emit LI directly with MCID (backward-compat).
    liNode.sourceNodeIds = [node.id];
    if (fullText.trim().length > 0) {
      liNode.actualText = fullText;
    }
  }

  return liNode;
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

function isAllUppercaseText(rowNode) {
  const cells = getSubstantiveTableCells(rowNode);
  if (cells.length === 0) {
    return false;
  }

  const textContent = cells.map((cell) => String(cell.label || "").trim()).join(" ");
  if (!textContent) {
    return false;
  }

  const letters = textContent.replace(/[^a-zA-Z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
}

function getThFraction(rowNode) {
  const cells = getSubstantiveTableCells(rowNode);
  if (cells.length === 0) {
    return 0;
  }

  const thCount = cells.filter((cell) => cell.type === "TH").length;
  return thCount / cells.length;
}

function isHeaderLikeTableRow(rowNode, rowIndex = null) {
  const cells = getSubstantiveTableCells(rowNode);
  if (cells.length === 0) {
    return false;
  }

  if (cells.every((cell) => cell.type === "TH")) {
    return true;
  }

  if (rowIndex != null && rowIndex < 2 && getThFraction(rowNode) >= 0.75) {
    return true;
  }

  if (rowIndex === 0 && isAllUppercaseText(rowNode)) {
    return true;
  }

  return false;
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

function isRowHeaderPattern(rowEntries) {
  if (rowEntries.length < 2) {
    return false;
  }

  return rowEntries.every((entry) => {
    const cells = (entry.rowNode.children || []).filter(isTableCellNode);
    if (cells.length < 2) {
      return false;
    }

    const firstCell = cells[0];
    const restCells = cells.slice(1);
    return firstCell.type === "TH" && restCells.every((cell) => cell.type === "TD");
  });
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
      const headerLike = isHeaderLikeTableRow(entry.rowNode, entry.rowIndex);
      return {
        ...entry,
        currentSectionKey,
        assignedSectionKey: getExplicitRowSectionKey(entry.rowNode, currentSectionKey),
        headerLike,
        bodyLike: headerLike ? false : isBodyLikeTableRow(entry.rowNode)
      };
    });

    if (rowEntries.length === 0) {
      return;
    }

    const rowHeaderOnly = isRowHeaderPattern(rowEntries);

    const firstBodyLikeIndex = rowEntries.findIndex((entry) => entry.bodyLike);
    if (firstBodyLikeIndex > 0 && !rowHeaderOnly) {
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

    // PDF/UA § 7.2.14 (Matterhorn 14-003): a Table with /THead kid
    // must also have /TBody. If we end up with THead but no TBody
    // (e.g. 1-row table all classified as header), unwrap the THead
    // and leave TR as a direct Table child instead. Avoids emitting
    // a structurally invalid Table > THead-only tree.
    const nextChildren = [];
    const bodySection = buildTableSectionChildren(node, "body", bodyRows);
    const footSection = buildTableSectionChildren(node, "foot", footRows);
    const headSection = buildTableSectionChildren(node, "head", headRows);

    if (headSection && !bodySection) {
      // No body — unwrap THead's TRs as direct Table children.
      for (const trNode of headSection.children || []) {
        nextChildren.push(trNode);
      }
    } else if (headSection) {
      nextChildren.push(headSection);
    }

    if (bodySection) {
      nextChildren.push(bodySection);
    }

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

function validateTableSections(rootNode) {
  let tableStructureRepairs = 0;

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

    for (const section of node.children || []) {
      if (section.type !== "THead") {
        continue;
      }

      for (const row of section.children || []) {
        if (row.type !== "TR") {
          continue;
        }

        for (const cell of row.children || []) {
          if (cell.type === "TD") {
            cell.type = "TH";
            cell.promotedFromTD = true;
            tableStructureRepairs += 1;
          }
        }
      }
    }
  };

  visit(rootNode);
  return tableStructureRepairs;
}

function getRowCellSignature(rowNode) {
  const cells = (rowNode?.children || []).filter(isTableCellNode);
  return cells.map((cell) => {
    const span = Math.max(1, Number(cell.columnSpan || 1));
    return `${cell.type}:${span}`;
  }).join("|");
}

function detectRepeatedHeaders(rootNode) {
  let repeatedHeaderRows = 0;

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

    let headSection = null;
    let bodySection = null;

    for (const section of node.children || []) {
      if (section.type === "THead" && !headSection) {
        headSection = section;
      }

      if (section.type === "TBody" && !bodySection) {
        bodySection = section;
      }
    }

    if (!headSection || !bodySection) {
      return;
    }

    const headRows = (headSection.children || []).filter((row) => row.type === "TR");
    const bodyRows = (bodySection.children || []).filter((row) => row.type === "TR");
    if (headRows.length === 0 || bodyRows.length < headRows.length) {
      return;
    }

    const headSignatures = headRows.map(getRowCellSignature);

    for (let offset = 0; offset <= bodyRows.length - headRows.length; offset += 1) {
      const candidateSignatures = bodyRows
        .slice(offset, offset + headRows.length)
        .map(getRowCellSignature);

      const isMatch = headSignatures.every((sig, index) => sig === candidateSignatures[index]);
      if (!isMatch) {
        continue;
      }

      const headLabels = headRows.flatMap((row) =>
        (row.children || []).filter(isTableCellNode).map((cell) => String(cell.label || "").trim())
      );
      const candidateLabels = bodyRows
        .slice(offset, offset + headRows.length)
        .flatMap((row) =>
          (row.children || []).filter(isTableCellNode).map((cell) => String(cell.label || "").trim())
        );

      const labelsMatch = headLabels.length === candidateLabels.length &&
        headLabels.every((label, index) => label === candidateLabels[index]);

      if (labelsMatch) {
        for (let rowIndex = offset; rowIndex < offset + headRows.length; rowIndex += 1) {
          bodyRows[rowIndex].repeatedHeader = true;
          repeatedHeaderRows += 1;
        }
      }
    }
  };

  visit(rootNode);
  return repeatedHeaderRows;
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

// ---- A5: Title vs first H1 detection -----------------------------------
// WTPDF / PDF/UA-2 prefer `/Title` for the document title as a struct
// element distinct from /Info /Title metadata. Heuristic: the first
// heading candidate, on page 1, whose font-size is the largest among
// page-1 heading candidates and whose text length is ≤ 12 words, is
// promoted to Title. All subsequent headings remain H#.
function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter((word) => word.length > 0).length;
}

function getNodeFontSize(node) {
  if (node == null) return 0;
  const candidates = [node.fontSize, node.maxFontSize, node.meanFontSize];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  // Fall back to bbox height as a proxy for font size — ordering is
  // what matters for the "largest on page 1" test, and all heading
  // candidates on the page are compared with the same proxy.
  const bbox = Array.isArray(node.bbox) ? node.bbox : null;
  if (bbox && bbox.length >= 4) {
    const height = Number(bbox[3]);
    if (Number.isFinite(height) && height > 0) return height;
  }
  return 0;
}

function detectTitleNodeId(orderedNodes) {
  const page1Candidates = [];
  for (const node of orderedNodes) {
    if (!node) continue;
    if (node.pageNumber !== 1) break;
    if (!getDetectedHeadingLevel(node)) continue;
    page1Candidates.push(node);
  }
  if (page1Candidates.length === 0) return null;

  const first = page1Candidates[0];
  const firstSize = getNodeFontSize(first);
  const maxSize = page1Candidates.reduce((acc, candidate) => {
    const size = getNodeFontSize(candidate);
    return size > acc ? size : acc;
  }, 0);
  if (firstSize <= 0 || firstSize < maxSize) return null;
  if (countWords(first.text) > 12) return null;
  return first.id;
}

// ---- A6: Caption detection --------------------------------------------
// Matches "Figure 1: …", "Table 3. …", "Fig. 2 …", "Tab. 4: …", etc.
const CAPTION_PATTERN = /^(Figure|Table|Fig\.|Tab\.)\s+\d+[\.:]?\s/i;

function isCaptionCandidate(node) {
  if (!node || node.role !== "P") return false;
  const text = String(node.text || "").trim();
  if (!text) return false;
  return CAPTION_PATTERN.test(text);
}

// ---- A14: Layout attribute owner --------------------------------------
function placementForType(type) {
  if (type === "Span") return "Inline";
  if (type === "Start") return "Start";
  if (type === "End") return "End";
  if (type === "Before") return "Before";
  return "Block";
}

function layoutEligibleType(type) {
  if (!type) return false;
  if (type === "P" || type === "Caption" || type === "Aside" || type === "BlockQuote") return true;
  if (/^H[1-6]$/.test(type)) return true;
  return false;
}

function computeLayoutAttrs(node, tagType) {
  if (!node) return null;
  const bbox = Array.isArray(node.bbox) ? node.bbox : null;
  if (!bbox || bbox.length < 4) return null;
  const [x, y, width, height] = bbox.map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return {
    O: "Layout",
    Placement: placementForType(tagType),
    BBox: [x, y, width, height]
  };
}

function applyLayoutAttrsToTree(node, sourceNodesById) {
  if (!node) return;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) applyLayoutAttrsToTree(child, sourceNodesById);
  if (!layoutEligibleType(node.type)) return;
  // Look up the source semantic node either via this node's own
  // sourceNodeIds OR (if this is a block leaf that wraps its MCID in a
  // Span child) via the child Span's sourceNodeIds. Layout attrs
  // (BBox etc.) belong on the outer block element, not the inline
  // Span.
  let sourceId = (node.sourceNodeIds || [])[0];
  if (!sourceId) {
    for (const child of children) {
      if (child?.type === "Span" && (child.sourceNodeIds || []).length > 0) {
        sourceId = child.sourceNodeIds[0];
        break;
      }
    }
  }
  const sourceNode = sourceId ? sourceNodesById.get(sourceId) : null;
  const attrs = computeLayoutAttrs(sourceNode, node.type);
  if (attrs) node.layoutAttrs = attrs;
}

// ---- A15: Table /Headers + ColSpan/RowSpan ----------------------------
function assignHeaderIdsAndTableAttrs(rootNode) {
  const decorateTable = (tableNode) => {
    // Step 1: walk the table subtree, marking which TH/TD cells
    // live inside a THead ancestor — they act as column headers.
    const thCells = [];
    const annotate = (n, inHead) => {
      if (!n) return;
      const nextInHead = inHead || n.type === "THead";
      if (n.type === "TH" || n.type === "TD") {
        n._inTHead = nextInHead;
        if (n.type === "TH") thCells.push(n);
      }
      for (const kid of n.children || []) annotate(kid, nextInHead);
    };
    annotate(tableNode, false);

    // Step 2: assign stable IDs to TH cells.
    let thFallback = 0;
    for (const th of thCells) {
      const rowIndex = Number.isInteger(th.tableRowIndex) ? th.tableRowIndex : thFallback;
      const columnIndex = Number.isInteger(th.tableColumnIndex) ? th.tableColumnIndex : thFallback;
      th.headerId = `H_r${rowIndex}c${columnIndex}`;
      thFallback += 1;
    }

    // Step 3: build column/row header lookups. Column headers come
    // from TH-in-THead; row headers come from TH in other contexts.
    const headersByColumn = new Map();
    const rowHeaderByRowIndex = new Map();
    for (const th of thCells) {
      const rowIndex = Number.isInteger(th.tableRowIndex) ? th.tableRowIndex : 0;
      const columnIndex = Number.isInteger(th.tableColumnIndex) ? th.tableColumnIndex : 0;
      const columnSpan = Math.max(1, Number(th.columnSpan || 1));
      const rowSpan = Math.max(1, Number(th.rowSpan || 1));
      if (th._inTHead) {
        for (let col = columnIndex; col < columnIndex + columnSpan; col += 1) {
          if (!headersByColumn.has(col)) headersByColumn.set(col, []);
          headersByColumn.get(col).push(th.headerId);
        }
      } else {
        for (let row = rowIndex; row < rowIndex + rowSpan; row += 1) {
          if (!rowHeaderByRowIndex.has(row)) rowHeaderByRowIndex.set(row, []);
          rowHeaderByRowIndex.get(row).push(th.headerId);
        }
      }
    }

    // Step 4: attach /Table attrs with ColSpan/RowSpan and /Headers
    // arrays on TD/TH cells that need them. Also attach /Scope on TH
    // cells (PDF/UA Matterhorn 13-004).
    const decorate = (n) => {
      if (!n) return;
      if (n.type === "TD" || n.type === "TH") {
        const cs = Math.max(1, Number(n.columnSpan || 1));
        const rs = Math.max(1, Number(n.rowSpan || 1));
        const attrs = { O: "Table" };
        let meaningful = false;
        if (cs > 1) { attrs.ColSpan = cs; meaningful = true; }
        if (rs > 1) { attrs.RowSpan = rs; meaningful = true; }
        if (n.type === "TH") {
          // Assign /Scope: Column headers live in THead, row headers elsewhere.
          // A TH that spans rows in THead (e.g. a corner cell) gets Both.
          const isColHeader = Boolean(n._inTHead);
          const spansRows = rs > 1;
          let scope;
          if (isColHeader && spansRows) {
            scope = "Both";
          } else if (isColHeader) {
            scope = "Column";
          } else {
            scope = "Row";
          }
          n.scope = scope;
        }
        if (n.type === "TD") {
          const colIdx = Number.isInteger(n.tableColumnIndex) ? n.tableColumnIndex : null;
          const rowIdx = Number.isInteger(n.tableRowIndex) ? n.tableRowIndex : null;
          const colHeaders = colIdx != null ? (headersByColumn.get(colIdx) || []) : [];
          const rowHeaders = rowIdx != null ? (rowHeaderByRowIndex.get(rowIdx) || []) : [];
          const headerIds = [...new Set([...colHeaders, ...rowHeaders])];
          if (headerIds.length > 0) {
            attrs.Headers = headerIds;
            meaningful = true;
          }
        }
        if (meaningful) n.tableAttrs = attrs;
      }
      for (const kid of n.children || []) decorate(kid);
    };
    decorate(tableNode);

    // Step 5: clean up the temporary marker so the flag doesn't
    // leak into the emitted tree.
    const cleanup = (n) => {
      if (!n) return;
      delete n._inTHead;
      for (const kid of n.children || []) cleanup(kid);
    };
    cleanup(tableNode);
  };

  const visit = (node) => {
    if (!node) return;
    if (node.type === "Table") decorateTable(node);
    for (const child of node.children || []) visit(child);
  };
  visit(rootNode);
}

// ---- #16: Section promotion for flat-P-under-Document -----------------
/**
 * Heuristic pass to undo false-positive Table classification from
 * the layout extractor. Typical culprits: scan OCR of cover pages
 * where spatial alignment looked tabular but the "cells" are really
 * fragments of a rubber-stamp date, a letterhead, or a judge's
 * signature line. Leaving these as Table/TR/TD produces:
 *   - "Blank tag" preview for Table/TR containers in Adobe's
 *     Tags panel (container tags have no direct text by design).
 *   - Screen readers announcing "table with N columns" for what is
 *     really running prose.
 *
 * Demotion criteria (ALL must hold):
 *   - ≤ 2 rows
 *   - Every cell text < 30 chars
 *   - No cell text contains a strong tabular signal (multi-digit
 *     numbers, currency, units, percent, colon-separated key:value).
 *   - No explicit Scope or header attribute pinned to cells.
 *
 * When these hold, the Table is replaced by a single P containing
 * the concatenation of cell texts in reading order. sourceNodeIds
 * are merged so downstream rewriter / validator still sees the same
 * operators. Returns count of tables demoted.
 */
function demoteSpuriousTables(rootNode) {
  let demoted = 0;

  function cellTexts(cellNode) {
    const out = [];
    const stack = [cellNode];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!n) continue;
      if (typeof n.label === "string" && n.label.trim()) out.push(n.label.trim());
      if (typeof n.text === "string" && n.text.trim()) out.push(n.text.trim());
      for (const c of n.children || []) stack.push(c);
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  }

  function sourceIds(node) {
    const out = [];
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!n) continue;
      for (const id of n.sourceNodeIds || []) out.push(id);
      for (const c of n.children || []) stack.push(c);
    }
    return out;
  }

  // Strong tabular signals — if ANY cell matches, keep it as a table.
  const TABULAR_PATTERNS = [
    /\b\d{2,}\b/,               // multi-digit number
    /\$\s*\d/,                  // currency
    /\b\d+(?:\.\d+)?\s?%/,       // percent
    /\b\d+\s*(?:kg|lb|oz|mm|cm|in|ft|m|km|hr|min|sec|USD|EUR|GBP)\b/i,
    /\b\w+:\s*\S/,               // key:value
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/ // formal date MM/DD/YYYY
  ];

  function shouldDemote(tableNode) {
    if (!tableNode || tableNode.type !== "Table") return false;
    // Gather rows (TR children), skipping THead/TBody wrappers.
    const rows = [];
    const rowStack = [...(tableNode.children || [])];
    while (rowStack.length > 0) {
      const n = rowStack.shift();
      if (!n) continue;
      if (n.type === "TR") rows.push(n);
      else if (n.type === "THead" || n.type === "TBody" || n.type === "TFoot") {
        for (const c of n.children || []) rowStack.push(c);
      }
    }
    if (rows.length === 0 || rows.length > 4) return false;
    const cellsPerRow = [];
    const allCells = [];
    for (const row of rows) {
      const cells = (row.children || []).filter(c => c.type === "TH" || c.type === "TD");
      cellsPerRow.push(cells.length);
      for (const cell of cells) allCells.push(cell);
    }
    if (allCells.length === 0) return false;
    if (allCells.length > 16) return false;
    // Any TH cells means this is intentional header tagging — keep as table.
    if (allCells.some(c => c.type === "TH")) return false;
    for (const cell of allCells) {
      const text = cellTexts(cell);
      if (text.length >= 30) return false;
      for (const re of TABULAR_PATTERNS) {
        if (re.test(text)) return false;
      }
      if (cell.scope || cell.tableAttrs) return false;
    }
    // Strong scan-artifact signal: inconsistent column counts across
    // rows (e.g. 3/4/2). Real tables keep the same column count
    // across rows. If the column count varies, it's almost certainly
    // OCR-layout misclassification.
    if (rows.length >= 2) {
      const minCells = Math.min(...cellsPerRow);
      const maxCells = Math.max(...cellsPerRow);
      if (maxCells - minCells >= 1) return true;
    }
    // Default (single-row or consistent-column small table): demote
    // since cells are all short + no tabular signals.
    return true;
  }

  function flattenToP(tableNode) {
    // Collect all cell texts in reading order.
    const rows = [];
    const rowStack = [...(tableNode.children || [])];
    while (rowStack.length > 0) {
      const n = rowStack.shift();
      if (!n) continue;
      if (n.type === "TR") rows.push(n);
      else if (n.type === "THead" || n.type === "TBody" || n.type === "TFoot") {
        for (const c of n.children || []) rowStack.push(c);
      }
    }
    const parts = [];
    for (const row of rows) {
      for (const cell of row.children || []) {
        const text = cellTexts(cell);
        if (text) parts.push(text);
      }
    }
    return {
      id: tableNode.id,
      type: "P",
      label: parts.join(" "),
      sourceNodeIds: sourceIds(tableNode),
      children: collectLeavesForDemotedTable(tableNode)
    };
  }

  // Collect all leaf-cells of the table so their MCIDs are retained
  // as children of the flattened P. Each TD's children (usually
  // inline leaves with mcRef/sourceNodeIds) become direct children
  // of the new P.
  function collectLeavesForDemotedTable(tableNode) {
    const out = [];
    const stack = [...(tableNode.children || [])];
    while (stack.length > 0) {
      const n = stack.shift();
      if (!n) continue;
      if (n.type === "TR" || n.type === "THead" || n.type === "TBody" || n.type === "TFoot") {
        for (const c of n.children || []) stack.push(c);
        continue;
      }
      if (n.type === "TD" || n.type === "TH") {
        // Move TD/TH's leaves up as children of the new P.
        for (const c of n.children || []) out.push(c);
        continue;
      }
      out.push(n);
    }
    return out;
  }

  function walk(container) {
    if (!container || !Array.isArray(container.children)) return;
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i];
      if (!child) continue;
      if (child.type === "Table" && shouldDemote(child)) {
        container.children[i] = flattenToP(child);
        demoted++;
      } else {
        walk(child);
      }
    }
  }

  walk(rootNode);
  return { applied: demoted > 0, demoted };
}

export function promoteFlatHeadingsIntoSections(rootNode) {
  if (!rootNode || !Array.isArray(rootNode.children)) return { applied: false, sectionsInserted: 0 };
  const children = rootNode.children;
  if (children.length === 0) return { applied: false, sectionsInserted: 0 };
  // Only promote when Document's direct children are flat text-level:
  // no existing Sect and at least one H#.
  const hasExistingSect = children.some((child) => child?.type === "Sect");
  if (hasExistingSect) return { applied: false, sectionsInserted: 0 };
  const hasHeading = children.some((child) => /^H[1-6]$/.test(String(child?.type || "")));
  if (!hasHeading) return { applied: false, sectionsInserted: 0 };
  // Check children are text-level: P/Figure/H#/Caption/L/Table only.
  const textLevel = new Set(["P", "Figure", "Caption", "L", "Table", "Aside", "BlockQuote", "Title"]);
  const allTextLevel = children.every((child) => {
    if (!child) return false;
    return textLevel.has(child.type) || /^H[1-6]$/.test(String(child.type || ""));
  });
  if (!allTextLevel) return { applied: false, sectionsInserted: 0 };

  const nextChildren = [];
  let currentSection = null;
  let currentLevel = null;
  let sectionsInserted = 0;
  let sectionCounter = 0;
  for (const child of children) {
    const headingMatch = /^H([1-6])$/.exec(String(child?.type || ""));
    if (headingMatch) {
      const level = Number(headingMatch[1]);
      // Close any currently-open section of equal-or-greater level
      if (currentLevel != null && level <= currentLevel && currentSection) {
        nextChildren.push(currentSection);
        currentSection = null;
        currentLevel = null;
      }
      if (currentSection == null) {
        sectionCounter += 1;
        currentSection = {
          id: `tag:document:sect:${sectionCounter}`,
          type: "Sect",
          children: [],
          syntheticSection: true
        };
        currentLevel = level;
        sectionsInserted += 1;
      }
      currentSection.children.push(child);
      continue;
    }
    if (currentSection) {
      currentSection.children.push(child);
    } else {
      nextChildren.push(child);
    }
  }
  if (currentSection) nextChildren.push(currentSection);
  rootNode.children = nextChildren;
  return { applied: sectionsInserted > 0, sectionsInserted };
}

// ---- A6: Caption association with Figure/Table ------------------------
// Walks the tree in order, identifies Caption nodes, and associates
// them with the nearest preceding Figure/Table within a configurable
// paragraph lookback. Association = move the Caption to be the first
// or last child of the semantic parent. Per the PDF Association cheat
// sheet, Caption MUST be first or last child of its semantic parent.
function associateCaptionsWithFiguresOrTables(rootNode, opts) {
  const lookback = Math.max(1, Number(opts?.captionLookbackParagraphs ?? 3));
  let associated = 0;
  let detected = 0;

  const visit = (parent) => {
    if (!parent || !Array.isArray(parent.children)) return;
    for (const child of parent.children) visit(child);
    const newChildren = [];
    for (let index = 0; index < parent.children.length; index += 1) {
      const child = parent.children[index];
      if (child?.type !== "Caption") {
        newChildren.push(child);
        continue;
      }
      detected += 1;
      // Look back through already-placed siblings for the nearest
      // Figure or Table, within the lookback window (counted over P
      // and other text-level nodes).
      let steps = 0;
      let target = null;
      for (let i = newChildren.length - 1; i >= 0 && steps < lookback; i -= 1) {
        const prior = newChildren[i];
        if (prior?.type === "Figure" || prior?.type === "Table") {
          target = prior;
          break;
        }
        if (prior?.type === "P") steps += 1;
      }
      if (!target) {
        newChildren.push(child);
        continue;
      }
      // Attach as last child of the semantic parent.
      target.children = Array.isArray(target.children) ? target.children : [];
      target.children.push(child);
      associated += 1;
    }
    parent.children = newChildren;
  };
  visit(rootNode);
  return { detected, associated };
}

// ---- A16: PrintField attribute owner for widgets ----------------------
export function buildPrintFieldAttrs(widget) {
  if (!widget) return null;
  const subtype = String(widget.widgetSubtype || widget.subtype || "").toLowerCase();
  let role = "TV";
  if (subtype.includes("radio")) role = "RB";
  else if (subtype.includes("check")) role = "CB";
  else if (subtype.includes("push") || subtype === "btn" || subtype === "button") role = "PB";
  else if (subtype.includes("text")) role = "TV";
  const desc =
    (typeof widget.tooltip === "string" && widget.tooltip) ||
    (typeof widget.TU === "string" && widget.TU) ||
    (typeof widget.alternateName === "string" && widget.alternateName) ||
    (typeof widget.fieldName === "string" && widget.fieldName) ||
    (typeof widget.name === "string" && widget.name) ||
    "Form field";
  return { O: "PrintField", Role: role, Desc: desc };
}

export function resolveOrderedNodes(semanticDocument) {
  if (semanticDocument.orderedNodeIds) {
    const nodesById = new Map();
    for (const node of semanticDocument.nodes || []) {
      if (!nodesById.has(node.id)) {
        nodesById.set(node.id, node);
      }
    }

    return semanticDocument.orderedNodeIds.map((id) => nodesById.get(id));
  }

  return [...semanticDocument.nodes].sort((left, right) => (left.readingOrder || 0) - (right.readingOrder || 0));
}

export async function buildTagTree(inputPath, overrides = {}) {
  const semanticDocument = JSON.parse(await readFile(inputPath, "utf8"));

  if (!validateSemantic(semanticDocument)) {
    throw new Error(`Tag builder input failed schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  const options = resolveTagBuilderOptions(overrides);
  const orderedNodes = resolveOrderedNodes(semanticDocument);

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

  // A5: identify which heading should be emitted as Title (if any).
  const titleNodeId = options.enableTitleDetection ? detectTitleNodeId(orderedNodes) : null;
  let titleEmitted = false;
  let captionCandidatesDetected = 0;

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
      // A5: promote detected title heading to a Title struct element.
      if (options.enableTitleDetection && !titleEmitted && node.id === titleNodeId) {
        const titleLeaf = {
          id: `tag:${node.id}`,
          type: "Title",
          label: node.text,
          sourceNodeIds: [node.id],
          children: []
        };
        // Emit Title as a direct child of Document — do not open a
        // Sect for it. Subsequent Sects will follow.
        root.children.push(titleLeaf);
        titleEmitted = true;
        activeList = null;
        activeTable = null;
        continue;
      }

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
        const listNumbering = inferListNumbering(node);
        if (listNumbering) {
          activeList.listNumbering = listNumbering;
        }
      }

      activeList.children.push(createLiLeaf(node, headingNormalization));
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
    const leaf = createLeaf(node, headingNormalization);
    // A6: promote Figure/Table caption-like paragraphs to /Caption.
    if (options.enableCaptionDetection && isCaptionCandidate(node)) {
      captionCandidatesDetected += 1;
      leaf.type = "Caption";
      leaf.detectedType = leaf.detectedType || "P";
    }
    currentContainer().children.push(leaf);
  }

  normalizeTableSections(root);
  const tableRegularityCorrection = normalizeTableRegularity(root);
  normalizeTableSections(root);
  const tableStructureRepairs = validateTableSections(root);
  const repeatedHeaderRows = detectRepeatedHeaders(root);
  flattenRedundantTableBodySections(root);

  // A6: associate captions with nearest preceding Figure/Table.
  let captionAssociation = { detected: captionCandidatesDetected, associated: 0 };
  if (options.enableCaptionDetection) {
    const association = associateCaptionsWithFiguresOrTables(root, options);
    captionAssociation = {
      detected: Math.max(captionCandidatesDetected, association.detected),
      associated: association.associated
    };
  }

  // Demote spurious tables before further post-processing. Scanned
  // cover pages and rubber-stamp overlays produce TDs whose "rows"
  // are fragments with no columnar structure (date stamps, letter-
  // heads, judge signatures). Adobe's Tags panel shows the Table+TR
  // containers with empty text preview ("blank tags"), and screen
  // readers announce them as tables when they're really prose.
  // Heuristic: a Table with ≤2 rows, ≤4 cells per row, cell text
  // length <30 chars each, and no numeric/unit/currency patterns in
  // any cell → flatten into a single P containing the concatenated
  // text. Always-on — never demotes real tables because real tables
  // have multiple rows OR numeric/unit cells OR long cell text.
  const tableDemotion = demoteSpuriousTables(root);

  // #16: promote flat H# children under Document into Sect wrappers.
  const sectionPromotion = options.enableSectionPromotion
    ? promoteFlatHeadingsIntoSections(root)
    : { applied: false, sectionsInserted: 0 };

  // A15: attach /Table attrs (ColSpan/RowSpan/Headers) to cells.
  if (options.enableTableHeaders) {
    assignHeaderIdsAndTableAttrs(root);
  }

  // A14: attach /Layout attrs to positional elements.
  if (options.enableLayoutAttrs) {
    const sourceNodesById = new Map();
    for (const semanticNode of semanticDocument.nodes || []) {
      if (!sourceNodesById.has(semanticNode.id)) {
        sourceNodesById.set(semanticNode.id, semanticNode);
      }
    }
    applyLayoutAttrsToTree(root, sourceNodesById);
  }

  const taggingDocument = {
    schemaVersion: "1.0.0",
    documentId: `${semanticDocument.documentId}:tagging`,
    source: {
      semanticDocumentId: semanticDocument.documentId,
      ...(semanticDocument.source.filePath ? { filePath: semanticDocument.source.filePath } : {}),
      headingNormalization: headingNormalization.summary,
      tableRegularityCorrection,
      tableStructureRepairs,
      repeatedHeaderRows,
      ...(options.enableTitleDetection ? { titleDetection: { applied: titleEmitted, nodeId: titleEmitted ? titleNodeId : null } } : {}),
      ...(options.enableCaptionDetection ? { captionAssociation } : {}),
      ...(options.enableSectionPromotion ? { sectionPromotion } : {}),
      ...(options.enableLayoutAttrs ? { layoutAttrs: { applied: true } } : {}),
      ...(options.enableTableHeaders ? { tableHeadersAttrs: { applied: true } } : {}),
      ...(options.enablePrintFieldAttrs ? { printFieldAttrs: { applied: true } } : {})
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
