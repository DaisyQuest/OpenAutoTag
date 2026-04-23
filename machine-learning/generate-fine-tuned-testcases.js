import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { parseArgs } from "./ml-artifacts.js";

const DEFAULT_OUTPUT_DIR = path.resolve("output", "ml-fine-tuned-corpus", "v2", "pdfs");

const PAGE_SIZES = {
  letter: [612, 792],
  legal: [612, 1008],
  compact: [540, 720]
};

export const MATRIX_FACTORS = Object.freeze({
  archetype: [
    "stamp-borderless-table",
    "numbered-list-endnotes",
    "odd-paragraph-shapes",
    "sparse-borderless-table",
    "two-column-noisy-paragraphs",
    "mixed-heading-table-footnote",
    "multi-page-carryover-table",
    "form-key-value-grid",
    "rotated-marginalia",
    "dense-nested-list"
  ],
  noiseProfile: ["clean", "speckle", "line-noise", "background-boxes"],
  typography: ["sans", "serif", "mono", "mixed"],
  pageSize: ["letter", "legal", "compact"],
  density: ["open", "standard", "dense"],
  tableRuling: ["none", "horizontal", "partial", "full-grid"],
  noteStyle: ["none", "symbol", "numeric", "bracket", "endnote"],
  stampStyle: ["none", "reviewed", "void", "confidential"],
  columnMode: ["single", "two-column", "side-note"],
  paragraphShape: ["normal", "ragged", "l-shaped", "inset"]
});

const FACTOR_STRIDES = Object.freeze({
  noiseProfile: 3,
  typography: 5,
  pageSize: 7,
  density: 11,
  tableRuling: 13,
  noteStyle: 17,
  stampStyle: 19,
  columnMode: 23,
  paragraphShape: 29
});

const FACTOR_DIVISORS = Object.freeze({
  noiseProfile: 7,
  typography: 11,
  pageSize: 5,
  density: 13,
  tableRuling: 17,
  noteStyle: 19,
  stampStyle: 23,
  columnMode: 29,
  paragraphShape: 31
});

const STAMP_TEXT = Object.freeze({
  none: "",
  reviewed: "REVIEWED",
  void: "VOID COPY",
  confidential: "CONFIDENTIAL"
});

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sanitizePathSegment(value) {
  return String(value || "case")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "case";
}

function matrixCaseForIndex(index) {
  const archetypes = MATRIX_FACTORS.archetype;
  const cycle = Math.floor(index / archetypes.length);
  const matrix = {
    archetype: archetypes[index % archetypes.length]
  };

  let factorIndex = 0;
  for (const [factor, values] of Object.entries(MATRIX_FACTORS)) {
    if (factor === "archetype") {
      continue;
    }
    if (factor === "noteStyle") {
      matrix[factor] = values[(index + cycle + Math.floor(cycle / 2)) % values.length];
      factorIndex += 1;
      continue;
    }
    const stride = FACTOR_STRIDES[factor] || 1;
    const divisor = FACTOR_DIVISORS[factor] || archetypes.length;
    const crossTerm = Math.floor(index / divisor) + cycle * (factorIndex + 2);
    matrix[factor] = values[(index * stride + crossTerm + factorIndex * 3) % values.length];
    factorIndex += 1;
  }

  return matrix;
}

function lineHeight(size) {
  return size * 1.28;
}

function drawWrappedText(page, text, { x, y, width, size, font, color = rgb(0, 0, 0), leading = lineHeight(size) }) {
  const words = String(text).split(/\s+/).filter(Boolean);
  let line = "";
  let cursorY = y;
  let lineCount = 0;

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width || !line) {
      line = candidate;
      continue;
    }

    page.drawText(line, { x, y: cursorY, size, font, color });
    cursorY -= leading;
    line = word;
    lineCount += 1;
  }

  if (line) {
    page.drawText(line, { x, y: cursorY, size, font, color });
    lineCount += 1;
  }

  return {
    y: cursorY - leading,
    lineCount
  };
}

async function loadFonts(pdfDoc, typography) {
  const sans = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const mono = await pdfDoc.embedFont(StandardFonts.Courier);
  const monoBold = await pdfDoc.embedFont(StandardFonts.CourierBold);

  if (typography === "serif") {
    return { regular: serif, bold: serifBold, italic: serifItalic, mono };
  }
  if (typography === "mono") {
    return { regular: mono, bold: monoBold, italic: mono, mono };
  }
  if (typography === "mixed") {
    return { regular: serif, bold: sansBold, italic: serifItalic, mono };
  }
  return { regular: sans, bold: sansBold, italic: serifItalic, mono };
}

function addPage(pdfDoc, matrix) {
  const [width, height] = PAGE_SIZES[matrix.pageSize] || PAGE_SIZES.letter;
  return {
    page: pdfDoc.addPage([width, height]),
    width,
    height
  };
}

function densityScale(matrix) {
  if (matrix.density === "dense") return 1.35;
  if (matrix.density === "open") return 0.72;
  return 1;
}

function drawNoise(page, rng, matrix, { width, height, baseIntensity = 8 } = {}) {
  const intensity = Math.round(baseIntensity * densityScale(matrix));
  if (matrix.noiseProfile === "clean") {
    return { type: "clean", count: 0 };
  }

  const tone = () => 0.7 + rng() * 0.22;
  let count = 0;

  if (matrix.noiseProfile === "speckle") {
    for (let index = 0; index < intensity * 4; index += 1) {
      const shade = tone();
      page.drawRectangle({
        x: 28 + rng() * (width - 56),
        y: 42 + rng() * (height - 84),
        width: 0.8 + rng() * 1.8,
        height: 0.8 + rng() * 1.8,
        color: rgb(shade, shade, shade)
      });
      count += 1;
    }
    return { type: "speckle", count };
  }

  if (matrix.noiseProfile === "background-boxes") {
    for (let index = 0; index < Math.max(2, Math.round(intensity / 3)); index += 1) {
      const shade = tone();
      page.drawRectangle({
        x: 42 + rng() * (width - 180),
        y: 70 + rng() * (height - 220),
        width: 48 + rng() * 96,
        height: 16 + rng() * 54,
        color: rgb(shade, shade, shade),
        opacity: 0.12
      });
      count += 1;
    }
  }

  for (let index = 0; index < intensity; index += 1) {
    const x = 36 + rng() * (width - 72);
    const y = 48 + rng() * (height - 96);
    const length = 4 + rng() * 24;
    const shade = tone();
    page.drawLine({
      start: { x, y },
      end: { x: x + length, y: y + (rng() - 0.5) * 2.5 },
      thickness: 0.25,
      color: rgb(shade, shade, shade)
    });
    count += 1;
  }

  return { type: matrix.noiseProfile, count };
}

function drawTableRuling(page, { x, y, columns, rowCount, rowGap, matrix, width }) {
  if (matrix.tableRuling === "none") {
    return;
  }

  const tableWidth = width || columns.reduce((sum, column) => sum + column.width, 0);
  const top = y + 14;
  const bottom = y - rowGap * rowCount - 6;
  const color = rgb(0.46, 0.46, 0.46);

  if (["horizontal", "partial", "full-grid"].includes(matrix.tableRuling)) {
    for (let row = 0; row <= rowCount + 1; row += 1) {
      const lineY = top - row * rowGap;
      const startX = matrix.tableRuling === "partial" && row % 2 === 1 ? x + 12 : x - 4;
      const endX = matrix.tableRuling === "partial" && row % 2 === 1 ? x + tableWidth - 28 : x + tableWidth + 4;
      page.drawLine({ start: { x: startX, y: lineY }, end: { x: endX, y: lineY }, thickness: 0.45, color });
    }
  }

  if (matrix.tableRuling === "full-grid") {
    let cursorX = x - 4;
    page.drawLine({ start: { x: cursorX, y: top }, end: { x: cursorX, y: bottom }, thickness: 0.45, color });
    for (const column of columns) {
      cursorX += column.width;
      page.drawLine({ start: { x: cursorX, y: top }, end: { x: cursorX, y: bottom }, thickness: 0.45, color });
    }
  }
}

function drawMatrixTable(page, { x, y, columns, rows, fonts, matrix, rowGap = 22, headerShade = false }) {
  const { regular, bold } = fonts;
  const headerY = y;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const rowCount = rows.length;

  if (headerShade) {
    page.drawRectangle({
      x: x - 4,
      y: headerY - 5,
      width: tableWidth + 8,
      height: 19,
      color: rgb(0.92, 0.94, 0.96)
    });
  }
  drawTableRuling(page, { x, y: headerY, columns, rowCount, rowGap, matrix, width: tableWidth });

  let cursorX = x;
  for (const column of columns) {
    page.drawText(column.label, { x: cursorX, y: headerY, size: 9.2, font: bold });
    cursorX += column.width;
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    cursorX = x + ((rowIndex + matrix.tableRuling.length) % 4 === 0 ? 2 : 0);
    const rowY = headerY - rowGap * (rowIndex + 1);
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      page.drawText(rows[rowIndex][columnIndex], {
        x: cursorX,
        y: rowY,
        size: 8.3 + (columnIndex === 0 ? 0.25 : 0),
        font: regular
      });
      cursorX += columns[columnIndex].width;
    }
  }

  return {
    bbox: [x, headerY - rowGap * rows.length - 6, tableWidth, rowGap * (rows.length + 1)]
  };
}

function noteMarker(matrix, fallback = "[1]") {
  if (matrix.noteStyle === "symbol") return "*";
  if (matrix.noteStyle === "numeric") return "1.";
  if (matrix.noteStyle === "endnote") return "End note 1.";
  if (matrix.noteStyle === "none") return fallback;
  return "[1]";
}

function drawStamp(page, { x, y, fonts, matrix }) {
  if (matrix.stampStyle === "none") {
    return null;
  }

  const text = STAMP_TEXT[matrix.stampStyle] || "REVIEWED";
  const width = text === "CONFIDENTIAL" ? 158 : 128;
  const height = 34;
  const angle = matrix.stampStyle === "void" ? 11 : -12;
  page.drawRectangle({
    x,
    y,
    width,
    height,
    borderWidth: 1.2,
    borderColor: rgb(0.72, 0.08, 0.08),
    color: rgb(1, 1, 1),
    opacity: 0.08,
    rotate: degrees(angle)
  });
  page.drawText(text, {
    x: x + 10,
    y: y + 11,
    size: text === "CONFIDENTIAL" ? 11.2 : 13,
    font: fonts.bold,
    color: rgb(0.72, 0.08, 0.08),
    rotate: degrees(angle)
  });
  return { bbox: [x, y, width, height], rotation: angle, text };
}

function drawFooter(page, fonts, caseId, pageNumber, { width }) {
  page.drawText(`Fine tuned matrix testcase ${caseId} - page ${pageNumber}`, {
    x: 42,
    y: 28,
    size: 7,
    font: fonts.regular,
    color: rgb(0.45, 0.45, 0.45)
  });
  page.drawText("OpenAutoTag synthetic matrix", {
    x: Math.max(42, width - 158),
    y: 28,
    size: 7,
    font: fonts.regular,
    color: rgb(0.45, 0.45, 0.45)
  });
}

function paragraphWidth(matrix, width) {
  if (matrix.paragraphShape === "ragged") return width * 0.57;
  if (matrix.paragraphShape === "inset") return width * 0.48;
  if (matrix.paragraphShape === "l-shaped") return width * 0.42;
  return width * 0.72;
}

function topY(height) {
  return height - 62;
}

async function buildStampAndBorderlessTable(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 10 });
  page.drawText("Inventory Compliance Extract", { x: 48, y: topY(height), size: 18, font: fonts.bold });
  drawWrappedText(page, "This case stresses compact numeric cells, a table-like region, and optional stamp interference near the header.", {
    x: 48,
    y: topY(height) - 27,
    width: Math.min(430, width - 96),
    size: 10,
    font: fonts.regular
  });
  const stamp = drawStamp(page, { x: width - 190, y: topY(height) - 62, fonts, matrix });
  const marker = noteMarker(matrix);
  const table = drawMatrixTable(page, {
    x: 52,
    y: topY(height) - 88,
    matrix,
    fonts,
    columns: [
      { label: "Item", width: 102 },
      { label: "Batch", width: 70 },
      { label: "Count", width: 62 },
      { label: "Variance", width: 76 },
      { label: "Disposition", width: 112 }
    ],
    rows: Array.from({ length: matrix.density === "dense" ? 8 : 6 }, (_, index) => [
      `Assembly ${index + 1}`,
      `B-${index}${caseId.slice(-2)}`,
      String(12 + index * 3),
      index % 2 === 0 ? "0.4%" : "-1.2%",
      index % 3 === 0 ? `hold ${marker}` : "release"
    ]),
    headerShade: matrix.tableRuling !== "none"
  });
  page.drawText(`${marker} Footnote belongs to the disposition cell, not the stamped artifact.`, {
    x: 52,
    y: table.bbox[1] - 36,
    size: 8,
    font: fonts.regular
  });
  drawFooter(page, fonts, caseId, 1, { width });

  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "table", rows: table.bbox[3] > 170 ? 9 : 7, columns: 5, ruling: matrix.tableRuling, bbox: table.bbox },
      ...(stamp ? [{ type: "artifact-stamp", text: stamp.text, bbox: stamp.bbox, rotation: stamp.rotation }] : []),
      { type: "footnote", marker, relation: "table-cell" },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

async function buildEndnoteListCase(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 7 });
  page.drawText("Policy Conditions With End Notes", { x: 48, y: topY(height), size: 19, font: fonts.bold });
  let y = topY(height) - 36;
  const items = [
    "1. Confirm that each appendix reference is resolved before publication.",
    "2. Flag tabular totals when the subtotal appears without visible column rules.",
    "3. Mark short side comments as artifacts only when they are outside the reading flow.",
    "4. Preserve nested list intent when continuation lines are indented irregularly.",
    "5. Review bottom notes separately from the body text when they use compact type."
  ];
  const selectedItems = matrix.density === "open" ? items.slice(0, 3) : matrix.density === "dense" ? items : items.slice(0, 4);
  for (const item of selectedItems) {
    const drawn = drawWrappedText(page, item, {
      x: 68 + (matrix.paragraphShape === "inset" ? 16 : 0),
      y,
      width: Math.min(420, width - 130),
      size: matrix.density === "dense" ? 9.8 : 10.8,
      font: fonts.regular
    });
    y = drawn.y - 5;
  }
  const notesY = Math.max(124, Math.min(220, y - 48));
  page.drawText(matrix.noteStyle === "endnote" ? "End Notes" : "Notes", { x: 48, y: notesY, size: 13, font: fonts.bold });
  page.drawText(`${noteMarker(matrix, "1.")} The reviewer should classify bottom notes separately from body paragraphs.`, {
    x: 68,
    y: notesY - 22,
    size: 8.2,
    font: fonts.regular
  });
  page.drawText("2. Italic emphasis here is visual noise, not a heading cue.", {
    x: 68,
    y: notesY - 36,
    size: 8.2,
    font: fonts.italic
  });
  drawFooter(page, fonts, caseId, 1, { width });

  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "list", itemCount: selectedItems.length, markerStyle: "decimal" },
      { type: matrix.noteStyle === "endnote" ? "endnotes" : "footnotes", count: 2, pageRegion: "bottom" },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

async function buildOddParagraphCase(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 14 });
  page.drawText("Ragged Paragraph Geometry", { x: 48, y: topY(height), size: 20, font: fonts.bold });
  drawWrappedText(page, "The main paragraph deliberately changes width across lines. The classifier should still treat the text as paragraph content rather than a table or list.", {
    x: 48,
    y: topY(height) - 40,
    width: paragraphWidth(matrix, width),
    size: 10.6,
    font: fonts.regular
  });
  drawWrappedText(page, "A narrow continuation block is inset beside a quiet sidebar. Its geometry is unusual but semantically it remains body text with a nearby artifact-like note.", {
    x: matrix.paragraphShape === "inset" ? 96 : 76,
    y: topY(height) - 104,
    width: Math.min(320, width - 190),
    size: 9.8,
    font: fonts.regular
  });
  page.drawRectangle({ x: width - 142, y: topY(height) - 150, width: 96, height: 88, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });
  page.drawText("sidebar", { x: width - 126, y: topY(height) - 88, size: 8, font: fonts.bold, color: rgb(0.35, 0.35, 0.35) });
  drawWrappedText(page, "Quality note: do not promote this box to the main heading sequence.", {
    x: width - 126,
    y: topY(height) - 106,
    width: 68,
    size: 7.2,
    font: fonts.regular,
    color: rgb(0.35, 0.35, 0.35)
  });
  drawWrappedText(page, "The closing paragraph has an L-shaped visual footprint caused by an omitted figure region. This is a common source of false table or artifact tags.", {
    x: 48,
    y: topY(height) - 214,
    width: matrix.paragraphShape === "l-shaped" ? Math.min(250, width - 220) : Math.min(420, width - 96),
    size: 9.8,
    font: fonts.regular
  });
  drawWrappedText(page, "Continuation returns to the full measure after the visual gap.", {
    x: 48,
    y: topY(height) - 306,
    width: Math.min(440, width - 96),
    size: 9.8,
    font: fonts.regular
  });
  drawFooter(page, fonts, caseId, 1, { width });

  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "paragraph", shape: matrix.paragraphShape },
      { type: "artifact-sidebar", text: "quality note" },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

async function buildSparseTableCase(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 6 });
  page.drawText("Sparse Register", { x: 48, y: topY(height), size: 18, font: fonts.bold });
  const table = drawMatrixTable(page, {
    x: 48,
    y: topY(height) - 48,
    matrix,
    fonts,
    rowGap: matrix.density === "dense" ? 22 : 28,
    columns: [
      { label: "Code", width: 76 },
      { label: "Description", width: 176 },
      { label: "FY 2024", width: 72 },
      { label: "FY 2025", width: 72 },
      { label: "Delta", width: 62 }
    ],
    rows: [
      ["A-10", "Microfilm transfer", "12", "15", "+3"],
      ["B-45", "Field review", "", "9", "+9"],
      ["C-02", "Cancelled item", "7", "", "-7"],
      ["D-18", "Manual verification", "2", "2", "0"],
      ["E-21", "Deferred review", "", "", "0"],
      ["TOTAL", "Program activity", "21", "26", "+5"]
    ].slice(0, matrix.density === "open" ? 4 : 6),
    headerShade: matrix.tableRuling !== "none"
  });
  page.drawText(`${noteMarker(matrix, "Note:")} empty cells are meaningful missing values.`, {
    x: 48,
    y: table.bbox[1] - 36,
    size: 8,
    font: fonts.regular
  });
  drawFooter(page, fonts, caseId, 1, { width });

  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "table", rows: matrix.density === "open" ? 5 : 7, columns: 5, ruling: matrix.tableRuling, emptyCells: matrix.density === "open" ? 2 : 4, bbox: table.bbox },
      { type: "note", style: matrix.noteStyle, relation: "table" },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

async function buildTwoColumnCase(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 16 });
  page.drawText("Two Column Technical Notice", { x: 48, y: topY(height), size: 18, font: fonts.bold });
  const gutter = 36;
  const columnWidth = (width - 96 - gutter) / 2;
  const left = "This left column contains dense explanatory text with short sentences. The reading order should finish this column before moving to the right column unless a heading crosses both columns.";
  const right = "The right column includes values, references, and abbreviations. It is not a table because the content lacks aligned row semantics across repeated columns.";
  if (matrix.columnMode === "single") {
    drawWrappedText(page, `${left} ${right}`, { x: 48, y: topY(height) - 40, width: width - 96, size: 10, font: fonts.regular });
  } else {
    drawWrappedText(page, left, { x: 48, y: topY(height) - 40, width: columnWidth, size: 9.8, font: fonts.regular });
    drawWrappedText(page, right, { x: 48 + columnWidth + gutter, y: topY(height) - 40, width: columnWidth, size: 9.8, font: fonts.regular });
  }
  page.drawText("Cross Column Heading", { x: 48, y: topY(height) - 174, size: 13, font: fonts.bold });
  drawWrappedText(page, "After this heading, the layout returns to paragraph text. The short labels below are section markers rather than table headers.", {
    x: 48,
    y: topY(height) - 198,
    width: width - 96,
    size: 9.8,
    font: fonts.regular
  });
  page.drawText("A. Scope", { x: 66, y: topY(height) - 262, size: 9.4, font: fonts.bold });
  page.drawText("B. Exclusions", { x: width / 2 - 34, y: topY(height) - 262, size: 9.4, font: fonts.bold });
  page.drawText("C. Evidence", { x: width - 150, y: topY(height) - 262, size: 9.4, font: fonts.bold });
  drawFooter(page, fonts, caseId, 1, { width });

  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "reading-order", columns: matrix.columnMode === "single" ? 1 : 2 },
      { type: "heading", span: "full-width" },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

async function buildMixedHeadingCase(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 8 });
  page.drawText("Appendix C", { x: 48, y: topY(height), size: 16, font: fonts.bold });
  page.drawText("NOT A TABLE HEADER", { x: 48, y: topY(height) - 26, size: 9.5, font: fonts.bold });
  drawWrappedText(page, "The uppercase line above is a subordinate heading. It should not be confused with a row of table column headers even though its typography resembles a table label.", {
    x: 48,
    y: topY(height) - 50,
    width: width - 104,
    size: 10.2,
    font: fonts.regular
  });
  const table = drawMatrixTable(page, {
    x: 48,
    y: topY(height) - 132,
    matrix,
    fonts,
    columns: [
      { label: "Column Label", width: 154 },
      { label: "Value", width: 78 }
    ],
    rows: [
      ["Alpha", "42"],
      ["Beta", "53"],
      ["Gamma", "61"]
    ],
    rowGap: 23,
    headerShade: matrix.tableRuling !== "none"
  });
  page.drawText(`${noteMarker(matrix, "*")} This footnote begins below the table.`, {
    x: 48,
    y: table.bbox[1] - 36,
    size: 8,
    font: fonts.regular
  });
  drawFooter(page, fonts, caseId, 1, { width });

  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "heading", text: "NOT A TABLE HEADER", allCaps: true },
      { type: "table", rows: 4, columns: 2, ruling: matrix.tableRuling, bbox: table.bbox },
      { type: "footnote", style: matrix.noteStyle },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

async function buildMultiPageCarryoverTable(pdfDoc, caseId, matrix, rng) {
  const pageRecords = [addPage(pdfDoc, matrix), addPage(pdfDoc, matrix)];
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const structures = [];
  for (let pageIndex = 0; pageIndex < pageRecords.length; pageIndex += 1) {
    const { page, width, height } = pageRecords[pageIndex];
    const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 9 });
    page.drawText(pageIndex === 0 ? "Continuation Table Audit" : "Continuation Table Audit (continued)", {
      x: 48,
      y: topY(height),
      size: 17,
      font: fonts.bold
    });
    const table = drawMatrixTable(page, {
      x: 48,
      y: topY(height) - 48,
      matrix,
      fonts,
      rowGap: matrix.density === "dense" ? 21 : 26,
      columns: [
        { label: "Ref", width: 62 },
        { label: "Finding", width: 190 },
        { label: "Severity", width: 78 },
        { label: "Owner", width: 96 },
        { label: "Due", width: 62 }
      ],
      rows: Array.from({ length: matrix.density === "open" ? 5 : 8 }, (_, index) => [
        `R${pageIndex + 1}-${index + 1}`,
        index % 2 === 0 ? "Header ambiguity" : "Footnote carryover",
        index % 3 === 0 ? "high" : "med",
        index % 2 === 0 ? "layout" : "semantic",
        `Q${(index % 4) + 1}`
      ]),
      headerShade: true
    });
    structures.push({ type: "table-fragment", pageNumber: pageIndex + 1, ruling: matrix.tableRuling, bbox: table.bbox });
    structures.push({ type: "artifact-noise", pageNumber: pageIndex + 1, profile: noise.type, count: noise.count });
    drawFooter(page, fonts, caseId, pageIndex + 1, { width });
  }
  return {
    pageCount: 2,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "table", rows: matrix.density === "open" ? 12 : 18, columns: 5, spansPages: true },
      ...structures
    ]
  };
}

async function buildFormKeyValueGrid(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 5 });
  page.drawText("Program Intake Form", { x: 48, y: topY(height), size: 18, font: fonts.bold });
  drawWrappedText(page, "This form-like page is built from key-value pairs, checkboxes, short notes, and a compact approval grid.", {
    x: 48,
    y: topY(height) - 30,
    width: width - 96,
    size: 9.8,
    font: fonts.regular
  });
  const yStart = topY(height) - 82;
  const fields = [
    ["Applicant", "North District Office"],
    ["Request ID", `REQ-${caseId.slice(-4)}`],
    ["Review date", "2026-04-22"],
    ["Status", "Pending manual review"],
    ["Document type", "borderless evidence package"],
    ["Escalation", matrix.stampStyle === "confidential" ? "restricted" : "standard"]
  ];
  for (let index = 0; index < fields.length; index += 1) {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 48 + column * Math.min(260, (width - 96) / 2);
    const y = yStart - row * 42;
    page.drawText(fields[index][0], { x, y, size: 8, font: fonts.bold });
    page.drawRectangle({ x, y: y - 22, width: 208, height: 17, borderWidth: 0.5, borderColor: rgb(0.5, 0.5, 0.5) });
    page.drawText(fields[index][1], { x: x + 5, y: y - 17, size: 8.2, font: fonts.regular });
  }
  const checkY = yStart - 152;
  for (let index = 0; index < 4; index += 1) {
    const x = 52 + index * 118;
    page.drawRectangle({ x, y: checkY, width: 10, height: 10, borderColor: rgb(0, 0, 0), borderWidth: 0.6 });
    if ((index + caseId.length) % 2 === 0) {
      page.drawLine({ start: { x: x + 2, y: checkY + 5 }, end: { x: x + 8, y: checkY + 8 }, thickness: 0.8 });
      page.drawLine({ start: { x: x + 8, y: checkY + 8 }, end: { x: x + 11, y: checkY + 1 }, thickness: 0.8 });
    }
    page.drawText(["Verified", "Needs OCR", "Table risk", "Footnotes"][index], { x: x + 16, y: checkY + 1, size: 8, font: fonts.regular });
  }
  drawFooter(page, fonts, caseId, 1, { width });
  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "form-like-key-value-grid", fields: fields.length, checkboxes: 4 },
      { type: "short-note", style: matrix.noteStyle },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

async function buildRotatedMarginalia(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 12 });
  page.drawText("Marginalia And Main Text", { x: 60, y: topY(height), size: 18, font: fonts.bold });
  drawWrappedText(page, "The main article text occupies a stable central column. Rotated marginal notes and stamps should be artifact candidates unless they are explicitly referenced by the paragraph.", {
    x: 84,
    y: topY(height) - 40,
    width: width - 180,
    size: 10,
    font: fonts.regular
  });
  drawWrappedText(page, "A second paragraph includes a bracketed note marker [2] that should be distinguished from the rotated side label.", {
    x: 84,
    y: topY(height) - 116,
    width: width - 180,
    size: 10,
    font: fonts.regular
  });
  page.drawText("SIDE NOTE", {
    x: 30,
    y: topY(height) - 210,
    size: 10,
    font: fonts.bold,
    color: rgb(0.38, 0.38, 0.38),
    rotate: degrees(90)
  });
  page.drawText("DRAFT", {
    x: width - 36,
    y: topY(height) - 90,
    size: 9,
    font: fonts.bold,
    color: rgb(0.55, 0.06, 0.06),
    rotate: degrees(90)
  });
  const stamp = drawStamp(page, { x: width - 210, y: topY(height) - 188, fonts, matrix });
  page.drawText("[2] Bottom note belongs to body text, not to the marginalia.", {
    x: 84,
    y: topY(height) - 250,
    size: 8,
    font: fonts.regular
  });
  drawFooter(page, fonts, caseId, 1, { width });
  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "paragraph", shape: "central-column" },
      { type: "rotated-artifact", count: 2 },
      ...(stamp ? [{ type: "artifact-stamp", text: stamp.text, bbox: stamp.bbox, rotation: stamp.rotation }] : []),
      { type: "footnote", marker: "[2]" },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

async function buildDenseNestedList(pdfDoc, caseId, matrix, rng) {
  const { page, width, height } = addPage(pdfDoc, matrix);
  const fonts = await loadFonts(pdfDoc, matrix.typography);
  const noise = drawNoise(page, rng, matrix, { width, height, baseIntensity: 10 });
  page.drawText("Nested List Audit", { x: 48, y: topY(height), size: 18, font: fonts.bold });
  const lines = [
    ["1.", "Primary requirement: preserve list semantics through compact line spacing."],
    ["a.", "Subrequirement: detect marker level without creating a table row."],
    ["i.", "Detail: tiny roman numeral markers are especially ambiguous."],
    ["b.", "Subrequirement: do not merge marker text with the previous paragraph."],
    ["2.", "Primary requirement: separate footnote references from list labels."],
    ["*", "Footnote-like item that is still part of the nested list body."]
  ];
  let y = topY(height) - 42;
  for (const [marker, text] of lines) {
    const depth = marker === "i." ? 2 : marker.length === 2 && /[a-z]\./.test(marker) ? 1 : 0;
    const x = 58 + depth * 24;
    page.drawText(marker, { x, y, size: matrix.density === "dense" ? 8.4 : 9.4, font: fonts.bold });
    const drawn = drawWrappedText(page, text, {
      x: x + 28,
      y,
      width: width - x - 78,
      size: matrix.density === "dense" ? 8.4 : 9.4,
      font: fonts.regular,
      leading: matrix.density === "dense" ? 10.5 : 12.4
    });
    y = drawn.y - (matrix.density === "open" ? 8 : 2);
  }
  page.drawText(`${noteMarker(matrix, "[1]")} Bottom note uses a marker that can be confused with list syntax.`, {
    x: 58,
    y: Math.max(82, y - 28),
    size: 8,
    font: fonts.regular
  });
  drawFooter(page, fonts, caseId, 1, { width });
  return {
    pageCount: 1,
    archetype: matrix.archetype,
    expectedStructures: [
      { type: "nested-list", levels: 3, itemCount: lines.length },
      { type: "footnote", style: matrix.noteStyle },
      { type: "artifact-noise", profile: noise.type, count: noise.count }
    ]
  };
}

const BUILDERS = Object.freeze({
  "stamp-borderless-table": buildStampAndBorderlessTable,
  "numbered-list-endnotes": buildEndnoteListCase,
  "odd-paragraph-shapes": buildOddParagraphCase,
  "sparse-borderless-table": buildSparseTableCase,
  "two-column-noisy-paragraphs": buildTwoColumnCase,
  "mixed-heading-table-footnote": buildMixedHeadingCase,
  "multi-page-carryover-table": buildMultiPageCarryoverTable,
  "form-key-value-grid": buildFormKeyValueGrid,
  "rotated-marginalia": buildRotatedMarginalia,
  "dense-nested-list": buildDenseNestedList
});

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function buildMatrixCoverage(cases) {
  const factorCounts = Object.fromEntries(
    Object.keys(MATRIX_FACTORS).map((factor) => [factor, countBy(cases.map((testCase) => testCase.matrixFactors[factor]))])
  );
  const factorNames = Object.keys(MATRIX_FACTORS);
  const pairCoverage = [];
  let observedPairsTotal = 0;
  let possiblePairsTotal = 0;

  for (let leftIndex = 0; leftIndex < factorNames.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < factorNames.length; rightIndex += 1) {
      const leftFactor = factorNames[leftIndex];
      const rightFactor = factorNames[rightIndex];
      const possible = MATRIX_FACTORS[leftFactor].length * MATRIX_FACTORS[rightFactor].length;
      const observed = new Set(cases.map((testCase) => `${testCase.matrixFactors[leftFactor]}::${testCase.matrixFactors[rightFactor]}`));
      observedPairsTotal += observed.size;
      possiblePairsTotal += possible;
      pairCoverage.push({
        factors: [leftFactor, rightFactor],
        observed: observed.size,
        possible,
        ratio: Number((observed.size / possible).toFixed(4))
      });
    }
  }

  pairCoverage.sort((left, right) => left.ratio - right.ratio || left.factors.join("/").localeCompare(right.factors.join("/")));

  return {
    factorCounts,
    pairCoverageSummary: {
      observedPairsTotal,
      possiblePairsTotal,
      ratio: Number((observedPairsTotal / Math.max(possiblePairsTotal, 1)).toFixed(4)),
      weakestPairs: pairCoverage.slice(0, 10)
    }
  };
}

async function buildCase({ index, outputDir, seed }) {
  const matrix = matrixCaseForIndex(index);
  const caseId = `ftm-${String(index + 1).padStart(5, "0")}`;
  const rngSeed = seed + index * 9973;
  const rng = createRng(rngSeed);
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`OpenAutoTag fine tuned matrix testcase ${caseId}`);
  pdfDoc.setSubject("Synthetic ML training testcase with explicit matrix coverage intent");
  pdfDoc.setProducer("OpenAutoTag fine-tuned matrix corpus generator");
  pdfDoc.setCreator("OpenAutoTag");
  const manifest = await BUILDERS[matrix.archetype](pdfDoc, caseId, matrix, rng);
  const fileName = `${caseId}-${sanitizePathSegment(matrix.archetype)}.pdf`;
  const pdfPath = path.join(outputDir, fileName);
  await writeFile(pdfPath, await pdfDoc.save());

  return {
    caseId,
    fileName,
    pdfPath,
    seed: rngSeed,
    matrixFactors: matrix,
    pageCount: manifest.pageCount,
    archetype: manifest.archetype,
    expectedStructures: manifest.expectedStructures
  };
}

export async function generateFineTunedTestcases({
  outputDir = DEFAULT_OUTPUT_DIR,
  count = 180,
  seed = 20260422
} = {}) {
  const resolvedOutputDir = path.resolve(outputDir);
  const resolvedCount = Math.max(1, Math.min(5000, Number(count) || 180));
  const resolvedSeed = Number.isFinite(Number(seed)) ? Number(seed) : 20260422;
  await mkdir(resolvedOutputDir, { recursive: true });

  const cases = [];
  for (let index = 0; index < resolvedCount; index += 1) {
    cases.push(await buildCase({ index, outputDir: resolvedOutputDir, seed: resolvedSeed }));
  }

  const archetypeCounts = countBy(cases.map((testCase) => testCase.archetype));
  const matrixCoverage = buildMatrixCoverage(cases);
  const manifest = {
    schemaVersion: "0.2.0",
    generatedAt: new Date().toISOString(),
    generator: {
      name: "generate-fine-tuned-testcases",
      seed: resolvedSeed,
      deterministic: true,
      matrixStrategy: "balanced-cyclic-factor-schedule",
      matrixFactorCount: Object.keys(MATRIX_FACTORS).length
    },
    outputDir: resolvedOutputDir,
    count: cases.length,
    matrixFactors: MATRIX_FACTORS,
    matrixCoverage,
    archetypeCounts,
    cases
  };
  const manifestPath = path.join(resolvedOutputDir, "fine-tuned-testcase-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    ...manifest,
    manifestPath
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await generateFineTunedTestcases({
    outputDir: args.get("--output-dir") || DEFAULT_OUTPUT_DIR,
    count: args.get("--count") ? Number(args.get("--count")) : 180,
    seed: args.get("--seed") ? Number(args.get("--seed")) : 20260422
  });

  process.stdout.write(`${JSON.stringify({
    manifestPath: result.manifestPath,
    outputDir: result.outputDir,
    count: result.count,
    archetypeCounts: result.archetypeCounts,
    pairCoverageSummary: result.matrixCoverage.pairCoverageSummary
  }, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
