import { attachWidgetOwnership } from "./widget-ownership.js";
import { associateCaptions } from "./captions.js";
import Ajv2020 from "ajv/dist/2020.js";
import { attachOcrSegments } from "./ocr-segments.js";
import { planTableGrid, tableGridReview, mergeDeclaredCellFragments } from "./table-grid.js";
import { assignTableHeaders } from "./table-headers.js";
import { appendTableCell, partitionTableSections, markRepeatedTableHeaders } from "./table-continuation.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import semanticSchema from "../../contracts/semantic.schema.json" with { type: "json" };
import taggingSchema from "../../contracts/tagging.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateSemantic = ajv.compile(semanticSchema);
const validateTagging = ajv.compile(taggingSchema);

// Feature flags for optional structure additions. Table header associations are
// enabled by default; callers may explicitly disable them. Other additions default off to
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
      overrides.enableTableHeaders ?? (process.env.TAG_BUILDER_ENABLE_TABLE_HEADERS == null || process.env.TAG_BUILDER_ENABLE_TABLE_HEADERS === "" ? true : readBooleanEnv("TAG_BUILDER_ENABLE_TABLE_HEADERS")),
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
    max: Number.isFinite(max) && max >= 1 && max <= 6 ? max : 6
  };
}

function clampHeadingLevel(level) {
  const { min, max } = readClampRange();
  return Math.max(min, Math.min(Number(level) || min, max));
}

function getDetectedHeadingLevel(node) {
  // Final semantic membership and rank are authoritative. Old detection metadata
  // must not resurrect demoted headings or undo a corrected rank.
  if (!/^H[1-6]$/.test(node.role || "")) {
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
  if (node.semanticRole === "Caption") return "Caption";
  const normalizedHeadingLevel = headingNormalization.levelsByNodeId.get(node.id);
  if (normalizedHeadingLevel) {
    return `H${normalizedHeadingLevel}`;
  }

  if (node.semanticRole === "Footnote" || node.footnote === true || node.footnoteGroupId) {
    return "Aside";
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

  // Replacement text belongs on the content Span, not the table cell:
  // readers may otherwise replace the TH/TD semantics with plain text.
  // Never duplicate ActualText on both the container and its content.
  const hasTextContent = typeof node.text === "string" && node.text.trim().length > 0;
  const directMcidLeaf = ["LI", "Lbl", "LBody", "Aside"].includes(resolvedRole);
  if (directMcidLeaf && hasTextContent) {
    leaf.actualText = node.text;
  }

  // Block-level structural roles and table cells — wrap
  // their MCID content in a Span child. Adobe's Tags panel derives the
  // tag-row preview text from the element's direct marked-content
  // descendants; when the MCID lives under a /Span intermediary, Adobe
  // shows the text, while a bare /P with a direct MCID kid can leave
  // the preview blank (observed on scanned PDFs with invisible-text
  // layers). Header IDs, Scope, spans and Headers remain on the TH/TD.
  const wrapInSpan = ["P", "H1", "H2", "H3", "H4", "H5", "H6", "Caption", "Title", "Code", "TH", "TD"].includes(resolvedRole);
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

  if (resolvedRole === "Aside" && node.footnoteGroupId) {
    leaf.semanticRole = "Footnote";
    leaf.footnoteGroupId = node.footnoteGroupId;
    if (node.footnoteMarker) {
      leaf.footnoteMarker = node.footnoteMarker;
    }
  }

  if (resolvedRole === "TH" || resolvedRole === "TD") {
    if (["Row", "Column", "Both"].includes(node.scope)) leaf.scope = node.scope;
    const tableRowIndex = getTableRowIndex(node);
    const tableColumnIndex = getTableColumnIndex(node);

    if (node.tableRowSpan !== undefined && node.tableRowSpan !== 1) {
      leaf.rowSpan = node.tableRowSpan;
    }
    if (node.tableColumnSpan !== undefined && node.tableColumnSpan !== 1) {
      leaf.columnSpan = node.tableColumnSpan;
    }
    if (node.tableSection) {
      leaf.tableSection = node.tableSection;
    }
    if (node.tableSource) {
      leaf.tableSource = node.tableSource;
    }
    if (tableRowIndex != null) {
      leaf.tableRowIndex = tableRowIndex;
    }
    if (tableColumnIndex != null) {
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
  const bullet = /^([•◦▪▸‣–—☐☑☒]|\*|-)\s+/.exec(text);
  if (bullet) return bullet[1];
  const ordered = /^(\d+[.)]\s*|[a-z][.)]\s*|[ivxlcdm]+[.)]\s*)/i.exec(text);
  if (ordered) return ordered[1].trimEnd();
  return null;
}

function inferListNumbering(node) {
  const style = String(node.listStyle || "");
  const marker = String(node.listMarker || node.text || "").trimStart();
  if (/^\d+[.)]/.test(marker)) return "Decimal";
  const roman = /^([ivxlcdm]+)[.)]/i.exec(marker);
  if (roman && (roman[1].length > 1 || /^[ivx]$/i.test(roman[1]))) return roman[1] === roman[1].toUpperCase() ? "UpperRoman" : "LowerRoman";
  if (/^[a-z][.)]/.test(marker)) return "LowerAlpha";
  if (/^[A-Z][.)]/.test(marker)) return "UpperAlpha";
  if (style === "ordered") return "Decimal";
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
      sourceNodeIds: [],
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
  if (value == null) return null;
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

function createPlaceholderCell(rowNode, sectionNode, rowIndex, columnIndex) {
  return {
    id: `${rowNode.id}:placeholder:${columnIndex}`,
    // A gap maintains the table grid; it has no header meaning, even in THead.
    type: "TD",
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

    if (node.type !== "Table" || node.tableGridReview) {
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

    const { headRows, bodyRows, footRows } = partitionTableSections(rowEntries);

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

  const normalizedPlan = planTableGrid(rowDescriptors);
  if (normalizedPlan.issues.length) {
    tableNode.tableGridReview = tableGridReview(tableNode.id, normalizedPlan.issues);
    return { applied: false, expectedColumnCount: 0, repairedRowCount: 0,
      insertedPlaceholderCellCount: 0, insertedSyntheticRowCount: 0, shiftedCellCount: 0 };
  }
  const expectedColumnCount = Math.max(1, normalizedPlan.requiredColumnCount);

  let repairedRowCount = 0;
  let insertedPlaceholderCellCount = 0;
  let insertedSyntheticRowCount = 0;
  let shiftedCellCount = 0;

  for (const rowPlan of normalizedPlan.plans) {
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
        node: createPlaceholderCell(rowPlan.rowNode, rowPlan.sectionNode, rowPlan.rowIndex, column),
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
    const targetSectionNode = lastRow?.sectionNode || tableNode;
    if (!targetSectionNode) {
      break;
    }

    const syntheticRow = createTableRowNode(targetSectionNode, nextSyntheticRowIndex);
    syntheticRow.synthetic = true;
    syntheticRow.repairReason = "table-rowspan-continuation";
    syntheticRow.tableColumnCount = expectedColumnCount;

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
        createPlaceholderCell(syntheticRow, targetSectionNode, nextSyntheticRowIndex, column)
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
      if (node.tableGridReview) (summary.reviews ||= []).push(node.tableGridReview);
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

const TRAILING_TABLE_VALUE_RE =
  /^(.*\S)\s+(-?(?:[$£€¥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|million|billion|thousand))?)$/i;

function splitTrailingTableValue(label) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  const match = TRAILING_TABLE_VALUE_RE.exec(text);
  if (!match) {
    return null;
  }

  const leftText = match[1].trim();
  const valueText = match[2].trim();
  if (!/[A-Za-z]/.test(leftText)) {
    return null;
  }

  if (!/[$£€¥%]|\b(?:million|billion|thousand)\b/i.test(valueText)) {
    return null;
  }

  return { leftText, valueText };
}

function setCellLabel(cell, label) {
  cell.label = label;
  if (cell.actualText) {
    cell.actualText = label;
  }

  for (const child of cell.children || []) {
    if (child?.actualText) {
      child.actualText = label;
    }
    if (typeof child?.label === "string") {
      child.label = label;
    }
  }
}

function createSplitValueCell(sourceCell, rowNode, columnIndex, valueText) {
  const id = `${sourceCell.id}:split:${columnIndex}`;
  return {
    id,
    type: sourceCell.type,
    label: valueText,
    sourceNodeIds: [],
    children: [{ id: `${id}:span`, type: "Span", label: valueText, actualText: valueText, sourceNodeIds: [], children: [] }],
    synthetic: true,
    repairReason: "split-merged-table-cell",
    splitFromCellId: sourceCell.id,
    tableSection: sourceCell.tableSection,
    tableSource: sourceCell.tableSource,
    tableRowIndex: toTableCoordinate(rowNode.tableRowIndex) ?? toTableCoordinate(sourceCell.tableRowIndex) ?? 0,
    tableColumnIndex: columnIndex
  };
}

function isEmptySyntheticCell(cell) {
  return (
    isTableCellNode(cell) &&
    cell.synthetic === true &&
    String(cell.label || "").trim() === "" &&
    (cell.sourceNodeIds || []).length === 0
  );
}

function repairMergedTableTextCells(rootNode) {
  const summary = {
    applied: false,
    splitCellCount: 0,
    filledPlaceholderCount: 0,
    insertedCellCount: 0
  };

  const repairRow = (rowNode) => {
    const children = rowNode.children || [];
    for (let index = 0; index < children.length; index += 1) {
      const cell = children[index];
      if (!isTableCellNode(cell) || cell.type !== "TD" || cell.mergedCellIds) {
        continue;
      }

      if (isEmptySyntheticCell(cell) && index > 0) {
        const previous = children[index - 1];
        if (!isTableCellNode(previous) || previous.type !== "TD") {
          continue;
        }

        const split = splitTrailingTableValue(previous.label);
        if (!split) {
          continue;
        }

        setCellLabel(previous, split.leftText);
        setCellLabel(cell, split.valueText);
        cell.children = [{ id: `${cell.id}:span`, type: "Span", label: split.valueText, actualText: split.valueText, sourceNodeIds: [], children: [] }];
        cell.repairReason = "split-merged-table-cell";
        cell.splitFromCellId = previous.id;
        summary.splitCellCount += 1;
        summary.filledPlaceholderCount += 1;
        continue;
      }

      const columnSpan = Math.max(1, Number(cell.columnSpan || 1));
      if (columnSpan <= 1) {
        continue;
      }

      const split = splitTrailingTableValue(cell.label);
      if (!split) {
        continue;
      }

      const startColumn = toTableCoordinate(cell.tableColumnIndex) ?? index;
      const valueColumn = startColumn + columnSpan - 1;
      const valueCell = createSplitValueCell(cell, rowNode, valueColumn, split.valueText);
      setCellLabel(cell, split.leftText);
      cell.columnSpan = columnSpan - 1;
      if (cell.columnSpan <= 1) {
        delete cell.columnSpan;
      }
      children.splice(index + 1, 0, valueCell);
      index += 1;
      summary.splitCellCount += 1;
      summary.insertedCellCount += 1;
    }
  };

  const visit = (node) => {
    if (!node || node.tableGridReview) {
      return;
    }

    if (node.type === "TR") {
      repairRow(node);
    }

    for (const child of node.children || []) {
      visit(child);
    }
  };

  visit(rootNode);
  summary.applied = summary.splitCellCount > 0;
  return summary;
}

function detectRepeatedHeaders(rootNode) {
  let count = 0;
  const visit = node => {
    if (node.type === "Table" && !node.tableGridReview) count += markRepeatedTableHeaders(collectTableRowDescriptors(node));
    for (const child of node.children || []) visit(child);
  };
  visit(rootNode);
  return count;
}

function flattenRedundantTableBodySections(rootNode) {
  const visit = (node) => {
    if (!node) {
      return;
    }

    for (const child of node.children || []) {
      visit(child);
    }

    if (node.type !== "Table" || node.tableGridReview) {
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
  const visit = node => {
    if (node.type === "Table") assignTableHeaders(node, collectTableRowDescriptors(node));
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
    if (!tableNode || tableNode.type !== "Table" || tableNode.tableGridReview) return false;
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
  let listStack = [], activeListGroup = null;
  let activeTable = null;
  let activeDiagram = null;
  let listIndex = 0;
  const listItemsBySource = new Map(), paragraphsByGroup = new Map();
  // Precedence constraints can split a table group around a heading or other
  // content. Preserve that order and every cell, but give each emitted fragment
  // its own identity. Reserve all source group names before allocating suffixes.
  const reservedTableIds = new Set(orderedNodes.filter(n => ["Table", "TH", "TD"].includes(n.role))
    .map(n => `tag:table:${getTableGroupId(n) || `page-${n.pageNumber}-table`}`));
  const emittedTableIds = new Set();
  const newTable = (node, groupId) => {
    const table = createTableNode(node, groupId), base = table.id;
    let fragment = 2;
    while (emittedTableIds.has(table.id)) {
      do { table.id = `${base}:fragment:${fragment++}`; } while (reservedTableIds.has(table.id));
    }
    emittedTableIds.add(table.id);
    return table;
  };

  // A5: identify which heading should be emitted as Title (if any).
  const titleNodeId = options.enableTitleDetection ? detectTitleNodeId(orderedNodes) : null;
  let titleEmitted = false;

  const currentContainer = () => sectionStack.at(-1)?.node || root;

  for (const node of orderedNodes) {
    if (!node) {
      continue;
    }

    if (node.role === "Artifact") {
      // Running page furniture does not interrupt a declared semantic table.
      continue;
    }

    if (node.diagramRegionId) {
      if (node.role !== "P") throw new Error("Diagram label role requires review");
      if (!activeDiagram || activeDiagram.group !== node.diagramRegionId || activeDiagram.parent !== currentContainer()) {
        const section={id:`tag:diagram:${node.id}`,type:"Sect",children:[]};
        currentContainer().children.push(section);
        activeDiagram={group:node.diagramRegionId,parent:currentContainer(),section};
      }
      activeDiagram.section.children.push(createLeaf(node,headingNormalization));
      activeList=null;activeTable=null;
      continue;
    }
    activeDiagram=null;

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

    if (node.role === "LI" && node.listContinuationOf) {
      const prior = listItemsBySource.get(node.listContinuationOf);
      if (!prior || !activeList) throw new Error("List continuation has no active preceding item; requires review");
      let body = prior.children.find((n) => n.type === "LBody");
      if (!body) {
        body = { id: `${prior.id}:body`, type: "LBody", sourceNodeIds: prior.sourceNodeIds || [], actualText: prior.actualText, children: [] };
        delete prior.sourceNodeIds; delete prior.actualText; prior.children.push(body);
      }
      if (body.sourceNodeIds?.length) {
        body.children.unshift({ id: `${body.id}:first`, type: "P", children: [{ id: `${body.id}:first:span`, type: "Span", label: body.label,
          sourceNodeIds: body.sourceNodeIds, ...(body.actualText ? { actualText: body.actualText } : {}), children: [] }] });
        delete body.sourceNodeIds; delete body.actualText;
      }
      body.children.push(createLeaf({ ...node, role: "P" }, headingNormalization));
      listItemsBySource.set(node.id, prior);
      continue;
    }
    if (node.role === "LI") {
      const level = Math.max(1, Number(node.listLevel) || 1);
      if (!activeList || (level === 1 && node.listGroupId && activeListGroup && node.listGroupId !== activeListGroup)) {
        listIndex += 1;
        activeList = createListNode(currentContainer(), listIndex);
        activeListGroup = node.listGroupId || null;
        listStack = [{ level: 1, list: activeList, last: null }];
        const listNumbering = inferListNumbering(node);
        if (listNumbering) {
          activeList.listNumbering = listNumbering;
        }
      }
      while (listStack.length > 1 && listStack.at(-1).level > level) listStack.pop();
      if (level > listStack.at(-1).level) {
        const parent = listStack.at(-1).last;
        if (!parent || level !== listStack.at(-1).level + 1) throw new Error("Ambiguous nested list level; requires review");
        let body = parent.children.find((n) => n.type === "LBody");
        if (!body) {
          body = { id: `${parent.id}:body`, type: "LBody", sourceNodeIds: parent.sourceNodeIds || [], label: parent.label, children: [] };
          delete parent.sourceNodeIds; delete parent.actualText; parent.children.push(body);
        }
        const nested = createListNode(body, ++listIndex);
        const numbering = inferListNumbering(node); if (numbering) nested.listNumbering = numbering;
        listStack.push({ level, list: nested, last: null });
      }
      const leaf = createLiLeaf(node, headingNormalization);
      listItemsBySource.set(node.id, leaf);
      listStack.at(-1).list.children.push(leaf); listStack.at(-1).last = leaf;
      activeTable = null;
      continue;
    }

    activeList = null;

    if (node.role === "Table") {
      const groupId = getTableGroupId(node) || node.id;
      const tableNode = newTable(node, groupId);
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
        const tableNode = newTable(null, groupId);
        currentContainer().children.push(tableNode);
        activeTable = {
          groupId,
          node: tableNode,
          rows: new Map()
        };
      }

      appendTableCell(activeTable, createLeaf(node, headingNormalization), node.pageNumber, getTableRowIndex(node));
      continue;
    }

    activeTable = null;
    const leaf = createLeaf(node, headingNormalization);
    if (node.paragraphGroupId && node.role === "P") {
      const prior = paragraphsByGroup.get(node.paragraphGroupId);
      if (prior) {
        if (prior.parent !== currentContainer()) throw new Error("Paragraph continuation crosses a semantic container; requires review");
        prior.leaf.children.push(...leaf.children);
        prior.leaf.label = `${prior.leaf.label} ${leaf.label}`;
        continue;
      }
      paragraphsByGroup.set(node.paragraphGroupId, { leaf, parent: currentContainer() });
    }
    // A6: promote Figure/Table caption-like paragraphs to /Caption.
    if (options.enableCaptionDetection && isCaptionCandidate(node)) {
      leaf.type = "Caption";
      leaf.detectedType = leaf.detectedType || "P";
    }
    currentContainer().children.push(leaf);
  }

  const tableCellMerges = [], sourceNodes = new Map(orderedNodes.map(n => [n.id, n]));
  const tableStack = [root];
  while (tableStack.length) {
    const item = tableStack.pop();
    if (item.type === "Table") tableCellMerges.push(...mergeDeclaredCellFragments(collectTableRowDescriptors(item), sourceNodes));
    for (const child of item.children || []) tableStack.push(child);
  }
  normalizeTableSections(root);
  const tableRegularityCorrection = normalizeTableRegularity(root);
  const mergedTableTextCellRepair = repairMergedTableTextCells(root);
  normalizeTableSections(root);
  // THead can contain mixed TH/TD cells. Section placement cannot override a cell role.
  const tableStructureRepairs = 0;
  const repeatedHeaderRows = detectRepeatedHeaders(root);
  flattenRedundantTableBodySections(root);

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
  const captionAssociation = associateCaptions(root, semanticDocument, options);

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

  attachOcrSegments(root, semanticDocument);
  const widgetOwnership=attachWidgetOwnership(root,semanticDocument);
  const taggingDocument = {
    schemaVersion: "1.0.0",
    documentId: `${semanticDocument.documentId}:tagging`,
    source: {
      semanticDocumentId: semanticDocument.documentId,
      ...(semanticDocument.source.filePath ? { filePath: semanticDocument.source.filePath } : {}),
      ...(widgetOwnership.widgets.length || widgetOwnership.reviews.length ? {widgetOwnership} : {}),
      headingNormalization: headingNormalization.summary,
      tableRegularityCorrection,
      ...(tableCellMerges.length ? { tableCellMerges } : {}),
      mergedTableTextCellRepair,
      tableStructureRepairs,
      repeatedHeaderRows,
      ...(options.enableTitleDetection ? { titleDetection: { applied: titleEmitted, nodeId: titleEmitted ? titleNodeId : null } } : {}),
      ...(captionAssociation.detected ? { captionAssociation } : {}),
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
