// Font embedder CLI.
//
// Usage:
//   node modules/font-embedder/index.js \
//     --pdf <input.pdf> --tags <tagging.json> --output <fonts.json>
//
// Produces a font-inventory document validated against
// contracts/font-inventory.schema.json. Writes JSON to --output, a short
// human summary to stdout, and structured errors to stderr.

import Ajv2020 from "ajv/dist/2020.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fontInventorySchema from "../../contracts/font-inventory.schema.json" with { type: "json" };
import taggingSchema from "../../contracts/tagging.schema.json" with { type: "json" };
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractFontUsage } from "./lib/extract.js";
import { analyzeFont } from "./lib/analyze.js";
import { standard14FallbackKey } from "./lib/standard14.js";

const ajv = new Ajv2020({ allErrors: true });
const validateInventory = ajv.compile(fontInventorySchema);
const validateTagging = ajv.compile(taggingSchema);

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }
  return {
    pdfPath: args.get("--pdf"),
    tagsPath: args.get("--tags"),
    outputPath: args.get("--output")
  };
}

function createDocumentId(pdfPath) {
  const base = path.basename(pdfPath, path.extname(pdfPath));
  return `font-inventory:${base}`;
}

function createPdfDocumentLoadOptions(data) {
  return {
    data,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: VerbosityLevel.ERRORS
  };
}

function buildFallbackDescriptors(fontEntries) {
  // Emit fallback descriptors for every fontKey that points at the vendored
  // Noto bundle. The pdf-writer module owns the actual font files; the path
  // we publish is the conventional vendor location.
  const fallbacks = {};
  for (const entry of fontEntries) {
    const key = entry.plan?.fallbackKey;
    if (!key || fallbacks[key]) {
      continue;
    }
    fallbacks[key] = descriptorForFallbackKey(key);
  }
  return fallbacks;
}

function descriptorForFallbackKey(key) {
  const [family, style] = key.split("-");
  const styleName = style || "Regular";
  let script = "Latin";
  if (family === "NotoSansMono") script = "Latin";
  else if (family === "NotoSansSymbols" || family === "NotoSansSymbols2") script = "Symbol";
  else if (family === "NotoSerif") script = "Latin";

  return {
    family,
    style: styleName,
    path: `modules/font-embedder/vendor/fonts/${family}-${styleName}.ttf`,
    license: "OFL-1.1",
    script
  };
}

function summarize(fontEntries, blockers) {
  const totalFonts = fontEntries.length;
  const embeddedFonts = fontEntries.filter((entry) => entry.embedded).length;
  const remediated = fontEntries.filter(
    (entry) => entry.plan?.action && entry.plan.action !== "embed-as-is"
  ).length;

  return {
    totalFonts,
    embeddedFonts,
    remediated,
    blockers
  };
}

function sortFontEntries(entries) {
  return [...entries].sort((left, right) => (left.fontKey < right.fontKey ? -1 : left.fontKey > right.fontKey ? 1 : 0));
}

export function buildInventoryFromEntries({ documentId, source, fontEntries, blockers = [] }) {
  const sortedEntries = sortFontEntries(fontEntries);
  const fallbacks = buildFallbackDescriptors(sortedEntries);
  const inventory = {
    schemaVersion: "1.0.0",
    documentId,
    source,
    fonts: sortedEntries,
    summary: summarize(sortedEntries, blockers)
  };
  if (Object.keys(fallbacks).length > 0) {
    inventory.fallbacks = fallbacks;
  }
  if (!validateInventory(inventory)) {
    throw new Error(
      `Font embedder output failed schema validation: ${ajv.errorsText(validateInventory.errors)}`
    );
  }
  return inventory;
}

export function getInventoryValidator() {
  return validateInventory;
}

export async function buildFontInventory({ pdfPath, tagsPath } = {}) {
  if (!pdfPath) {
    throw new Error(
      "Usage: node modules/font-embedder/index.js --pdf <input.pdf> --tags <tagging.json> --output <fonts.json>"
    );
  }

  const absolutePdfPath = path.resolve(pdfPath);
  const data = new Uint8Array(await readFile(absolutePdfPath));
  const pdf = await getDocument(createPdfDocumentLoadOptions(data)).promise;

  let resolvedTagsPath = null;
  if (tagsPath) {
    const absoluteTags = path.resolve(tagsPath);
    const tagsDocument = JSON.parse(await readFile(absoluteTags, "utf8"));
    if (!validateTagging(tagsDocument)) {
      throw new Error(
        `Font embedder tagging input failed schema validation: ${ajv.errorsText(validateTagging.errors)}`
      );
    }
    resolvedTagsPath = absoluteTags;
  }

  const rawRecords = await extractFontUsage(pdf);
  const blockers = [];
  const fontEntries = [];

  for (const record of rawRecords) {
    const { fontEntry, blocker } = analyzeFont(record);
    fontEntries.push(fontEntry);
    if (blocker) {
      blockers.push({
        fontKey: fontEntry.fontKey,
        ...blocker,
        detail: describeBlocker(fontEntry, blocker)
      });
    }
  }

  const sortedEntries = sortFontEntries(fontEntries);
  const fallbacks = buildFallbackDescriptors(sortedEntries);

  const inventory = {
    schemaVersion: "1.0.0",
    documentId: createDocumentId(absolutePdfPath),
    source: {
      pdfPath: absolutePdfPath,
      ...(resolvedTagsPath ? { tagsPath: resolvedTagsPath } : {})
    },
    fonts: sortedEntries,
    summary: summarize(sortedEntries, blockers)
  };

  if (Object.keys(fallbacks).length > 0) {
    inventory.fallbacks = fallbacks;
  }

  if (!validateInventory(inventory)) {
    throw new Error(
      `Font embedder output failed schema validation: ${ajv.errorsText(validateInventory.errors)}`
    );
  }

  return inventory;
}

function describeBlocker(fontEntry, blocker) {
  const baseFont = fontEntry.baseFont || "<unknown>";
  switch (blocker.blocker) {
    case "standard-14":
      return `${baseFont} is one of the Standard 14 fonts; substitute fallback ${standard14FallbackKey(baseFont) || "<none>"}.`;
    case "not-embedded":
      return `${baseFont} is not embedded in the source PDF.`;
    case "missing-to-unicode":
      return `${baseFont} has no ToUnicode CMap.`;
    case "broken-to-unicode":
      return `${baseFont} ToUnicode coverage is incomplete and could not be reconstructed.`;
    case "missing-cid-system-info":
      return `${baseFont} is a Type0 font without a /CIDSystemInfo dictionary.`;
    case "symbolic-without-differences":
      return `${baseFont} is symbolic but has no /Differences array — encoding cannot be resolved.`;
    case "invalid-encoding":
      return `${baseFont} encoding is not recognized.`;
    default:
      return `${baseFont}: ${blocker.blocker}`;
  }
}

function renderHumanSummary(inventory) {
  const lines = [];
  lines.push(`font-inventory: ${inventory.documentId}`);
  lines.push(`  totalFonts:    ${inventory.summary.totalFonts}`);
  lines.push(`  embeddedFonts: ${inventory.summary.embeddedFonts}`);
  lines.push(`  remediated:    ${inventory.summary.remediated}`);
  lines.push(`  blockers:      ${inventory.summary.blockers.length}`);
  for (const entry of inventory.fonts) {
    lines.push(
      `  - ${entry.baseFont} [${entry.subtype}] -> plan=${entry.plan.action}` +
        (entry.toUnicode.repairStrategy ? ` (repair=${entry.toUnicode.repairStrategy})` : "")
    );
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.pdfPath || !options.outputPath) {
    throw new Error(
      "Usage: node modules/font-embedder/index.js --pdf <input.pdf> --tags <tagging.json> --output <fonts.json>"
    );
  }

  const inventory = await buildFontInventory(options);
  await mkdir(path.dirname(path.resolve(options.outputPath)), { recursive: true });
  await writeFile(path.resolve(options.outputPath), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  process.stdout.write(`${renderHumanSummary(inventory)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
