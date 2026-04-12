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

function makeContentUnit(node) {
  return {
    kind: "content",
    pageNumber: node.pageNumber,
    nodes: [node],
    top: getNodeTop(node),
    left: getNodeLeft(node),
    explicitColumnHint: getNodeColumnHint(node),
    priority: rolePriority(node),
    sortKey: node.id,
    phase: 1
  };
}

function makeArtifactUnit(node) {
  return {
    kind: "artifact",
    pageNumber: node.pageNumber,
    nodes: [node],
    top: getNodeTop(node),
    left: getNodeLeft(node),
    explicitColumnHint: getNodeColumnHint(node),
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
  return {
    kind: "list",
    pageNumber: firstNode.pageNumber,
    nodes: sortedNodes,
    top: Math.min(...sortedNodes.map(getNodeTop)),
    left: Math.min(...sortedNodes.map(getNodeLeft)),
    explicitColumnHint: sortedNodes
      .map(getNodeColumnHint)
      .find((value) => Number.isInteger(value)),
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
  return {
    kind: "table",
    pageNumber: firstNode.pageNumber,
    nodes: sortedNodes,
    top: Math.min(...sortedNodes.map(getNodeTop)),
    left: Math.min(...sortedNodes.map(getNodeLeft)),
    explicitColumnHint: sortedNodes
      .map(getNodeColumnHint)
      .find((value) => Number.isInteger(value)),
    priority: 3,
    sortKey: `table:${tableId}`,
    phase: 1
  };
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

  const sortedUnits = [
    ...headerArtifacts,
    ...contentUnits,
    ...footerArtifacts
  ].sort((left, right) => compareUnits(left, right));

  return sortedUnits;
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
