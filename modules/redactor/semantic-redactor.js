import Ajv2020 from "ajv/dist/2020.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import layoutSchema from "../../contracts/layout.schema.json" with { type: "json" };
import semanticSchema from "../../contracts/semantic.schema.json" with { type: "json" };
import redactionPlanSchema from "../../contracts/redaction-plan.schema.json" with { type: "json" };
import {
  applySsnMasking,
  buildBlockLookup,
  estimateMatchBbox
} from "./shared.js";

const ajv = new Ajv2020({ allErrors: true });
const validateLayout = ajv.compile(layoutSchema);
const validateSemantic = ajv.compile(semanticSchema);
const validateRedactionPlan = ajv.compile(redactionPlanSchema);

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }

  return {
    semanticPath: args.get("--semantic"),
    layoutPath: args.get("--layout"),
    semanticOutputPath: args.get("--semantic-output"),
    planOutputPath: args.get("--plan-output")
  };
}

function buildFallbackPage(node) {
  const [x = 0, y = 0, width = 0, height = 0] = node.bbox || [];
  return {
    width: x + width + 12,
    height: y + height + 12
  };
}

export function buildSemanticRedactionArtifacts({ semanticDocument, layoutDocument, workloadId = "tag-and-ssn-redact" }) {
  const blocksById = buildBlockLookup(layoutDocument);
  const matches = [];
  const redactedNodeIds = new Set();

  const nodes = (semanticDocument.nodes || []).map((node) => {
    const masking = applySsnMasking(node.text);
    if (!masking.matches.length) {
      return node;
    }

    redactedNodeIds.add(node.id);
    const blockEntry = blocksById.get(node.sourceBlockId);
    const bboxSource = blockEntry?.block || {
      text: node.text,
      bbox: node.bbox
    };
    const page = blockEntry?.page || buildFallbackPage(node);

    masking.matches.forEach((match, matchIndex) => {
      matches.push({
        matchId: `${node.id}:ssn:${matchIndex + 1}`,
        pageNumber: node.pageNumber,
        sourceBlockId: node.sourceBlockId,
        sourceNodeId: node.id,
        maskedText: match.maskedText,
        bbox: estimateMatchBbox(bboxSource, match, page)
      });
    });

    return {
      ...node,
      text: masking.text,
      redaction: {
        policy: "ssn-mask",
        matchCount: masking.matches.length
      }
    };
  });

  const semanticRedacted = {
    ...semanticDocument,
    source: {
      ...(semanticDocument.source || {}),
      redaction: {
        policy: "ssn-mask",
        redactedNodeCount: redactedNodeIds.size,
        redactedMatches: matches.length
      }
    },
    nodes
  };

  const plan = {
    schemaVersion: "1.0.0",
    workloadId,
    sourcePdf: semanticDocument.source?.filePath || layoutDocument.source?.filePath || "",
    semanticDocumentId: semanticDocument.documentId,
    summary: {
      pagesProcessed: layoutDocument.pages?.length || 0,
      candidateMatches: matches.length,
      redactedMatches: matches.length,
      pagesRedacted: new Set(matches.map((match) => match.pageNumber)).size,
      outputMode: "semantic-mask-plan"
    },
    redactedNodeIds: [...redactedNodeIds],
    matches
  };

  if (!validateSemantic(semanticRedacted)) {
    throw new Error(`Semantic redaction output failed semantic schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  if (!validateRedactionPlan(plan)) {
    throw new Error(`Semantic redaction plan failed schema validation: ${ajv.errorsText(validateRedactionPlan.errors)}`);
  }

  return {
    semanticRedacted,
    plan
  };
}

export async function redactSemanticDocument({ semanticPath, layoutPath, semanticOutputPath, planOutputPath }) {
  if (!semanticPath || !layoutPath || !semanticOutputPath || !planOutputPath) {
    throw new Error(
      "Usage: node modules/redactor/semantic-redactor.js --semantic <semantic.json> --layout <layout.json> --semantic-output <semantic-redacted.json> --plan-output <redaction-plan.json>"
    );
  }

  const semanticDocument = JSON.parse(await readFile(semanticPath, "utf8"));
  const layoutDocument = JSON.parse(await readFile(layoutPath, "utf8"));

  if (!validateSemantic(semanticDocument)) {
    throw new Error(`Semantic redaction input failed semantic schema validation: ${ajv.errorsText(validateSemantic.errors)}`);
  }

  if (!validateLayout(layoutDocument)) {
    throw new Error(`Semantic redaction input failed layout schema validation: ${ajv.errorsText(validateLayout.errors)}`);
  }

  const result = buildSemanticRedactionArtifacts({ semanticDocument, layoutDocument });

  await mkdir(path.dirname(semanticOutputPath), { recursive: true });
  await mkdir(path.dirname(planOutputPath), { recursive: true });
  await writeFile(semanticOutputPath, `${JSON.stringify(result.semanticRedacted, null, 2)}\n`);
  await writeFile(planOutputPath, `${JSON.stringify(result.plan, null, 2)}\n`);

  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await redactSemanticDocument(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        semanticOutputPath: options.semanticOutputPath,
        planOutputPath: options.planOutputPath,
        redactedNodeCount: result.plan.redactedNodeIds.length,
        redactedMatches: result.plan.summary.redactedMatches
      },
      null,
      2
    )}\n`
  );
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
