import Ajv2020 from "ajv/dist/2020.js";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import layoutSchema from "../contracts/layout.schema.json" with { type: "json" };
import tableStructureSchema from "../contracts/table-structure.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateLayout = ajv.compile(layoutSchema);
const validateTableStructure = ajv.compile(tableStructureSchema);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const buildDir = path.join(scriptDir, ".build");
const javaSourcePath = path.join(scriptDir, "java", "TableStructureExtractorCli.java");
const javaClassPath = path.join(buildDir, "TableStructureExtractorCli.class");
const pdfboxJarPath = path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    pdfPath: args.get("--pdf"),
    layoutPath: args.get("--layout"),
    outputPath: args.get("--output")
  };
}

function execCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function needsCompilation() {
  try {
    const [sourceStats, classStats] = await Promise.all([stat(javaSourcePath), stat(javaClassPath)]);
    return sourceStats.mtimeMs > classStats.mtimeMs;
  } catch {
    return true;
  }
}

async function ensureJavaHelperCompiled() {
  await mkdir(buildDir, { recursive: true });

  if (!(await needsCompilation())) {
    return;
  }

  await execCommand("javac", [
    "-encoding",
    "UTF-8",
    "-cp",
    pdfboxJarPath,
    "-d",
    buildDir,
    javaSourcePath
  ]);
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bboxCenterX(bbox) {
  return bbox[0] + bbox[2] / 2;
}

function bboxCenterY(bbox) {
  return bbox[1] + bbox[3] / 2;
}

function bboxContainsPoint(bbox, x, y, margin = 0) {
  return (
    x >= bbox[0] - margin &&
    x <= bbox[0] + bbox[2] + margin &&
    y >= bbox[1] - margin &&
    y <= bbox[1] + bbox[3] + margin
  );
}

function clusterByTolerance(items, measureFn, tolerance) {
  const sorted = [...items].sort((left, right) => measureFn(left) - measureFn(right));
  const clusters = [];

  for (const item of sorted) {
    const value = measureFn(item);
    const current = clusters.at(-1);

    if (!current || Math.abs(value - current.centroid) > tolerance) {
      clusters.push({
        items: [item],
        centroid: value
      });
      continue;
    }

    current.items.push(item);
    current.centroid = current.items.reduce((total, clusterItem) => total + measureFn(clusterItem), 0) / current.items.length;
  }

  return clusters;
}

function normalizeSegments(pageVector, pageHeight) {
  const normalized = [];

  for (const segment of pageVector.segments || []) {
    if (segment.orientation === "horizontal") {
      normalized.push({
        orientation: "horizontal",
        xStart: round(Math.min(segment.x1, segment.x2)),
        xEnd: round(Math.max(segment.x1, segment.x2)),
        y: round(pageHeight - ((segment.y1 + segment.y2) / 2)),
        lineWidth: round(segment.lineWidth),
        length: round(segment.length)
      });
      continue;
    }

    if (segment.orientation === "vertical") {
      const upper = Math.max(segment.y1, segment.y2);
      const lower = Math.min(segment.y1, segment.y2);
      normalized.push({
        orientation: "vertical",
        x: round((segment.x1 + segment.x2) / 2),
        yStart: round(pageHeight - upper),
        yEnd: round(pageHeight - lower),
        lineWidth: round(segment.lineWidth),
        length: round(segment.length)
      });
    }
  }

  return normalized.filter((segment) => segment.length >= 18);
}

function mergeHorizontalSegments(segments, tolerance = 2, gapTolerance = 14) {
  return clusterByTolerance(segments, (segment) => segment.y, tolerance).flatMap((cluster, clusterIndex) => {
    const ordered = [...cluster.items].sort((left, right) => left.xStart - right.xStart);
    const merged = [];

    for (const segment of ordered) {
      const current = merged.at(-1);
      if (!current || segment.xStart - current.xEnd > gapTolerance) {
        merged.push({
          id: `h-${clusterIndex}-${merged.length}`,
          y: round(cluster.centroid),
          xStart: segment.xStart,
          xEnd: segment.xEnd,
          lineWidth: segment.lineWidth
        });
        continue;
      }

      current.xEnd = Math.max(current.xEnd, segment.xEnd);
      current.lineWidth = round((current.lineWidth + segment.lineWidth) / 2);
    }

    return merged
      .map((segment) => ({
        ...segment,
        length: round(segment.xEnd - segment.xStart)
      }))
      .filter((segment) => segment.length >= 24);
  });
}

function mergeVerticalSegments(segments, tolerance = 2, gapTolerance = 14) {
  return clusterByTolerance(segments, (segment) => segment.x, tolerance).flatMap((cluster, clusterIndex) => {
    const ordered = [...cluster.items].sort((left, right) => left.yStart - right.yStart);
    const merged = [];

    for (const segment of ordered) {
      const current = merged.at(-1);
      if (!current || segment.yStart - current.yEnd > gapTolerance) {
        merged.push({
          id: `v-${clusterIndex}-${merged.length}`,
          x: round(cluster.centroid),
          yStart: segment.yStart,
          yEnd: segment.yEnd,
          lineWidth: segment.lineWidth
        });
        continue;
      }

      current.yEnd = Math.max(current.yEnd, segment.yEnd);
      current.lineWidth = round((current.lineWidth + segment.lineWidth) / 2);
    }

    return merged
      .map((segment) => ({
        ...segment,
        length: round(segment.yEnd - segment.yStart)
      }))
      .filter((segment) => segment.length >= 24);
  });
}

function buildConnectedComponents(horizontalSegments, verticalSegments, tolerance = 3) {
  const visited = new Set();
  const components = [];

  function horizontalKey(segment) {
    return `h:${segment.id}`;
  }

  function verticalKey(segment) {
    return `v:${segment.id}`;
  }

  function connectedHorizontals(vertical) {
    return horizontalSegments.filter(
      (horizontal) =>
        vertical.x >= horizontal.xStart - tolerance &&
        vertical.x <= horizontal.xEnd + tolerance &&
        horizontal.y >= vertical.yStart - tolerance &&
        horizontal.y <= vertical.yEnd + tolerance
    );
  }

  function connectedVerticals(horizontal) {
    return verticalSegments.filter(
      (vertical) =>
        vertical.x >= horizontal.xStart - tolerance &&
        vertical.x <= horizontal.xEnd + tolerance &&
        horizontal.y >= vertical.yStart - tolerance &&
        horizontal.y <= vertical.yEnd + tolerance
    );
  }

  for (const horizontal of horizontalSegments) {
    const startKey = horizontalKey(horizontal);
    if (visited.has(startKey)) {
      continue;
    }

    const queue = [startKey];
    const componentHorizontals = [];
    const componentVerticals = [];

    while (queue.length > 0) {
      const key = queue.shift();
      if (visited.has(key)) {
        continue;
      }

      visited.add(key);

      if (key.startsWith("h:")) {
        const segment = horizontalSegments.find((item) => horizontalKey(item) === key);
        if (!segment) {
          continue;
        }
        componentHorizontals.push(segment);
        for (const vertical of connectedVerticals(segment)) {
          const verticalKeyValue = verticalKey(vertical);
          if (!visited.has(verticalKeyValue)) {
            queue.push(verticalKeyValue);
          }
        }
      } else {
        const segment = verticalSegments.find((item) => verticalKey(item) === key);
        if (!segment) {
          continue;
        }
        componentVerticals.push(segment);
        for (const horizontalMatch of connectedHorizontals(segment)) {
          const horizontalKeyValue = horizontalKey(horizontalMatch);
          if (!visited.has(horizontalKeyValue)) {
            queue.push(horizontalKeyValue);
          }
        }
      }
    }

    if (componentHorizontals.length > 0 || componentVerticals.length > 0) {
      components.push({
        horizontals: componentHorizontals,
        verticals: componentVerticals
      });
    }
  }

  return components;
}

function segmentCoversBand(segment, start, end, tolerance = 2) {
  return segment.yStart <= start + tolerance && segment.yEnd >= end - tolerance;
}

function horizontalCoversBand(segment, start, end, tolerance = 2) {
  return segment.xStart <= start + tolerance && segment.xEnd >= end - tolerance;
}

function buildGridClusters(segments, orientation) {
  const tolerance = 2;
  const measureFn = orientation === "horizontal" ? (segment) => segment.y : (segment) => segment.x;
  return clusterByTolerance(segments, measureFn, tolerance)
    .map((cluster) => ({
      position: round(cluster.centroid),
      segments: [...cluster.items].sort((left, right) =>
        orientation === "horizontal" ? left.xStart - right.xStart : left.yStart - right.yStart
      )
    }))
    .sort((left, right) => left.position - right.position);
}

function detectMergeSignals(horizontalGrid, verticalGrid) {
  const mergeSignals = [];

  for (let dividerIndex = 1; dividerIndex < verticalGrid.length - 1; dividerIndex += 1) {
    const divider = verticalGrid[dividerIndex];

    for (let rowIndex = 0; rowIndex < horizontalGrid.length - 1; rowIndex += 1) {
      const start = horizontalGrid[rowIndex].position;
      const end = horizontalGrid[rowIndex + 1].position;
      const hasCoverage = divider.segments.some((segment) => segmentCoversBand(segment, start, end));

      if (!hasCoverage) {
        mergeSignals.push({
          kind: "colspan",
          rowIndex,
          columnIndex: dividerIndex - 1,
          reason: "Missing interior vertical divider segment within ruled grid."
        });
      }
    }
  }

  for (let dividerIndex = 1; dividerIndex < horizontalGrid.length - 1; dividerIndex += 1) {
    const divider = horizontalGrid[dividerIndex];

    for (let columnIndex = 0; columnIndex < verticalGrid.length - 1; columnIndex += 1) {
      const start = verticalGrid[columnIndex].position;
      const end = verticalGrid[columnIndex + 1].position;
      const hasCoverage = divider.segments.some((segment) => horizontalCoversBand(segment, start, end));

      if (!hasCoverage) {
        mergeSignals.push({
          kind: "rowspan",
          rowIndex: dividerIndex - 1,
          columnIndex,
          reason: "Missing interior horizontal divider segment within ruled grid."
        });
      }
    }
  }

  return mergeSignals;
}

function hasColspanMerge(mergeSignals, rowIndex, columnIndex) {
  return mergeSignals.some(
    (signal) =>
      signal.kind === "colspan" &&
      signal.rowIndex === rowIndex &&
      signal.columnIndex === columnIndex
  );
}

function hasRowspanMerge(mergeSignals, rowIndex, columnIndex) {
  return mergeSignals.some(
    (signal) =>
      signal.kind === "rowspan" &&
      signal.rowIndex === rowIndex &&
      signal.columnIndex === columnIndex
  );
}

function buildCells(horizontalGrid, verticalGrid, mergeSignals) {
  const rowCount = horizontalGrid.length - 1;
  const columnCount = verticalGrid.length - 1;
  const occupied = new Set();
  const cells = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const key = `${rowIndex}:${columnIndex}`;
      if (occupied.has(key)) {
        continue;
      }

      let columnSpan = 1;
      while (
        columnIndex + columnSpan < columnCount &&
        hasColspanMerge(mergeSignals, rowIndex, columnIndex + columnSpan - 1)
      ) {
        columnSpan += 1;
      }

      let rowSpan = 1;
      let canGrow = true;
      while (rowIndex + rowSpan < rowCount && canGrow) {
        for (let spanColumn = columnIndex; spanColumn < columnIndex + columnSpan; spanColumn += 1) {
          if (!hasRowspanMerge(mergeSignals, rowIndex + rowSpan - 1, spanColumn)) {
            canGrow = false;
            break;
          }
        }

        if (canGrow) {
          rowSpan += 1;
        }
      }

      for (let coveredRow = rowIndex; coveredRow < rowIndex + rowSpan; coveredRow += 1) {
        for (let coveredColumn = columnIndex; coveredColumn < columnIndex + columnSpan; coveredColumn += 1) {
          occupied.add(`${coveredRow}:${coveredColumn}`);
        }
      }

      cells.push({
        rowIndex,
        columnIndex,
        rowSpan,
        columnSpan,
        bbox: [
          round(verticalGrid[columnIndex].position),
          round(horizontalGrid[rowIndex].position),
          round(verticalGrid[columnIndex + columnSpan].position - verticalGrid[columnIndex].position),
          round(horizontalGrid[rowIndex + rowSpan].position - horizontalGrid[rowIndex].position)
        ],
        assignedBlockIds: []
      });
    }
  }

  return cells;
}

function assignBlocksToCells(cells, textBlocks) {
  for (const cell of cells) {
    const assigned = textBlocks.filter((block) =>
      bboxContainsPoint(cell.bbox, bboxCenterX(block.bbox), bboxCenterY(block.bbox), 2)
    );
    cell.assignedBlockIds = assigned.map((block) => block.id);
  }
}

function buildTableCandidate(page, component, tableIndex) {
  const horizontalGrid = buildGridClusters(component.horizontals, "horizontal");
  const verticalGrid = buildGridClusters(component.verticals, "vertical");

  if (horizontalGrid.length < 3 || verticalGrid.length < 3) {
    return null;
  }

  const rowCount = horizontalGrid.length - 1;
  const columnCount = verticalGrid.length - 1;
  const bbox = [
    round(verticalGrid[0].position),
    round(horizontalGrid[0].position),
    round(verticalGrid.at(-1).position - verticalGrid[0].position),
    round(horizontalGrid.at(-1).position - horizontalGrid[0].position)
  ];

  if (bbox[2] < 64 || bbox[3] < 36) {
    return null;
  }

  const mergeSignals = detectMergeSignals(horizontalGrid, verticalGrid);
  const cells = buildCells(horizontalGrid, verticalGrid, mergeSignals);
  const blocksInside = page.textBlocks.filter((block) =>
    bboxContainsPoint(bbox, bboxCenterX(block.bbox), bboxCenterY(block.bbox), 4)
  );

  assignBlocksToCells(cells, blocksInside);

  const blockDensity = blocksInside.length / Math.max(1, rowCount * columnCount);
  const dividerSignals = mergeSignals.length;
  const confidence = clamp(
    0.62 +
      Math.min(0.18, rowCount * 0.03) +
      Math.min(0.12, columnCount * 0.03) +
      Math.min(0.08, blockDensity * 0.08) +
      Math.min(0.06, dividerSignals * 0.02),
    0,
    0.97
  );

  if (blocksInside.length < 2) {
    return null;
  }

  return {
    id: `vector-table:${page.pageNumber}:${tableIndex}`,
    source: "vector-grid",
    bbox,
    rowCount,
    columnCount,
    confidence: round(confidence),
    assignedBlockIds: blocksInside.map((block) => block.id),
    mergeSignals,
    cells
  };
}

function analyzePageTables(page, pageVector) {
  const normalizedSegments = normalizeSegments(pageVector, page.height);
  const horizontalSegments = mergeHorizontalSegments(normalizedSegments.filter((segment) => segment.orientation === "horizontal"));
  const verticalSegments = mergeVerticalSegments(normalizedSegments.filter((segment) => segment.orientation === "vertical"));
  const components = buildConnectedComponents(horizontalSegments, verticalSegments);
  const tables = [];

  for (const component of components) {
    const table = buildTableCandidate(page, component, tables.length + 1);
    if (table) {
      tables.push(table);
    }
  }

  return {
    pageNumber: page.pageNumber,
    vectorSummary: {
      strokedSegmentCount: normalizedSegments.length,
      horizontalSegmentCount: horizontalSegments.length,
      verticalSegmentCount: verticalSegments.length
    },
    tables
  };
}

async function extractRuledTableGeometry(pdfPath) {
  await ensureJavaHelperCompiled();
  const stdout = await execCommand("java", [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJarPath}`,
    "TableStructureExtractorCli",
    "--pdf",
    path.resolve(pdfPath)
  ]);
  return JSON.parse(stdout);
}

export async function buildTableStructureMap({ pdfPath, layoutPath, outputPath }) {
  if (!pdfPath || !layoutPath) {
    throw new Error("Usage: node scripts/build-table-structure-map.js --pdf <input.pdf> --layout <layout.json> [--output <map.json>]");
  }

  const layoutDocument = JSON.parse(await readFile(layoutPath, "utf8"));
  if (!validateLayout(layoutDocument)) {
    throw new Error(`Table structure map input failed schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  const extracted = await extractRuledTableGeometry(pdfPath);
  const vectorPages = new Map((extracted.pages || []).map((page) => [page.pageNumber, page]));
  const pages = layoutDocument.pages.map((page) =>
    analyzePageTables(page, vectorPages.get(page.pageNumber) || { pageNumber: page.pageNumber, segments: [] })
  );

  const result = {
    schemaVersion: "1.0.0",
    status: "completed",
    pdfPath: path.resolve(pdfPath),
    layoutPath: path.resolve(layoutPath),
    pageCount: layoutDocument.pages.length,
    pages,
    summary: {
      detectedTables: pages.reduce((total, page) => total + page.tables.length, 0),
      pagesWithTables: pages.filter((page) => page.tables.length > 0).length,
      totalMergeSignals: pages.reduce(
        (total, page) => total + page.tables.reduce((pageTotal, table) => pageTotal + table.mergeSignals.length, 0),
        0
      )
    }
  };

  if (!validateTableStructure(result)) {
    throw new Error(`Table structure map output failed schema validation: ${ajv.errorsText(validateTableStructure.errors)}`);
  }

  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildTableStructureMap(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
