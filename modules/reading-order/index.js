import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import semanticSchema from "../../contracts/semantic.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validateSemantic = ajv.compile(semanticSchema);

function isArtifactNode(node) {
  return node.role === "Artifact" || node.artifactType != null;
}

function isHeaderArtifact(node) {
  return isArtifactNode(node) && String(node.artifactType || "").toLowerCase() === "header";
}

function isFooterArtifact(node) {
  return isArtifactNode(node) && String(node.artifactType || "").toLowerCase() === "footer";
}

function isTableNode(node) {
  return (
    node.role === "Table" ||
    node.role === "TH" ||
    node.role === "TD" ||
    node.tableId != null ||
    node.tableRowIndex != null ||
    node.tableColumnIndex != null
  );
}

function isListNode(node) {
  return node.role === "LI" || node.listGroupId != null;
}

function compareNumbers(left, right) {
  return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
}

function getNodeTop(node) {
  return Array.isArray(node.bbox) ? node.bbox[1] : 0;
}

function getNodeLeft(node) {
  return Array.isArray(node.bbox) ? node.bbox[0] : 0;
}

function getNodeRight(node) {
  return Array.isArray(node.bbox) ? node.bbox[0] + node.bbox[2] : getNodeLeft(node);
}

function getNodeBottom(node) {
  return Array.isArray(node.bbox) ? node.bbox[1] + node.bbox[3] : getNodeTop(node);
}

function getNodeColumnHint(node) {
  return Number.isInteger(node.columnHint) ? node.columnHint : null;
}

function rolePriority(node) {
  if (node.role && /^H\d$/.test(node.role)) {
    return 0;
  }
  if (node.role === "LI") {
    return 1;
  }
  if (node.role === "P") {
    return 2;
  }
  if (node.role === "TH") {
    return 3;
  }
  if (node.role === "TD") {
    return 3;
  }
  if (node.role === "Table") {
    return 4;
  }
  return 5;
}

function buildColumnBands(units) {
  const explicitColumns = units
    .map((unit) => unit.explicitColumnHint)
    .filter((value) => Number.isInteger(value));

  if (explicitColumns.length > 0) {
    return [...new Set(explicitColumns)].sort((left, right) => left - right).map((index) => ({
      index,
      minX: null,
      maxX: null
    }));
  }

  const xValues = units
    .map((unit) => unit.left)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (xValues.length === 0) {
    return [{ index: 0, minX: 0, maxX: 0 }];
  }

  const span = xValues[xValues.length - 1] - xValues[0];
  const threshold = Math.max(64, span * 0.18);
  const bands = [{ index: 0, minX: xValues[0], maxX: xValues[0] }];

  for (const x of xValues.slice(1)) {
    const lastBand = bands[bands.length - 1];
    if (x - lastBand.maxX > threshold) {
      bands.push({ index: bands.length, minX: x, maxX: x });
      continue;
    }

    lastBand.maxX = x;
  }

  return bands;
}

function assignColumnIndex(unit, bands) {
  if (Number.isInteger(unit.explicitColumnHint)) {
    return unit.explicitColumnHint;
  }

  if (bands.length <= 1) {
    return 0;
  }

  let bestIndex = 0;
  let bestDistance = Infinity;

  for (const band of bands) {
    const center =
      band.minX == null || band.maxX == null ? unit.left : (band.minX + band.maxX) / 2;
    const distance = Math.abs(unit.left - center);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = band.index;
    }
  }

  return bestIndex;
}

function compareUnits(left, right) {
  return (
    compareNumbers(left.pageNumber, right.pageNumber) ||
    compareNumbers(left.phase, right.phase) ||
    compareNumbers(left.columnIndex, right.columnIndex) ||
    compareNumbers(left.top, right.top) ||
    compareNumbers(left.left, right.left) ||
    compareNumbers(left.priority, right.priority) ||
    left.sortKey.localeCompare(right.sortKey)
  );
}

function compareSpanningUnits(left, right) {
  return (
    compareNumbers(left.pageNumber, right.pageNumber) ||
    compareNumbers(left.top, right.top) ||
    compareNumbers(left.left, right.left) ||
    compareNumbers(left.priority, right.priority) ||
    left.sortKey.localeCompare(right.sortKey)
  );
}

function collectUnitBounds(nodes) {
  return {
    top: Math.min(...nodes.map(getNodeTop)),
    left: Math.min(...nodes.map(getNodeLeft)),
    right: Math.max(...nodes.map(getNodeRight)),
    bottom: Math.max(...nodes.map(getNodeBottom))
  };
}

function collectExplicitColumnHints(nodes) {
  return [...new Set(nodes.map(getNodeColumnHint).filter((value) => Number.isInteger(value)))];
}

function makeContentUnit(node) {
  const bounds = collectUnitBounds([node]);
  return {
    kind: "content",
    pageNumber: node.pageNumber,
    nodes: [node],
    ...bounds,
    explicitColumnHint: getNodeColumnHint(node),
    explicitColumnHints: collectExplicitColumnHints([node]),
    priority: rolePriority(node),
    sortKey: node.id,
    phase: 1
  };
}

function makeArtifactUnit(node) {
  const bounds = collectUnitBounds([node]);
  return {
    kind: "artifact",
    pageNumber: node.pageNumber,
    nodes: [node],
    ...bounds,
    explicitColumnHint: getNodeColumnHint(node),
    explicitColumnHints: collectExplicitColumnHints([node]),
    priority: 0,
    sortKey: node.id,
    phase: isFooterArtifact(node) ? 2 : 0
  };
}

function makeListUnit(groupId, nodes) {
  const sortedNodes = [...nodes].sort((left, right) => {
    return (
      compareNumbers(left.listItemIndex, right.listItemIndex) ||
      compareNumbers(getNodeTop(left), getNodeTop(right)) ||
      compareNumbers(getNodeLeft(left), getNodeLeft(right)) ||
      left.id.localeCompare(right.id)
    );
  });

  const firstNode = sortedNodes[0];
  const bounds = collectUnitBounds(sortedNodes);
  return {
    kind: "list",
    pageNumber: firstNode.pageNumber,
    nodes: sortedNodes,
    ...bounds,
    explicitColumnHint: sortedNodes
      .map(getNodeColumnHint)
      .find((value) => Number.isInteger(value)),
    explicitColumnHints: collectExplicitColumnHints(sortedNodes),
    priority: 1,
    sortKey: `list:${groupId}`,
    phase: 1
  };
}

function makeTableUnit(tableId, nodes) {
  const sortedNodes = [...nodes].sort((left, right) => {
    return (
      compareNumbers(left.tableRowIndex, right.tableRowIndex) ||
      compareNumbers(left.tableColumnIndex, right.tableColumnIndex) ||
      compareNumbers(getNodeTop(left), getNodeTop(right)) ||
      compareNumbers(getNodeLeft(left), getNodeLeft(right)) ||
      left.id.localeCompare(right.id)
    );
  });

  const firstNode = sortedNodes[0];
  const bounds = collectUnitBounds(sortedNodes);
  return {
    kind: "table",
    pageNumber: firstNode.pageNumber,
    nodes: sortedNodes,
    ...bounds,
    explicitColumnHint: sortedNodes
      .map(getNodeColumnHint)
      .find((value) => Number.isInteger(value)),
    explicitColumnHints: collectExplicitColumnHints(sortedNodes),
    priority: 3,
    sortKey: `table:${tableId}`,
    phase: 1
  };
}

function buildColumnRanges(units) {
  const rangesByColumn = new Map();

  for (const unit of units) {
    const existingRange = rangesByColumn.get(unit.columnIndex);
    if (existingRange) {
      existingRange.minLeft = Math.min(existingRange.minLeft, unit.left);
      existingRange.maxRight = Math.max(existingRange.maxRight, unit.right);
      continue;
    }

    rangesByColumn.set(unit.columnIndex, {
      columnIndex: unit.columnIndex,
      minLeft: unit.left,
      maxRight: unit.right
    });
  }

  return [...rangesByColumn.values()].sort((left, right) => left.columnIndex - right.columnIndex);
}

function isColumnSpanningUnit(unit, columnRanges, contentSpanWidth) {
  if ((unit.explicitColumnHints || []).length > 1) {
    return true;
  }

  const tolerance = Math.max(12, contentSpanWidth * 0.03);

  for (let index = 0; index < columnRanges.length - 1; index += 1) {
    const separator = (columnRanges[index].maxRight + columnRanges[index + 1].minLeft) / 2;
    if (unit.left < separator - tolerance && unit.right > separator + tolerance) {
      return true;
    }
  }

  return false;
}

function orderContentUnits(contentUnits) {
  if (contentUnits.length === 0) {
    return [];
  }

  const columnRanges = buildColumnRanges(contentUnits);
  if (columnRanges.length <= 1) {
    return [...contentUnits].sort((left, right) => compareUnits(left, right));
  }

  const contentSpanWidth =
    Math.max(...contentUnits.map((unit) => unit.right)) - Math.min(...contentUnits.map((unit) => unit.left));
  const spanningUnits = contentUnits
    .filter((unit) => isColumnSpanningUnit(unit, columnRanges, contentSpanWidth))
    .sort((left, right) => compareSpanningUnits(left, right));

  if (spanningUnits.length === 0) {
    return [...contentUnits].sort((left, right) => compareUnits(left, right));
  }

  const remainingUnits = [...contentUnits];
  const orderedUnits = [];

  for (const spanningUnit of spanningUnits) {
    if (remainingUnits.indexOf(spanningUnit) < 0) {
      continue;
    }

    const verticalTolerance = Math.max(8, (spanningUnit.bottom - spanningUnit.top) * 0.25);
    const precedingUnits = remainingUnits
      .filter((unit) => unit !== spanningUnit && unit.bottom <= spanningUnit.top + verticalTolerance)
      .sort((left, right) => compareUnits(left, right));

    for (const unit of precedingUnits) {
      orderedUnits.push(unit);
      remainingUnits.splice(remainingUnits.indexOf(unit), 1);
    }

    orderedUnits.push(spanningUnit);
    remainingUnits.splice(remainingUnits.indexOf(spanningUnit), 1);
  }

  orderedUnits.push(...remainingUnits.sort((left, right) => compareUnits(left, right)));
  return orderedUnits;
}

function buildPageUnits(pageNodes) {
  const headerArtifacts = [];
  const footerArtifacts = [];
  const listGroups = new Map();
  const tableGroups = new Map();
  const contentNodes = [];

  for (const node of pageNodes) {
    if (isHeaderArtifact(node)) {
      headerArtifacts.push(makeArtifactUnit(node));
      continue;
    }

    if (isFooterArtifact(node)) {
      footerArtifacts.push(makeArtifactUnit(node));
      continue;
    }

    if (isTableNode(node)) {
      const tableId = String(node.tableId || `table:${node.pageNumber}:${node.sourceBlockId}`);
      const group = tableGroups.get(tableId) || [];
      group.push(node);
      tableGroups.set(tableId, group);
      continue;
    }

    if (isListNode(node)) {
      const groupId = String(node.listGroupId || `list:${node.id}`);
      const group = listGroups.get(groupId) || [];
      group.push(node);
      listGroups.set(groupId, group);
      continue;
    }

    contentNodes.push(makeContentUnit(node));
  }

  const bandsSource = [
    ...contentNodes,
    ...[...listGroups.values()].flat().map((node) => ({
      left: getNodeLeft(node),
      explicitColumnHint: getNodeColumnHint(node)
    })),
    ...[...tableGroups.values()].flat().map((node) => ({
      left: getNodeLeft(node),
      explicitColumnHint: getNodeColumnHint(node)
    }))
  ];
  const bands = buildColumnBands(bandsSource);

  const contentUnits = [
    ...contentNodes,
    ...[...listGroups.entries()].map(([groupId, nodes]) => makeListUnit(groupId, nodes)),
    ...[...tableGroups.entries()].map(([tableId, nodes]) => makeTableUnit(tableId, nodes))
  ].map((unit) => ({
    ...unit,
    columnIndex: assignColumnIndex(unit, bands)
  }));

  return [
    ...headerArtifacts.sort((left, right) => compareUnits(left, right)),
    ...orderContentUnits(contentUnits),
    ...footerArtifacts.sort((left, right) => compareUnits(left, right))
  ];
}

function flattenUnits(units) {
  const orderedNodes = [];
  for (const unit of units) {
    const nodes = [...unit.nodes];
    for (const node of nodes) {
      orderedNodes.push(node);
    }
  }
  return orderedNodes;
}

export async function assignReadingOrder(inputPath) {
  const semanticDocument = JSON.parse(await readFile(inputPath, "utf8"));

  if (!validateSemantic(semanticDocument)) {
    throw new Error(`Reading-order input failed schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  const pageGroups = new Map();
  for (const node of semanticDocument.nodes) {
    const pageNodes = pageGroups.get(node.pageNumber) || [];
    pageNodes.push(node);
    pageGroups.set(node.pageNumber, pageNodes);
  }

  const orderedNodes = [];
  for (const pageNumber of [...pageGroups.keys()].sort((left, right) => left - right)) {
    const pageUnits = buildPageUnits(pageGroups.get(pageNumber));
    orderedNodes.push(...flattenUnits(pageUnits));
  }

  const orderedNodeIds = orderedNodes.map((node, index) => {
    node.readingOrder = index;
    return node.id;
  });

  const nodesById = new Map(orderedNodes.map((node) => [node.id, node]));
  const nodes = semanticDocument.nodes.map((node) => nodesById.get(node.id));

  const output = {
    ...semanticDocument,
    nodes,
    orderedNodeIds
  };

  if (!validateSemantic(output)) {
    throw new Error(`Reading-order output failed schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  return output;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: node modules/reading-order/index.js <semantic.json>");
  }

  const result = await assignReadingOrder(inputPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
