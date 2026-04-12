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

function createTableNode(node, groupId) {
  return {
    id: `tag:table:${groupId}`,
    type: "Table",
    sourceNodeIds: node ? [node.id] : [],
    children: []
  };
}

function normalizeTableSection(node) {
  const explicitSection = String(node.tableSection || "").trim().toLowerCase();
  if (explicitSection === "head" || explicitSection === "thead" || explicitSection === "header") {
    return "head";
  }

  if (explicitSection === "foot" || explicitSection === "tfoot" || explicitSection === "footer") {
    return "foot";
  }

  if (explicitSection === "body" || explicitSection === "tbody") {
    return "body";
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
    children: []
  };
  containerNode.children.push(rowNode);
  return rowNode;
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
        sections: new Map(),
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
          sections: new Map(),
          rows: new Map()
        };
      }

      const rowIndex = getTableRowIndex(node);
      const sectionKey = normalizeTableSection(node);
      let sectionNode = activeTable.sections.get(sectionKey);
      if (!sectionNode) {
        sectionNode = createTableSectionNode(activeTable.node, sectionKey);
        activeTable.sections.set(sectionKey, sectionNode);
      }

      const rowKey = `${sectionKey}:${rowIndex}`;
      let rowNode = activeTable.rows.get(rowKey);
      if (!rowNode) {
        rowNode = createTableRowNode(sectionNode, rowIndex);
        activeTable.rows.set(rowKey, rowNode);
      }

      rowNode.children.push(createLeaf(node, headingNormalization));
      continue;
    }

    activeTable = null;
    currentContainer().children.push(createLeaf(node, headingNormalization));
  }

  const taggingDocument = {
    schemaVersion: "1.0.0",
    documentId: `${semanticDocument.documentId}:tagging`,
    source: {
      semanticDocumentId: semanticDocument.documentId,
      filePath: semanticDocument.source.filePath,
      headingNormalization: headingNormalization.summary
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
