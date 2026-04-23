import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

const DEFAULT_PAGE_WIDTH = 612;
const DEFAULT_PAGE_HEIGHT = 792;
const MAX_TEXT_LENGTH = 180;

const pageSizeCache = new Map();

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;"
    };
    return entities[character];
  });
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 3)}...` : text;
}

function normalizeBbox(bbox, page) {
  const [rawX, rawY, rawWidth, rawHeight] = Array.isArray(bbox) ? bbox : [0, 0, page.width, page.height];
  const x = clamp(numberOr(rawX, 0), 0, page.width);
  const y = clamp(numberOr(rawY, 0), 0, page.height);
  const width = clamp(numberOr(rawWidth, page.width), 1, Math.max(1, page.width - x));
  const height = clamp(numberOr(rawHeight, 24), 1, Math.max(1, page.height - y));
  return { x, y, width, height };
}

async function readPdfPageSize(pdfPath, pageNumber) {
  const cacheKey = `${pdfPath}:${pageNumber}`;
  if (pageSizeCache.has(cacheKey)) {
    return pageSizeCache.get(cacheKey);
  }

  let size = {
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
    source: "fallback"
  };

  if (pdfPath) {
    try {
      const bytes = await readFile(pdfPath);
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pageIndex = clamp(Math.round(numberOr(pageNumber, 1)) - 1, 0, Math.max(0, pdf.getPageCount() - 1));
      const page = pdf.getPage(pageIndex);
      const pageSize = page.getSize();
      size = {
        width: numberOr(pageSize.width, DEFAULT_PAGE_WIDTH),
        height: numberOr(pageSize.height, DEFAULT_PAGE_HEIGHT),
        source: "pdf-lib"
      };
    } catch {
      size = {
        width: DEFAULT_PAGE_WIDTH,
        height: DEFAULT_PAGE_HEIGHT,
        source: "fallback"
      };
    }
  }

  pageSizeCache.set(cacheKey, size);
  return size;
}

function renderGrid(width, height) {
  const lines = [];
  for (let x = 0; x <= width; x += 72) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" class="grid-line" />`);
  }
  for (let y = 0; y <= height; y += 72) {
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" class="grid-line" />`);
  }
  return lines.join("\n");
}

function buildCalloutGeometry(page, bbox) {
  const calloutWidth = 250;
  const calloutHeight = 170;
  const gutter = 28;
  const rightSpace = page.width + gutter + calloutWidth;
  const x = page.width + gutter;
  const y = clamp(bbox.y + bbox.height / 2 - calloutHeight / 2, 0, Math.max(0, page.height - calloutHeight));
  return {
    pageAndCalloutWidth: rightSpace,
    x,
    y,
    width: calloutWidth,
    height: calloutHeight,
    anchorX: bbox.x + bbox.width,
    anchorY: bbox.y + bbox.height / 2
  };
}

function renderWrappedSvgText(text, { x, y, width, lineHeight = 15, maxLines = 5, className = "callout-text" }) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  const approximateCharsPerLine = Math.max(16, Math.floor(width / 7));

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > approximateCharsPerLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) {
    lines.push(line);
  }

  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines && visible.length > 0) {
    visible[visible.length - 1] = `${visible[visible.length - 1].replace(/\.*$/, "")}...`;
  }

  return visible
    .map((lineText, index) => `<text x="${x}" y="${y + index * lineHeight}" class="${className}">${escapeXml(lineText)}</text>`)
    .join("\n");
}

function renderRasterImage(page, rasterDataUri) {
  if (!rasterDataUri) {
    return "";
  }

  return `<image class="raster-page" href="${escapeXml(rasterDataUri)}" x="0" y="0" width="${page.width}" height="${page.height}" preserveAspectRatio="none" />`;
}

export async function buildHumanReviewSampleSvg(item, { rasterDataUri = null, rasterSource = null } = {}) {
  const page = await readPdfPageSize(item.sourcePdf, item.target?.pageNumber);
  const bbox = normalizeBbox(item.target?.bbox, page);
  const callout = buildCalloutGeometry(page, bbox);
  const pad = 18;
  const svgWidth = callout.pageAndCalloutWidth + pad * 2;
  const svgHeight = page.height + pad * 2;
  const label = `${item.predictedLabel || "unknown"} / ${Math.round(numberOr(item.confidence, 0) * 1000) / 10}%`;
  const bboxLabelY = bbox.y > 24 ? bbox.y - 7 : bbox.y + bbox.height + 15;
  const pointRadius = Math.max(5, Math.min(12, Math.max(bbox.width, bbox.height) * 0.15));
  const pageSource = rasterSource || `Page size from ${page.source}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-labelledby="title desc">
  <title id="title">Human review sample for ${escapeXml(item.predictionId)}</title>
  <desc id="desc">Page ${escapeXml(item.target?.pageNumber || "unknown")} with the classified region outlined and magnified as a callout.</desc>
  <style>
    .page { fill: #fff; stroke: #9aa7a4; stroke-width: 1.5; }
    .raster-page { image-rendering: auto; }
    .grid-line { stroke: #e7ece9; stroke-width: 1; opacity: ${rasterDataUri ? "0.16" : "1"}; }
    .target { fill: rgba(9, 108, 79, 0.13); stroke: #096c4f; stroke-width: 3; }
    .target-center { fill: #096c4f; stroke: #fff; stroke-width: 2; }
    .target-label { fill: #096c4f; font: 700 15px Segoe UI, Arial, sans-serif; }
    .callout { fill: #fbfcfa; stroke: #d8dfdc; stroke-width: 1.5; }
    .callout-title { fill: #172326; font: 700 16px Segoe UI, Arial, sans-serif; }
    .callout-text { fill: #172326; font: 13px Segoe UI, Arial, sans-serif; }
    .callout-muted { fill: #5b686c; font: 12px Segoe UI, Arial, sans-serif; }
    .leader { stroke: #096c4f; stroke-width: 2; fill: none; stroke-dasharray: 5 5; }
  </style>
  <rect width="100%" height="100%" fill="#f7f8f6" />
  <g transform="translate(${pad}, ${pad})">
    <rect class="page" x="0" y="0" width="${page.width}" height="${page.height}" rx="4" />
    ${renderRasterImage(page, rasterDataUri)}
    ${renderGrid(page.width, page.height)}
    <rect class="target" x="${bbox.x}" y="${bbox.y}" width="${bbox.width}" height="${bbox.height}" rx="2" />
    <circle class="target-center" cx="${bbox.x + bbox.width / 2}" cy="${bbox.y + bbox.height / 2}" r="${pointRadius}" />
    <text class="target-label" x="${bbox.x}" y="${bboxLabelY}">${escapeXml(label)}</text>
    <path class="leader" d="M ${callout.anchorX} ${callout.anchorY} C ${callout.x - 20} ${callout.anchorY}, ${callout.x - 20} ${callout.y + 42}, ${callout.x} ${callout.y + 42}" />
    <g>
      <rect class="callout" x="${callout.x}" y="${callout.y}" width="${callout.width}" height="${callout.height}" rx="8" />
      <text class="callout-title" x="${callout.x + 14}" y="${callout.y + 28}">Selected sample</text>
      <text class="callout-muted" x="${callout.x + 14}" y="${callout.y + 48}">Page ${escapeXml(item.target?.pageNumber || "n/a")} / bbox ${escapeXml(`${bbox.x.toFixed(1)}, ${bbox.y.toFixed(1)}, ${bbox.width.toFixed(1)}, ${bbox.height.toFixed(1)}`)}</text>
      <text class="callout-muted" x="${callout.x + 14}" y="${callout.y + 66}">${escapeXml(pageSource)}: ${escapeXml(`${page.width.toFixed(1)} x ${page.height.toFixed(1)}`)}</text>
      ${renderWrappedSvgText(item.text || "(no semantic text available)", {
        x: callout.x + 14,
        y: callout.y + 94,
        width: callout.width - 28
      })}
    </g>
  </g>
</svg>
`;
}
