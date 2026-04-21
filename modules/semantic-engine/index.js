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

// ---- Inline style classification (A1 Em/Strong, A2 Code) ----
//
// These helpers feature-detect run-level metadata on a layout text block.
// Today the layout analyzer exposes only block-level `fontName`, so most
// corpus blocks will have no `inlineRuns` array and the run-level classifier
// is a no-op. We still classify the block as a whole for A2 (Code) because
// a paragraph whose fontName is monospaced really is a code paragraph.
//
// For A1, the gate in the plan ("don't emit Em/Strong if the ENTIRE paragraph
// is bold/italic") means we must NOT block-fallback for Em/Strong: that case
// is already handled by heading promotion, and emitting /Strong on a whole-
// bold paragraph would duplicate /H# emphasis. So Em/Strong ride only on
// run-level detections.

const MONOSPACE_FONT_FAMILIES = [
  "Courier",
  "NotoSansMono",
  "Consolas",
  "Menlo",
  "Source Code Pro",
  "SourceCodePro",
  "Fira Code",
  "FiraCode",
  "Inconsolata",
  "Roboto Mono",
  "RobotoMono",
  "JetBrains Mono",
  "JetBrainsMono",
  "Ubuntu Mono",
  "UbuntuMono",
  "Liberation Mono",
  "LiberationMono"
];

function isMonospaceFont(fontName) {
  if (!fontName) return false;
  const name = String(fontName);
  for (const family of MONOSPACE_FONT_FAMILIES) {
    if (name.toLowerCase().includes(family.toLowerCase())) return true;
  }
  // Trailing "Mono" / "Monospace" / "Mono-Regular" etc.
  return /(^|[-_ ,+])mono(space)?([-_ ,+].*)?$/i.test(name);
}

function isBoldFont(fontName, fontWeight) {
  if (Number.isFinite(fontWeight) && fontWeight >= 600) return true;
  if (typeof fontWeight === "string" && /bold/i.test(fontWeight)) return true;
  if (!fontName) return false;
  return /bold|black|heavy|semibold|demibold/i.test(fontName);
}

function isItalicFont(fontName, fontStyle) {
  if (typeof fontStyle === "string" && /italic|oblique/i.test(fontStyle)) return true;
  if (!fontName) return false;
  return /italic|oblique/i.test(fontName);
}

function classifyRunStyle(run, block) {
  const fontName = run.fontName || block.fontName;
  const fontWeight = run.fontWeight ?? block.fontWeight;
  const fontStyle = run.fontStyle ?? block.fontStyle;
  return {
    bold: isBoldFont(fontName, fontWeight),
    italic: isItalicFont(fontName, fontStyle),
    mono: isMonospaceFont(fontName)
  };
}

// Emit inlineRuns annotation on a paragraph-like node. Each annotated run
// carries { text, start, end, semanticRole } where semanticRole is one of
// "Em" | "Strong" | "Code". Returns null when no runs need tagging so we
// don't pollute nodes with empty arrays.
function classifyInlineRuns(block) {
  const runs = Array.isArray(block.inlineRuns) ? block.inlineRuns : null;
  if (!runs || runs.length === 0) return null;

  // Determine paragraph-majority style. Weight by text length to avoid a
  // tiny non-matching run dominating.
  let totalLen = 0;
  let boldLen = 0;
  let italicLen = 0;
  const perRun = [];
  for (const r of runs) {
    const text = String(r.text || "");
    const style = classifyRunStyle(r, block);
    perRun.push({ run: r, text, style });
    totalLen += text.length;
    if (style.bold) boldLen += text.length;
    if (style.italic) italicLen += text.length;
  }
  if (totalLen === 0) return null;

  const majorityBold = boldLen / totalLen >= 0.9;
  const majorityItalic = italicLen / totalLen >= 0.9;

  const out = [];
  let cursor = 0;
  for (const { run, text, style } of perRun) {
    const start = cursor;
    const end = cursor + text.length;
    cursor = end;

    let semanticRole = null;
    if (style.mono) {
      semanticRole = "Code";
    } else if (style.bold && !majorityBold) {
      semanticRole = "Strong";
    } else if (style.italic && !majorityItalic) {
      semanticRole = "Em";
    }

    if (semanticRole) {
      out.push({
        text,
        start,
        end,
        semanticRole,
        ...(run.bbox ? { bbox: run.bbox } : {}),
        ...(run.fontName ? { fontName: run.fontName } : {})
      });
    }
  }

  return out.length > 0 ? out : null;
}

// ---- A3 Abbreviations ----
const ABBREVIATION_DICTIONARY = Object.freeze({
  W3C: "World Wide Web Consortium",
  URL: "Uniform Resource Locator",
  URI: "Uniform Resource Identifier",
  HTML: "HyperText Markup Language",
  HTTP: "HyperText Transfer Protocol",
  HTTPS: "HyperText Transfer Protocol Secure",
  PDF: "Portable Document Format",
  XML: "Extensible Markup Language",
  JSON: "JavaScript Object Notation",
  API: "Application Programming Interface",
  USA: "United States of America",
  UK: "United Kingdom",
  EU: "European Union",
  UN: "United Nations",
  NYC: "New York City",
  ISO: "International Organization for Standardization",
  IEEE: "Institute of Electrical and Electronics Engineers",
  NASA: "National Aeronautics and Space Administration",
  FBI: "Federal Bureau of Investigation",
  CEO: "Chief Executive Officer",
  CIO: "Chief Information Officer",
  CFO: "Chief Financial Officer"
});

// Matches an all-caps / digit token of length 2-6. We enforce token
// boundaries so "UKULELE" (not in dict anyway) doesn't trigger on a prefix
// and "MP3S" (not in dict) isn't pulled out of a longer word.
const ABBREVIATION_TOKEN_RE = /(?<![A-Za-z0-9])([A-Z0-9]{2,6})(?![A-Za-z0-9])/g;

function classifyAbbreviations(text) {
  if (!text || typeof text !== "string") return null;
  const out = [];
  ABBREVIATION_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = ABBREVIATION_TOKEN_RE.exec(text)) !== null) {
    const token = match[1];
    const expansion = ABBREVIATION_DICTIONARY[token];
    if (!expansion) continue;
    out.push({
      token,
      start: match.index,
      end: match.index + token.length,
      expansion,
      semanticRole: "Span"
    });
  }
  return out.length > 0 ? out : null;
}

function buildSemanticNode(block, pageNumber, index, state, options) {
  const artifactPlacement = inferArtifactPlacement(block);
  const tableMetadata = inferTableMetadata(block, pageNumber, index, state, options);
  const listMetadata = inferListMetadata(block, pageNumber, index, state);
  const role = inferRole(block, artifactPlacement, tableMetadata);

  // A1 Em/Strong + A2 Code at run level. Feature-detected on block.inlineRuns;
  // no-op when the layout analyzer doesn't carry run metadata.
  const inlineRuns = !artifactPlacement ? classifyInlineRuns(block) : null;

  // A2 Code block-level: whole paragraph in a monospace font becomes Code.
  // Only applied to P nodes (not headings, tables, lists, artifacts).
  const blockSemanticRole =
    role === "P" && isMonospaceFont(block.fontName) ? "Code" : null;

  // A3 Abbreviations: scan plain text for dictionary hits. Applied to P and
  // heading nodes; suppressed inside tables/artifacts/lists where call-outs
  // are less meaningful.
  const abbreviations =
    role === "P" || role.startsWith("H")
      ? classifyAbbreviations(block.text)
      : null;

  return {
    id: `n-${pageNumber}-${index + 1}`,
    pageNumber,
    sourceBlockId: block.id,
    role,
    text: block.text,
    bbox: block.bbox,
    ...(block.writingMode ? { writingMode: block.writingMode } : {}),
    ...(Number.isFinite(block.textRotation) ? { textRotation: block.textRotation } : {}),
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
      : {}),
    ...(inlineRuns ? { inlineRuns } : {}),
    ...(blockSemanticRole ? { semanticRole: blockSemanticRole } : {}),
    ...(abbreviations ? { abbreviations } : {})
  };
}

// ---- A4 BlockQuote detection ----
//
// After nodes are built for a page, detect contiguous runs of paragraph
// nodes whose left margin (bbox[0]) is significantly deeper than the page's
// baseline left margin, and which are NOT inside a list or table. Baseline
// is the mode of left margins across the page's non-list, non-table P nodes.
// Feature-gated: if fewer than 3 baseline paragraphs exist, skip (too little
// evidence to establish a baseline).

function computeLeftMarginMode(paragraphs) {
  const buckets = new Map();
  // Round to 1-point buckets; visually-equal left margins in PDFs can differ
  // by sub-point amounts due to kerning/anchoring.
  for (const p of paragraphs) {
    const x = Array.isArray(p.bbox) ? Math.round(p.bbox[0]) : null;
    if (x == null) continue;
    buckets.set(x, (buckets.get(x) || 0) + 1);
  }
  let bestX = null;
  let bestCount = 0;
  for (const [x, count] of buckets) {
    if (count > bestCount) {
      bestCount = count;
      bestX = x;
    }
  }
  return { mode: bestX, modeCount: bestCount, total: paragraphs.length };
}

function isEligibleForBlockQuote(node) {
  if (!node) return false;
  if (node.role !== "P") return false;
  if (node.listGroupId) return false;
  if (node.tableId) return false;
  if (node.artifactType) return false;
  return Array.isArray(node.bbox);
}

function markBlockQuotesForPage(pageNodes, { pageNumber, thresholdRatio = 0.1 } = {}) {
  const paragraphs = pageNodes.filter(isEligibleForBlockQuote);
  if (paragraphs.length < 3) return; // too little evidence

  const { mode, modeCount } = computeLeftMarginMode(paragraphs);
  if (mode == null || modeCount < 2) return;

  // "10% greater than baseline" — apply threshold against the mode value
  // directly. Guard against a degenerate mode of 0 (no left margin at all).
  const threshold = Math.max(mode * (1 + thresholdRatio), mode + 12);

  let groupSeq = 0;
  let activeGroupId = null;
  let activeNodes = [];

  const closeGroup = () => {
    // Require at least 1 paragraph; matches plan ("contiguous paragraph
    // sequences"). We keep single-P quotes because short pull-quotes are
    // real. A stricter gate can be added later.
    if (activeNodes.length >= 1) {
      for (const n of activeNodes) {
        n.blockQuoteGroupId = activeGroupId;
      }
    }
    activeGroupId = null;
    activeNodes = [];
  };

  for (const node of pageNodes) {
    if (!isEligibleForBlockQuote(node)) {
      if (activeGroupId) closeGroup();
      continue;
    }
    const leftMargin = node.bbox[0];
    const isIndented = leftMargin >= threshold;
    if (isIndented) {
      if (!activeGroupId) {
        groupSeq += 1;
        activeGroupId = `bq:${pageNumber}:${groupSeq}`;
      }
      activeNodes.push(node);
    } else if (activeGroupId) {
      closeGroup();
    }
  }
  if (activeGroupId) closeGroup();
}

// ---- A9 BibEntry state machine ----
//
// Walk all nodes in document order. When a heading whose text matches the
// bibliography patterns is encountered, enter "in references" mode. Every P
// node from that heading until the next heading (of any level) or end of
// document is annotated with bibEntry: true. Non-P nodes (tables, lists,
// artifacts) are passed through unchanged.

const BIB_HEADING_RE = /^\s*(References|Bibliography|Works Cited|Literature Cited)\s*$/i;

function markBibEntries(nodes) {
  let inReferences = false;
  for (const node of nodes) {
    if (!node || !node.role) continue;
    if (node.role.startsWith("H")) {
      inReferences = BIB_HEADING_RE.test(String(node.text || ""));
      continue;
    }
    if (inReferences && node.role === "P") {
      node.bibEntry = true;
      node.semanticRole = node.semanticRole || "BibEntry";
    }
  }
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
  // Propagate the parser's hybrid-OCR flag onto each semantic node so
  // tag-builder can inject /ActualText for AT on hybrid pages.
  const pageIsHybrid = page.hybrid === true;
  return page.textBlocks.map((block, index) => {
    const node = buildSemanticNode(block, page.pageNumber, index, state, pageOptions);
    if (pageIsHybrid) node.hybrid = true;
    return node;
  });
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
    // A4 BlockQuote is a page-level pass; run it before cross-page passes so
    // left-margin mode is computed from a single page's paragraphs.
    markBlockQuotesForPage(pageNodes, {
      pageNumber: page.pageNumber,
      thresholdRatio: effectiveOptions.blockQuoteThresholdRatio
    });
    nodes.push(...pageNodes);
  }

  // A9 BibEntry is a document-level pass; it needs headings from all pages
  // to decide where the "References" section starts and ends.
  markBibEntries(nodes);

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
